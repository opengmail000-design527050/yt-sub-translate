/* 一个够用的假 YouTube 播放页：只实现内容脚本真正会去摸的那几样东西。
 *
 * 不是为了像 YouTube，而是为了让「冷启动 → 拿轨 → 切句 → 翻译 → 上屏」这条链路
 * 在真的浏览器里、真的扩展里跑一遍。假到哪一步是有讲究的：DOM 结构、
 * getPlayerResponse、captions / 音轨那几个 API 都得在，因为自检和兜底路要摸它们。
 */
export const CUES = (word, n = 24) => ({
  events: Array.from({ length: n }, (_, i) => ({
    tStartMs: i * 3000,
    dDurationMs: 3000,
    segs: [{ utf8: word + ' sentence number ' + i + ' about something reasonably long indeed.' }]
  }))
});

/* opts.pot：模拟 2026 年的真 YouTube ——
 *   - timedtext 不带 PO token（pot=）就回 200 空体，扩展自己直接拉是拉不到的；
 *   - 原生字幕一上来就开着，首份字幕跟着视频流（SABR）下来，不发 timedtext 请求；
 *   - 只有字幕轨真的变了，播放器才带着 pot 发一次 XHR。设成同一条轨什么都不发生。 */
export function playerHtml(videoId, tracks, opts = {}) {
  const pr = {
    videoDetails: { videoId, title: 'E2E ' + videoId, isLive: false, isLiveContent: false },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks.map((t) => ({
      languageCode: t.lang,
      kind: t.kind || '',
      name: { simpleText: t.lang },
      baseUrl: 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=' + t.lang +
               (t.kind ? '&kind=' + t.kind : '')
    })) } },
    streamingData: { adaptiveFormats: [{ audioTrack: { id: 'en.4' } }] }
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${videoId}</title>
<style>#movie_player{position:relative;width:640px;height:360px;background:#111}
.ytp-chrome-bottom{position:absolute;bottom:0;height:36px;width:100%}
.ytp-right-controls{float:right}</style></head><body>
<div id="movie_player" class="html5-video-player">
  <video class="html5-main-video"></video>
  <div class="ytp-chrome-bottom"><div class="ytp-right-controls">
    <div class="ytp-right-controls-left">
      <button class="ytp-subtitles-button">cc</button>
      <button class="ytp-settings-button">s</button>
    </div>
    <div class="ytp-right-controls-right">
      <button class="ytp-size-button">t</button>
      <button class="ytp-fullscreen-button">f</button>
    </div>
  </div></div>
</div>
<script>
window.ytInitialPlayerResponse = ${JSON.stringify(pr)};
const p = document.getElementById('movie_player');
const POT = ${!!opts.pot};
// CC 菜单里选中的那条；pot 模式下一上来就开着第一条轨
let curTrack = POT ? ${JSON.stringify({ languageCode: (tracks[0] || {}).lang, kind: (tracks[0] || {}).kind || '' })} : null;
p.getPlayerResponse = () => window.ytInitialPlayerResponse;
p.getOption = (mod, key) => {
  if (mod !== 'captions') return null;
  if (key === 'track') return curTrack || {};
  if (key === 'tracklist') return ${JSON.stringify(tracks.map((t) => ({ languageCode: t.lang, kind: t.kind || '' })))};
  return null;
};
p.setOption = (mod, key, v) => {
  if (mod !== 'captions' || key !== 'track') return;
  const was = curTrack;
  curTrack = v;
  const same = was && v && was.languageCode === v.languageCode && (was.kind || '') === (v.kind || '');
  if (!POT || !v || !v.languageCode || same) return;
  const t = window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
    .find((c) => c.languageCode === v.languageCode && (c.kind || '') === (v.kind || ''));
  if (!t) return;
  const x = new XMLHttpRequest();
  x.open('GET', t.baseUrl + '&fmt=json3&pot=e2e-token&c=WEB');
  x.send();
};
p.loadModule = () => {};
p.getAudioTrack = () => ({ meta: { id: 'en.4', name: 'English', isDefault: true } });
p.getAvailableAudioTracks = () => [1];
// 测试用：假装用户在 CC 菜单里换了一条轨
window.__pickTrack = (lang, kind) => {
  curTrack = { languageCode: lang, kind: kind || '' };
};
</script></body></html>`;
}
