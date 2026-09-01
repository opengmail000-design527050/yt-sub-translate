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
  const post = (type, data) => {
    try { window.postMessage({ ns: NS, dir: 'p2c', type, data }, '*'); } catch (_) {}
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

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (isTT(url)) {
        p.then((r) => {
          try {
            r.clone().text().then((b) =>
              post('track', { source: 'hook', url, body: b, videoId: videoOfUrl(url) }));
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

    return {
      videoId: vd.videoId || new URLSearchParams(location.search).get('v') || '',
      title: vd.title || '',
      isLive: !!vd.isLiveContent,
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
  function watchCaption() {
    const c = currentCaption();
    const sig = capSig(c);
    if (sig === lastCap) return;
    lastCap = sig;
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

  /* ---------- 3. 直接拉取字幕轨 ---------- */
  /* 不预设任何语言：内容脚本已经判定好原声语言并传进来，
   * 没传就退回「人工轨优先，其次自动字幕」。 */
  function pickTrack(tracks, prefix) {
    if (!tracks || !tracks.length) return null;
    const base = (c) => String(c || '').toLowerCase().split('-')[0];
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

  function enableNative(lang) {
    const p = getPlayer();
    if (!p) return;
    try {
      if (typeof p.loadModule === 'function') p.loadModule('captions');
      setTimeout(() => {
        let list = [];
        try { list = p.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch (_) {}
        if (!list.length) { try { list = p.getOption('captions', 'tracklist') || []; } catch (_) {} }
        const t = pickTrack(list, lang || '');
        if (!t) return;
        if (nativePrev === null) {
          let cur = null;
          try { cur = p.getOption('captions', 'track'); } catch (_) {}
          nativePrev = cur && cur.languageCode ? cur : {};
        }
        try { p.setOption('captions', 'track', t); } catch (_) {}
        markCaptionSeen();
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
    if (m.type === 'probe') report();
    else if (m.type === 'fetchTrack') fetchTrack(m.data || {});
    else if (m.type === 'enableNative') enableNative((m.data && m.data.lang) || 'en');
    else if (m.type === 'disableNative') disableNative();
  });

  document.addEventListener('yt-navigate-finish', () => { lastCap = ''; lastAudio = ''; reported = false; setTimeout(report, 250); });
  document.addEventListener('yt-player-updated', () => setTimeout(report, 250));
  // 播放器换了视频/换了配置，字幕轨列表会跟着变
  document.addEventListener('yt-page-data-updated', () => { reported = false; setTimeout(report, 250); });

  /* 轮询到问出字幕轨为止，不再是固定 12 次就撒手。
   * 冷刷新时播放器可能十几秒才就绪（慢网、前贴片广告），
   * 定量轮询一走完就再没人去问，这个标签页从此永远「没有字幕」。 */
  let n = 0;
  const iv = setInterval(() => {
    report();
    // 前 40 次（~24 秒）密集问；之后降频常驻，代价可以忽略
    if (++n >= 40) {
      clearInterval(iv);
      setInterval(() => { if (!reported) report(); }, 3000);
    }
  }, 600);
  report();

  // 字幕选项和音轨都要一直盯着 —— 用户随时可能在播放器里换语言
  setInterval(() => { watchCaption(); watchAudio(); }, 1000);
})();
