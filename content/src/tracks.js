/* 字幕轨：挑哪一条、跟着用户在 CC 菜单里的选择走、换视频、换音轨，
 * 以及「视频自带目标语言的人工字幕就直接拿来用」这条不花钱的路。
 */
import { NAME_TO_CODE, sameLanguage as sameLang, uiLanguage } from '../../common.js';
import { S, st, log, updateStatus, pageUnsupported, timing, flags, patchSettings } from './state.js';
import { buildSegments, parseJson3, parseXml, decodeEntities, isWide } from './segments.js';
import { loadCache, applyCacheToAll, saveCacheNow } from './cache.js';
import { schedule, makeBatches, resetTier, bumpEpoch } from './scheduler.js';
import { render, removeOverlay } from './overlay.js';
import { post2page } from './bridge.js';

/* ---------- 语言 ---------- */
export function targetCode() {
  const t = String(S.targetLang || 'auto').trim();
  if (!t || t.toLowerCase() === 'auto') return uiLanguage();
  return NAME_TO_CODE[t] || '';    // 认不出的自定义写法：返回空，表示不做同语言判断
}

/** 挑一条最合适的字幕轨，并顺带确定「要翻的这段文字是什么语言」。
 *  自动字幕（ASR）一定是按原声语言生成的，所以它是最可靠的语言判据；
 *  但人工字幕有标点、质量更好，所以同语言时优先用人工轨。
 *
 *  注意 spoken 返回的是**选中那条轨的语言**，不一定等于音频语言：视频可能压根
 *  没有原声那条轨（对白是烧进画面的），这时只能退回现有的轨去翻。这个返回值
 *  是给翻译提示词用的（要如实说明原文是什么语言），所以就该是轨的语言；
 *  「音频疑似另一种语言」这件事由 st.audioLang 单独报给弹窗。 */
export function chooseTrack(tracks, audioLang) {
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
export function pickTargetTrack(tracks, tgt) {
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

export function maybeAdopt() {
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
export function applyAdopted() {
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

/* ------------------------------------------------------------------ *
 * 开关
 * ------------------------------------------------------------------ */
export function toggle() { st.active ? stop(true) : start(); }

export async function start() {
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
  if (!st.segments.length) requestTrack();
  else { maybeAdopt(); schedule(); render(); }
  updateStatus();
}

export function stop(byUser) {
  st.active = false;
  if (byUser) st.userOff = true;
  document.documentElement.classList.remove('ytst-hide-native');
  /* 兜底取字幕时我们替用户打开过原生字幕 —— 翻译开着的时候它被 ytst-hide-native
   * 藏着，看不出来；一旦关掉翻译就凭空冒出一条用户自己没开过的字幕，而且从来没人
   * 负责关。inject.js 那边记着动手前的状态，这里让它原样还回去。 */
  if (st.nativeOn) { st.nativeOn = false; post2page('disableNative'); }
  removeOverlay();
  updateStatus();
}

export function requestTrack() {
  // 直播 / Shorts / 没有播放器：没有轨可拉，别没完没了地要
  if (st.unsupported) return;
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
  /* 两种情况都带编号。播放器可能正在同时拉另一条轨（账号开了自动翻译、
   * 或者视频默认轨不是原声语言），先到先得的话我们会拿「译文的译文」当原文翻，
   * 而且从此再也换不回来。带上编号，我们点名要的那条就能盖过它。 */
  st.wantReq = ++st.reqSeq;
  log('要字幕轨 #' + st.wantReq + (st.userTrack ? '（用户指定）' : '（自动挑）'));
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
export function resetVideo(data) {
  saveCacheNow();
  bumpEpoch();                      // 在途的旧请求从此作废
  st.videoId = data.videoId;
  st.title = data.title || '';
  st.isLive = !!data.isLive;
  st.isUpcoming = !!data.isUpcoming;
  timing.bootAt = Date.now();
  st.unsupported = pageUnsupported();
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
  st.errorCode = '';
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
  st.cachePending = {};
  st.cacheDirty = false;
  removeOverlay();

  stop(false);
  evaluateTracks();
}

/* 按当前 st.tracks 定原声语言、定是否需要翻译，并决定要不要自动开始。
 * 单独抽出来是因为字幕轨可能比第一份播放器信息晚到 —— 那时必须重跑这一整套，
 * 只更新 st.tracks 会让视频永远停在「无字幕」。 */
export function evaluateTracks() {
  /* 设置还没读回来：先记一笔，等 boot 读完再判。
   * 拿 DEFAULTS 判出来的结论没人会去纠正，将错就错的代价比等这几十毫秒大得多。 */
  if (!flags.settingsReady) { flags.pendingEval = true; return; }
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

  if (st.unsupported) { updateStatus(); return; }

  if (!st.tracks.length) {
    if (!st.active) { st.status = 'nosub'; }
    return;
  }
  if (st.status === 'nosub') st.status = 'idle';

  if (!st.active && !st.userOff && S.enabled && S.autoStart && st.needsTranslation) start();
  else updateStatus();
}

/* 换音轨。多音轨视频（尤其 YouTube 的 AI 自动配音）常常一上来就给一条配音轨，
 * 听着别扭；用户在播放器里换回原声，我们得跟着重判：音轨已经是目标语言就没什么
 * 可翻的，换回外语就该接着翻。 */
export function onAudioTrack(a) {
  if (!a || !a.lang) return;
  const same = sameLang(a.lang, st.audioLang);
  st.audioLang = a.lang;
  st.audioDubbed = !!a.dubbed;
  /* 音轨轮询从页面一加载就开始跑，很可能赶在设置读回来之前。
     那会儿 targetCode() 还是 DEFAULTS 算出来的，判出来的结论没人纠正。 */
  if (!flags.settingsReady) { flags.pendingEval = true; return; }
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
export const sigLang = (sig) => { const p = String(sig).split('|'); return p[2] || p[0] || ''; };

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
export function onCaptionTrack(cap) {
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

export async function onTrackBody(data) {
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
    bumpEpoch();             // 在途请求带的是旧轨的 segment id，必须作废
    st.trans = new Map();
    st.dropped = new Set();
    st.curIdx = -1;
    st.settleAt = 0;
    st.error = '';
    st.errorCode = '';
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
  log('收下字幕轨 ' + sig + '，切出 ' + st.segments.length + ' 句' + (st.noPunct ? '（无标点）' : ''));
  if (!st.segments.length) { st.status = 'nosub'; return; }
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
export function resegment() {
  if (!st.rawCues || !st.rawCues.length) return;
  bumpEpoch();             // 分段变了，在途请求带的是旧 segment id，必须作废
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
