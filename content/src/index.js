/* Sub Translator —— 内容脚本的接线与启动。
 *
 * 这个文件是打包入口：npm run build 把它和它 import 的模块打成一段普通脚本
 * （dist/content/content.js）—— content script 不能是 ES 模块。
 *
 * 干活的分在六个模块里：
 *   segments  切句
 *   scheduler 分批、调度、收结果、失败怎么办
 *   cache     本地缓存
 *   tracks    选轨、换轨、换视频、自带译文轨
 *   overlay   字幕框与播放器按钮（唯一碰 DOM 的地方）
 *   bridge    与主世界脚本 inject.js 的消息通道
 * 外加一个 state：状态、设置，以及「现在是什么状态」这个判断。
 *
 * 这里只留三件事：设置变更怎么落到各模块、渲染循环与常驻轮询、以及启动顺序。
 */
import { DEFAULTS } from '../../common.js';
import { S, setS, st, flags, timing, logs, updateStatus, refreshUnsupported } from './state.js';
import { buildSegments, parseJson3 } from './segments.js';
import { loadCache, applyCacheToAll, saveCacheNow } from './cache.js';
import { schedule, makeBatches, resetTier, bumpEpoch, retryErrors, purgeCache } from './scheduler.js';
import { applyAdopted, pickTargetTrack, onAudioTrack, evaluateTracks, maybeAdopt, resegment,
         requestTrack, start, stop, toggle, sigLang } from './tracks.js';
import { render, findIndex, ensureButton, applyStyleVars } from './overlay.js';
import { inject, post2page, wirePage } from './bridge.js';

(function () {
  'use strict';
  if (window.__YTST_CONTENT__) return;
  window.__YTST_CONTENT__ = true;

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
        unsupported: st.unsupported,
        playerChanged: st.playerChanged,
        capsMissing: st.capsMissing,
        errorCode: st.errorCode,
        error: st.error,
        segments: st.segments.length,
        translated: st.trans.size,
        running: st.running,
        hasTracks: st.tracks.length > 0
      });
      return true;
    }
    if (msg.type === 'getLog') {
      sendResponse({
        ok: true,
        videoId: st.videoId,
        status: st.status,
        unsupported: st.unsupported,
        capsMissing: st.capsMissing,
        segments: st.segments.length,
        translated: st.trans.size,
        dropped: st.dropped.size,
        batches: st.batches.map((b) => b.state).join(''),
        tier: st.batchTier + '/' + st.batchCeil,
        sourceLang: st.sourceLang,
        trackSig: st.trackSig,
        adopt: st.adoptState,
        lines: logs.slice()
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
      setS(Object.assign({}, DEFAULTS, got.settings || {}));
    } catch (_) {}
  }

  /* 改了会改变译文内容的设置：已有译文和在途请求都不能留。
   *
   * 推理档位（reasoning）不在里面，而且是有意不在的。它确实会让后面的译文更贴切，
   * 可这不等于前面已经翻好的就作废了 —— 那些句子的译文本身没有任何问题。
   * README 推荐的用法正是「难懂的段落临时开中档」，一进来就把整片译文清空重买，
   * 等于给这个用法明码标价。档位只影响之后发出去的批次：background 每次请求都现读
   * settings，所以下一批自然就带上新档位了，这里什么都不用做。 */
  const OUTPUT_KEYS = ['model', 'targetLang', 'baseUrl', 'extraPrompt',
                       'reasoningStyle', 'temperature', 'maxTokens', 'useContext'];
  /* 只影响怎么分批，译文本身不变，保留已翻好的部分 */
  const BATCH_KEYS = ['batchChars', 'batchLines'];

  /* 设置变更只走这一条路径。设置页会同时触发 storage.onChanged 和 settingsChanged 消息，
   * 两边都进这里；第二次进来时新旧值已经相同，只会重刷样式，不会重复作废译文。 */
  async function applySettings(raw) {
    const old = S;
    setS(Object.assign({}, DEFAULTS, raw || {}));
    const wasReady = flags.settingsReady;
    flags.settingsReady = true;
    // boot 还没读完就先收到了设置变更：挂起的语言/自动开启判定现在就能做了
    if (!wasReady && (flags.pendingEval || st.videoId)) { flags.pendingEval = false; evaluateTracks(); }

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
    bumpEpoch();                // 守卫会丢掉回来的结果，这里再把请求本身掐掉
    st.trans = new Map();
    st.dropped = new Set();
    st.error = '';
    st.errorCode = '';
    st.cacheDirty = false;      // 没落盘的旧译文属于旧配置，别写了
    st.cachePending = {};
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

  /* 落盘的时机不能只有 beforeunload：手机端和后台标签页常常等不到它就被丢掉，
   * 而 pagehide / 页面转入后台是浏览器保证会给的最后一程。三个都挂上，flushCache
   * 自己会看 cacheDirty，重复触发不会重复写。 */
  window.addEventListener('beforeunload', saveCacheNow);
  window.addEventListener('pagehide', saveCacheNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveCacheNow();
  });

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
      if (st.unsupported) return;     // 直播 / Shorts：问了也没有轨，别空转
      post2page('probe');
      // 前 30 秒每秒问一次，之后降到 5 秒一次，一直陪到底
      if (++n === 30) { clearInterval(iv); setInterval(() => { if ((!st.videoId || !st.tracks.length) && !st.unsupported) post2page('probe'); }, 5000); }
    }, 1000);
  }

  (async function boot() {
    /* 先注入。inject.js 要赶在播放器自己去拉字幕之前把 fetch/XHR 劫持装上，
     * 而 loadSettings 读的是 chrome.storage —— 缓存攒多了它可能要几百毫秒甚至更久，
     * 排在注入前面等于把劫持推迟到播放器之后，首份字幕就截不到了。 */
    inject();
    wirePage();
    requestAnimationFrame(loop);
    setInterval(observeUi, 1000);
    setInterval(() => {
      refreshUnsupported();          // Shorts 是靠地址认的，站内跳转随时会变
      if (!st.active) return;
      schedule();
      // 开着却一句都没拿到：字幕轨也许刚到、也许上次是偶发失败，再要一次
      if (!st.segments.length && st.tracks.length) requestTrack();
    }, 2000);
    document.addEventListener('yt-navigate-finish', () => {
      timing.bootAt = Date.now();           // 换页了，播放器的宽限期重新开始算
      setTimeout(() => post2page('probe'), 300);
    });
    setTimeout(() => post2page('probe'), 800);
    keepProbing();
    await loadSettings();
    flags.settingsReady = true;
    applyStyleVars();
    if (!S.enabled) { stop(false); return; }
    // 挂起期间来过播放器信息：现在按真正的设置重判一次语言和自动开启
    if (flags.pendingEval || st.videoId) { flags.pendingEval = false; evaluateTracks(); }
    if (st.active) { schedule(); render(); }
  })();
})();
