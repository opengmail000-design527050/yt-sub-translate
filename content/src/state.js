/* 运行时状态、设置，以及「现在是什么状态」这个判断本身。
 *
 * 别的模块都读这里的 st 和 S。S 是 export let：设置变了由 setS 整份换掉，
 * 模块之间靠 ES 的实时绑定看到同一份新值（打包之后仍然如此）。
 */
import { DEFAULTS } from '../../common.js';
import { stop, evaluateTracks } from './tracks.js';

/* 设置读回来之前，一切语言/自动开启的判定都挂起（见 evaluateTracks 的注释）。
 * 用一个对象装着，模块之间才好一起改一起看。 */
export const flags = { settingsReady: false, pendingEval: false };

/* 页面开始计时的时刻。切视频、站内跳转都会重新起算 —— 「播放器迟迟没出现」
 * 这个判断得按当前这一页算。 */
export const timing = { bootAt: Date.now() };

/* 运行时的设置。整份替换而不是逐字段改 —— 别的模块读的是 ES 的实时绑定，
 * 换一份新的它们立刻看到同一份。 */
export let S = Object.assign({}, DEFAULTS);
export function setS(next) { S = next; }

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */
export const st = {
  videoId: '',
  title: '',
  audioLang: '',          // 当前音轨的语言（多音轨视频里会中途变）
  audioDubbed: false,     // 当前音轨是 YouTube 的 AI 自动配音
  tracks: [],
  sourceLang: '',          // 自动识别出的原声语言
  needsTranslation: false, // 原声语言与目标语言不同才需要翻
  active: false,           // 当前视频翻译是否开启
  userOff: false,          // 用户在本视频手动关过
  isLive: false,           // 正在直播（不是「曾经是直播」的录播）
  isUpcoming: false,       // 还没开始的首播
  unsupported: '',         // '' | live | upcoming | shorts | no-player，见 pageUnsupported
  playerChanged: false,    // YouTube 改版，连 player response 都读不到了
  capsMissing: [],         // 自检里缺了哪几样，报障时一句话就能定位
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
  batchSeq: 0,             // 每发出一批就给它一个编号，兜底超时时按它点名取消
  status: 'idle',          // idle | waiting | ready | translating | error | nosub | unsupported
  error: '',               // 出错的原话（服务商说了什么），照实给用户看
  errorCode: '',           // 九种之一，见 background 的 httpCode —— 弹窗按它决定给什么按钮
  curIdx: -1,
  settleAt: 0,             // 拖动进度条后，等到这个时刻才允许再调度（见 SEEK_SETTLE）
  cache: null,             // { items: {hash: text} }
  cachePending: {},        // 上次落盘之后新买到的译文，落盘时只送这一份增量
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
 * 诊断日志
 *
 * 200 条的环形缓冲：状态迁移、要了哪条轨、每一批的结果、每一次错误。
 * 报障的时候用户点一下弹窗里的「复制诊断信息」就能贴出来 —— 没有这个，
 * 别人机器上的问题基本查不动，只能来回猜。
 * 不落盘、不上报，页面一关就没了。 */
const LOG_MAX = 200;

export const logs = [];

const t0 = Date.now();

export function log(msg) {
  // 不用 toISOString：只关心相对时刻，而且时间戳里不该出现用户的时区
  logs.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + msg);
  if (logs.length > LOG_MAX) logs.shift();
}

export function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function debounce(fn, ms) {
  let t = null;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}

