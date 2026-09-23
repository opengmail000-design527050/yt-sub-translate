/* 验证「批次自适应」这件事：
 *   - 连续几批干干净净就把批次调大（那 250 token 的系统提示是按次付的）
 *   - 一出现错位立刻回落，而且不再试那一档
 *   - 网络层的错误不算数，不该拖累批次大小
 * 用桩跑 content.js，不联网、不碰真实存储。 */
const vm = require('vm');

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
vm.runInContext(require('./bundle')(), ctx, { filename: 'content.js' });
const vmWindow = vm.runInContext('window', ctx);

/* 注入时内容脚本会现生成一个随机 token 挂在 script 标签上，之后只认带这个 token
   的消息（防页面脚本伪造字幕）。桩得把它找出来一起带上。 */
const pageToken = () => {
  const el = (doc.head.children || []).find((c) => c && c.dataset && c.dataset.ytstToken);
  return el ? el.dataset.ytstToken : '';
};
const toPage = (type, data, token) => {
  const t = token === undefined ? pageToken() : token;
  (listeners.window.message || []).forEach((f) =>
    f({ source: vmWindow, data: { ns: 'ytst', dir: 'p2c', type, data, token: t } }));
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
const ask = () => new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'getStatus' }, {}, res)));

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
  /* 第一句还没有译文、用户正看着「···」：先切 6 句的小首批，一两秒就回来；
     同一批剩下的 14 句紧跟着发。首批不参与升档，14 句那批照常算一批。 */
  check('开头先发 6 句的小首批，同一批剩下的紧跟着发', s1[0] === 6 && s1[1] === 14, JSON.stringify(s1));
  check('之后还是基准的 20 行', s1.slice(2, 4).every((n) => n === 20), JSON.stringify(s1));
  check('连着三批干净（首批不算）就升到 30 行（20 × 1.5）', s1[4] === 30, JSON.stringify(s1));
  check('再干净三批就升到 40 行（20 × 2）', s1.includes(40), JSON.stringify(s1));
  check('40 行封顶，不会无限往上涨', s1.every((n) => n <= 40), JSON.stringify(s1));

  console.log('\n[2] 单次错位：立刻回落，但不判死刑');
  /* 原来是「一次错位就永久封顶」。可封顶的代价极不对称：档位每个视频都从 0 重新
     起步，tier 已经是 0 时再错一次，整个视频就锁死在 20 句/批 —— 两小时的访谈会
     从 33 次请求涨到 62 次，光固定开销就多烧约一万五千 token。而模型偶尔把相邻
     两句并成一句本来就是常态，一次远不足以断定这一档不行。
     现在回落照旧是一次就回落（便宜且可逆），永久封顶要连着两次。 */
  sent.length = 0;
  let nth = 0;
  runtimeReply = async (m) => {
    nth++;
    const r = await cleanReply(m);
    if (nth === 5) r.split = 1;   // 第 5 个请求（首批之后第 4 批）正好是刚升到 30 行的那一批
    return r;
  };
  await feed('B2', 500);

  const s2 = sizes();
  check('出事的那一批确实是 30 行', s2[4] === 30, JSON.stringify(s2));
  check('出事之后立刻回落到 20 行', s2[5] === 20, JSON.stringify(s2));
  check('偶发一次不封顶，后面还能再升上去', s2.slice(6).some((n) => n > 20), JSON.stringify(s2));

  console.log('\n[2b] 连着两批错位：这才认定这一档不行，永久封顶');
  sent.length = 0;
  let nth2 = 0;
  runtimeReply = async (m) => {
    nth2++;
    const r = await cleanReply(m);
    // 第 5 个请求是刚升到 30 行的那一批；紧接着的第 6 个（已回落到 20）再错一次
    if (nth2 === 5 || nth2 === 6) r.split = 1;
    return r;
  };
  await feed('B2b', 500);

  const s2b = sizes();
  check('第 5 个请求是 30 行', s2b[4] === 30, JSON.stringify(s2b));
  check('第 6 个请求已经回落到 20 行', s2b[5] === 20, JSON.stringify(s2b));
  // 末尾那一批是整条字幕剩下的零头，天然比档位小，所以是 <= 而不是 ==
  check('连错两次之后从此再没升上去过', s2b.slice(6).every((n) => n <= 20), JSON.stringify(s2b));

  console.log('\n[2c] 中间隔了干净批次，两次错位不该累加');
  sent.length = 0;
  let nth3b = 0;
  runtimeReply = async (m) => {
    nth3b++;
    const r = await cleanReply(m);
    if (nth3b === 5 || nth3b === 10) r.split = 1;   // 两次之间隔着好几批干净的
    return r;
  };
  await feed('B2c', 500);

  const s2c = sizes();
  check('两次都是偶发，最终仍能升上去', s2c.slice(11).some((n) => n > 20), JSON.stringify(s2c));

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

  /* 最后落在 500 秒 = 第 250 句，正好在 [240, 259] 这一批的中间。原来要等模型把
     整批 20 句（包括刚跳过的 240~249）翻完才一起回来；现在播放头前 2 句之前的切掉，
     从这里起先发一个小首批。 */
  const firstAfter = sent.filter((m) => m.type === 'translateBatch')[0];
  const ids = firstAfter ? firstAfter.payload.lines.map((l) => l.id) : [];
  check('停稳之后第一个请求从播放头前 2 句起', ids[0] === 248, JSON.stringify(ids));
  check('而且是个小首批（前 2 句 + 往后 6 句）', ids.length === 8, JSON.stringify(ids));
  check('刚跳过的 240~247 没有抢在前面', !sent.some((m) => m.type === 'translateBatch' &&
        m.payload.lines.some((l) => l.id >= 240 && l.id < 248)), JSON.stringify(sizes()));

  console.log('\n[5] 限流：带退避时间的失败自己回到队列，不用人点重试');
  {
    /* 服务商的配额按分钟算。以前 429 之后这一批就是 err，字幕框写「翻译出错」，
       要用户去弹窗点重试 —— 而他什么也做不了，只能等。现在 background 把「还要等
       多久」报回来，这一批自己回来。桩里的计时器按 1/50 压缩，2 秒退避 = 40 毫秒。 */
    let limited = 0;
    runtimeReply = async (m) => {
      if (m.type !== 'translateBatch') return { ok: true };
      // 前两批撞上限流，之后恢复正常
      if (limited < 2) { limited++; return { ok: false, error: 'HTTP 429: 慢一点', retryAfter: 2000 }; }
      return cleanReply(m);
    };
    videoEl.currentTime = 0;              // [4] 把播放头留在了 500 秒，这条字幕只有 120 秒长
    sent.length = 0;
    await feed('B5', 60);
    const st1 = await ask();
    check('撞上限流时说的是「稍后自动重试」，不是干巴巴一句出错',
          /自动重试/.test(st1.error || '') || st1.translated === st1.segments,
          JSON.stringify({ error: st1.error, translated: st1.translated }));

    await sleep(600);
    const st2 = await ask();
    check('没有人点任何按钮，字幕自己补齐了', st2.translated === st2.segments,
          JSON.stringify({ translated: st2.translated, segments: st2.segments }));
    check('确实为此重发过', sizes().length > 2, '共发了 ' + sizes().length + ' 批');
    check('最后没有留下错误', !st2.error, String(st2.error));
  }

  console.log('\n[6] 一直限流也不会没完没了地重试');
  {
    runtimeReply = async (m) => (m.type === 'translateBatch'
      ? { ok: false, error: 'HTTP 429: 慢一点', retryAfter: 2000 }
      : { ok: true });
    sent.length = 0;
    await feed('B6', 40);
    await sleep(1200);
    const n = sizes().length;
    check('次数有封顶（不会把电池耗干）', n > 1 && n <= 20, '共发了 ' + n + ' 批');
    const stx = await ask();
    check('最后老老实实报错，用户还能自己点重试', stx.status === 'error' && !!stx.error,
          JSON.stringify(stx));
  }

  console.log('\n[7] 从上次看到的地方续播：先翻播放头那里，不是视频开头');
  {
    /* 字幕到达时 schedule 先于 render 被调用，curIdx 还是 -1；两句之间的长静音里
       它也是 -1。原来这两种情况都按第 0 句排批次 —— 续播到 20 分钟处，第一批请求
       翻的却是片头，还占着并发名额。 */
    runtimeReply = cleanReply;
    videoEl.currentTime = 600;            // 每句 2 秒：第 300 句
    sent.length = 0;
    await feed('B7', 400);
    const first = sent.filter((m) => m.type === 'translateBatch')[0];
    const ids = first ? first.payload.lines.map((l) => l.id) : [];
    check('第一个请求就在播放头附近', ids.length > 0 && ids[0] >= 290 && ids[0] <= 300, JSON.stringify(ids));
    check('片头一句都没翻', !sent.some((m) => m.type === 'translateBatch' &&
          m.payload.lines.some((l) => l.id < 250)), JSON.stringify(sizes()));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
