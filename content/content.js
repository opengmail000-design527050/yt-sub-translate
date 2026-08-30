/* YT 字幕译 —— 内容脚本（隔离世界）
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

  /** 挑一条最合适的字幕轨，并顺带确定这个视频的原声语言。
   *  自动字幕（ASR）一定是按原声语言生成的，所以它是最可靠的语言判据；
   *  但人工字幕有标点、质量更好，所以同语言时优先用人工轨。 */
  function chooseTrack(tracks, audioLang) {
    if (!tracks || !tracks.length) return null;
    const base = (c) => String(c || '').toLowerCase().split('-')[0];

    const asr = tracks.find((t) => t.kind === 'asr');
    const spoken = (asr && asr.languageCode) || audioLang || tracks[0].languageCode || '';

    const manual = tracks.find((t) => t.kind !== 'asr' && base(t.languageCode) === base(spoken));
    const track = manual || asr || tracks[0];
    return { track, spoken: track.languageCode || spoken };
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

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  const st = {
    videoId: '',
    title: '',
    audioLang: '',
    tracks: [],
    sourceLang: '',          // 自动识别出的原声语言
    needsTranslation: false, // 原声语言与目标语言不同才需要翻
    active: false,           // 当前视频翻译是否开启
    userOff: false,          // 用户在本视频手动关过
    rawCues: null,           // 原始 cue，改字幕长度档位时用来重新切句
    segments: [],            // [{id,start,end,text}]
    trans: new Map(),        // id -> 译文
    dropped: new Set(),      // 补翻后模型仍未给出译文的行，只显示原文
    batches: [],             // [{from,to,state:'idle'|'run'|'done'|'err'}]
    running: 0,
    status: 'idle',          // idle | waiting | ready | translating | error | nosub
    error: '',
    curIdx: -1,
    cache: null,             // { items: {hash: text} }
    cacheDirty: false,
    trackRequested: false,
    fallbackTried: false
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

    // 1. 先切成句子（无标点的自动字幕退回按 cue 边界分组）
    let pieces = [];
    if (hasPunct) {
      const re = /[^.!?…。！？]*[.!?…。！？]+["'’”)\]」』】]*/g;
      let m, last = 0;
      while ((m = re.exec(full)) !== null) {
        const s = m.index, e = m.index + m[0].length;
        if (e > s) pieces.push({ s, e });
        last = e;
      }
      if (last < full.length && full.slice(last).trim()) pieces.push({ s: last, e: full.length });
    } else {
      for (const mk of marks) pieces.push({ s: mk.pos, e: mk.pos + mk.len });
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
      const text = full.slice(p.s, p.e).trim();
      if (!text) continue;
      const start = timeAt(p.s), end = timeAt(p.e);
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

  function makeBatches(segments) {
    const batches = [];
    let from = 0, chars = 0, count = 0;
    for (let i = 0; i < segments.length; i++) {
      chars += wid(segments[i].text);
      count += 1;
      const last = i === segments.length - 1;
      if (last || chars >= S.batchChars || count >= S.batchLines) {
        batches.push({ from, to: i, state: 'idle' });
        from = i + 1; chars = 0; count = 0;
      }
    }
    return batches;
  }

  /* ------------------------------------------------------------------ *
   * 缓存
   * ------------------------------------------------------------------ */
  function cacheKey(videoId) {
    // 用解析后的目标语言，'auto' 在不同浏览器语言下不会串到同一份缓存
    return 'c_' + videoId + '_' + hash((S.model || '') + '|' + (targetCode() || S.targetLang || ''));
  }

  /* 单独维护一份 { key: 最后使用时间 } 索引，这样清理时不用把所有缓存正文读进内存 */
  async function touchIndex(key) {
    try {
      const got = await chrome.storage.local.get('cacheIndex');
      const idx = got.cacheIndex || {};
      idx[key] = Date.now();
      await chrome.storage.local.set({ cacheIndex: idx });
    } catch (_) {}
  }

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
      await touchIndex(k);
      pruneCache();
    } catch (_) {}
  }, 4000);

  async function pruneCache() {
    try {
      const got = await chrome.storage.local.get('cacheIndex');
      const idx = got.cacheIndex || {};
      const days = Number(S.cacheDays) || 60;
      const max = Number(S.cacheMax) || 300;
      const cutoff = Date.now() - days * 86400000;

      let keys = Object.keys(idx);
      const expired = keys.filter((k) => (idx[k] || 0) < cutoff);

      keys = keys.filter((k) => !expired.includes(k)).sort((a, b) => (idx[b] || 0) - (idx[a] || 0));
      const overflow = keys.slice(max);

      const drop = expired.concat(overflow);
      if (!drop.length) return;
      for (const k of drop) delete idx[k];
      await chrome.storage.local.remove(drop);
      await chrome.storage.local.set({ cacheIndex: idx });
    } catch (_) {}
  }

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

  function schedule() {
    if (!st.active || !st.segments.length) return;
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

  async function runBatch(bi) {
    const b = st.batches[bi];
    if (!b || b.state !== 'idle') return;
    b.state = 'run';
    st.running++;
    st.status = 'translating';
    renderStatusChip();

    const lines = [];
    for (let i = b.from; i <= b.to; i++) {
      const seg = st.segments[i];
      if (!seg) continue;
      if (st.trans.has(i)) continue;
      lines.push({ id: i, text: seg.text });
    }

    if (!lines.length) { b.state = 'done'; st.running--; schedule(); return; }

    let context = '';
    if (S.useContext && b.from > 0) {
      const prev = st.segments[b.from - 1];
      if (prev) context = prev.text.slice(-220);
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'translateBatch',
        payload: { lines, context, sourceLang: st.sourceLang }
      });
      if (res && res.ok) {
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
        // 补翻之后仍然没回来的行：不再干等，直接只显示原文
        for (const id of (res.dropped || [])) st.dropped.add(Number(id));
        b.state = got ? 'done' : 'err';
        st.error = '';
      } else {
        b.state = 'err';
        st.error = (res && res.error) || '翻译失败';
      }
    } catch (e) {
      b.state = 'err';
      st.error = String((e && e.message) || e);
    }

    st.running--;
    render();
    updateStatus();
    schedule();
  }

  function retryErrors() {
    for (const b of st.batches) if (b.state === 'err') b.state = 'idle';
    st.error = '';
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
    overlay.style.setProperty('--ytst-bg', 'rgba(0,0,0,' + S.bgOpacity + ')');
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
      for (let k = i; k < Math.min(segs.length, i + 6); k++) {
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
    if (idx !== st.curIdx) { st.curIdx = idx; schedule(); }

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
    document.documentElement.classList.toggle('ytst-hide-native', !!S.hideNative);
    syncButton();
    if (!st.segments.length) requestTrack();
    else { schedule(); render(); }
    updateStatus();
  }

  function stop(byUser) {
    st.active = false;
    if (byUser) st.userOff = true;
    document.documentElement.classList.remove('ytst-hide-native');
    removeOverlay();
    syncButton();
    updateStatus();
  }

  function requestTrack() {
    if (st.trackRequested) return;
    st.trackRequested = true;
    st.status = 'waiting';
    renderStatusChip();
    post2page('fetchTrack', { lang: st.sourceLang || '' });
    // 直接拉取失败/无响应时的兜底
    setTimeout(() => {
      if (st.active && !st.segments.length && !st.fallbackTried) {
        st.fallbackTried = true;
        post2page('enableNative', { lang: st.sourceLang || '' });
      }
    }, 3500);
  }

  /* ------------------------------------------------------------------ *
   * 视频切换
   * ------------------------------------------------------------------ */
  function resetVideo(data) {
    saveCacheNow();
    st.videoId = data.videoId;
    st.title = data.title || '';
    st.audioLang = data.audioLang || '';
    st.tracks = data.tracks || [];
    st.rawCues = null;
    st.segments = [];
    st.trans = new Map();
    st.dropped = new Set();
    st.batches = [];
    st.curIdx = -1;
    st.error = '';
    st.status = 'idle';
    st.trackRequested = false;
    st.fallbackTried = false;
    st.userOff = false;
    st.cache = null;
    removeOverlay();

    const pick = chooseTrack(st.tracks, st.audioLang);
    st.sourceLang = pick ? pick.spoken : '';
    const tgt = targetCode();
    // 认不出目标语言时（自定义写法）就照翻，别自作主张跳过
    st.needsTranslation = !!pick && !sameLang(st.sourceLang, tgt);

    stop(false);

    if (!st.tracks.length) { st.status = 'nosub'; renderStatusChip(); return; }
    if (S.enabled && S.autoStart && st.needsTranslation) start();
  }

  function saveCacheNow() {
    if (S.useCache && st.videoId && st.cache && st.cacheDirty) {
      const k = cacheKey(st.videoId);
      st.cache.ts = Date.now();
      st.cacheDirty = false;
      try { chrome.storage.local.set({ [k]: st.cache }); touchIndex(k); } catch (_) {}
    }
  }

  async function onTrackBody(body) {
    if (st.segments.length) return;
    if (!body || typeof body !== 'string') return;
    const cues = body.trim().startsWith('<') ? parseXml(body) : (parseJson3(body) || parseXml(body));
    if (!cues || !cues.length) return;

    st.rawCues = cues;                       // 留着，改字幕长度档位时不用重新拉字幕
    st.segments = buildSegments(cues);
    if (!st.segments.length) { st.status = 'nosub'; renderStatusChip(); return; }
    st.batches = makeBatches(st.segments);

    await loadCache(st.videoId);
    applyCacheToAll();

    if (st.active) { schedule(); render(); }
    updateStatus();
  }

  /** 改了字幕长度档位后重新切句。缓存按原文哈希存，没变的句子仍然直接命中，不会重复花钱。 */
  function resegment() {
    if (!st.rawCues || !st.rawCues.length) return;
    st.segments = buildSegments(st.rawCues);
    st.trans = new Map();
    st.dropped = new Set();
    st.batches = makeBatches(st.segments);
    st.curIdx = -1;
    applyCacheToAll();
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
      else if (!st.tracks.length && d.tracks && d.tracks.length) st.tracks = d.tracks;
    } else if (m.type === 'track') {
      onTrackBody(m.data && m.data.body);
    } else if (m.type === 'trackfail') {
      if (st.active && !st.fallbackTried) {
        st.fallbackTried = true;
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
    if (msg.type === 'settingsChanged') {
      const oldDensity = S.density;
      loadSettings().then(() => {
        applyStyleVars();
        document.documentElement.classList.toggle('ytst-hide-native', st.active && !!S.hideNative);
        if (!S.enabled) stop(false);
        if (S.density !== oldDensity) resegment();
        render();
        schedule();
        sendResponse({ ok: true });
      });
      return true;
    }
  });

  async function loadSettings() {
    try {
      const got = await chrome.storage.local.get('settings');
      S = Object.assign({}, DEFAULTS, got.settings || {});
    } catch (_) {}
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    S = Object.assign({}, DEFAULTS, changes.settings.newValue || {});
    applyStyleVars();
    document.documentElement.classList.toggle('ytst-hide-native', st.active && !!S.hideNative);
  });

  window.addEventListener('beforeunload', saveCacheNow);

  (async function boot() {
    await loadSettings();
    inject();
    requestAnimationFrame(loop);
    setInterval(observeUi, 1000);
    setInterval(() => { if (st.active) schedule(); }, 2000);
    document.addEventListener('yt-navigate-finish', () => setTimeout(() => post2page('probe'), 300));
    setTimeout(() => post2page('probe'), 800);
  })();
})();
