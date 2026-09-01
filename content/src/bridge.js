/* 与主世界脚本（inject.js）之间的那条通道。
 *
 * 隔离世界和页面之间只有 postMessage 一条路，而页面里任何脚本都能发一条同样格式的
 * 消息出来。所以注入时现生成一个随机 token 交给 inject.js，两边的消息都带着它。
 */
import { st } from './state.js';
import { onSelfCheck, refreshUnsupported } from './state.js';
import { resetVideo, evaluateTracks, onTrackBody, onCaptionTrack, onAudioTrack } from './tracks.js';

const NS = 'ytst';

/* 页面里任何脚本都能 postMessage 一条 {ns:'ytst'} 出来 —— 别的扩展、YouTube 自己、
 * 或者一段第三方脚本。伪造一条 track 消息就能把假的「原文」摆到用户屏幕上，还会
 * 连着写进缓存、拿去花钱翻。所以注入时现生成一个随机 token 交给 inject.js，
 * 之后双向消息都带着它，不带的一律丢掉。
 * 页面脚本读不到这个 token：它只出现在我们创建的那个 script 标签上，而那个标签
 * onload 就自己删掉了。 */
const TOKEN = makeToken();

function makeToken() {
  try {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
export const post2page = (type, data) => {
  try { window.postMessage({ ns: NS, dir: 'c2p', type, data, token: TOKEN }, '*'); } catch (_) {}
};

/* ------------------------------------------------------------------ *
 * 注入主世界脚本
 * ------------------------------------------------------------------ */
export function inject() {
  try {
    const s = document.createElement('script');
    /* token 两条路都给：dataset 是主路，地址后面的 #token 是备用 —— 只要有一条
     * 到得了，注入脚本就能认出自己人。两条都读不到时它会退回不带 token，
     * 那些消息在下面会被丢掉，宁可不工作也不能收来路不明的字幕。 */
    s.dataset.ytstToken = TOKEN;
    s.src = chrome.runtime.getURL('content/inject.js') + '#' + TOKEN;
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (_) {}
}

/* 装上页面那一侧的监听。由 index 在启动时调用一次。 */
export function wirePage() {
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.ns !== NS || m.dir !== 'p2c') return;
    if (m.token !== TOKEN) return;      // 不是我们注入的那个脚本发的

    if (m.type === 'player') {
      const d = m.data || {};
      if (!d.videoId) return;
      if (d.videoId !== st.videoId) { resetVideo(d); return; }
      // 首播开始播了、直播结束了，这两个标记都会变
      if (st.isLive !== !!d.isLive || st.isUpcoming !== !!d.isUpcoming) {
        st.isLive = !!d.isLive;
        st.isUpcoming = !!d.isUpcoming;
        refreshUnsupported();
      }
      if (d.tracks && d.tracks.length !== st.tracks.length) {
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
    } else if (m.type === 'selfcheck') {
      onSelfCheck(m.data);
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
}
