/* 运行在 YouTube 页面主世界（MAIN world）。
 * 职责：
 *   1. 劫持 fetch / XHR，截获播放器自己请求的 /api/timedtext 字幕数据
 *   2. 读取 player response 里的字幕轨列表
 *   3. 直接同源拉取字幕轨（首选方案，不改动用户的字幕开关）
 *   4. 必要时兜底：程序化打开原生字幕，让播放器自己去拉，我们从 1 截获
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

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (isTT(url)) {
        p.then((r) => {
          try { r.clone().text().then((b) => post('track', { source: 'hook', url, body: b })); } catch (_) {}
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
          try { post('track', { source: 'hook', url: this.__ytstUrl, body: this.responseText }); } catch (_) {}
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

  function report() {
    const d = collect();
    if (d && d.videoId) post('player', d);
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

  async function fetchTrack(req) {
    const d = collect();
    if (!d) { post('trackfail', { reason: 'no-player-response' }); return; }
    const track = pickTrack(d.tracks, (req && req.lang) || '');
    if (!track || !track.baseUrl) { post('trackfail', { reason: 'no-track', videoId: d.videoId }); return; }

    try {
      const url = track.baseUrl.replace(/([?&])fmt=[^&]*/g, '$1') + '&fmt=json3';
      const r = await fetch(url, { credentials: 'include' });
      const body = await r.text();
      if (r.ok && body && body.length > 40) {
        post('track', {
          source: 'direct',
          url,
          body,
          videoId: d.videoId,
          languageCode: track.languageCode,
          kind: track.kind
        });
        return;
      }
    } catch (_) {}
    post('trackfail', { reason: 'fetch-failed', videoId: d.videoId });
  }

  /* ---------- 4. 兜底：打开原生字幕触发播放器请求 ---------- */
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
        if (t) { try { p.setOption('captions', 'track', t); } catch (_) {} }
      }, 400);
    } catch (_) {}
  }

  function disableNative() {
    const p = getPlayer();
    try { if (p) p.setOption('captions', 'track', {}); } catch (_) {}
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

  document.addEventListener('yt-navigate-finish', () => setTimeout(report, 250));
  document.addEventListener('yt-player-updated', () => setTimeout(report, 250));

  let n = 0;
  const iv = setInterval(() => { report(); if (++n >= 12) clearInterval(iv); }, 600);
  report();
})();
