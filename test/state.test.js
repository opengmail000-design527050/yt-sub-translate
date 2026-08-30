/* 用桩环境跑 content.js，验证状态机路径。不联网、不碰真实存储。 */
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
const sent = [];
let runtimeReply = null;

const chrome = {
  runtime: {
    getURL: (p) => 'chrome-extension://x/' + p,
    sendMessage: async (m) => { sent.push(m); return runtimeReply ? runtimeReply(m) : { ok: false, error: 'stub' }; },
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
  i18n: { getUILanguage: () => 'en-US' }
};
function fireChange(key, val) {
  chrome.storage.onChanged._l.forEach((f) => {
    try { f({ [key]: { newValue: val } }, 'local'); } catch (e) { console.error('onChanged 抛错:', e.message); }
  });
}

const posted = [];
const win = {
  addEventListener(t, f) { (listeners.window[t] = listeners.window[t] || []).push(f); },
  removeEventListener() {},
  postMessage(m) { posted.push(m); },
  getSelection() { return null; },
  requestAnimationFrame() { return 0; },
  setTimeout: (f, ms) => setTimeout(f, Math.min(ms || 0, 1)),
  setInterval: () => 0, clearTimeout, clearInterval,
  getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' }),
  DOMParser: class { parseFromString() { return { querySelectorAll: () => [] }; } },
  console
};
win.window = win; win.self = win; win.document = doc; win.chrome = chrome;
win.location = { href: 'https://www.youtube.com/watch?v=A' };

const ctx = vm.createContext(win);
vm.runInContext(fs.readFileSync('content/content.js', 'utf8'), ctx, { filename: 'content.js' });
/* vm 里的 window 是沙箱全局代理，跟宿主的 win 不是同一个对象；
   content.js 用 e.source !== window 做校验，所以事件里必须带 vm 侧的那个。 */
const vmWindow = vm.runInContext('window', ctx);

const toPage = (type, data) => {
  (listeners.window.message || []).forEach((f) => f({ source: vmWindow, data: { ns: 'ytst', dir: 'p2c', type, data } }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = () => new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'getStatus' }, {}, res)));
const cacheKeys = () => Object.keys(storage).filter((k) => k.startsWith('c_'));

