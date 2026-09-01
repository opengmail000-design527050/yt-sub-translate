/* Sub Translator —— 内容脚本（隔离世界）
 * 负责：注入主世界脚本、拿字幕、切句、按播放头懒翻译、渲染叠加层、播放器按钮。
 */
(function () {
  'use strict';
  if (window.__YTST_CONTENT__) return;
  window.__YTST_CONTENT__ = true;

  const NS = 'ytst';

  /* ------------------------------------------------------------------ *
   * 配置（与 common.js 保持一致）
   * ------------------------------------------------------------------ */
  const DEFAULTS = {
    enabled: true, autoStart: true,
    baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-5.6-luna', targetLang: 'auto',
    reasoning: 'none', reasoningStyle: 'effort_none',
    layout: 'both', fontFamily: 'serif', fontSize: 24, autoScale: true, origScale: 0.8,
    maxWidth: 88, bgOpacity: 0.55, hideNative: true, posX: null, posY: null,
    batchChars: 1500, batchLines: 20, lookahead: 45,
    useContext: true, useCache: true, cacheDays: 60, cacheMax: 300, concurrency: 3,
    density: 'standard',
    temperature: '', maxTokens: '', extraPrompt: ''
  };

  /* ---------- 语言 ---------- */
  const NAME_TO_CODE = {
    '简体中文': 'zh-CN', '繁體中文': 'zh-TW', '中文': 'zh', 'English': 'en', '英文': 'en',
    '英语': 'en', '日本語': 'ja', '日文': 'ja', '日语': 'ja', '한국어': 'ko', '韩语': 'ko',
    'Français': 'fr', 'Deutsch': 'de', 'Español': 'es', 'Русский': 'ru',
    'Português': 'pt', 'Italiano': 'it', 'ไทย': 'th', 'Tiếng Việt': 'vi',
    'العربية': 'ar', 'हिन्दी': 'hi'
  };

  function targetCode() {
    const t = String(S.targetLang || 'auto').trim();
    if (!t || t.toLowerCase() === 'auto') {
      try { return chrome.i18n.getUILanguage() || 'zh-CN'; } catch (_) { return 'zh-CN'; }
    }
    return NAME_TO_CODE[t] || '';    // 认不出的自定义写法：返回空，表示不做同语言判断
  }

  const sameLang = (a, b) =>
    !!a && !!b && String(a).toLowerCase().split('-')[0] === String(b).toLowerCase().split('-')[0];

  /** 挑一条最合适的字幕轨，并顺带确定「要翻的这段文字是什么语言」。
   *  自动字幕（ASR）一定是按原声语言生成的，所以它是最可靠的语言判据；
   *  但人工字幕有标点、质量更好，所以同语言时优先用人工轨。
   *
   *  注意 spoken 返回的是**选中那条轨的语言**，不一定等于音频语言：视频可能压根
   *  没有原声那条轨（对白是烧进画面的），这时只能退回现有的轨去翻。这个返回值
   *  是给翻译提示词用的（要如实说明原文是什么语言），所以就该是轨的语言；
   *  「音频疑似另一种语言」这件事由 st.audioLang 单独报给弹窗。 */
  function chooseTrack(tracks, audioLang) {
    if (!tracks || !tracks.length) return null;
    const base = (c) => String(c || '').toLowerCase().split('-')[0];

    const asr = tracks.find((t) => t.kind === 'asr');
    const spoken = (asr && asr.languageCode) || audioLang || tracks[0].languageCode || '';

    const manual = tracks.find((t) => t.kind !== 'asr' && base(t.languageCode) === base(spoken));
    const track = manual || asr || tracks[0];
    return { track, spoken: track.languageCode || spoken };
  }

  /* 简繁是两路：zh-CN / zh-Hans / zh-SG 一路，zh-TW / zh-HK / zh-Hant 一路。
   * 只比主语言的话，简中用户会被塞一条繁体轨（虽然多半也看得懂，但能挑就挑对的）。 */
  const SCRIPT = {
    'zh': 'hans', 'zh-cn': 'hans', 'zh-sg': 'hans', 'zh-hans': 'hans',
    'zh-tw': 'hant', 'zh-hk': 'hant', 'zh-mo': 'hant', 'zh-hant': 'hant'
  };
  const scriptOf = (c) => SCRIPT[String(c || '').toLowerCase()] || '';

  /** 视频自带的、目标语言的人工字幕轨。有它就不用花钱翻了。
   *  自动字幕（asr）不算 —— 那是机器听写原声的，只会是原声语言。 */
  function pickTargetTrack(tracks, tgt) {
    if (!tracks || !tracks.length || !tgt) return '';
    const cand = tracks.filter((t) => t.kind !== 'asr' && sameLang(t.languageCode, tgt));
    if (!cand.length) return '';
    const score = (t) => {
      const c = String(t.languageCode || '');
      if (c.toLowerCase() === String(tgt).toLowerCase()) return 3;
      const a = scriptOf(c), b = scriptOf(tgt);
      if (a && b) return a === b ? 2 : 0;
      return 1;
    };
    let best = cand[0], bs = score(cand[0]);
    for (const t of cand.slice(1)) { const v = score(t); if (v > bs) { best = t; bs = v; } }
    return best.languageCode || '';
  }

  /* 中日韩与全角字符按 2 个单位计宽，其余按 1。
   * 这样同一套长度上限在拉丁语系和中日韩之间都说得通 ——
   * 130 个拉丁字符和 65 个汉字，无论信息量还是屏幕宽度都差不多。 */
  const WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;
  const isWide = (ch) => !!ch && WIDE_RE.test(ch);
  function wid(s) {
    let w = 0;
    for (let i = 0; i < s.length; i++) w += isWide(s[i]) ? 2 : 1;
    return w;
  }

  /* 字幕长度档位：soft = 合并短句的上限，hard = 超过才不得不切（单位同上） */
  const DENSITY = {
    compact: { soft: 76, hard: 96 },
    standard: { soft: 100, hard: 130 },
    full: { soft: 130, hard: 180 }
  };

  const FONT_STACKS = {
    serif: '"Georgia", "Iowan Old Style", "Palatino Linotype", Constantia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", STSong, serif',
    sans: '"Inter", "Helvetica Neue", -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    kai: '"Constantia", "Cambria", Georgia, "Kaiti SC", STKaiti, KaiTi, "Noto Serif SC", serif'
  };
  let S = Object.assign({}, DEFAULTS);
  /* 注入被提到了读设置之前（见 boot 的注释），所以在设置真正读回来之前
   * 有一小段时间 S 还是 DEFAULTS —— 而 DEFAULTS 里 autoStart 是 true、
   * targetLang 是 'auto'，跟用户存的很可能不是一回事。
   *
   * 这段时间里播放器信息完全可能已经到了。要是照 DEFAULTS 去判语言、判要不要自动开，
   * 就会出现：用户明明关了自动开启却自己启动了；或者目标语言按浏览器界面语言算成英语，
   * 把英文视频判成「不需要翻译」从此保持关闭。设置读回来之后又没人重判，就一直错到底。
   *
   * 所以设置没到位之前，一切判定挂起（见 evaluateTracks），到位后补跑一次。 */
  let settingsReady = false;
  let pendingEval = false;

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  const st = {
    videoId: '',
    title: '',
    audioLang: '',          // 当前音轨的语言（多音轨视频里会中途变）
    audioDubbed: false,     // 当前音轨是 YouTube 的 AI 自动配音
    tracks: [],
    sourceLang: '',          // 自动识别出的原声语言
    needsTranslation: false, // 原声语言与目标语言不同才需要翻
    active: false,           // 当前视频翻译是否开启
    userOff: false,          // 用户在本视频手动关过
    rawCues: null,           // 原始 cue，改字幕长度档位时用来重新切句
    noPunct: false,          // 这一轨的原文没有标点（多半是自动字幕），翻译时要额外提示模型
    segments: [],            // [{id,start,end,text}]
    trans: new Map(),        // id -> 译文
    dropped: new Set(),      // 补翻后模型仍未给出译文的行，只显示原文
    batches: [],             // [{from,to,state:'idle'|'run'|'done'|'err'}]
    batchTier: 0,            // 当前批次档位，见 BATCH_TIERS
    batchCeil: 0,            // 本视频还允许升到哪一档（出过错位就往下压，不再回去）
    batchClean: 0,           // 连续几批干干净净了
    batchDirty: 0,           // 连续几批出了错位（连着两批才封顶，见 noteBatchResult）
    running: 0,
    status: 'idle',          // idle | waiting | ready | translating | error | nosub
    error: '',
    curIdx: -1,
    settleAt: 0,             // 拖动进度条后，等到这个时刻才允许再调度（见 SEEK_SETTLE）
    cache: null,             // { items: {hash: text} }
    cacheDirty: false,
    /* 「这一版」的编号：切视频、重新切句、改了影响译文的设置都会 +1。
     * 所有异步回来的结果写回前先对一下号，不然旧响应会写进新状态。 */
    epoch: 0,
    trackRequested: false,
    trackAt: 0,              // 上次点名要轨的时间，用来决定隔多久可以再要一次
    fallbackTried: false,
    nativeOn: false,         // 兜底时我们替用户打开过原生字幕，关翻译时要还回去
    trackSig: '',            // 当前用的是哪条字幕轨（lang|kind|tlang）
    reqSeq: 0,               // 每次点名要轨都发一个新编号
    wantReq: 0,              // 正在等的那个编号，只认它回来的那一份
    wantLang: '',            // 点名要的是哪种语言，回来的对不上就不认
    userTrack: null,         // 用户在 CC 菜单里选中的轨，之后一切以它为准

    /* 视频自带目标语言的人工字幕轨时，直接拿它当译文，不花 token。
     * '' = 没有这回事 | pending = 已发现、正在取 | on = 正在用 | off = 取失败/不好用，照常自己翻 */
    adoptLang: '',
    adoptState: '',
    adoptCues: null,         // 那条轨的原始 cue，改字幕长度档位时重新对齐要用
    adoptReq: 0,
    adoptIds: new Set()      // 哪些句子的译文是从那条轨贴过来的（回退时要收回）
  };

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */
  const post2page = (type, data) => {
    try { window.postMessage({ ns: NS, dir: 'c2p', type, data }, '*'); } catch (_) {}
  };

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function debounce(fn, ms) {
    let t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function getVideo() { return document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video'); }
  function getPlayerEl() { return document.getElementById('movie_player') || document.querySelector('.html5-video-player'); }

  /* ------------------------------------------------------------------ *
   * 注入主世界脚本
   * ------------------------------------------------------------------ */
  function inject() {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('content/inject.js');
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
      s.onload = () => s.remove();
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 字幕解析
   * ------------------------------------------------------------------ */
  function parseJson3(body) {
    let j;
    try { j = JSON.parse(body); } catch (_) { return null; }
    if (!j || !Array.isArray(j.events)) return null;
    const cues = [];
    for (const ev of j.events) {
      if (!ev.segs) continue;
      if (ev.aAppend) continue;                       // 自动字幕的滚动补帧，跳过
      const text = ev.segs.map((x) => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = Number(ev.tStartMs || 0) / 1000;
      const dur = Number(ev.dDurationMs || 0) / 1000;
      cues.push({ start, end: start + (dur || 2), text });
    }
    return cues.length ? cues : null;
  }

  function parseXml(body) {
    let doc;
    try { doc = new DOMParser().parseFromString(body, 'text/xml'); } catch (_) { return null; }
    const nodes = doc.querySelectorAll('text, p');
    if (!nodes.length) return null;
    const cues = [];
    nodes.forEach((n) => {
      const start = Number(n.getAttribute('start') || (Number(n.getAttribute('t') || 0) / 1000));
      const dur = Number(n.getAttribute('dur') || (Number(n.getAttribute('d') || 0) / 1000)) || 2;
      const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) cues.push({ start, end: start + dur, text });
    });
    return cues.length ? cues : null;
  }

  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    const t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }

  /* 把碎片化的 cue 合成「句子级」片段：一屏读得完，翻译质量更好，token 也更省。
   * YouTube 的 cue 只有两三个词，句号常落在 cue 中间，所以先把整轨拼成一条文本、
   * 用字符位置反查时间，再按句子边界切。 */
  const MIN_CHARS = 26;   // 太短的句子并进下一句，免得字幕一闪而过
  const MAX_DUR = 9;
  const GAP = 1.4;

  function buildSegments(cues) {
    const d = DENSITY[S.density] || DENSITY.standard;
    const SOFT_MAX = d.soft;   // 翻译单元的目标长度，超了才考虑切
    const HARD_MAX = d.hard;   // 超过这个不得不切，否则一屏放不下

    const clean = cues
      .map((c) => ({ start: c.start, end: c.end, text: decodeEntities(c.text).replace(/\s+/g, ' ').trim() }))
      .filter((c) => c.text && !/^\[[^\]]*\]$/.test(c.text));
    if (!clean.length) return [];

    // 自动字幕的 cue 时长常常盖过下一条（播放器靠它做滚动效果），
    // 不修掉的话按字符插值出来的时间会整体偏晚
    for (let i = 0; i < clean.length - 1; i++) {
      if (clean[i].end > clean[i + 1].start) clean[i].end = clean[i + 1].start;
      if (clean[i].end <= clean[i].start) clean[i].end = clean[i].start + 0.25;
    }

    /* 静音前的最后一条 cue，时长常常一路拉到下一条开口的地方 —— 自动字幕尤其如此，
     * 播放器靠它把这行字一直挂在屏幕上。可那几十秒里根本没人说话：照它插值，这条
     * cue 后半句的时间会被摊进静音里，下面的静音检测也就看不见这个洞了。
     * 按文本长度给单条 cue 的时长封顶，说得再慢也用不了这么久。 */
    for (const c of clean) {
      const cap = Math.max(2, 0.5 + wid(c.text) * 0.14);
      if (c.end - c.start > cap) c.end = c.start + cap;
    }

    // 拼成整条文本，同时记录每个 cue 的字符区间用于时间插值。
    // 中日韩之间不能补空格，否则会在词中间插进空隙。
    let full = '';
    const marks = [];
    for (const c of clean) {
      if (full && !(isWide(full[full.length - 1]) && isWide(c.text[0]))) full += ' ';
      marks.push({ pos: full.length, len: Math.max(1, c.text.length), start: c.start, end: c.end });
      full += c.text;
    }

    // 前缀宽度表：之后判断「这一段有多长」都是 O(1)，不用反复扫字符串
    const pw = new Int32Array(full.length + 1);
    for (let i = 0; i < full.length; i++) pw[i + 1] = pw[i] + (isWide(full[i]) ? 2 : 1);
    const widthOf = (a, b) => pw[b] - pw[a];
    /** 从 s 出发、宽度不超过 w 的最远字符位置 */
    const advance = (s, w) => {
      const target = pw[s] + w;
      let lo = s, hi = full.length, best = s;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pw[mid] <= target) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best;
    };

    /* 句子边界落在 cue 之间的空格上，而空格在字符表里算作上一条 cue 的尾巴。
     * 直接拿边界位置反查时间，新句子的开始就会被算成上一句的结束 ——
     * 中间隔着几十秒静音时，下一句会提前几十秒冒出来。取时间前先跳过两端空白。 */
    const skipL = (a, b) => { while (a < b && /\s/.test(full[a])) a++; return a; };
    const skipR = (a, b) => { while (b > a && /\s/.test(full[b - 1])) b--; return b; };

    const timeAt = (idx) => {
      let lo = 0, hi = marks.length - 1, k = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid].pos <= idx) { k = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const m = marks[k];
      const frac = Math.min(1, Math.max(0, (idx - m.pos) / m.len));
      return m.start + frac * (m.end - m.start);
    };

    // 全角句号后面通常不跟空格，所以单独判
    const hasPunct = /[。！？]|[.!?]["'’”)\]]?(\s|$)/.test(full.slice(0, 4000));
    /* 给翻译请求带上。用「有没有标点」而不是「是不是 asr 轨」来判断：
       有些自动字幕带标点（不需要额外提示），有些人工上传的反而不带（需要）。 */
    st.noPunct = !hasPunct;

    // 1. 先切成句子（无标点的自动字幕退回按 cue 边界分组）
    let pieces = [];
    if (hasPunct) {
      /* 半角句点只有在后面跟着空白（或者到头了）时才算句子结束。
       * 以前是见点就断，于是 GPT-4.5 被切成 "GPT-4." + "5"、$3.50 切成 "$3." + "50"、
       * Python 3.12 切成 "Python 3." + "12" —— 科技访谈里版本号和价格满地都是。切坏的
       * 半截既照原样显示在屏幕上、也照原样发给模型翻，而且第 3 步合并短句时会在接缝处
       * 补一个空格（"GPT-4. 5"），原文哈希跟着变，缓存也一起弄脏。
       * 全角句号本来就不跟空格，照旧见点就断。
       *
       * 写法上不能给旧正则挂个 lookahead 了事：旧正则靠开头那段 [^.!?…。！？]* 保证两次
       * 匹配首尾相接，一旦某个点因为不满足条件被跳过，它前面那段文字就会掉在两次匹配
       * 之间被无声丢掉。所以改成只扫标点本身，自己拿 last 游标接住中间的文字。 */
      const re = /[.!?…。！？]+["'’”)\]」』】]*/g;
      let m, last = 0;
      while ((m = re.exec(full)) !== null) {
        const e = m.index + m[0].length;
        const cjkStop = /[…。！？]/.test(m[0]);
        if (!cjkStop && e < full.length && !/\s/.test(full[e])) continue;   // 小数点、版本号
        pieces.push({ s: last, e });
        last = e;
      }
      if (last < full.length && full.slice(last).trim()) pieces.push({ s: last, e: full.length });
    } else {
      /* 自动字幕没有标点。以前这里拿 cue 边界当句子边界 —— 可 cue 边界只是
       * 「每两三个词换一屏」的显示节奏，跟语义毫无关系，于是每一句都被切在
       * 半截上（"so the question I keep coming" / "back to is what intelligence
       * really"），模型只能照着半截短语硬翻，而系统提示又明令禁止它跨行搬运语义。
       *
       * 改成只在「真的停顿了」的地方断开：前面已经把重叠的 cue 时长削平，
       * 滚动字幕的相邻 cue 因此严格首尾相接，gap 只会出现在真实的静音处。
       * 断不开的长句交给下面第 2 步，它会优先切在 and / because / so 这些
       * 连词前，比按显示节奏乱切近得多。 */
      const PAUSE = 0.45;
      let s0 = marks[0].pos, prevEnd = marks[0].end;
      for (let i = 1; i < marks.length; i++) {
        const mk = marks[i];
        if (mk.start - prevEnd > PAUSE) {
          const prev = marks[i - 1];
          pieces.push({ s: s0, e: prev.pos + prev.len });
          s0 = mk.pos;
        }
        prevEnd = mk.end;
      }
      pieces.push({ s: s0, e: full.length });
    }

    /* 1.5 静音处一律断开，跟这条轨有没有标点无关。
     * 上面按标点切句有个前提：句末真的有标点。说话人拖长音收尾、或者自动字幕漏掉
     * 那个句号时，一个「句子」就会横跨几十秒静音 —— 它的 start 落在静音之前，于是
     * 整段静音里屏幕上挂着的，是后面才说出口的下一段对白。无标点那条分支已经按
     * 停顿切过了，这里再拿一个更宽的阈值兜住有标点的轨：2 秒以上的空档，正常语句
     * 内部不会出现，出现了就一定是真的没人说话。 */
    const HOLE = 2;
    const holes = [];                       // 静音之后那条 cue 的起始字符位置
    for (let i = 1; i < marks.length; i++) {
      if (marks[i].start - marks[i - 1].end > HOLE) holes.push(marks[i].pos);
    }
    if (holes.length) {
      const broken = [];
      for (const p of pieces) {
        let s0 = p.s;
        for (const h of holes) {
          if (h > s0 && h < p.e) { broken.push({ s: s0, e: h }); s0 = h; }
        }
        broken.push({ s: s0, e: p.e });
      }
      pieces = broken;
    }

    // 2. 只有真的过长才切，而且尽量只在强标点处切。
    //    在连词/空格处切会造出半截片段，译文必然要跨行调语序，
    //    模型就会把好几行并成一句塞进第一行、后面留空 —— 中英不同步就是这么来的。
    const split = [];
    for (const p of pieces) {
      let s = p.s;
      while (widthOf(s, p.e) > HARD_MAX) {
        const stop = advance(s, HARD_MAX);        // 这一刀最远能切到哪
        const win = full.slice(s, stop);
        const floorIdx = advance(s, HARD_MAX * 0.3) - s;   // 太靠前的位置不切
        let cut = -1;

        // 逗号 / 分号 / 破折号之后 —— 语义完整，译文不会跨界。
        // 拉丁标点要求后面跟空格（免得切进 "1,000"），全角标点本来就不带空格。
        const punct = win.match(/^.*(?:[,;:—–]\s|[，、；：])/);
        if (punct && punct[0].length > floorIdx) cut = punct[0].length;

        // 没有标点可切时才退而求其次，让连词起下一句（只对有空格的语言有效）
        if (cut < 0) {
          const re = /\s(and|but|so|because|which|that|when|if|though|while)\s/gi;
          let mm, best = -1;
          while ((mm = re.exec(win)) !== null) {
            if (mm.index + 1 > floorIdx) best = mm.index + 1;
            re.lastIndex = mm.index + 1;
          }
          if (best > 0) cut = best;
        }

        if (cut < 0) {
          const sp = win.lastIndexOf(' ');
          if (sp > floorIdx) cut = sp + 1;
        }
        // 中日韩没有空格可依，最后只能按宽度硬切
        if (cut <= 0) cut = Math.max(1, stop - s);
        split.push({ s, e: s + cut });
        s += cut;
      }
      if (p.e > s) split.push({ s, e: p.e });
    }

    // 3. 太短的往后并，直到读得舒服为止
    const out = [];
    let cur = null;
    for (const p of split) {
      const ps = skipL(p.s, p.e), pe = skipR(p.s, p.e);
      const text = full.slice(ps, pe).trim();
      if (!text) continue;
      const start = timeAt(ps), end = timeAt(pe);
      if (!cur) { cur = { start, end, text }; continue; }
      const joiner = (isWide(cur.text[cur.text.length - 1]) && isWide(text[0])) ? '' : ' ';
      const merged = wid(cur.text) + wid(joiner) + wid(text);
      if (wid(cur.text) < MIN_CHARS &&
          merged <= SOFT_MAX &&
          (start - cur.end) <= GAP &&
          (end - cur.start) <= MAX_DUR) {
        cur.text += joiner + text;
        cur.end = end;
      } else {
        out.push(cur);
        cur = { start, end, text };
      }
    }
    if (cur) out.push(cur);

    const segs = out
      .map((s, i) => ({ id: i, start: s.start, end: s.end, text: s.text.replace(/\s+/g, ' ').trim() }))
      .filter((s) => s.text);

    // 一句留在屏幕上直到下一句开始（静音处最多多留 1.2 秒），
    // 免得译文一闪就没、给人「中文比英文快」的错觉
    for (let i = 0; i < segs.length; i++) {
      const next = segs[i + 1];
      const cap = segs[i].end + 1.2;
      segs[i].end = next ? Math.min(next.start, cap) : cap;
      if (segs[i].end <= segs[i].start) segs[i].end = segs[i].start + 0.7;
    }
    segs.forEach((s, i) => { s.id = i; });
    return segs;
  }

  /* 批次越大越省：那 250 token 的系统提示是按「次」付的，一批装的句子多一倍，
   * 摊到每句就少一半；而且同一批里模型能看见更多上下文，术语和语气反而更稳。
   *
   * 唯一的代价是错位风险 —— 行数一多，模型更容易把相邻两句并成一句，那一批就得
   * 整个作废重来，反而更贵。所以不写死，从用户设的档位起步，连续几批没出问题
   * 就往上加，一出问题立刻回落并且封顶，不再试那一档。 */
  const BATCH_TIERS = [1, 1.5, 2];
  const TIER_PROMOTE_AFTER = 3;   // 连续这么多批毫无瑕疵，才敢加大

  function tierLimits() {
    const k = BATCH_TIERS[Math.min(st.batchTier, BATCH_TIERS.length - 1)] || 1;
    return {
      chars: Math.max(200, Math.round(S.batchChars * k)),
      lines: Math.max(4, Math.round(S.batchLines * k))
    };
  }

  /** 切出 [from, 末尾] 这一段的批次。from 省略就是整条重切。 */
  function makeBatches(segments, from) {
    const lim = tierLimits();
    const batches = [];
    let start = from || 0, chars = 0, count = 0;
    for (let i = start; i < segments.length; i++) {
      chars += wid(segments[i].text);
      count += 1;
      const last = i === segments.length - 1;
      if (last || chars >= lim.chars || count >= lim.lines) {
        batches.push({ from: start, to: i, state: 'idle' });
        start = i + 1; chars = 0; count = 0;
      }
    }
    return batches;
  }

  /* 换档之后重切还没翻的那一截。
   *
   * 只动「后面全是 idle」的那条尾巴：done 的边界一改，applyCacheToAll 之外
   * 就没人知道它翻过了；run 的更不能动，在途结果按 id 回填，边界变了会对不上。
   * 译文和缓存都是按句子 id / 原文哈希存的，跟批次边界无关，所以重切是安全的。 */
  function rebuildTail() {
    let k = st.batches.length;
    while (k > 0 && st.batches[k - 1].state === 'idle') k--;
    if (k >= st.batches.length) return;        // 没有可以重切的尾巴
    const from = st.batches[k].from;
    st.batches.length = k;
    for (const b of makeBatches(st.segments, from)) {
      let done = true;
      for (let j = b.from; j <= b.to; j++) if (!st.trans.has(j)) { done = false; break; }
      if (done) b.state = 'done';              // 整批都在缓存里
      st.batches.push(b);
    }
  }

  /* 连着这么多批错位，才认定「这一档真的不行」并永久封顶。
   *
   * 原来是一次就封。可封顶的代价极不对称：档位是每个视频从 0 重新起步的，tier 已经
   * 是 0 时再出一次错位，这个视频就锁死在 20 句/批 —— 按真实档位逻辑算，两小时的
   * 访谈会从 33 次请求涨到 62 次，光固定开销就多烧约一万五千 token。而模型偶尔把
   * 相邻两句并成一句本来就是常态，单次错位远不足以判死刑。
   *
   * 回落仍然是一次就回落（那一步便宜又可逆），放宽的只是「永远不再试」这个判决。 */
  const DIRTY_BEFORE_CEIL = 2;

  function resetTier() {
    st.batchTier = 0;
    st.batchCeil = BATCH_TIERS.length - 1;
    st.batchClean = 0;
    st.batchDirty = 0;
  }

  /**
   * 一批回来之后调整档位。
   *   bad   —— 出现了错位（后端拆过块，或有行到底也没翻出来）
   *   clean —— 一次就整整齐齐，没补翻也没拆块
   * 网络错误、401、超时跟批次大小无关，两个都传 false，档位不动。
   */
  function noteBatchResult(bad, clean) {
    if (bad) {
      st.batchClean = 0;
      if (st.batchTier > 0) st.batchTier--;
      // 连着第二次才封顶。中间只要有一批干净的，前一次就当它是偶发，既往不咎
      if (++st.batchDirty >= DIRTY_BEFORE_CEIL) st.batchCeil = Math.min(st.batchCeil, st.batchTier);
      rebuildTail();
      return;
    }
    if (!clean) { st.batchClean = 0; return; }
    st.batchDirty = 0;
    if (st.batchTier >= st.batchCeil) return;
    if (++st.batchClean < TIER_PROMOTE_AFTER) return;
    st.batchClean = 0;
    st.batchTier++;
    rebuildTail();
  }

  /* ------------------------------------------------------------------ *
   * 缓存
   * ------------------------------------------------------------------ */
  /* 凡是会改变译文内容的设置都要进缓存键，否则换了服务商、提示词或推理档位之后
   * 还会命中上一套配置的结果。目标语言用解析后的值，'auto' 在不同浏览器语言下不会串。 */
  function cacheSig() {
    const base = String(S.baseUrl || '').trim();
    return [
      S.model || '',
      targetCode() || S.targetLang || '',
      base.endsWith('/') ? base.slice(0, -1) : base,
      S.reasoning || '',
      S.reasoningStyle || '',
      String(S.temperature === null || S.temperature === undefined ? '' : S.temperature),
      String(S.maxTokens === null || S.maxTokens === undefined ? '' : S.maxTokens),
      S.useContext ? 'ctx2' : '',
      String(S.extraPrompt || '').trim()
    ].join('|');
  }

  function cacheKey(videoId) {
    return 'c_' + videoId + '_' + hash(cacheSig());
  }

  /* 索引（{ 缓存键: 最后使用时间 }）的读-改-写交给 background 排队执行，不在这儿
   * 直接动 storage：同时开着几个 YouTube 标签页时，两边各读一份旧索引、各写回自己
   * 那份，后写的把先写的整个盖掉 —— 丢了索引的那些缓存正文从此没人清理（淘汰只
   * 遍历索引里的键），存储只增不减。 */
  async function cacheIndexOp(op, key, prune) {
    try { await chrome.runtime.sendMessage({ type: 'cacheIndex', payload: { op, key, prune } }); } catch (_) {}
  }
  const touchIndex = (key) => cacheIndexOp('touch', key);

  async function loadCache(videoId) {
    if (!S.useCache) { st.cache = { items: {} }; return; }
    try {
      const k = cacheKey(videoId);
      const got = await chrome.storage.local.get(k);
      st.cache = got[k] && got[k].items ? got[k] : { items: {}, ts: Date.now() };
      // 重看也算「用过」，否则常看的视频反而会被当成旧数据淘汰掉
      await touchIndex(k);
    } catch (_) { st.cache = { items: {} }; }
  }

  const saveCache = debounce(async () => {
    if (!S.useCache || !st.videoId || !st.cache || !st.cacheDirty) return;
    st.cacheDirty = false;
    try {
      const k = cacheKey(st.videoId);
      st.cache.ts = Date.now();
      await chrome.storage.local.set({ [k]: st.cache });
      // 顺手让 background 淘汰过期和超量的缓存，正好在同一次索引读写里做掉
      await cacheIndexOp('touch', k, { days: Number(S.cacheDays) || 60, max: Number(S.cacheMax) || 300 });
    } catch (_) {}
  }, 4000);

  function cacheGet(text) {
    if (!S.useCache || !st.cache) return null;
    return st.cache.items[hash(text)] || null;
  }
  function cachePut(text, tr) {
    if (!S.useCache || !st.cache) return;
    st.cache.items[hash(text)] = tr;
    st.cacheDirty = true;
    saveCache();
  }

  /* ------------------------------------------------------------------ *
   * 翻译调度
   * ------------------------------------------------------------------ */
  function applyCacheToAll() {
    let hit = 0;
    for (const seg of st.segments) {
      const c = cacheGet(seg.text);
      if (c) { st.trans.set(seg.id, c); hit++; }
    }
    // 整批命中的直接标记完成
    for (const b of st.batches) {
      let done = true;
      for (let i = b.from; i <= b.to; i++) if (!st.trans.has(i)) { done = false; break; }
      if (done) b.state = 'done';
    }
    return hit;
  }

  /* ------------------------------------------------------------------ *
   * 采用视频自带的译文轨
   *
   * 视频自带一条目标语言的人工字幕时，那就是一份现成的译文：拿来贴到我们自己的
   * 句子上，字幕框、双语、字体、拖动、选中复制全都照旧，只是「译文」这一半不再
   * 来自模型 —— 一个 token 都不花。
   * ------------------------------------------------------------------ */

  /** 至少要贴住这么多比例的句子才认。自带轨只覆盖了片头几分钟、或者时间轴对不上
   *  的时候，与其让一多半的句子只剩原文，不如老老实实自己翻 —— 正常的自带轨
   *  贴合率在 95% 以上，够不到这条线的基本都是不能用的轨。 */
  const ADOPT_MIN_COVER = 0.75;

  function maybeAdopt() {
    if (st.adoptState !== 'pending' || !st.adoptLang) return;
    if (!st.segments.length || st.adoptReq) return;
    st.adoptReq = ++st.reqSeq;
    post2page('fetchTrack', { reqId: st.adoptReq, exact: true, lang: st.adoptLang, kind: '', tlang: '' });
    /* 拉不回来就别让用户干等着一屏原文：到点还没回应就当没有这条轨，照常自己翻。 */
    setTimeout(() => {
      if (st.adoptReq && st.adoptState === 'pending') {
        st.adoptReq = 0;
        st.adoptState = 'off';
        if (st.active) { schedule(); updateStatus(); }
      }
    }, 6000);
  }

  function onAdoptBody(data) {
    st.adoptReq = 0;
    const body = data.body;
    const cues = body.trim().startsWith('<') ? parseXml(body) : (parseJson3(body) || parseXml(body));
    if (!cues || !cues.length) { adoptFailed(); return; }
    // 对齐用的是只往前走的双指针，先按时间排一遍，乱序的轨不至于错配
    st.adoptCues = cues.slice().sort((a, b) => a.start - b.start);
    const cover = applyAdopted();
    if (cover < ADOPT_MIN_COVER) { st.adoptCues = null; adoptFailed(); return; }
    st.adoptState = 'on';
    if (st.active) render();
    updateStatus();
  }

  /** 收回从自带轨贴进去的译文（覆盖率不够，改回自己翻） */
  function dropAdopted() {
    if (!st.adoptIds.size) return;
    for (const id of st.adoptIds) st.trans.delete(id);
    st.adoptIds = new Set();
    /* 贴的时候可能盖掉了缓存里已经买过的译文，这里原样还回来，
       免得回退之后又为同一句付一次钱。顺带把批次状态重新算对。 */
    applyCacheToAll();
    for (const b of st.batches) {
      if (b.state !== 'done') continue;
      for (let i = b.from; i <= b.to; i++) if (!st.trans.has(i)) { b.state = 'idle'; break; }
    }
  }

  function adoptFailed() {
    dropAdopted();
    st.adoptState = 'off';
    if (st.active) { schedule(); updateStatus(); }
  }

  /* 把自带的那条轨按时间贴到我们自己的句子上。
   *
   * 两条轨的 cue 边界几乎不可能一致（一条按原文断句，一条按译文断句），所以按
   * 「这条 cue 的时间大部分落在哪一句里」归属，一条 cue 只算给一句 —— 否则同一行
   * 中文会在相邻两句里各出现一遍。落不到任何一句上的 cue 就丢掉，一句都没分到的
   * 句子只显示原文（跟模型没给出译文时的表现一致）。
   *
   * 返回贴住了多少比例的句子，给上面那道覆盖率闸门用。 */
  function applyAdopted() {
    const segs = st.segments;
    if (!st.adoptCues || !segs.length) return 0;

    const buckets = new Map();
    let si = 0;
    for (const c of st.adoptCues) {
      const text = decodeEntities(c.text || '').replace(/\s+/g, ' ').trim();
      if (!text || /^\[[^\]]*\]$/.test(text)) continue;      // [音乐] 这类提示音不要
      while (si < segs.length - 1 && segs[si].end <= c.start) si++;
      let best = -1, bestOv = 0;
      for (let j = si; j < segs.length && segs[j].start < c.end; j++) {
        const ov = Math.min(segs[j].end, c.end) - Math.max(segs[j].start, c.start);
        if (ov > bestOv) { bestOv = ov; best = j; }
      }
      if (best < 0) continue;
      const arr = buckets.get(segs[best].id);
      if (arr) arr.push(text); else buckets.set(segs[best].id, [text]);
    }

    const added = new Set();
    for (const [id, list] of buckets) {
      // 中日韩之间不补空格，否则会在词中间插进空隙（跟 buildSegments 同一条规矩）
      const joined = list.reduce((a, t) =>
        a + (a && !(isWide(a[a.length - 1]) && isWide(t[0])) ? ' ' : '') + t, '');
      st.trans.set(id, joined);
      added.add(id);
      st.dropped.delete(id);
    }
    st.adoptIds = added;
    // 贴过译文的批次不用再翻
    for (const b of st.batches) {
      let done = true;
      for (let i = b.from; i <= b.to; i++) if (!st.trans.has(i)) { done = false; break; }
      if (done) b.state = 'done';
    }
    return buckets.size / segs.length;
  }

  /* 播放头一次跳过这么多句，就认定是拖进度条／连按方向键，而不是正常播放 */
  const SEEK_JUMP = 5;
  /* 跳完之后等这么久没有再跳，才真的开始翻 */
  const SEEK_SETTLE = 1200;

  function schedule() {
    if (!st.active || !st.segments.length || !settingsReady) return;
    /* 自带译文轨还在取（pending）或者已经用上（on）：一个请求都不该发。
       pending 时不拦住的话，等它回来这几批就白翻了，钱已经花掉。 */
    if (st.adoptState === 'pending' || st.adoptState === 'on') return;
    /* 还在拖动中：一个请求都不发。
     *
     * 以前 render 里播放头一换句就立刻 schedule，而拖进度条时播放头会连续落在
     * 十几个位置上，每个落点都按 concurrency 发满请求 —— 用户从头拖到尾，
     * 整条视频就被零零散散翻了一遍，而他一句都没看。
     *
     * 顺序播放时 curIdx 每次只 +1，跳变判定不成立，走不到这里。 */
    if (st.settleAt && Date.now() < st.settleAt) return;
    st.settleAt = 0;
    const idx = st.curIdx >= 0 ? st.curIdx : 0;
    const limit = idx + Math.max(5, S.lookahead);

    const candidates = st.batches
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.state === 'idle' && b.to >= idx - 2 && b.from <= limit)
      .sort((a, b) => a.b.from - b.b.from);

    while (st.running < Math.max(1, S.concurrency) && candidates.length) {
      const { b, i } = candidates.shift();
      runBatch(i);
    }
    updateStatus();
  }

  /* 往前、往后各多数几句当参考。这里只管备齐候选，真正发多少由 background 按
   * 字符预算裁 —— 句子长短差得很远，按句数卡预算卡不准。 */
  const CTX_PREV_LINES = 6;
  const CTX_NEXT_LINES = 4;

  async function runBatch(bi) {
    const b = st.batches[bi];
    if (!b || b.state !== 'idle') return;
    const epoch = st.epoch;      // 记下这批属于哪一版，回来时核对
    b.state = 'run';
    st.running++;
    st.status = 'translating';
    renderStatusChip();

    /* 送出去之前先摘两类不必花钱的行：
     * 1. 缓存里已经有的 —— 访谈里「Right.」「Exactly.」这类短句整段视频反复出现，
     *    翻过一次就不用再送（applyCacheToAll 只在载入时跑一次，接不到本次会话新写入的）；
     * 2. 同一批里原文完全相同的 —— 只送一条，回来后写给所有相同的行。 */
    const lines = [];
    const firstOf = new Map();   // 原文 -> 已排进 lines 的那一行 id
    const alias = new Map();     // 被合并掉的行 id -> 代表行 id
    for (let i = b.from; i <= b.to; i++) {
      const seg = st.segments[i];
      if (!seg) continue;
      if (st.trans.has(i)) continue;

      const cached = cacheGet(seg.text);
      if (cached) { st.trans.set(i, cached); st.dropped.delete(i); continue; }

      const rep = firstOf.get(seg.text);
      if (rep !== undefined) { alias.set(i, rep); continue; }
      firstOf.set(seg.text, i);
      lines.push({ id: i, text: seg.text });
    }

    if (!lines.length) { b.state = 'done'; st.running--; schedule(); return; }

    /* 参考上下文。以前只带前一句原文，可访谈里前一句很可能就是「Right.」，等于
     * 没带；批尾那一句更是整批里唯一看不见下文的一行，无标点的轨按停顿切，它
     * 很可能是半截话。
     *
     * 所以两头都给：前面连译文一起给（模型看见自己上一批把 agent 译成了什么，
     * 术语和人称才跨批一致），后面只给原文，它们还没翻。这里只管备齐候选 ——
     * 裁多少、有标点的轨要不要发后文，都由 background 的 refBlocks 决定。 */
    const prev = [], next = [];
    if (S.useContext) {
      for (let i = Math.max(0, b.from - CTX_PREV_LINES); i < b.from; i++) {
        const seg = st.segments[i];
        if (seg) prev.push({ text: seg.text, tr: st.trans.get(i) || '' });
      }
      const end = Math.min(st.segments.length - 1, b.to + CTX_NEXT_LINES);
      for (let i = b.to + 1; i <= end; i++) {
        const seg = st.segments[i];
        if (seg) next.push(seg.text);
      }
    }

    let res = null, err = '';
    try {
      res = await chrome.runtime.sendMessage({
        type: 'translateBatch',
        payload: { lines, prev, next, title: st.title, sourceLang: st.sourceLang, noPunct: st.noPunct }
      });
    } catch (e) {
      err = String((e && e.message) || e);
    }

    st.running--;   // 名额先还回去，不管这批还算不算数

    /* 等待期间切了视频、改了模型/目标语言、或重新切过句：这批结果已经不对应当前状态。
     * 直接丢弃 —— 尤其不能写缓存，st.segments 可能已经是另一个视频的，
     * 那会把旧视频的译文按新视频的原文哈希存起来，重看时永久错乱。 */
    if (epoch !== st.epoch) return;

    if (err) {
      b.state = 'err';
      st.error = err;
      noteBatchResult(false, false);   // 网络层的错，跟批次大小无关
    } else if (res && res.ok) {
      /* split > 0 = 后端因为错位对半重来过；dropped 非空 = 有行到底也没翻出来。
       * 两者都说明这一批给大了。repaired > 0 是模型留了空、补翻救回来了，
       * 对齐没坏，但也不算干净，只是不再往上加档。 */
      noteBatchResult(
        Number(res.split || 0) > 0 || (res.dropped && res.dropped.length > 0),
        !res.split && !(res.dropped && res.dropped.length) && !res.repaired
      );
      let got = 0;
      for (const k in res.map) {
        const id = Number(k);
        const tr = String(res.map[k] || '').trim();
        if (!tr) continue;
        st.trans.set(id, tr);
        st.dropped.delete(id);
        const seg = st.segments[id];
        if (seg) cachePut(seg.text, tr);
        got++;
      }
      // 批内被合并掉的重复行，跟着代表行一起填上
      for (const [id, repId] of alias) {
        const tr = st.trans.get(repId);
        if (tr) { st.trans.set(id, tr); st.dropped.delete(id); got++; }
      }
      // 补翻之后仍然没回来的行：不再干等，直接只显示原文
      for (const id of (res.dropped || [])) st.dropped.add(Number(id));
      if (got) {
        b.state = 'done';
        st.error = '';
      } else {
        // 整批错位时后端不会进补翻，会返回 ok 但空 map。
        // 这里必须留下错误信息，否则状态会显示「已就绪」而 popup 也不给重试入口。
        b.state = 'err';
        st.error = '这一批模型没给出可用的译文，可以点重试';
      }
    } else {
      b.state = 'err';
      st.error = (res && res.error) || '翻译失败';
      // 整批失败：只有拆到底还在错位才算批次太大，401/超时之类不算
      noteBatchResult(Number((res && res.split) || 0) > 0, false);
    }

    render();
    updateStatus();
    schedule();
  }

  function retryErrors() {
    for (const b of st.batches) if (b.state === 'err') b.state = 'idle';

    // 补翻后仍然缺译文的行所在的批次，也再给一次机会
    if (st.dropped.size) {
      for (const b of st.batches) {
        if (b.state !== 'idle') {
          for (const id of st.dropped) {
            if (id >= b.from && id <= b.to) { b.state = 'idle'; break; }
          }
        }
      }
      st.dropped = new Set();
    }
    st.error = '';
    schedule();
  }

  /* 丢掉这个视频的缓存，从零重翻。
   *
   * 错位的译文是按「原文哈希 -> 译文」存下来的，刷新页面只会原样命中同一份错位结果，
   * 重试按钮也救不回来（runBatch 看到 st.trans 里已经有了就直接跳过这一行）。
   * 这是唯一的出口。 */
  async function purgeCache() {
    st.epoch++;                 // 在途请求作废，别把旧结果又写回来
    st.trans = new Map();
    st.dropped = new Set();
    st.cache = { items: {} };
    st.cacheDirty = false;
    st.error = '';
    resetTier();
    st.batches = st.segments.length ? makeBatches(st.segments) : [];
    st.curIdx = -1;
    st.settleAt = 0;
    if (st.videoId) {
      try {
        const k = cacheKey(st.videoId);
        await chrome.storage.local.remove(k);
        await cacheIndexOp('forget', k);
      } catch (_) {}
    }
    render();
    updateStatus();
    schedule();
  }

  function updateStatus() {
    if (!st.active) { st.status = 'idle'; }
    else if (!st.segments.length) { st.status = st.status === 'nosub' ? 'nosub' : 'waiting'; }
    else if (st.running > 0) { st.status = 'translating'; }
    else if (st.error) { st.status = 'error'; }
    else { st.status = 'ready'; }
    renderStatusChip();
  }

  /* ------------------------------------------------------------------ *
   * 叠加层渲染
   * ------------------------------------------------------------------ */
  let overlay = null, box = null, elOrig = null, elTrans = null, chip = null, sizeWatcher = null;

  function ensureOverlay() {
    const player = getPlayerEl();
    if (!player) return null;
    if (overlay && overlay.isConnected && overlay.parentElement === player) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'ytst-overlay';
    overlay.innerHTML =
      '<div class="ytst-box">' +
      '<div class="ytst-grip" title="拖动移动字幕 · 双击复位"></div>' +
      '<div class="ytst-edge ytst-edge-l" title="拖动调整字幕框宽度 · 双击复位"></div>' +
      '<div class="ytst-edge ytst-edge-r" title="拖动调整字幕框宽度 · 双击复位"></div>' +
      '<div class="ytst-orig"></div>' +
      '<div class="ytst-trans"></div>' +
      '</div>';
    player.appendChild(overlay);
    box = overlay.querySelector('.ytst-box');
    elOrig = overlay.querySelector('.ytst-orig');
    elTrans = overlay.querySelector('.ytst-trans');
    wireBox();

    // 全屏 / 剧场模式 / 拖窗口时字号跟着画面变
    try {
      if (sizeWatcher) sizeWatcher.disconnect();
      sizeWatcher = new ResizeObserver(() => applyScale());
      sizeWatcher.observe(player);
    } catch (_) {}

    applyStyleVars();
    return overlay;
  }

  function applyStyleVars() {
    if (!overlay) return;
    overlay.style.setProperty('--ytst-size', S.fontSize + 'px');
    overlay.style.setProperty('--ytst-orig-size', Math.round(S.fontSize * S.origScale) + 'px');
    const bg = Math.max(0, Number(S.bgOpacity) || 0);
    overlay.style.setProperty('--ytst-bg', 'rgba(0,0,0,' + bg + ')');
    // 完全透明时要连毛玻璃一起关，见 overlay.css 里的 .ytst-no-bg
    overlay.classList.toggle('ytst-no-bg', bg <= 0);
    overlay.style.setProperty('--ytst-maxw', (S.maxWidth || 88) + '%');
    overlay.style.setProperty('--ytst-font', FONT_STACKS[S.fontFamily] || FONT_STACKS.serif);
    overlay.classList.toggle('ytst-trans-only', S.layout === 'transOnly');

    const custom = typeof S.posX === 'number' && typeof S.posY === 'number';
    overlay.classList.toggle('ytst-custom', custom);
    if (custom) {
      overlay.style.setProperty('--ytst-x', S.posX + '%');
      overlay.style.setProperty('--ytst-y', S.posY + '%');
    }
    applyScale();
  }

  /* 字号跟着画面走：小窗口按设定值，全屏/大屏成比例放大。
   * 只放大不缩小，所以滑块上的数字始终是「最小会是多大」。 */
  function applyScale() {
    if (!overlay) return;
    const p = getPlayerEl();
    if (!p) return;
    const h = p.clientHeight || 0;
    const k = (S.autoScale === false || !h) ? 1 : clamp(h / 620, 1, 2.8);
    overlay.style.setProperty('--ytst-scale', k.toFixed(3));
    lastBottom = -1;    // 画面尺寸变了，控制栏高度重新量
    fitWidth();
  }

  function removeOverlay() {
    if (sizeWatcher) { try { sizeWatcher.disconnect(); } catch (_) {} sizeWatcher = null; }
    if (overlay) { overlay.remove(); overlay = null; box = null; elOrig = null; elTrans = null; }
  }

  /* ---------- 拖动 + 选中 ---------- */
  function wireBox() {
    if (!box) return;

    // 字幕框内的点击不该穿透到播放器（否则点一下就暂停/全屏了）
    ['mousedown', 'click', 'dblclick', 'mouseup'].forEach((ev) => {
      box.addEventListener(ev, (e) => e.stopPropagation());
    });

    const grip = box.querySelector('.ytst-grip');
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      persistPos(null, null);
    });

    /* ---- 左右边缘：调整字幕框宽度 ---- */
    const edges = [...box.querySelectorAll('.ytst-edge')];
    let resize = null;

    edges.forEach((edge) => {
      edge.addEventListener('dblclick', (e) => {
        e.preventDefault();
        persistWidth(DEFAULTS.maxWidth);
      });
      edge.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const player = getPlayerEl();
        if (!player) return;
        const pr = player.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        // 框是绕锚点居中的，缩放过程中中心不动，所以只记一次
        resize = { pr, cx: br.left + br.width / 2 };
        edge.setPointerCapture(e.pointerId);
        overlay.classList.add('ytst-resizing');
        e.preventDefault();
        e.stopPropagation();
      });
      edge.addEventListener('pointermove', (e) => {
        if (!resize) return;
        const half = Math.abs(e.clientX - resize.cx);
        const pct = clamp((half * 2 / resize.pr.width) * 100, 20, 96);
        overlay.style.setProperty('--ytst-maxw', pct.toFixed(1) + '%');
        // 拖动时让框实际展开到这个宽度，边缘才跟得住光标；松手后再收回贴合内容
        box.style.width = Math.round(resize.pr.width * pct / 100) + 'px';
        resize.pct = pct;
        e.stopPropagation();
      });
      const endResize = (e) => {
        if (!resize) return;
        try { edge.releasePointerCapture(e.pointerId); } catch (_) {}
        overlay.classList.remove('ytst-resizing');
        if (typeof resize.pct === 'number') persistWidth(Math.round(resize.pct));
        resize = null;
        fitWidth();   // 收回到贴合内容的宽度，刚才拖出来的只是上限
      };
      edge.addEventListener('pointerup', endResize);
      edge.addEventListener('pointercancel', endResize);
    });

    let drag = null;
    const onDown = (e) => {
      // 只从手柄或字幕框的空白处起拖，正文留给文本选中
      if (e.button !== 0) return;
      if (e.target !== grip && e.target !== box) return;
      const player = getPlayerEl();
      if (!player) return;
      const pr = player.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      drag = {
        pr,
        dx: e.clientX - (br.left + br.width / 2),
        dy: e.clientY - (br.top + br.height / 2)
      };
      box.setPointerCapture(e.pointerId);
      overlay.classList.add('ytst-dragging');
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!drag) return;
      const cx = e.clientX - drag.dx - drag.pr.left;
      const cy = e.clientY - drag.dy - drag.pr.top;
      const x = clamp((cx / drag.pr.width) * 100, 6, 94);
      const y = clamp((cy / drag.pr.height) * 100, 6, 94);
      overlay.classList.add('ytst-custom');
      overlay.style.setProperty('--ytst-x', x.toFixed(2) + '%');
      overlay.style.setProperty('--ytst-y', y.toFixed(2) + '%');
      drag.x = x; drag.y = y;
    };

    const onUp = (e) => {
      if (!drag) return;
      try { box.releasePointerCapture(e.pointerId); } catch (_) {}
      overlay.classList.remove('ytst-dragging');
      if (typeof drag.x === 'number') persistPos(drag.x, drag.y);
      drag = null;
    };

    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  async function persistPos(x, y) {
    S.posX = x; S.posY = y;
    applyStyleVars();
    await patchSettings({ posX: x, posY: y });
  }

  async function persistWidth(pct) {
    S.maxWidth = pct;
    applyStyleVars();
    await patchSettings({ maxWidth: pct });
  }

  /* 只把改动合进已存的那份，不把 DEFAULTS 一起写进去 ——
   * 否则用户从没碰过的默认值会被固化成显式设置，以后版本改默认值也推不到老用户。 */
  async function patchSettings(patch) {
    try {
      const got = await chrome.storage.local.get('settings');
      const next = Object.assign({}, got.settings || {}, patch);
      await chrome.storage.local.set({ settings: next });
    } catch (_) {}
  }

  /** 正在框内选中文字时冻结字幕，方便复制 */
  function selectionInBox() {
    if (!box) return false;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    let n = sel.anchorNode;
    if (!n) return false;
    if (n.nodeType !== 1) n = n.parentNode;
    return !!(n && box.contains(n));
  }

  function setText(el, text) {
    if (el.textContent === text) return false;   // 不无谓重写，否则选中会被清掉
    el.textContent = text;
    return true;
  }

  /* ---------- 宽度贴合实际折行结果 ---------- */
  /* CSS 的 max-content 是按「不折行时的宽度」算的：英文长句折了两行，
   * 框却仍然按最长那一行撑到上限，中文短句左右就空出一大片黑边。
   * 这里量一下真正渲染出来的每一行有多宽，按最宽的那行收紧。 */
  function widestLine(el) {
    if (!el || !el.textContent || !el.offsetParent) return 0;
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      let m = 0;
      for (const rect of r.getClientRects()) m = Math.max(m, rect.width);
      return m;
    } catch (_) { return 0; }
  }

  function fitWidth() {
    if (!box) return;
    const cs = getComputedStyle(box);
    const extra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
                  parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);

    box.style.width = '';   // 先让它按 max-content + max-width 正常排一次
    // 两轮：收紧后 text-wrap:balance 可能重新断行，再量一次就收敛了
    for (let i = 0; i < 2; i++) {
      const w = Math.max(widestLine(elOrig), widestLine(elTrans));
      if (w <= 0) return;
      const next = Math.ceil(w + extra + 1);
      if (i > 0 && Math.abs(next - parseFloat(box.style.width || '0')) < 2) break;
      box.style.width = next + 'px';
    }
  }

  /* ---------- 别被底部控制栏压住 ---------- */
  let lastBottom = -1;
  function applyLayout() {
    if (!overlay || !box) return;
    const player = getPlayerEl();
    if (!player) return;

    const bar = player.querySelector('.ytp-chrome-bottom');
    const barShown = bar && !player.classList.contains('ytp-autohide');
    const barH = barShown ? bar.getBoundingClientRect().height : 0;
    const bottom = Math.round(barH + 14);

    if (bottom !== lastBottom) {
      lastBottom = bottom;
      overlay.style.setProperty('--ytst-bottom', bottom + 'px');
    }

    // 拖到自定义位置时改用位移把它顶上去，位置本身不改，控制栏收起后会落回原处
    if (!overlay.classList.contains('ytst-custom')) {
      overlay.style.setProperty('--ytst-lift', '0px');
      return;
    }
    const pr = player.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const cur = parseFloat(overlay.style.getPropertyValue('--ytst-lift')) || 0;
    const over = br.bottom - (pr.bottom - bottom);
    const next = clamp(cur + over, 0, pr.height * 0.6);
    if (Math.abs(next - cur) > 1) overlay.style.setProperty('--ytst-lift', Math.round(next) + 'px');
  }

  function findIndex(t) {
    const segs = st.segments;
    if (!segs.length) return -1;
    // 就近线性查找（播放通常是顺序的），失败再二分
    let i = st.curIdx;
    if (i >= 0 && i < segs.length) {
      const stop = Math.min(segs.length, i + 6);
      /* 先按严格区间找。buildSegments 已经把每句的 end 拉到了下一句的 start，句子之间
       * 首尾相接 —— 带着容差从前往后扫，播放头进入下一句之后的 0.35 秒里上一句仍然满足
       * 条件、还会先命中，于是顺序播放时每一次换句都固定晚半拍。 */
      for (let k = i; k < stop; k++) {
        if (t >= segs[k].start && t < segs[k].end) return k;
      }
      // 严格区间里没有：这才轮到容差，它本来就是给句子之间的空隙用的
      for (let k = i; k < stop; k++) {
        if (t >= segs[k].start - 0.15 && t < segs[k].end + 0.35) return k;
      }
    }
    let lo = 0, hi = segs.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start - 0.15 <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best >= 0 && t < segs[best].end + 0.35) return best;
    return -1;
  }

  function render() {
    if (!st.active) { removeOverlay(); return; }
    const v = getVideo();
    const player = getPlayerEl();
    if (!v || !player) return;
    if (!ensureOverlay()) return;

    // 广告期间不显示
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      overlay.classList.add('ytst-hidden');
      return;
    }
    overlay.classList.remove('ytst-hidden');

    const idx = findIndex(v.currentTime);
    if (idx !== st.curIdx) {
      // 跳着走的先记下时刻、不调度；顺着走的照旧立刻调度
      const jumped = st.curIdx >= 0 && idx >= 0 && Math.abs(idx - st.curIdx) > SEEK_JUMP;
      st.curIdx = idx;
      if (jumped) st.settleAt = Date.now() + SEEK_SETTLE;
      else schedule();
    } else if (st.settleAt && Date.now() >= st.settleAt) {
      schedule();   // 停稳了，补上这一次
    }

    // 正在选中框内文字时不刷新内容，让你把这句复制走
    const frozen = selectionInBox();
    overlay.classList.toggle('ytst-frozen', frozen);
    if (frozen) { overlay.classList.remove('ytst-empty'); return; }

    if (idx < 0) {
      setText(elOrig, '');
      setText(elTrans, '');
      overlay.classList.add('ytst-empty');
      return;
    }
    overlay.classList.remove('ytst-empty');

    const seg = st.segments[idx];
    const tr = st.trans.get(idx);
    let changed = setText(elOrig, seg.text);

    if (tr) {
      changed = setText(elTrans, tr) || changed;
      elTrans.classList.remove('ytst-pending');
      overlay.classList.remove('ytst-no-trans');
    } else if (st.dropped.has(idx)) {
      // 模型两次都没给这一行译文，与其挂着省略号，不如干脆只显示原文
      changed = setText(elTrans, '') || changed;
      elTrans.classList.remove('ytst-pending');
      overlay.classList.add('ytst-no-trans');
    } else {
      changed = setText(elTrans, st.error ? '· 翻译出错，点插件图标查看 ·' : '···') || changed;
      elTrans.classList.add('ytst-pending');
      overlay.classList.remove('ytst-no-trans');
    }

    if (changed) fitWidth();
    applyLayout();
  }

  /* 状态小圆点（在播放器按钮上） */
  function renderStatusChip() {
    if (!chip) return;
    chip.dataset.state = st.status;
  }

  /* ------------------------------------------------------------------ *
   * 播放器按钮
   * ------------------------------------------------------------------ */
  function ensureButton() {
    const right = document.querySelector('#movie_player .ytp-right-controls');
    if (!right) return;
    let btn = right.querySelector('.ytst-btn');
    if (btn && btn.isConnected) { syncButton(); return; }

    btn = document.createElement('button');
    btn.className = 'ytp-button ytst-btn';
    btn.title = '双语字幕翻译 (Alt+Shift+T)';
    btn.innerHTML = '<span class="ytst-btn-label">译</span><span class="ytst-dot"></span>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    const settings = right.querySelector('.ytp-settings-button');
    if (settings) right.insertBefore(btn, settings); else right.insertBefore(btn, right.firstChild);
    chip = btn.querySelector('.ytst-dot');
    syncButton();
  }

  function syncButton() {
    const btn = document.querySelector('#movie_player .ytst-btn');
    if (!btn) return;
    btn.classList.toggle('ytst-on', st.active);
    chip = btn.querySelector('.ytst-dot');
    renderStatusChip();
  }

  /* ------------------------------------------------------------------ *
   * 开关
   * ------------------------------------------------------------------ */
  function toggle() { st.active ? stop(true) : start(); }

  async function start() {
    // 只回写这一个字段：直接写整个 S 会把本文件的 DEFAULTS 固化进存储，
    // 把用户从没选过的默认值（尤其 targetLang）变成显式设置
    if (!S.enabled) {
      S.enabled = true;
      await patchSettings({ enabled: true });
    }
    st.active = true;
    st.userOff = false;
    st.settleAt = 0;
    document.documentElement.classList.toggle('ytst-hide-native', !!S.hideNative);
    syncButton();
    if (!st.segments.length) requestTrack();
    else { maybeAdopt(); schedule(); render(); }
    updateStatus();
  }

  function stop(byUser) {
    st.active = false;
    if (byUser) st.userOff = true;
    document.documentElement.classList.remove('ytst-hide-native');
    /* 兜底取字幕时我们替用户打开过原生字幕 —— 翻译开着的时候它被 ytst-hide-native
     * 藏着，看不出来；一旦关掉翻译就凭空冒出一条用户自己没开过的字幕，而且从来没人
     * 负责关。inject.js 那边记着动手前的状态，这里让它原样还回去。 */
    if (st.nativeOn) { st.nativeOn = false; post2page('disableNative'); }
    removeOverlay();
    syncButton();
    updateStatus();
  }

  function requestTrack() {
    /* 原来是「一个视频只许要一次」。可失败的路子太多了 —— 字幕轨列表比播放器信息晚到、
     * 直接拉取被 YouTube 拒了、兜底打开原生字幕时播放器还没装好 captions 模块。
     * 一旦撞上，这个标签页就永远停在「等字幕」，只能重开浏览器。
     * 改成隔一段时间可以重来一次，直到真的拿到句子为止。 */
    if (st.trackRequested && Date.now() - st.trackAt < 8000) return;
    if (st.segments.length) return;
    st.trackRequested = true;
    st.trackAt = Date.now();
    st.fallbackTried = false;
    st.status = 'waiting';
    renderStatusChip();
    /* 两种情况都带编号。播放器可能正在同时拉另一条轨（账号开了自动翻译、
     * 或者视频默认轨不是原声语言），先到先得的话我们会拿「译文的译文」当原文翻，
     * 而且从此再也换不回来。带上编号，我们点名要的那条就能盖过它。 */
    st.wantReq = ++st.reqSeq;
    // 用户已经在 CC 菜单里选好语言了就照办，别再按音轨去猜
    if (st.userTrack) {
      st.wantLang = sigLang(capSig(st.userTrack));
      post2page('fetchTrack', trackReq(st.userTrack, st.wantReq));
    } else {
      st.wantLang = '';        // 没指定具体语言，页面挑哪条都认
      post2page('fetchTrack', { reqId: st.wantReq, lang: st.sourceLang || '' });
    }
    // 直接拉取失败/无响应时的兜底
    setTimeout(() => {
      if (st.active && !st.segments.length && !st.fallbackTried) {
        st.fallbackTried = true;
        st.nativeOn = true;
        post2page('enableNative', { lang: st.sourceLang || '' });
      }
    }, 3500);
  }

  /* ------------------------------------------------------------------ *
   * 视频切换
   * ------------------------------------------------------------------ */
  function resetVideo(data) {
    saveCacheNow();
    st.epoch++;                       // 在途的旧请求从此作废
    st.videoId = data.videoId;
    st.title = data.title || '';
    st.audioLang = data.audioLang || '';
    st.audioDubbed = false;
    st.tracks = data.tracks || [];
    st.adoptLang = '';
    st.adoptState = '';
    st.adoptCues = null;
    st.adoptReq = 0;
    st.adoptIds = new Set();
    st.rawCues = null;
    st.segments = [];
    st.trans = new Map();
    st.dropped = new Set();
    resetTier();
    st.batches = [];
    st.curIdx = -1;
    st.settleAt = 0;
    st.error = '';
    st.status = 'idle';
    st.trackRequested = false;
    st.trackAt = 0;
    st.fallbackTried = false;
    st.userOff = false;
    st.trackSig = '';
    st.wantReq = 0;
    st.wantLang = '';
    st.userTrack = null;
    st.cache = null;
    removeOverlay();

    stop(false);
    evaluateTracks();
  }

  /* 按当前 st.tracks 定原声语言、定是否需要翻译，并决定要不要自动开始。
   * 单独抽出来是因为字幕轨可能比第一份播放器信息晚到 —— 那时必须重跑这一整套，
   * 只更新 st.tracks 会让视频永远停在「无字幕」。 */
  function evaluateTracks() {
    /* 设置还没读回来：先记一笔，等 boot 读完再判。
     * 拿 DEFAULTS 判出来的结论没人会去纠正，将错就错的代价比等这几十毫秒大得多。 */
    if (!settingsReady) { pendingEval = true; return; }
    const pick = chooseTrack(st.tracks, st.audioLang);
    // 用户在 CC 菜单里指定过语言就听他的，别再按音轨去猜
    const chosen = st.userTrack ? sigLang(capSig(st.userTrack)) : '';
    st.sourceLang = chosen || (pick ? pick.spoken : '');
    const tgt = targetCode();
    /* 听的是什么语言比字幕轨是什么语言更有发言权：多音轨视频可能正放着中文配音，
       而字幕轨列表里挂的还是英文 ASR。音轨认得出来就以音轨为准。 */
    const audioIsTarget = !!st.audioLang && sameLang(st.audioLang, tgt);
    // 认不出目标语言时（自定义写法）就照翻，别自作主张跳过
    st.needsTranslation = !!pick && !audioIsTarget && !sameLang(st.sourceLang, tgt);

    /* 视频自带目标语言的人工字幕轨：那就是一份现成的译文，没有理由再花钱翻一遍。
       换视频、换目标语言、字幕轨列表变了都会重算，所以这里只在结论变了时重置。 */
    const adopt = st.needsTranslation ? pickTargetTrack(st.tracks, tgt) : '';
    if (adopt !== st.adoptLang) {
      st.adoptLang = adopt;
      st.adoptState = adopt ? 'pending' : '';
      st.adoptCues = null;
      st.adoptReq = 0;
    }

    if (!st.tracks.length) {
      if (!st.active) { st.status = 'nosub'; renderStatusChip(); }
      return;
    }
    if (st.status === 'nosub') st.status = 'idle';

    if (!st.active && !st.userOff && S.enabled && S.autoStart && st.needsTranslation) start();
    else updateStatus();
  }

  /* 换音轨。多音轨视频（尤其 YouTube 的 AI 自动配音）常常一上来就给一条配音轨，
   * 听着别扭；用户在播放器里换回原声，我们得跟着重判：音轨已经是目标语言就没什么
   * 可翻的，换回外语就该接着翻。 */
  function onAudioTrack(a) {
    if (!a || !a.lang) return;
    const same = sameLang(a.lang, st.audioLang);
    st.audioLang = a.lang;
    st.audioDubbed = !!a.dubbed;
    /* 音轨轮询从页面一加载就开始跑，很可能赶在设置读回来之前。
       那会儿 targetCode() 还是 DEFAULTS 算出来的，判出来的结论没人纠正。 */
    if (!settingsReady) { pendingEval = true; return; }
    if (same) { updateStatus(); return; }   // 只是变体不同（en → en-US），不折腾

    if (sameLang(a.lang, targetCode())) {
      /* 换到了目标语言的音轨（多半是配音）：正在翻的停下，别再花钱。
         stop(false) —— 不算用户关的，等他换回外语音轨我们还要自己开回来。 */
      st.needsTranslation = false;
      if (st.active) stop(false); else updateStatus();
      return;
    }
    evaluateTracks();       // 换回外语：重新判一遍，autoStart 会把翻译接上
  }

  function saveCacheNow() {
    if (S.useCache && st.videoId && st.cache && st.cacheDirty) {
      const k = cacheKey(st.videoId);
      st.cache.ts = Date.now();
      st.cacheDirty = false;
      try { chrome.storage.local.set({ [k]: st.cache }); touchIndex(k); } catch (_) {}
    }
  }

  /* 一条字幕轨的身份：语言 | 是否自动字幕 | 自动翻译到哪个语言。
   * 同一条轨不管从哪条路回来都必须算出同一个签名，否则会来回切 ——
   * 我们自己发起的那次请求，会同时以 direct 和 fetch 劫持两种身份回来两遍。 */
  function trackSigOf(data) {
    const url = data && data.url;
    if (url) {
      try {
        const q = new URL(url, location.href).searchParams;
        const lang = q.get('lang') || '';
        const tlang = q.get('tlang') || '';
        if (lang || tlang) return lang + '|' + (q.get('kind') || '') + '|' + tlang;
      } catch (_) {}
    }
    if (data && data.languageCode) return data.languageCode + '|' + (data.kind || '') + '|';
    return '';
  }

  const capSig = (c) => (c.languageCode || '') + '|' + (c.kind || '') + '|' + (c.tlang || '');
  /** 这条轨最终呈现的是哪种语言：自动翻译轨看 tlang，其余看 lang */
  const sigLang = (sig) => { const p = String(sig).split('|'); return p[2] || p[0] || ''; };
  const trackReq = (c, reqId) =>
    ({ reqId, exact: true, lang: c.languageCode || '', kind: c.kind || '', tlang: c.tlang || '' });

  /* 这份字幕到底属于哪个视频。播放器自己发的请求不经过我们，inject.js 只能从
   * 字幕地址里的 v= 认出来；认不出来的就当成来路不明，宁可不要。 */
  function trackVideoOf(data) {
    if (data && data.videoId) return data.videoId;
    try {
      if (data && data.url) return new URL(data.url, location.href).searchParams.get('v') || '';
    } catch (_) {}
    return '';
  }

  /* 用户在 CC 菜单里换了语言。播放器有时会直接用自己缓存的字幕、不再发网络请求，
   * 光靠 inject.js 的劫持会漏掉，所以这里点名去要一次。 */
  function onCaptionTrack(cap) {
    if (!cap || !cap.languageCode) return;
    st.userTrack = cap;                      // 之后 requestTrack 也跟着他的选择走
    if (capSig(cap) === st.trackSig) return; // 已经在用这条轨了
    /* 首份字幕还在路上时换语言，同样要按新选择重新点名。原来这里直接 return，
     * 指望交给 requestTrack()，可它因为 trackRequested 已置位不会再跑第二次 ——
     * 结果在途的旧请求照样落地，用户刚选的语言被无声丢掉。 */
    if (!st.active && !st.segments.length) return;
    st.wantReq = ++st.reqSeq;
    st.wantLang = sigLang(capSig(cap));
    post2page('fetchTrack', trackReq(cap, st.wantReq));
  }

  async function onTrackBody(data) {
    const body = data && data.body;
    // 字幕体是异步取回来的，可能属于上一个视频（YouTube 是单页应用，切视频时
    // 上一个视频的字幕请求还在路上）。挂错视频会串片、还会污染缓存。
    const vid = trackVideoOf(data);
    if (st.videoId && vid !== st.videoId) return;
    if (!body || typeof body !== 'string') return;

    /* 自带译文轨的回应。它跟原文轨是两码事，绝不能走下面那套换轨逻辑 ——
       否则会把中文轨当成新的原文轨用上。 */
    if (data.reqId && data.reqId === st.adoptReq) { onAdoptBody(data); return; }

    const sig = trackSigOf(data);
    /* 换轨。原来这里是无条件 `if (st.segments.length) return`，
     * 于是用户在 YouTube 里换了字幕语言之后，翻译框还挂着上一条轨的内容。
     *
     * 但也不能来一份换一份：只认我们点名要的那一次回应。播放器自己发的字幕请求
     * ——预加载、失败重试、上一个视频的迟到响应——都不带这个编号，
     * 于是绝不会被误判成换轨、白白清空译文再重翻一遍。 */
    const switching = st.segments.length > 0;
    if (switching) {
      if (sig && sig === st.trackSig) return;   // 已经在用这条轨了，别白重来一轮
      if (!(data.reqId && data.reqId === st.wantReq)) return;
      /* 回来的语言得跟点名要的对得上。inject.js 那边已经不会拿别的轨来顶了，
       * 这里再核一道：宁可维持现状，也别把用户选的德语翻成日语。
       * 地区变体不计较（pt-BR 收到 pt 算数），只看主语言。 */
      if (st.wantLang && !sameLang(sigLang(sig), st.wantLang)) { st.wantReq = 0; return; }
    }

    const cues = body.trim().startsWith('<') ? parseXml(body) : (parseJson3(body) || parseXml(body));
    if (!cues || !cues.length) return;

    if (switching) {
      st.epoch++;              // 在途请求带的是旧轨的 segment id，必须作废
      st.trans = new Map();
      st.dropped = new Set();
      st.curIdx = -1;
      st.settleAt = 0;
      st.error = '';
    }
    st.trackSig = sig;
    /* 只有「我们点名要的那一份」才算把这次点名了结。先顶上来的那条（播放器自己拉的）
     * 不能把请求勾销，否则我们要的那条随后到达时会被自己的闸门挡在门外。 */
    if (data.reqId && data.reqId === st.wantReq) { st.wantReq = 0; st.wantLang = ''; }

    // 原声语言以实际拿到的这条轨为准，提示词里才不会写错源语言
    const lang = sigLang(sig);
    if (lang) {
      st.sourceLang = lang;
      st.needsTranslation = !sameLang(lang, targetCode());
    }

    st.rawCues = cues;                       // 留着，改字幕长度档位时不用重新拉字幕
    st.segments = buildSegments(cues);
    if (!st.segments.length) { st.status = 'nosub'; renderStatusChip(); return; }
    resetTier();
    st.batches = makeBatches(st.segments);

    /* 用户挑的这条轨本来就是目标语言（比如直接选了中文字幕）：再翻一遍既费钱、
     * 显示出来还是两行一样的字。让位给 YouTube 自己的字幕就好。 */
    if (switching && st.active && !st.needsTranslation) {
      st.adoptLang = '';                 // 都让位了，就别再去取那条译文轨
      st.adoptState = '';
      st.adoptCues = null;
      st.adoptReq = 0;
      stop(false);
      return;
    }
    maybeAdopt();          // 有现成译文轨就去取，取到之前 schedule 不会发请求

    const epoch = st.epoch;
    await loadCache(st.videoId);
    if (epoch !== st.epoch) return;          // 读缓存期间又切了视频
    applyCacheToAll();

    if (st.active) { schedule(); render(); }
    updateStatus();
  }

  /** 改了字幕长度档位后重新切句。缓存按原文哈希存，没变的句子仍然直接命中，不会重复花钱。 */
  function resegment() {
    if (!st.rawCues || !st.rawCues.length) return;
    st.epoch++;              // 分段变了，在途请求带的是旧 segment id，必须作废
    st.segments = buildSegments(st.rawCues);
    st.trans = new Map();
    st.dropped = new Set();
    resetTier();
    st.batches = makeBatches(st.segments);
    st.curIdx = -1;
    st.settleAt = 0;
    st.adoptIds = new Set();
    applyCacheToAll();
    if (st.adoptState === 'on') applyAdopted();   // 句子边界变了，重新贴一遍
    if (st.active) { schedule(); render(); }
    updateStatus();
  }

  /* ------------------------------------------------------------------ *
   * 事件接线
   * ------------------------------------------------------------------ */
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.ns !== NS || m.dir !== 'p2c') return;

    if (m.type === 'player') {
      const d = m.data || {};
      if (!d.videoId) return;
      if (d.videoId !== st.videoId) resetVideo(d);
      else if (d.tracks && d.tracks.length !== st.tracks.length) {
        // 字幕轨比第一份播放器信息晚到（常见于刚上传或长视频）：
        // 光更新数组不够，语言判定、状态、自动开始都得重来一遍
        st.tracks = d.tracks;
        if (!st.audioLang && d.audioLang) st.audioLang = d.audioLang;
        evaluateTracks();
      }
    } else if (m.type === 'track') {
      onTrackBody(m.data);
    } else if (m.type === 'captiontrack') {
      onCaptionTrack(m.data);
    } else if (m.type === 'audiotrack') {
      onAudioTrack(m.data);
    } else if (m.type === 'trackfail') {
      // 点名要的那条轨没找到：维持现在这条，别退回去翻成另一种语言
      if (m.data && m.data.reqId && m.data.reqId === st.wantReq) {
        st.wantReq = 0;
        st.wantLang = '';
        if (st.segments.length) return;
      }
      if (st.active && !st.fallbackTried) {
        st.fallbackTried = true;
        st.nativeOn = true;
        post2page('enableNative', { lang: st.sourceLang || '' });
      }
    }
  });

  /* 渲染循环：跟着 requestAnimationFrame 走，节流到 ~8fps */
  let lastPaint = 0;
  function loop(ts) {
    if (ts - lastPaint > 120) {
      lastPaint = ts;
      try { if (st.active) render(); } catch (_) {}
    }
    requestAnimationFrame(loop);
  }

  const observeUi = () => {
    try { ensureButton(); } catch (_) {}
  };

  /* popup 通信 */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'getStatus') {
      sendResponse({
        onYoutube: true,
        videoId: st.videoId,
        title: st.title,
        sourceLang: st.sourceLang,
        audioLang: st.audioLang,
        audioDubbed: st.audioDubbed,
        adopted: st.adoptState === 'on' ? st.adoptLang : '',
        trackLang: sigLang(st.trackSig),
        trackKind: String(st.trackSig).split('|')[1] || '',
        trackList: st.tracks.map((t) => ({ lang: t.languageCode, kind: t.kind })),
        needsTranslation: st.needsTranslation,
        active: st.active,
        status: st.status,
        error: st.error,
        segments: st.segments.length,
        translated: st.trans.size,
        hasTracks: st.tracks.length > 0
      });
      return true;
    }
    if (msg.type === 'toggle') { toggle(); sendResponse({ ok: true, active: st.active }); return true; }
    if (msg.type === 'setActive') { msg.value ? start() : stop(true); sendResponse({ ok: true }); return true; }
    if (msg.type === 'retry') { retryErrors(); sendResponse({ ok: true }); return true; }
    if (msg.type === 'purgeCache') { purgeCache().then(() => sendResponse({ ok: true })); return true; }
    if (msg.type === 'settingsChanged') {
      chrome.storage.local.get('settings')
        .then((got) => applySettings(got.settings))
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
  });

  async function loadSettings() {
    try {
      const got = await chrome.storage.local.get('settings');
      S = Object.assign({}, DEFAULTS, got.settings || {});
    } catch (_) {}
  }

  /* 改了会改变译文内容的设置：已有译文和在途请求都不能留 */
  const OUTPUT_KEYS = ['model', 'targetLang', 'baseUrl', 'extraPrompt',
                       'reasoning', 'reasoningStyle', 'temperature', 'maxTokens', 'useContext'];
  /* 只影响怎么分批，译文本身不变，保留已翻好的部分 */
  const BATCH_KEYS = ['batchChars', 'batchLines'];

  /* 设置变更只走这一条路径。设置页会同时触发 storage.onChanged 和 settingsChanged 消息，
   * 两边都进这里；第二次进来时新旧值已经相同，只会重刷样式，不会重复作废译文。 */
  async function applySettings(raw) {
    const old = S;
    S = Object.assign({}, DEFAULTS, raw || {});
    const wasReady = settingsReady;
    settingsReady = true;
    // boot 还没读完就先收到了设置变更：挂起的语言/自动开启判定现在就能做了
    if (!wasReady && (pendingEval || st.videoId)) { pendingEval = false; evaluateTracks(); }

    applyStyleVars();
    document.documentElement.classList.toggle('ytst-hide-native', st.active && !!S.hideNative);

    if (!S.enabled) { stop(false); return; }

    if (S.density !== old.density) { resegment(); return; }   // 内部已经作废并重建

    if (OUTPUT_KEYS.some((k) => S[k] !== old[k])) { await invalidateTranslations(); return; }

    if (st.segments.length && BATCH_KEYS.some((k) => S[k] !== old[k])) {
      resetTier();            // 用户重新设了基准，之前压下去的档位不算数了
      st.batches = makeBatches(st.segments);
      applyCacheToAll();
    }
    render();
    schedule();
  }

  /* 换了模型 / 目标语言 / 提示词之后：作废在途请求和已有译文，按新的缓存键重新来过。
   * 不这么做的话，一段字幕会前半截是旧语言、后半截是新语言，
   * 而且旧请求回来还会写进新配置对应的缓存。 */
  async function invalidateTranslations() {
    st.epoch++;                 // 在途请求回来会被 runBatch 的守卫丢掉
    st.trans = new Map();
    st.dropped = new Set();
    st.error = '';
    st.cacheDirty = false;      // 没落盘的旧译文属于旧配置，别写了
    st.cache = null;
    resetTier();
    st.batches = st.segments.length ? makeBatches(st.segments) : [];

    /* 目标语言可能刚被改掉：自带译文轨得重新认一次。不重置的话，adoptState 会
       停在 on/pending 上把 schedule 一直闸着 —— 译文刚被清空，又永远不会重翻。 */
    st.adoptLang = '';
    st.adoptState = '';
    st.adoptCues = null;
    st.adoptReq = 0;
    st.adoptIds = new Set();
    evaluateTracks();

    if (st.videoId && st.segments.length) {
      const epoch = st.epoch;
      await loadCache(st.videoId);
      if (epoch !== st.epoch) return;
      applyCacheToAll();
    }
    maybeAdopt();
    render();
    updateStatus();
    schedule();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    applySettings(changes.settings.newValue);
  });

  window.addEventListener('beforeunload', saveCacheNow);

  // 测试用出口：只有测试桩会预先把这个键设成对象，页面里永远是 undefined
  if (window.__YTST_TEST__) Object.assign(window.__YTST_TEST__,
    { buildSegments, parseJson3, findIndex, st, applyAdopted, pickTargetTrack, onAudioTrack, evaluateTracks });

  /* 一直问到问出来为止。
   *
   * 以前是「boot 时探一次 + 每次 SPA 导航探一次」，inject.js 那边也只轮询 12×600ms。
   * 冷刷新时播放器如果 7 秒内没就绪（网速慢、前贴片广告、storage 变大拖慢了启动），
   * 这两条路就一起走完了，之后再没有任何人去问，页面就永久停在「没有字幕」——
   * 只能靠站内跳到另一个视频、或者重开浏览器才恢复。 */
  function keepProbing() {
    let n = 0;
    const iv = setInterval(() => {
      if (st.videoId && st.tracks.length) { clearInterval(iv); return; }
      post2page('probe');
      // 前 30 秒每秒问一次，之后降到 5 秒一次，一直陪到底
      if (++n === 30) { clearInterval(iv); setInterval(() => { if (!st.videoId || !st.tracks.length) post2page('probe'); }, 5000); }
    }, 1000);
  }

  (async function boot() {
    /* 先注入。inject.js 要赶在播放器自己去拉字幕之前把 fetch/XHR 劫持装上，
     * 而 loadSettings 读的是 chrome.storage —— 缓存攒多了它可能要几百毫秒甚至更久，
     * 排在注入前面等于把劫持推迟到播放器之后，首份字幕就截不到了。 */
    inject();
    requestAnimationFrame(loop);
    setInterval(observeUi, 1000);
    setInterval(() => {
      if (!st.active) return;
      schedule();
      // 开着却一句都没拿到：字幕轨也许刚到、也许上次是偶发失败，再要一次
      if (!st.segments.length && st.tracks.length) requestTrack();
    }, 2000);
    document.addEventListener('yt-navigate-finish', () => setTimeout(() => post2page('probe'), 300));
    setTimeout(() => post2page('probe'), 800);
    keepProbing();
    await loadSettings();
    settingsReady = true;
    applyStyleVars();
    if (!S.enabled) { stop(false); return; }
    // 挂起期间来过播放器信息：现在按真正的设置重判一次语言和自动开启
    if (pendingEval || st.videoId) { pendingEval = false; evaluateTracks(); }
    if (st.active) { schedule(); render(); }
  })();
})();
