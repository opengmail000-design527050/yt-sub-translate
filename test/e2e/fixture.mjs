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

export function playerHtml(videoId, tracks) {
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
    <button class="ytp-settings-button">s</button>
  </div></div>
</div>
<script>
window.ytInitialPlayerResponse = ${JSON.stringify(pr)};
const p = document.getElementById('movie_player');
let curTrack = null;                       // CC 菜单里选中的那条
p.getPlayerResponse = () => window.ytInitialPlayerResponse;
p.getOption = (mod, key) => {
  if (mod !== 'captions') return null;
  if (key === 'track') return curTrack || {};
  if (key === 'tracklist') return ${JSON.stringify(tracks.map((t) => ({ languageCode: t.lang, kind: t.kind || '' })))};
  return null;
};
p.setOption = (mod, key, v) => { if (mod === 'captions' && key === 'track') curTrack = v; };
p.loadModule = () => {};
p.getAudioTrack = () => ({ meta: { id: 'en.4', name: 'English', isDefault: true } });
p.getAvailableAudioTracks = () => [1];
// 测试用：假装用户在 CC 菜单里换了一条轨
window.__pickTrack = (lang, kind) => {
  curTrack = { languageCode: lang, kind: kind || '' };
};
</script></body></html>`;
}