function track(n, word) {
  return JSON.stringify({
    events: Array.from({ length: n }, (_, i) => ({
      tStartMs: i * 2000, dDurationMs: 2000,
      segs: [{ utf8: word + ' sentence number ' + i + ' about something reasonably long indeed.' }]
    }))
  });
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

(async () => {
  await sleep(30);

  /* 桩里的浏览器界面语言是 en-US。干净安装时 targetLang 应当解析成英语，
     英文视频于是「无需翻译」。修复前 content.js 的 DEFAULTS 写死简体中文，
     这里会判成需要翻译，然后拿去请求一个实际会译成英文的后端。 */
  console.log('\n[1] 干净安装 + 英文界面浏览器 + 英文视频');
  runtimeReply = async () => ({ ok: true, map: {}, dropped: [] });
  toPage('player', { videoId: 'A0', title: 'a0', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(20);
  const s0 = await ask();
  check('默认目标语言跟随浏览器，英文视频判定为无需翻译', s0.needsTranslation === false && !s0.active,
        JSON.stringify(s0));
  check('因此不会去拉字幕、不会发请求', !posted.some((p) => p.type === 'fetchTrack'),
        'posted=' + JSON.stringify(posted.map((p) => p.type)));

  /* 之后的用例把目标语言显式设成中文，让英文视频确实需要翻译 */
  await chrome.storage.local.set({ settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1 } });
  await sleep(20);

  console.log('\n[2] 视频切换：旧响应不得写入新视频');
  posted.length = 0; sent.length = 0;
  toPage('player', { videoId: 'A', title: 'a', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(20);
  let release; const gate = new Promise((r) => { release = r; });
  runtimeReply = async (m) => {
    await gate;
    return { ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '旧视频译文'])), dropped: [] };
  };
  toPage('track', { videoId: 'A', body: track(40, 'Alpha') });
  await sleep(20);
  const inflight = sent.length;
  toPage('player', { videoId: 'B', title: 'b', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(10);
  runtimeReply = async (m) => ({ ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '新视频译文'])), dropped: [] });
  toPage('track', { videoId: 'B', body: track(40, 'Bravo') });
  release();
  await sleep(80);
  const polluted = cacheKeys().some((k) => Object.values((storage[k] || {}).items || {}).includes('旧视频译文'));
  check('切走时确实有在途请求', inflight > 0, 'inflight=' + inflight);
  check('旧视频译文没被写进任何缓存', !polluted,
        JSON.stringify(cacheKeys().map((k) => Object.values(storage[k].items || {})[0])));

  console.log('\n[3] 字幕轨迟到');
  posted.length = 0;
  toPage('player', { videoId: 'C', title: 'c', audioLang: 'en', tracks: [] });
  await sleep(15);
  const s1 = await ask();
  check('先报无字幕', s1.status === 'nosub', s1.status);
  toPage('player', { videoId: 'C', title: 'c', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(25);
  const s2 = await ask();
  check('轨道到了以后恢复并自动开始', s2.status !== 'nosub' && s2.active, JSON.stringify(s2));

  console.log('\n[4] 播放中换模型');
  runtimeReply = async (m) => ({ ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, 'A模型译文'])), dropped: [] });
  toPage('track', { videoId: 'C', body: track(30, 'Charlie') });
  await sleep(80);
  const before = await ask();
  check('先翻出了一部分', before.translated > 0, JSON.stringify(before));

  const keysBefore = cacheKeys().length;
  runtimeReply = async (m) => ({ ok: true, map: {}, dropped: m.payload.lines.map((l) => l.id) });
  await chrome.storage.local.set({ settings: Object.assign({}, storage.settings, { model: 'another-model' }) });
  await sleep(80);
  const after = await ask();
  check('换模型后旧译文清空，不会中英混排', after.translated === 0, JSON.stringify(after));

  console.log('\n[5] 整批错位（后端返回 ok 但空 map）');
  check('状态是 error 且 error 文案非空（popup 才会给重试入口）',
        after.status === 'error' && !!after.error, JSON.stringify(after));

  console.log('\n[6] 缓存键覆盖附加提示词');
  runtimeReply = async (m) => ({ ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '文言译文'])), dropped: [] });
  await chrome.storage.local.set({ settings: Object.assign({}, storage.settings, { extraPrompt: '全部用文言文' }) });
  await sleep(120);
  check('改提示词后写入了新的缓存键', cacheKeys().length > keysBefore, keysBefore + ' -> ' + cacheKeys().length);

  console.log('[7] 重复原文不重复付费');
  const seen = [];
  runtimeReply = async (m) => {
    m.payload.lines.forEach((l) => seen.push(l.text));
    return { ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '译:' + l.text.slice(0, 6)])), dropped: [] };
  };
  await chrome.storage.local.set({
    settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1, useCache: true, extraPrompt: 'dedup' }
  });
  await sleep(30);
  // 同一句口头禅反复出现，中间夹着各不相同的长句
  const evs = [];
  for (let i = 0; i < 60; i++) {
    const t = (i % 2 === 0)
      ? 'Right, exactly, that is what I have been saying all along here.'
      : 'A distinct sentence number ' + i + ' that appears exactly once in this transcript.';
    evs.push({ tStartMs: i * 4000, dDurationMs: 4000, segs: [{ utf8: t }] });
  }
  toPage('player', { videoId: 'D', title: 'd', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(30);
  seen.length = 0;            // 只统计视频 D，排除上一个视频遗留的批次
  toPage('track', { videoId: 'D', body: JSON.stringify({ events: evs }) });
  await sleep(250);
  const d = await ask();
  const uniqueSent = new Set(seen).size;
  check('重复句只送一次', seen.length === uniqueSent, '送出 ' + seen.length + ' 行，其中不重复 ' + uniqueSent + ' 行');
  check('所有行仍然都拿到了译文', d.translated === d.segments, JSON.stringify(d));
  check('实际送出的行数少于总行数 (送出 ' + seen.length + ' / 共 ' + d.segments + ' 行)', seen.length < d.segments);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
