/* 刷新（冷启动）这条路自己的回归测试。
 *
 * state.test.js 把 setInterval 整个禁掉了，也没有加载 content/inject.js，
 * 所以「播放器迟迟不就绪时还会不会继续问」「设置比播放器信息晚到会怎么判」
 * 这两件事在那里一条都跑不到 —— 而它们正是刷新后拿不到字幕的成因。
 *
 * 这里换一套：假时钟（能把 30 秒快进过去）＋ 可以卡住的 storage
 *   ＋ content.js 和 inject.js 装在同一个 window 里真的对话。
 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

/* ---------------- 假 DOM ---------------- */
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), children: [],
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    classList: {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)); },
      remove(...a) { a.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    dataset: {}, isConnected: true, parentElement: null, offsetParent: null,
    textContent: '', innerHTML: '', title: '', id: '', className: '', type: '',
    clientHeight: 450, clientWidth: 800,
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 800, height: 450, left: 0, top: 0, right: 800, bottom: 450 }; },
    setAttribute() {}, getAttribute() { return null; }, contains() { return false; }
  };
}

/* ---------------- 一次冷启动 ---------------- */
/**
 * opts.settings        存储里的设置（用户上次保存的）
 * opts.settingsDelayMs 设置要多久才读得回来（0 = 立刻）
 * opts.playerReadyMs   播放器多久之后才交得出 playerResponse
 * opts.trackFails      直接拉取字幕连续失败几次
 * opts.uiLang          浏览器界面语言（DEFAULTS 的 targetLang 是 'auto'，跟着它走）
 */
function boot(opts) {
  const o = Object.assign({ settings: {}, settingsDelayMs: 0, playerReadyMs: 0, trackFails: 0, uiLang: 'en-US' }, opts);

  /* ---- 假时钟 ---- */
  let now = 0, seq = 0;
  const timers = new Map();
  const clock = {
    setTimeout: (f, ms) => { const id = ++seq; timers.set(id, { at: now + (Number(ms) || 0), f, every: 0 }); return id; },
    setInterval: (f, ms) => { const id = ++seq; timers.set(id, { at: now + (Number(ms) || 0), f, every: Math.max(1, Number(ms) || 1) }); return id; },
    clear: (id) => { timers.delete(id); },
    now: () => now
  };
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick.t.at)) pick = { id, t };
      if (!pick) break;
      now = pick.t.at;
      if (pick.t.every) pick.t.at = now + pick.t.every; else timers.delete(pick.id);
      try { pick.t.f(); } catch (e) { console.error('定时器抛错:', e.message); }
      await new Promise((r) => setTimeout(r, 0));   // 让真实微任务/promise 跑完
    }
    now = target;
    await new Promise((r) => setTimeout(r, 0));
  }

  /* ---- 假存储：settings 可以卡住不给 ---- */
  const storage = { settings: o.settings };
  const chrome = {
    runtime: {
      getURL: (p) => 'chrome-extension://x/' + p,
      sendMessage: async (m) => (m.type === 'translateBatch'
        ? { ok: true, map: {}, dropped: (m.payload.lines || []).map((l) => l.id) }
        : { ok: true }),
      onMessage: { _l: [], addListener(f) { this._l.push(f); } }
    },
    storage: {
      local: {
        get(k) {
          const take = () => {
            if (k === null) return Object.assign({}, storage);
            if (Array.isArray(k)) { const r = {}; k.forEach((x) => { if (x in storage) r[x] = storage[x]; }); return r; }
            return (k in storage) ? { [k]: storage[k] } : {};
          };
          // 设置这一项按 settingsDelayMs 延迟；其余立刻给
          if (k === 'settings' && o.settingsDelayMs > 0) {
            return new Promise((res) => clock.setTimeout(() => res(take()), o.settingsDelayMs));
          }
          return Promise.resolve(take());
        },
        async set(obj) { Object.assign(storage, obj); },
        async remove(ks) { (Array.isArray(ks) ? ks : [ks]).forEach((k) => delete storage[k]); },
        async getBytesInUse() { return 0; }
      },
      onChanged: { _l: [], addListener(f) { this._l.push(f); } }
    },
    i18n: { getUILanguage: () => o.uiLang }
  };

  /* ---- 播放器 ---- */
  const PR = {
    videoDetails: { videoId: 'VID', title: '一期很长的访谈' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto)' },
        baseUrl: 'https://www.youtube.com/api/timedtext?v=VID&lang=en&kind=asr' }
    ] } },
    streamingData: { adaptiveFormats: [{ audioTrack: { id: 'en.4' } }] }
  };
  const player = makeEl('div');
  player.id = 'movie_player';
  player.getPlayerResponse = () => (now >= o.playerReadyMs ? PR : null);

  const docListeners = {};
  const doc = {
    documentElement: makeEl('html'), head: makeEl('head'), body: makeEl('body'),
    createElement: makeEl,
    createRange() { return { selectNodeContents() {}, getClientRects() { return []; } }; },
    getElementById: (id) => (id === 'movie_player' ? player : null),
    querySelector: (s) => (s.indexOf('movie_player') !== -1 && s.indexOf('video') === -1 ? player : null),
    querySelectorAll: () => [],
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener() {}
  };

  /* ---- window：content.js 和 inject.js 共用，postMessage 真的送到对面 ---- */
  const msgListeners = [];
  let fetchCount = 0;
  const body = JSON.stringify({
    events: Array.from({ length: 12 }, (_, i) => ({
      tStartMs: i * 2000, dDurationMs: 2000,
      segs: [{ utf8: 'Sentence number ' + i + ' about something reasonably long indeed.' }]
    }))
  });

  const win = {
    addEventListener(t, f) { if (t === 'message') msgListeners.push(f); },
    removeEventListener() {},
    postMessage(m) { clock.setTimeout(() => msgListeners.forEach((f) => f({ source: vmWindow, data: m })), 0); },
    getSelection() { return null; },
    requestAnimationFrame() { return 0; },
    setTimeout: clock.setTimeout, setInterval: clock.setInterval,
    clearTimeout: clock.clear, clearInterval: clock.clear,
    Date: Object.assign(function () {}, { now: clock.now }),
    getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' }),
    DOMParser: class { parseFromString() { return { querySelectorAll: () => [] }; } },
    XMLHttpRequest: function () {},
    URL, URLSearchParams, console,
    fetch: async () => {
      fetchCount++;
      if (fetchCount <= o.trackFails) return { ok: false, status: 429, text: async () => '' };
      return { ok: true, status: 200, text: async () => body };
    }
  };
  win.XMLHttpRequest.prototype = { open() {}, send() {} };
  win.window = win; win.self = win; win.document = doc; win.chrome = chrome;
  win.location = { href: 'https://www.youtube.com/watch?v=VID', search: '?v=VID' };

  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync('content/content.js', 'utf8'), ctx, { filename: 'content.js' });
  vm.runInContext(fs.readFileSync('content/inject.js', 'utf8'), ctx, { filename: 'inject.js' });
  const vmWindow = vm.runInContext('window', ctx);

  const status = () => new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'getStatus' }, {}, res)));
  return { advance, status, storage, get fetchCount() { return fetchCount; } };
}

