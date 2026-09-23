/* 运行在 YouTube 页面主世界（MAIN world）。
 * 职责：
 *   1. 劫持 fetch / XHR，截获播放器自己请求的 /api/timedtext 字幕数据
 *   2. 读取 player response 里的字幕轨列表
 *   3. 直接同源拉取字幕轨（首选方案，不改动用户的字幕开关）
 *   4. 必要时兜底：程序化打开原生字幕，让播放器自己去拉，我们从 1 截获
 *   5. 盯住用户在 CC 菜单里选中的那条轨，换语言时通知内容脚本跟上
 */
(() => {
  if (window.__YTST_INJECTED__) return;
  window.__YTST_INJECTED__ = true;

  const NS = 'ytst';

  /* 内容脚本注入我们的时候现生成的随机口令。页面上任何别的脚本都拿不到它
   * （dataset 挂在那个 script 标签上，标签 onload 就删了），所以两边的消息带上它
   * 就能互相认出自己人 —— 防的是页面脚本伪造一条 track 把假字幕塞进来。
   * dataset 读不到就退到地址后面的 #token。 */
  const TOKEN = (() => {
    const el = document.currentScript;
    try {
      if (el && el.dataset && el.dataset.ytstToken) return el.dataset.ytstToken;
      if (el && el.src) return String(el.src).split('#')[1] || '';
    } catch (_) {}
    return '';
  })();

  const post = (type, data) => {
    try { window.postMessage({ ns: NS, dir: 'p2c', type, data, token: TOKEN }, '*'); } catch (_) {}
  };

  /* ---------- 1. 网络劫持 ---------- */
  const isTT = (u) => {
    try { return typeof u === 'string' && u.indexOf('/api/timedtext') !== -1; } catch (_) { return false; }
  };

  /* 字幕地址里自带 v=，那才是这份字幕真正属于哪个视频。
   * 不能拿 location 去猜：劫持是在响应回来时触发的，那会儿地址栏可能已经翻到下一个视频，
   * 迟到的旧字幕就会被盖上新视频的戳，正好骗过内容脚本的核对。 */
  const videoOfUrl = (u) => {
    try { return new URL(u, location.href).searchParams.get('v') || ''; } catch (_) { return ''; }
  };

  /* 最近一次截到「有内容的」字幕是什么时候。兜底打开原生字幕之后靠它判断播放器到底
   * 发没发请求（我们自己直接拉取拿回的空体不算）。 */
  let hookAt = 0;
  const noteHook = (b) => { if (typeof b === 'string' && b.length > 40) hookAt = Date.now(); };

  const origFetch = window.fetch;
  window.fetch = function (input, _init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (isTT(url)) {
        p.then((r) => {
          try {
            r.clone().text().then((b) => {
              noteHook(b);
              post('track', { source: 'hook', url, body: b, videoId: videoOfUrl(url) });
            });
          } catch (_) {}
        }).catch(() => {});
      }
    } catch (_) {}
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__ytstUrl = url; } catch (_) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (isTT(this.__ytstUrl)) {
        this.addEventListener('load', () => {
          try {
            noteHook(this.responseText);
            post('track', {
              source: 'hook', url: this.__ytstUrl, body: this.responseText,
              videoId: videoOfUrl(this.__ytstUrl)
            });
          } catch (_) {}
        });
      }
    } catch (_) {}
    return origSend.apply(this, arguments);
  };

  /* ---------- 2. 播放器信息 ---------- */
  function getPlayer() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  function textOf(n) {
    if (!n) return '';
    if (n.simpleText) return n.simpleText;
    if (n.runs && n.runs[0]) return n.runs[0].text || '';
    return '';
  }

  function collect() {
    const p = getPlayer();
    let pr = null;
    try { if (p && typeof p.getPlayerResponse === 'function') pr = p.getPlayerResponse(); } catch (_) {}
    if (!pr) pr = window.ytInitialPlayerResponse || null;
    if (!pr || !pr.videoDetails) return null;

    const vd = pr.videoDetails || {};
    const tl = (pr.captions && pr.captions.playerCaptionsTracklistRenderer) || {};
    const tracks = (tl.captionTracks || []).map((t) => ({
      languageCode: t.languageCode || '',
      kind: t.kind || '',
      name: textOf(t.name),
      baseUrl: t.baseUrl || ''
    }));

    // 音轨语言（用于判断是不是英文视频）
    let audioLang = '';
    try {
      const fmts = (pr.streamingData && pr.streamingData.adaptiveFormats) || [];
      const withAudio = fmts.find((f) => f.audioTrack && f.audioTrack.id);
      if (withAudio) audioLang = String(withAudio.audioTrack.id).split('.')[0];
    } catch (_) {}

    /* isLive 和 isLiveContent 是两回事：后者对「曾经是直播」的录播也为真，而录播
     * 有字幕、能翻、也该翻。挡的是正在直播的那种 —— 它的字幕轨要么没有，要么是
     * 一边生成一边推的，我们这套「整轨拉下来切句」的做法根本对不上。
     * isUpcoming 是还没开始的首播，同样没有轨可拉。 */
    return {
      videoId: vd.videoId || new URLSearchParams(location.search).get('v') || '',
      title: vd.title || '',
      isLive: !!(vd.isLive || vd.isLiveNow),
      isUpcoming: !!vd.isUpcoming,
      isLiveContent: !!vd.isLiveContent,
      audioLang,
      tracks
    };
  }

  let reported = false;
  function report() {
    const d = collect();
    if (d && d.videoId) {
      // 有字幕轨才算真的问出来了：videoId 常常比 captions 早好几秒出现
      if (d.tracks.length) reported = true;
      post('player', d);
    }
  }

  /* ---------- 2.5 用户当前选中的字幕轨 ---------- */
  /* 光靠网络劫持不够：同一条轨再选回来时，播放器往往直接用自己缓存的字幕，
   * 根本不发请求，我们就永远看不到这次切换。所以直接盯播放器的字幕选项。 */
  function currentCaption() {
    const p = getPlayer();
    if (!p || typeof p.getOption !== 'function') return null;
    let t = null;
    try { t = p.getOption('captions', 'track'); } catch (_) { return null; }
    if (!t || !t.languageCode) return null;              // 关掉字幕时是空对象
    const tl = t.translationLanguage || null;
    return {
      languageCode: t.languageCode || '',
      kind: t.kind || '',
      // 「自动翻译」出来的轨：真正呈现的是这个语言
      tlang: (tl && tl.languageCode) || ''
    };
  }

  const capSig = (c) => (c ? c.languageCode + '|' + c.kind + '|' + c.tlang : '');

  let lastCap = '';
  let quietUntil = 0;       // 我们自己刚动过字幕轨，这段时间里的变化不算用户的选择
  function watchCaption() {
    const c = currentCaption();
    const sig = capSig(c);
    if (sig === lastCap) return;
    lastCap = sig;
    if (Date.now() < quietUntil) return;
    if (c) post('captiontrack', c);
  }

  /* 我们自己动过字幕轨之后调一次，把当前状态记成「已经看过」。
   * 不压住的话 watchCaption 会把这次变化当成用户在 CC 菜单里的选择报上去，内容脚本
   * 从此认定「用户指定了这个语言」，之后所有点名要轨都锁死在这条上 —— 而兜底挑轨
   * 本来就只是猜，猜错了就再也纠正不回来。
   * setOption 未必立刻反映到 getOption 上；读不到新值时这里等于没压住，
   * 那就退回原来的行为，不会更糟。 */
  function markCaptionSeen() {
    lastCap = capSig(currentCaption());
    /* setOption 往往要过一会儿才反映到 getOption 上，光记一下当前值压不住 ——
     * 实测兜底那次切换照样被报成了「用户在菜单里选了英文」。所以再给一段静默期。 */
    quietUntil = Date.now() + 2500;
  }

  /* ---------- 2.6 当前音轨 ---------- */
  /* 多音轨视频（人工配音、YouTube 的 AI 自动配音）可以中途换音轨，而换音轨不会重发
   * player response —— 只能盯着播放器问。getAudioTrack() 返回的对象里有一层压缩过
   * 名字的小对象，形如 {name, id: 'zh-Hans.3', isDefault, isAutoDubbed}；那个键名
   * （写这段时是 j7）每次发版都可能变，所以按字段特征去认，不写死键名。
   * 单音轨视频这里拿到的 id 是 'und'，当成「不知道」，别去覆盖播放器信息里的判断。 */
  const LANG_ID = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)\.\d+$/;

  function audioMeta(t) {
    if (!t || typeof t !== 'object') return null;
    for (const k of Object.keys(t)) {
      const v = t[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          ('isAutoDubbed' in v || 'audioIsDefault' in v || ('id' in v && 'name' in v))) return v;
    }
    return null;
  }

  function currentAudio() {
    const p = getPlayer();
    if (!p || typeof p.getAudioTrack !== 'function') return null;
    let t = null;
    try { t = p.getAudioTrack(); } catch (_) { return null; }
    const meta = audioMeta(t);
    const m = LANG_ID.exec(String((meta && meta.id) || (t && t.id) || ''));
    if (!m) return null;                       // 'und' / 认不出的写法：当作没这回事
    let count = 0;
    try { count = (p.getAvailableAudioTracks() || []).length; } catch (_) {}
    return {
      lang: m[1],
      name: (meta && meta.name) || '',
      dubbed: !!(meta && meta.isAutoDubbed),
      isDefault: !!(meta && (meta.isDefault || meta.audioIsDefault)),
      count
    };
  }

  let lastAudio = '';
  function watchAudio() {
    const a = currentAudio();
    const sig = a ? a.lang + '|' + (a.dubbed ? 'd' : '') : '';
    if (sig === lastAudio) return;
    lastAudio = sig;
    if (a) post('audiotrack', a);
  }

  /* ---------- 2.7 自检 ---------- */
  /* 我们摸的每一样东西都是 YouTube 的内部实现：播放器元素、getPlayerResponse、
   * captions 模块、getAudioTrack、控制栏的类名。它们随时可能在某次发版里换掉，
   * 而坏掉的表现全都一样 —— 字幕永远「正在获取」。用户报障时说不清，我们也查不动。
   *
   * 所以每轮轮询顺手自检一遍，变了就报上去。区分两种：
   *   读不到 player response = 致命，什么都干不了，明确告诉用户「等插件更新」；
   *   其余几样 = 少一样残一点（按钮没了、兜底路走不通、认不出音轨语言），
   *              照常翻，只在诊断信息里留个痕。
   * 判死刑要非常克制。第一版是「问够 12 次（约 7 秒）还读不到就报改版」，结果冷启动
   * 时人人都会先看到一次「YouTube 改版了」，过十几秒又自己消失 —— 播放器本来就可能
   * 二十秒才就绪（慢网、前贴片广告、storage 大了拖慢启动），我们自己的 boot 测试里
   * 就有这么一条用例。一个会自己好的报错比不报还糟：它教用户以后别信这个提示。
   *
   * 现在三个条件同时成立才算坏：
   *   1. 在视频页上（首页、搜索页、频道页上那个悬停预览播放器也匹配 .html5-video-player，
   *      而那些页面本来就没有我们要的 player response —— 那不是坏，是没这回事）；
   *   2. 播放器元素在，可 player response 一直读不出来；
   *   3. 已经等了 WAIT_BEFORE_BROKEN 这么久（比播放器最慢的就绪时间还宽一截）。 */
  const WAIT_BEFORE_BROKEN = 45000;

  let watchSince = Date.now();      // 这一页开始等的时刻，站内跳转会重新起算

  /** 只有真正的视频页才谈得上「读不到播放器数据」 */
  function onVideoPage() {
    try {
      const path = location.pathname;
      if (path === '/watch') return !!new URLSearchParams(location.search).get('v');
      return path.indexOf('/embed/') === 0;
    } catch (_) { return false; }
  }

  function caps() {
    const p = getPlayer();
    const c = {
      player: !!p,
      response: !!collect(),
      captions: !!(p && typeof p.getOption === 'function' && typeof p.setOption === 'function'),
      audio: !!(p && typeof p.getAudioTrack === 'function'),
      controls: !!document.querySelector('#movie_player .ytp-right-controls'),
      bar: !!document.querySelector('#movie_player .ytp-chrome-bottom')
    };
    c.broken = !!(c.player && !c.response && onVideoPage() &&
                  Date.now() - watchSince > WAIT_BEFORE_BROKEN);
    return c;
  }

  let lastCaps = '';
  function watchCaps() {
    const c = caps();
    const sig = JSON.stringify(c);
    if (sig === lastCaps) return;
    lastCaps = sig;
    post('selfcheck', c);
  }

  /* ---------- 3. 直接拉取字幕轨 ---------- */
  /* 不预设任何语言：内容脚本已经判定好原声语言并传进来，
   * 没传就退回「人工轨优先，其次自动字幕」。 */
  function pickTrack(tracks, prefix) {
    if (!tracks || !tracks.length) return null;
    const base = (c) => String(c || '').toLowerCase().split('-')[0];
    /* 没传语言时按自动字幕的语言认原声（跟内容脚本的 chooseTrack 同一个判据）。
     * 直接拿第一条人工轨的话，很多访谈的第一条是志愿者上传的俄语 / 西语译轨，
     * 翻出来就是「译文的译文」。 */
    if (!prefix) {
      const asr = tracks.find((t) => t.kind === 'asr');
      prefix = asr ? asr.languageCode : '';
    }
    if (prefix) {
      const p = base(prefix);
      const hit = (t) => base(t.languageCode) === p;
      const m = tracks.find((t) => hit(t) && t.kind !== 'asr') || tracks.find(hit);
      if (m) return m;
    }
    return tracks.find((t) => t.kind !== 'asr') || tracks[0];
  }

  /* 用户在 CC 菜单里指名了某条轨：语言和「是不是自动字幕」都得对上，
   * 不能像 pickTrack 那样退回「人工轨优先」，否则又把他的选择改回去了。 */
  function exactTrack(tracks, req) {
    if (!tracks || !tracks.length) return null;
    const base = (c) => String(c || '').toLowerCase().split('-')[0];
    const want = base(req.lang);
    const asr = req.kind === 'asr';
    return tracks.find((t) => t.languageCode === req.lang && (t.kind === 'asr') === asr)
        || tracks.find((t) => base(t.languageCode) === want && (t.kind === 'asr') === asr)
        || tracks.find((t) => base(t.languageCode) === want)
        || null;
  }

  async function fetchTrack(req) {
    req = req || {};
    const reqId = req.reqId || 0;          // 原样带回去，内容脚本只认自己点名要的那一次
    const d = collect();
    if (!d) { post('trackfail', { reason: 'no-player-response', reqId }); return; }
    /* 点名要某条轨时找不到就直说。以前这里会 || pickTrack(...) 退回我们自己的猜测，
     * 那等于把用户指定的语言悄悄换成另一种，翻出来的内容驴唇不对马嘴。 */
    const track = req.exact ? exactTrack(d.tracks, req) : pickTrack(d.tracks, req.lang || '');
    if (!track || !track.baseUrl) {
      post('trackfail', { reason: req.exact ? 'no-such-track' : 'no-track', videoId: d.videoId, reqId });
      return;
    }

    try {
      let url = track.baseUrl.replace(/([?&])fmt=[^&]*/g, '$1') + '&fmt=json3';
      // 自动翻译轨：在原轨地址后面加 tlang，YouTube 直接返回翻好的那一版
      if (req.exact && req.tlang) url += '&tlang=' + encodeURIComponent(req.tlang);
      const r = await fetch(url, { credentials: 'include' });
      const body = await r.text();
      if (r.ok && body && body.length > 40) {
        post('track', {
          source: 'direct',
          url,
          body,
          reqId,
          videoId: d.videoId,
          languageCode: track.languageCode,
          kind: track.kind
        });
        return;
      }
    } catch (_) {}
    post('trackfail', { reason: 'fetch-failed', videoId: d.videoId, reqId });
  }

  /* ---------- 4. 兜底：打开原生字幕触发播放器请求 ---------- */
  /* 打开原生字幕是我们自己的动作，用户没要求过 —— 翻译开着的时候它被 CSS 藏起来，
   * 一旦关掉翻译就凭空冒出一条自己没开过的字幕，而且没人负责关。
   * 所以动手之前先记下当时的状态，内容脚本说「不用了」的时候原样还回去。
   * null = 我们没动过；{} = 动之前字幕本来就是关着的。 */
  let nativePrev = null;

  /* tries：冷启动时 captions 模块往往还没装好，tracklist 是空的。以前空了就收手，
   * 可内容脚本那边已经记下「兜底试过了」，要等 8 秒后的整轮重来 —— 字幕框就白空这么久。
   * 所以空的时候隔半秒再看，最多看 10 次。
   * kicks：切过之后播放器也没发请求时，又重来了几次（见下面）。 */
  function enableNative(lang, tries, kicks) {
    const p = getPlayer();
    if (!p) return;
    tries = tries || 0;
    kicks = kicks || 0;
    try {
      if (typeof p.loadModule === 'function') p.loadModule('captions');
      setTimeout(() => {
        let list = [];
        try { list = p.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch (_) {}
        if (!list.length) { try { list = p.getOption('captions', 'tracklist') || []; } catch (_) {} }
        if (!list.length && tries < 10) { enableNative(lang, tries + 1, kicks); return; }
        const t = pickTrack(list, lang || '');
        if (!t) return;
        let cur = null;
        try { cur = p.getOption('captions', 'track'); } catch (_) {}
        if (nativePrev === null) nativePrev = cur && cur.languageCode ? cur : {};
        /* 原生字幕已经开着、而且正是这一条：再 setOption 一遍什么都不会发生。
         * 冷启动时播放器的首份字幕跟着视频流一起下来（SABR），根本不走 timedtext，
         * 劫持就永远等不到东西 —— 而直接拉取又因为缺 PO token 拿回空体，
         * 于是整个视频停在「等字幕」。先关再开，播放器会带着 pot 重新请求一次。 */
        const same = cur && cur.languageCode === t.languageCode && (cur.kind || '') === (t.kind || '');
        const since = Date.now();
        if (same) {
          try { p.setOption('captions', 'track', {}); } catch (_) {}
          setTimeout(() => {
            try { p.setOption('captions', 'track', t); } catch (_) {}
            markCaptionSeen();
          }, 300);
        } else {
          try { p.setOption('captions', 'track', t); } catch (_) {}
        }
        markCaptionSeen();
        /* 页面刚加载的那几秒，关了再开播放器也可能照旧从视频流里取字幕、一个请求都
         * 不发。等一会儿还没截到东西就再切一次，而不是让内容脚本干等 8 秒的整轮重来。
         * 内容脚本已经说了「不用了」（disableNative 把 nativePrev 清掉了）就停。 */
        setTimeout(() => {
          if (nativePrev === null || hookAt >= since || kicks >= 3) return;
          enableNative(lang, 0, kicks + 1);
        }, 2500);
      }, 400);
    } catch (_) {}
  }

  function disableNative() {
    const p = getPlayer();
    // 没动过就别动。用户自己开着的字幕不归我们关
    if (!p || nativePrev === null) return;
    const prev = nativePrev;
    nativePrev = null;
    try { p.setOption('captions', 'track', prev); } catch (_) {}
    markCaptionSeen();
  }

  /* ---------- 消息通道 ---------- */
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.ns !== NS || m.dir !== 'c2p') return;
    if (m.token !== TOKEN) return;      // 不是注入我们的那个内容脚本发的
    if (m.type === 'probe') report();
    else if (m.type === 'fetchTrack') fetchTrack(m.data || {});
    else if (m.type === 'enableNative') enableNative((m.data && m.data.lang) || 'en');
    else if (m.type === 'disableNative') disableNative();
  });

  document.addEventListener('yt-navigate-finish', () => {
    lastCap = ''; lastAudio = ''; lastCaps = ''; reported = false; n = 0;
    watchSince = Date.now();       // 换了一页，等待重新起算
    setTimeout(report, 250);
  });
  document.addEventListener('yt-player-updated', () => setTimeout(report, 250));
  // 播放器换了视频/换了配置，字幕轨列表会跟着变
  document.addEventListener('yt-page-data-updated', () => { reported = false; setTimeout(report, 250); });

  /* 轮询到问出字幕轨为止，不再是固定 12 次就撒手。
   * 冷刷新时播放器可能十几秒才就绪（慢网、前贴片广告），
   * 定量轮询一走完就再没人去问，这个标签页从此永远「没有字幕」。 */
  let n = 0;
  const iv = setInterval(() => {
    report();
    watchCaps();
    // 前 40 次（~24 秒）密集问；之后降频常驻，代价可以忽略
    if (++n >= 40) {
      clearInterval(iv);
      setInterval(() => { if (!reported) { report(); watchCaps(); } }, 3000);
    }
  }, 600);
  report();

  // 字幕选项和音轨都要一直盯着 —— 用户随时可能在播放器里换语言
  setInterval(() => { watchCaption(); watchAudio(); }, 1000);
})();
