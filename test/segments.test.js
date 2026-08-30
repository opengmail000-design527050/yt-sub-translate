/* 切句与时间轴。重点：长静音处下一句不能提前冒出来。 */
const fs = require('fs'), vm = require('vm');

const noop = () => {};
const makeEl = () => ({
  style: { setProperty: noop, removeProperty: noop },
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  dataset: {}, textContent: '', innerHTML: '', value: '',
  appendChild: (c) => c, insertBefore: (c) => c, remove: noop,
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  setAttribute: noop, getAttribute: () => null,
  getBoundingClientRect: () => ({ width: 800, height: 450, left: 0, top: 0 })
});
const doc = {
  documentElement: makeEl(), head: makeEl(), body: makeEl(), createElement: makeEl,
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener: noop, removeEventListener: noop,
  createRange: () => ({ selectNodeContents: noop, getClientRects: () => [] })
};
const win = {
  __YTST_TEST__: {},
  addEventListener: noop, removeEventListener: noop, postMessage: noop,
  getSelection: () => null, requestAnimationFrame: () => 0,
  setTimeout: (f) => setTimeout(f, 0), setInterval: () => 0, clearTimeout, clearInterval,
  getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' }),
  DOMParser: class { parseFromString() { return { querySelectorAll: () => [] }; } },
  console, document: doc,
  chrome: {
    runtime: { getURL: (p) => p, sendMessage: async () => ({ ok: false }), onMessage: { addListener: noop } },
    storage: {
      local: { async get() { return {}; }, async set() {}, async remove() {}, async getBytesInUse() { return 0; } },
      onChanged: { addListener: noop }
    },
    i18n: { getUILanguage: () => 'zh-CN' }
  },
  location: { href: 'https://www.youtube.com/watch?v=A' }
};
win.window = win; win.self = win;
const ctx = vm.createContext(win);
vm.runInContext(fs.readFileSync('content/content.js', 'utf8'), ctx, { filename: 'content.js' });
const T = vm.runInContext('window.__YTST_TEST__', ctx);

const segsOf = (events) => T.buildSegments(T.parseJson3(JSON.stringify({ events })));
const cue = (startMs, durMs, text) => ({ tStartMs: startMs, dDurationMs: durMs, segs: [{ utf8: text }] });

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

/* 句子边界落在 cue 之间的空格上，而空格算作上一条 cue 的尾巴。
   修复前这里第三句的 start 会被算成第二句的 end（5.5 秒），
   于是 60 秒静音期间字幕框一直挂着还没说出口的下一句。 */
console.log('\n[1] 长静音：下一句不能提前显示');
{
  const segs = segsOf([
    cue(1000, 2000, 'Welcome back to the channel everyone.'),
    cue(3000, 2500, 'Today we are going to look at something quite unusual.'),
    cue(66000, 3000, 'So that was the demo you just watched in silence.')
  ]);
  check('切出三句', segs.length === 3, JSON.stringify(segs));
  const last = segs[segs.length - 1];
  check('静音后那句的 start 贴着真实说话时间', Math.abs(last.start - 66) < 0.3,
        'start=' + last.start);
  check('前一句在静音里最多多留 1.2 秒', segs[1].end <= segs[1].start + 3.9,
        JSON.stringify(segs[1]));
  const gapEmpty = segs.every((s) => !(30 >= s.start && 30 < s.end));
  check('静音正中间没有任何一句是「当前句」', gapEmpty, JSON.stringify(segs));
}

console.log('\n[2] 一条 cue 里跨句号也要各归各的时间');
{
  const segs = segsOf([
    cue(0, 4000, 'First sentence here. Second sentence follows right after.'),
    cue(40000, 3000, 'And much later comes the third one after a long pause.')
  ]);
  check('第三句仍然对齐到 40 秒', Math.abs(segs[segs.length - 1].start - 40) < 0.3,
        JSON.stringify(segs));
}

console.log('\n[3] 无标点的自动字幕：时间仍按 cue 边界走');
{
  const segs = segsOf([
    cue(0, 2000, 'okay so this is the thing we were talking about earlier today'),
    cue(50000, 2000, 'and here we are again after quite a while of nothing at all')
  ]);
  const last = segs[segs.length - 1];
  check('静音后那句不提前', last.start > 45, JSON.stringify(segs));
}

console.log('\n[4] 连续说话时不该被切出空档');
{
  const evs = [];
  for (let i = 0; i < 12; i++) evs.push(cue(i * 2500, 2500, 'This is line number ' + i + ' spoken without any pause at all.'));
  const segs = segsOf(evs);
  let holes = 0;
  for (let i = 0; i < segs.length - 1; i++) if (segs[i + 1].start - segs[i].end > 1.4) holes++;
  check('相邻句之间没有明显空档', holes === 0, holes + ' 处空档 / ' + segs.length + ' 句');
  check('时间严格递增', segs.every((s, i) => s.end > s.start && (i === 0 || s.start >= segs[i - 1].start)),
        JSON.stringify(segs));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
