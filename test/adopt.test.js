/* 视频自带译文轨 + 音轨切换。
 * 桩环境跑 content.js，不联网：这里最该守住的是「一个 token 都不该花」。 */
const fs = require('fs'), vm = require('vm');

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), children: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)); },
      remove(...a) { a.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    dataset: {}, isConnected: true, parentElement: null, offsetParent: null,
    textContent: '', innerHTML: '', title: '', id: '', className: '', type: '',
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 800, height: 450, left: 0, top: 0 }; },
    setAttribute() {}, getAttribute() { return null; }, contains() { return false; }
  };
}

const listeners = { window: {}, document: {} };
const doc = {
  documentElement: makeEl('html'), head: makeEl('head'), body: makeEl('body'),
  createElement: makeEl,
  createRange() { return { selectNodeContents() {}, getClientRects() { return []; } }; },
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  addEventListener(t, f) { (listeners.document[t] = listeners.document[t] || []).push(f); },
  removeEventListener() {}
};

const storage = { settings: {} };
const sent = [];                 // 发给 background 的所有消息（含缓存索引维护）
// 只有 translateBatch 是花钱的那种
const paid = () => sent.filter((m) => m.type === 'translateBatch');
let runtimeReply = null;

const chrome = {
  runtime: {
    getURL: (p) => 'chrome-extension://x/' + p,
    /* 桩要像 background 一样按消息类型分流：cancel 是「把这一版的在途请求掐掉」的
       通知，跟译文回调毫无关系，交给 runtimeReply 会打乱用例自己的计数。 */
    sendMessage: async (m) => {
      sent.push(m);
      if (m && m.type === 'cancel') return { ok: true, aborted: 0 };
      return runtimeReply ? runtimeReply(m) : { ok: false, error: 'stub' };
    },
    onMessage: { _l: [], addListener(f) { this._l.push(f); } }
  },
  storage: {
    local: {
      async get(k) {
        if (k === null) return Object.assign({}, storage);
        if (Array.isArray(k)) { const o = {}; k.forEach((x) => { if (x in storage) o[x] = storage[x]; }); return o; }
        return (k in storage) ? { [k]: storage[k] } : {};
      },
      async set(o) { Object.assign(storage, o); Object.keys(o).forEach((k) => fireChange(k, o[k])); },
      async remove(ks) { (Array.isArray(ks) ? ks : [ks]).forEach((k) => delete storage[k]); },
      async getBytesInUse() { return 0; }
    },
    onChanged: { _l: [], addListener(f) { this._l.push(f); } }
  },
  i18n: { getUILanguage: () => 'zh-CN' }
};
function fireChange(key, val) {
  chrome.storage.onChanged._l.forEach((f) => {
    try { f({ [key]: { newValue: val } }, 'local'); } catch (e) { console.error('onChanged 抛错:', e.message); }
  });
}

const posted = [];
const win = {
  __YTST_TEST__: {},
  addEventListener(t, f) { (listeners.window[t] = listeners.window[t] || []).push(f); },
  removeEventListener() {},
  postMessage(m) { posted.push(m); },
  getSelection() { return null; },
  requestAnimationFrame() { return 0; },
  // 时间轴等比压缩（同 state.test.js）：压成 1ms 的话各种兜底计时器会抢跑
  setTimeout: (f, ms) => setTimeout(f, Math.min(Math.ceil((ms || 0) / 50), 60)),
  setInterval: () => 0, clearTimeout, clearInterval,
  getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' }),
  DOMParser: class { parseFromString() { return { querySelectorAll: () => [] }; } },
  URL, URLSearchParams,
  console
};
win.window = win; win.self = win; win.document = doc; win.chrome = chrome;
win.location = { href: 'https://www.youtube.com/watch?v=A' };

const ctx = vm.createContext(win);
vm.runInContext(fs.readFileSync(__dirname + '/../content/content.js', 'utf8'), ctx, { filename: 'content.js' });
const vmWindow = vm.runInContext('window', ctx);
const T = vm.runInContext('window.__YTST_TEST__', ctx);