export function getVideo() { return document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video'); }

export function getPlayerEl() { return document.getElementById('movie_player') || document.querySelector('.html5-video-player'); }

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* 只把改动合进已存的那份，不把 DEFAULTS 一起写进去 ——
 * 否则用户从没碰过的默认值会被固化成显式设置，以后版本改默认值也推不到老用户。 */
export async function patchSettings(patch) {
  try {
    const got = await chrome.storage.local.get('settings');
    const next = Object.assign({}, got.settings || {}, patch);
    await chrome.storage.local.set({ settings: next });
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * 这个页面根本没得翻
 *
 * 以前这几种情况的表现都是「一直转圈」：直播卡在「正在获取字幕…」，每 8 秒重新
 * 要一次轨、每 3.5 秒试着替用户打开原生字幕，无止境；Shorts 页没有 #movie_player，
 * 弹窗写「页面未就绪，刷新一下试试」—— 刷多少次都一样。
 * 说不出原因的等待比直说「这儿不支持」糟得多：用户会一直以为是自己哪儿没弄对。
 * ------------------------------------------------------------------ */
const PLAYER_GRACE = 25000;      // 播放器最多容它这么久没出现（慢网、前贴片广告）

export function pageUnsupported() {
  try { if (/^\/shorts\//.test(location.pathname)) return 'shorts'; } catch (_) {}
  if (st.isLive) return 'live';
  if (st.isUpcoming) return 'upcoming';
  // 播放器一直没出现：多半是频道页、播放列表页这类根本没有播放器的地方
  if (!st.videoId && !getPlayerEl() && Date.now() - timing.bootAt > PLAYER_GRACE) return 'no-player';
  return '';
}

/* 自检的结论。inject.js 每轮轮询报一次（只在结论变了时才发）。
 *
 * 只有「读不到 player response」算致命 —— 那意味着字幕轨列表根本拿不到，什么都
 * 干不了，得明确告诉用户等插件更新。其余几样缺了只是残一点：按钮没了、兜底路
 * 走不通、认不出音轨语言，照常翻，留在诊断信息里就够了。
 * 把「缺一样就报坏」写死是不对的：getAudioTrack 在单音轨视频上本来就可能没有，
 * 那样会把一个明明能用的插件说成坏了。 */
/** 地址栏里的视频 id。认不出来（不在视频页）就返回 ''。 */
function urlVideoId() {
  try {
    if (location.pathname !== '/watch') return '';
    return new URLSearchParams(location.search).get('v') || '';
  } catch (_) { return ''; }
}

export function onSelfCheck(c) {
  if (!c) return;
  const miss = [];
  if (!c.response) miss.push('player-response');
  if (!c.captions) miss.push('captions-api');
  if (!c.audio) miss.push('audio-api');
  if (!c.bar) miss.push('chrome-bottom');
  st.capsMissing = miss;

  /* 第二道闸（第一道在 inject：得在视频页上、等够 45 秒）。
   *
   * 已经切出句子就不必说了。另一半是：地址栏里这个视频的信息我们已经拿到了 ——
   * 那 player response 显然读得出来，这不是改版。
   * 比的是「当前这一页的 id」而不是「有没有 id」：YouTube 真在中途改版时，
   * 新页面的播放器信息一条都进不来，st.videoId 还停在上一个视频上，
   * 光看「有没有」会把这种情况漏掉。 */
  const broken = !!c.broken && !st.segments.length && st.videoId !== urlVideoId();
  if (broken === st.playerChanged) return;
  st.playerChanged = broken;
  log(broken ? 'selfcheck 坏了：' + miss.join(',') : 'selfcheck 恢复');
  updateStatus();
}

export function refreshUnsupported() {
  const was = st.unsupported;
  st.unsupported = pageUnsupported();
  if (was === st.unsupported) return;
  log('页面支持情况：' + (st.unsupported || '正常'));
  if (st.unsupported) {
    if (st.active) stop(false);     // 不算用户关的：直播结束了还要自己接上
    updateStatus();
  } else {
    evaluateTracks();               // 从「不支持」里出来了，重新判一遍语言和自动开启
  }
}

export function updateStatus() {
  const was = st.status;
  updateStatusInner();
  if (st.status !== was) log('状态 ' + was + ' → ' + st.status + (st.error ? ' (' + st.error + ')' : ''));
}

function updateStatusInner() {
  // 不支持的页面压过一切：说清楚为什么，别再显示「正在获取字幕…」
  if (st.unsupported) { st.status = 'unsupported'; return; }
  if (st.playerChanged) { st.status = 'playerChanged'; return; }
  if (!st.active) { st.status = 'idle'; }
  else if (!st.segments.length) { st.status = st.status === 'nosub' ? 'nosub' : 'waiting'; }
  else if (st.running > 0) { st.status = 'translating'; }
  else if (st.error) { st.status = 'error'; }
  else { st.status = 'ready'; }
}