/* ---------------- 用例 ---------------- */
(async () => {
  console.log('\n[1] 播放器 20 秒后才就绪：还得有人在问');
  {
    // 旧代码 inject.js 只轮询 12×600ms ≈ 7.2 秒，走完就再没人问，这里会永远拿不到字幕
    const b = boot({ settings: { targetLang: '简体中文', apiKey: 'x' }, playerReadyMs: 20000 });
    await b.advance(8000);
    const early = await b.status();
    ok('8 秒时确实还没就绪（说明用例本身有效）', !early.videoId, JSON.stringify(early));
    await b.advance(20000);
    const late = await b.status();
    ok('播放器就绪后仍然问到了视频', late.videoId === 'VID', JSON.stringify(late));
    ok('字幕轨也拿到了', late.hasTracks === true);
    ok('并且真的切出了句子', late.segments > 0, JSON.stringify(late));
  }

  console.log('\n[2] 设置比播放器信息晚到：autoStart:false 不能被默认值盖掉');
  {
    /* 界面语言设成中文，这样连 DEFAULTS 都会把英文视频判成「需要翻译」——
     * 于是 autoStart 是唯一的分水岭：照 DEFAULTS（true）就会抢跑，
     * 照用户存的（false）才不会。不这么设的话，默认目标语言解析成英语，
     * 视频会先被「无需翻译」挡下来，这条用例就白测了。 */
    const b = boot({
      settings: { targetLang: '简体中文', apiKey: 'x', autoStart: false },
      settingsDelayMs: 4000, playerReadyMs: 300, uiLang: 'zh-CN'
    });
    await b.advance(1000);
    const mid = await b.status();
    ok('设置还没到时按兵不动，没有照 DEFAULTS 抢跑', mid.active === false, JSON.stringify(mid));
    await b.advance(10000);
    const s = await b.status();
    ok('设置到了之后仍然尊重 autoStart:false', s.active === false, JSON.stringify(s));
    ok('也没有偷偷去拉字幕', s.segments === 0);
  }

  console.log('\n[3] 设置比播放器信息晚到：目标语言必须按用户存的算');
  {
    /* 桩里的浏览器界面语言是 en-US，DEFAULTS 的 targetLang 是 'auto' —— 解析成英语。
     * 用 DEFAULTS 判的话，英文视频会被判成「无需翻译」从此保持关闭，
     * 而设置读回来之后旧代码没有任何地方会重判。 */
    const b = boot({
      settings: { targetLang: '简体中文', apiKey: 'x' },
      settingsDelayMs: 4000, playerReadyMs: 300
    });
    await b.advance(12000);
    const s = await b.status();
    ok('英文视频判定为需要翻译', s.needsTranslation === true, JSON.stringify(s));
    ok('并且自动开起来了', s.active === true, JSON.stringify(s));
    ok('字幕也拿到了', s.segments > 0, JSON.stringify(s));
  }

  console.log('\n[4] 头一次拉字幕失败：过一会儿要再要一次，不能就此停摆');
  {
    const b = boot({ settings: { targetLang: '简体中文', apiKey: 'x' }, trackFails: 1 });
    await b.advance(2000);
    const mid = await b.status();
    ok('第一次确实没拿到', mid.segments === 0, JSON.stringify(mid));
    await b.advance(20000);
    const s = await b.status();
    ok('重试之后拿到了字幕', s.segments > 0, JSON.stringify(s));
    ok('确实重新拉过', b.fetchCount >= 2, 'fetchCount=' + b.fetchCount);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