const toPage = (type, data) => {
  (listeners.window.message || []).forEach((f) => f({ source: vmWindow, data: { ns: 'ytst', dir: 'p2c', type, data } }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = () => new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'getStatus' }, {}, res)));
const lastFetch = () => [...posted].reverse().find((p) => p.type === 'fetchTrack');

/** 英文原文轨：n 条，每条 2 秒 */
const enTrack = (n) => JSON.stringify({
  events: Array.from({ length: n }, (_, i) => ({
    tStartMs: i * 2000, dDurationMs: 2000,
    segs: [{ utf8: 'Sentence number ' + i + ' about something reasonably long indeed.' }]
  }))
});

/** 自带中文轨：每 1 秒一条，覆盖 0..spanSec 秒 */
const zhTrack = (spanSec) => JSON.stringify({
  events: Array.from({ length: spanSec }, (_, i) => ({
    tStartMs: i * 1000, dDurationMs: 1000,
    segs: [{ utf8: '第' + i + '句中文' }]
  }))
});

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

(async () => {
  await chrome.storage.local.set({ settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1 } });
  await sleep(30);
  runtimeReply = async (m) => ({ ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '模型译文'])), dropped: [] });

  /* ---------------------------------------------------------------- */
  console.log('\n[1] 挑轨：只认目标语言的人工轨，简繁分得清');
  {
    const p = T.pickTargetTrack;
    check('简中目标优先拿 zh-Hans，不拿 zh-Hant',
      p([{ languageCode: 'zh-Hant', kind: '' }, { languageCode: 'zh-Hans', kind: '' }], 'zh-CN') === 'zh-Hans');
    check('只有繁体也认（简中用户看得懂）',
      p([{ languageCode: 'zh-Hant', kind: '' }], 'zh-CN') === 'zh-Hant');
    check('语言码完全一致的最优先',
      p([{ languageCode: 'zh-Hans', kind: '' }, { languageCode: 'zh-CN', kind: '' }], 'zh-CN') === 'zh-CN');
    check('自动字幕轨不算（那是机器听写原声的）',
      p([{ languageCode: 'zh', kind: 'asr' }], 'zh-CN') === '');
    check('没有中文轨就返回空',
      p([{ languageCode: 'en', kind: '' }, { languageCode: 'ja', kind: '' }], 'zh-CN') === '');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 自带中文字幕：直接用，一个请求都不发');
  posted.length = 0; sent.length = 0;
  toPage('player', {
    videoId: 'V1', title: 'v1', audioLang: 'en',
    tracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'zh-Hans', kind: '' }]
  });
  await sleep(20);
  toPage('track', { videoId: 'V1', body: enTrack(30) });
  await sleep(25);

  const req = lastFetch();
  check('自动去要那条中文轨', !!req && req.data.lang === 'zh-Hans' && req.data.exact === true,
        JSON.stringify(req && req.data));
  check('中文轨到手之前一个翻译请求都没发', paid().length === 0, 'paid=' + paid().length);

  toPage('track', { videoId: 'V1', body: zhTrack(60), reqId: req.data.reqId });
  await sleep(60);
  const s1 = await ask();
  check('状态里报告「用的是自带 zh-Hans 轨」', s1.adopted === 'zh-Hans', JSON.stringify(s1.adopted));
  check('句子都贴上了译文', s1.translated >= s1.segments * 0.9,
        s1.translated + '/' + s1.segments);
  check('全程没有调用过模型', paid().length === 0, JSON.stringify(sent.map((x) => x.type)));

  /* ---------------------------------------------------------------- */
  console.log('\n[3] 对齐：一条 cue 只算给一句，不在相邻两句里各出现一次');
  {
    const st = T.st;
    const seen = new Map();
    let dup = 0;
    for (const seg of st.segments) {
      const tr = st.trans.get(seg.id);
      if (!tr) continue;
      for (const piece of tr.split('第').filter(Boolean)) {
        if (seen.has(piece)) dup++;
        seen.set(piece, seg.id);
      }
    }
    check('没有一行中文被贴到两句上', dup === 0, 'dup=' + dup);
    const first = st.trans.get(st.segments[0].id) || '';
    check('一句里可以并进多条 cue', first.split('第').length > 2, first);
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 自带轨只覆盖片头：回退到自己翻，别留半屏空白');
  posted.length = 0; sent.length = 0;
  toPage('player', {
    videoId: 'V2', title: 'v2', audioLang: 'en',
    tracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'zh-Hans', kind: '' }]
  });
  await sleep(20);
  toPage('track', { videoId: 'V2', body: enTrack(40) });
  await sleep(25);
  const req2 = lastFetch();
  toPage('track', { videoId: 'V2', body: zhTrack(6), reqId: req2.data.reqId });   // 只有前 6 秒
  await sleep(120);
  const s2 = await ask();
  check('不采用这条轨', !s2.adopted, JSON.stringify(s2.adopted));
  check('改回自己翻，请求发出去了', paid().length > 0, 'paid=' + paid().length);

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 换音轨：切到中文配音就停，换回英文原声就继续');
  posted.length = 0; sent.length = 0;
  toPage('player', { videoId: 'V3', title: 'v3', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(20);
  toPage('track', { videoId: 'V3', body: enTrack(30) });
  await sleep(60);
  const before = await ask();
  check('英文音轨下正常在翻', before.active && before.translated > 0, JSON.stringify(before.translated));

  sent.length = 0;
  toPage('audiotrack', { lang: 'zh-Hans', dubbed: true, name: '中文（自动配音）', count: 12 });
  await sleep(30);
  const dubbed = await ask();
  check('切到中文配音音轨就停下', !dubbed.active && dubbed.needsTranslation === false, JSON.stringify(dubbed.status));
  check('停下之后不再发请求', paid().length === 0, JSON.stringify(sent.map((x) => x.type)));
  check('状态里报得出这是配音音轨', dubbed.audioDubbed === true && dubbed.audioLang === 'zh-Hans',
        JSON.stringify([dubbed.audioLang, dubbed.audioDubbed]));

  toPage('audiotrack', { lang: 'en', dubbed: false, name: 'English original', count: 12 });
  await sleep(40);
  const back = await ask();
  check('换回英文原声自动接着翻', back.active && back.needsTranslation === true, JSON.stringify(back.status));

  /* ---------------------------------------------------------------- */
  console.log('\n[6] 手动关掉之后，换音轨不该把它自己打开');
  await new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'setActive', value: false }, {}, res)));
  await sleep(10);
  toPage('audiotrack', { lang: 'zh-Hans', dubbed: true, count: 12 });
  await sleep(10);
  toPage('audiotrack', { lang: 'en', dubbed: false, count: 12 });
  await sleep(30);
  const off = await ask();
  check('用户关过就一直关着', !off.active, JSON.stringify(off.status));

  /* ---------------------------------------------------------------- */
  console.log('\n[7] 用着自带轨时改目标语言：不能卡死在「不用翻」上');
  posted.length = 0; sent.length = 0;
  toPage('player', {
    videoId: 'V4', title: 'v4', audioLang: 'en',
    tracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'zh-Hans', kind: '' }]
  });
  await sleep(20);
  toPage('track', { videoId: 'V4', body: enTrack(30) });
  await sleep(25);
  const req4 = lastFetch();
  toPage('track', { videoId: 'V4', body: zhTrack(60), reqId: req4.data.reqId });
  await sleep(40);
  check('先用上了自带的中文轨', (await ask()).adopted === 'zh-Hans');

  sent.length = 0;
  await chrome.storage.local.set({ settings: { targetLang: '日本語', apiKey: 'x', concurrency: 1 } });
  await sleep(90);
  const s4 = await ask();
  check('改成日文后不再用那条中文轨', !s4.adopted, JSON.stringify(s4.adopted));
  check('并且真的重新翻了起来，没有卡住', paid().length > 0, 'paid=' + paid().length);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
