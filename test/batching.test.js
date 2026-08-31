/* 验证「批次自适应」这件事：
 *   - 连续几批干干净净就把批次调大（那 250 token 的系统提示是按次付的）
 *   - 一出现错位立刻回落，而且不再试那一档
 *   - 网络层的错误不算数，不该拖累批次大小
 * 用桩跑 content.js，不联网、不碰真实存储。 */
const fs = require('fs'), vm = require('vm');

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
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {},
    _q: null,
    querySelector(sel) { this._q = this._q || {}; return this._q[sel] || (this._q[sel] = makeEl('div')); },
    querySelectorAll() { return []; },
    clientHeight: 450, clientWidth: 800,
    getBoundingClientRect() { return { width: 800, height: 450, left: 0, top: 0, bottom: 450, right: 800 }; },
    setAttribute() {}, getAttribute() { return null; }, contains() { return false; }
  };
}

const listeners = { window: {}, document: {} };
/* 装上之后 render() 才跑得起来；[4] 之前一直是 null，render 会自己早退，
   不会干扰前面几组用例。 */
let videoEl = null, playerEl = null;
const doc = {
  documentElement: makeEl('html'), head: makeEl('head'), body: makeEl('body'),
  createElement: makeEl,
  createRange() { return { selectNodeContents() {}, getClientRects() { return []; } }; },
  getElementById(id) { return (playerEl && id === 'movie_player') ? playerEl : null; },
  querySelector(sel) {
    if (sel === '#movie_player video' || sel === 'video.html5-main-video') return videoEl;
    if (sel === '.html5-video-player') return playerEl;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener(t, f) { (listeners.document[t] = listeners.document[t] || []).push(f); },
  removeEventListener() {}
};

const storage = { settings: {} };
const sent = [];
let runtimeReply = null;

function fireChange(key, val) {
  chrome.storage.onChanged._l.forEach((f) => { try { f({ [key]: { newValue: val } }, 'local'); } catch (_) {} });
}

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

const posted = [];
let rafClock = 0;
const win = {
  addEventListener(t, f) { (listeners.window[t] = listeners.window[t] || []).push(f); },
  removeEventListener() {},
  postMessage(m) { posted.push(m); },
  getSelection() { return null; },
  // 真的驱动起来：content.js 的 loop 里有 ts - lastPaint > 120 的节流，
  // 所以喂给它一个自己往前走的时钟
  requestAnimationFrame(f) { rafClock += 200; setTimeout(() => f(rafClock), 4); return 0; },
  setTimeout: (f, ms) => setTimeout(f, Math.min(Math.ceil((ms || 0) / 50), 60)),
  setInterval: () => 0, clearTimeout, clearInterval,
  getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' }),
  DOMParser: class { parseFromString() { return { querySelectorAll: () => [] }; } },
  URL, URLSearchParams, console
};
win.window = win; win.self = win; win.document = doc; win.chrome = chrome;
win.location = { href: 'https://www.youtube.com/watch?v=A' };

const ctx = vm.createContext(win);
vm.runInContext(fs.readFileSync('content/content.js', 'utf8'), ctx, { filename: 'content.js' });
const vmWindow = vm.runInContext('window', ctx);

const toPage = (type, data) => {
  (listeners.window.message || []).forEach((f) => f({ source: vmWindow, data: { ns: 'ytst', dir: 'p2c', type, data } }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 每句约 60 字符。把 batchChars 设得极大，让「行数」先到上限，
   批次大小就正好等于当前档位的行数，断言才好写。 */
function track(n) {
  return JSON.stringify({
    events: Array.from({ length: n }, (_, i) => ({
      tStartMs: i * 2000, dDurationMs: 2000,
      segs: [{ utf8: 'Sentence number ' + i + ' says something quite ordinary here.' }]
    }))
  });
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

/* 逐行照抄回去，模拟一个完全守规矩的模型 */
const cleanReply = async (m) => {
  const map = {};
  for (const l of m.payload.lines) map[String(l.id)] = 'ZH:' + l.text;
  return { ok: true, map, dropped: [], repaired: 0, split: 0 };
};

const sizes = () => sent.filter((m) => m.type === 'translateBatch').map((m) => m.payload.lines.length);

async function feed(videoId, n) {
  toPage('player', { videoId, title: videoId, audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(40);
  toPage('track', { videoId, url: 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=en&kind=asr', body: track(n) });
  await sleep(500);
}

(async () => {
  await sleep(30);
  await chrome.storage.local.set({
    settings: {
      targetLang: '简体中文', apiKey: 'x', concurrency: 1,
      batchLines: 20, batchChars: 1000000, useCache: false, lookahead: 100000
    }
  });
  await sleep(30);

  console.log('\n[1] 一直很干净：批次应当自己变大');
  sent.length = 0;
  runtimeReply = cleanReply;
  await feed('B1', 500);

  const s1 = sizes();
  check('确实发出了多批', s1.length >= 7, JSON.stringify(s1));
  check('头三批还是基准的 20 行', s1.slice(0, 3).every((n) => n === 20), JSON.stringify(s1));
  check('第 4 批起升到 30 行（20 × 1.5）', s1[3] === 30, JSON.stringify(s1));
  check('再干净三批就升到 40 行（20 × 2）', s1.includes(40), JSON.stringify(s1));
  check('40 行封顶，不会无限往上涨', s1.every((n) => n <= 40), JSON.stringify(s1));

  console.log('\n[2] 后端报错位：立刻回落，而且不再试那一档');
  sent.length = 0;
  let nth = 0;
  runtimeReply = async (m) => {
    nth++;
    const r = await cleanReply(m);
    if (nth === 4) r.split = 1;   // 第 4 批正好是刚升到 30 行的那一批
    return r;
  };
  await feed('B2', 500);

  const s2 = sizes();
  check('出事的那一批确实是 30 行', s2[3] === 30, JSON.stringify(s2));
  check('出事之后回落到 20 行', s2[4] === 20, JSON.stringify(s2));
  // 末尾那一批是整条字幕剩下的零头，天然比档位小，所以是 <= 而不是 ==
  check('从此再没升上去过', s2.slice(4).every((n) => n <= 20), JSON.stringify(s2));

  console.log('\n[3] 网络错误不该被当成「批次太大」');
  sent.length = 0;
  let nth3 = 0;
  runtimeReply = async (m) => {
    nth3++;
    if (nth3 === 2) return { ok: false, error: 'HTTP 429: rate limited' };   // 没有 split 字段
    return cleanReply(m);
  };
  await feed('B3', 500);

  const s3 = sizes();
  check('限流之后批次仍然长得上去', s3.some((n) => n > 20), JSON.stringify(s3));

  console.log('[4] 拖进度条：过程中一个请求都不发');
  /* 每句 2 秒。lookahead 收窄一点，免得一上来就把整条视频排进候选。 */
  await chrome.storage.local.set({
    settings: {
      targetLang: '简体中文', apiKey: 'x', concurrency: 1,
      batchLines: 20, batchChars: 1000000, useCache: false, lookahead: 40
    }
  });
  await sleep(40);

  playerEl = makeEl('div');
  videoEl = makeEl('video');
  videoEl.currentTime = 0;

  sent.length = 0;
  runtimeReply = cleanReply;
  await feed('B4', 400);
  check('正常播放时确实在翻', sizes().length > 0, String(sizes().length));

  /* 模拟拖动：连续把播放头甩到很远的地方，每次都跨过几十句。
     每两跳之间只等 60ms，远小于 SEEK_SETTLE(1200ms)。 */
  sent.length = 0;
  for (const t of [400, 120, 700, 250, 900, 60, 500]) {
    videoEl.currentTime = t;
    await sleep(60);
  }
  const during = sizes().length;
  check('拖动过程中一个请求都没发', during === 0, '发了 ' + during + ' 个');

  // 松手停稳，超过 SEEK_SETTLE 之后应当补上
  await sleep(1600);
  const after = sizes().length;
  check('停稳之后照常翻当前位置', after > 0, '发了 ' + after + ' 个');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
