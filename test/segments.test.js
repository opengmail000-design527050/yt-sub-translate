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
vm.runInContext(fs.readFileSync(__dirname + '/../content/content.js', 'utf8'), ctx, { filename: 'content.js' });
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

console.log('\n[5] 自动字幕（无标点）不能按 cue 边界切');
{
  /* YouTube 的自动字幕一条 cue 只有两三个词，而 cue 边界只是「每两三个词换一屏」
     的显示节奏。修复前这里拿它当句子边界，每一句都被切在半截上、平均只有 33 字符，
     模型拿到的全是残缺短语。现在只在真的停顿处断开。 */
  const words = ('so the question I keep coming back to is what intelligence really is and whether '
    + 'we would even recognise it if we saw it in a machine because the definitions we have are '
    + 'circular and honestly not very useful when you try to apply them').split(' ');
  const evs = [];
  // 滚动字幕：每条 cue 三个词，首尾严格相接，中间没有任何停顿
  for (let i = 0; i < words.length; i += 3) evs.push(cue((i / 3) * 1500, 1500, words.slice(i, i + 3).join(' ')));

  const segs = segsOf(evs);
  const lens = segs.map((s) => s.text.length);
  const avg = lens.reduce((a, b) => a + b, 0) / segs.length;

  check('段数远少于 cue 数', segs.length < evs.length / 4, segs.length + ' 段 / ' + evs.length + ' 条 cue');
  check('平均长度到得了 80 字符以上（修复前只有 33）', avg > 80, '平均 ' + Math.round(avg) + ' 字符');
  check('没有短到只剩几个词的碎片', Math.min(...lens) > 40, JSON.stringify(lens));
  check('原文一个字都没丢', segs.map((s) => s.text).join(' ') === words.join(' '),
        JSON.stringify(segs.map((s) => s.text)));
  check('时间严格递增且不重叠',
        segs.every((s, i) => s.end > s.start && (i === 0 || s.start >= segs[i - 1].end - 0.01)),
        JSON.stringify(segs.map((s) => [s.start.toFixed(1), s.end.toFixed(1)])));
}

console.log('\n[6] 无标点时，真的停顿了还是要断开');
{
  const evs = [
    cue(0, 1500, 'okay so here is'), cue(1500, 1500, 'the first thought'),
    cue(3000, 1500, 'I wanted to share'),
    // 4.5 秒说完，下一句 8 秒才开口 —— 中间 3.5 秒静音
    cue(8000, 1500, 'and now something'), cue(9500, 1500, 'completely different')
  ];
  const segs = segsOf(evs);
  check('停顿处断成了两段', segs.length === 2, JSON.stringify(segs.map((s) => s.text)));
  check('第二段从静音之后才开始', segs[1] && segs[1].start > 7, JSON.stringify(segs.map((s) => s.start)));
  check('第一段没被拖到静音里', segs[0] && segs[0].end < 7, JSON.stringify(segs.map((s) => s.end)));
}

console.log('\n[7] 有标点的轨不受影响：仍按句号切');
{
  /* 句子都写得够长，避免被 MIN_CHARS 那条「太短就并进下一句」的规则合并掉 ——
     那是原有行为，跟这次改动无关。 */
  const segs = segsOf([
    cue(0, 2000, 'So the question I keep'), cue(2000, 2000, 'coming back to is what intelligence really is.'),
    cue(4000, 2000, 'That turns out to be a much harder'), cue(6000, 2000, 'question than anybody expected.')
  ]);
  check('按句号切成两句', segs.length === 2, JSON.stringify(segs.map((s) => s.text)));
  check('每句都以句号结尾', segs.every((s) => /[.!?]$/.test(s.text)), JSON.stringify(segs.map((s) => s.text)));
  check('切在句号处而不是 cue 边界',
        segs[0].text === 'So the question I keep coming back to is what intelligence really is.',
        JSON.stringify(segs[0].text));
}

console.log('\n[8] 小数点、版本号、价格不能当成句子结束');
{
  /* 修复前是「见点就断」：GPT-4.5 切成 "GPT-4." + "5"，$3.50 切成 "$3." + "50"，
     Python 3.12 切成 "Python 3." + "12"。切坏的半截既直接显示在屏幕上、也直接发给
     模型翻，而且第 3 步合并短句时会在接缝补一个空格（"GPT-4. 5"），原文哈希跟着变，
     缓存也一起弄脏。科技访谈里这三样满地都是。 */
  const segs = segsOf([
    cue(0, 3000, 'We benchmarked GPT-4.5 against Claude and the difference was striking.'),
    cue(3000, 3000, 'It costs $3.50 per million tokens, and Python 3.12 helps quite a lot here.')
  ]);
  const all = segs.map((s) => s.text).join(' || ');
  check('GPT-4.5 没被切开', /GPT-4\.5/.test(all), all);
  check('$3.50 没被切开', /\$3\.50/.test(all), all);
  check('Python 3.12 没被切开', /Python 3\.12/.test(all), all);
  check('没有句子以「数字 + 句点」结尾', !segs.some((s) => /\d\.$/.test(s.text)), all);
  check('接缝处没有被塞进多余空格', !/\d\. \d/.test(all), all);
  check('仍然按真正的句号切成两句', segs.length === 2, all);
}

console.log('\n[9] 句号后面确实跟着空格时照常切');
{
  /* 上一条的收紧不能矫枉过正：正常的句子边界必须还认得出来。 */
  const segs = segsOf([
    cue(0, 2000, 'The first sentence is long enough to stand on its own here.'),
    cue(2000, 2000, 'The second sentence is also long enough to stand alone.')
  ]);
  check('按句号切成两句', segs.length === 2, JSON.stringify(segs.map((s) => s.text)));

  // 结尾的句号（后面什么都没有）也算句子结束
  const one = segsOf([cue(0, 2000, 'Just one complete sentence that ends right here.')]);
  check('末尾句号算句子结束', one.length === 1 && /here\.$/.test(one[0].text),
        JSON.stringify(one.map((s) => s.text)));

  // 引号收尾
  const q = segsOf([
    cue(0, 2000, 'And then he said "this is the whole point of it."'),
    cue(2000, 2000, 'Everybody in the room went completely quiet after that.')
  ]);
  check('引号收尾的句子也切得开', q.length === 2, JSON.stringify(q.map((s) => s.text)));
}

console.log('\n[10] 被跳过的句点不能把它前面的文字弄丢');
{
  /* 旧正则靠开头那段 [^.!?…。！？]* 保证两次匹配首尾相接。改成只扫标点之后，
     如果不自己拿游标接住中间的文字，被跳过的那个点前面的一整段就会掉在两次匹配
     之间被无声丢掉 —— 屏幕上少半句话，而且没有任何报错。 */
  const src = 'The number 3.14 shows up everywhere in this field. And 2.71 does too, as it happens.';
  const segs = segsOf([cue(0, 4000, src)]);
  const joined = segs.map((s) => s.text).join(' ');
  check('原文一个字都没丢', joined === src, JSON.stringify(joined));
  check('3.14 完整', /3\.14/.test(joined), joined);
  check('2.71 完整', /2\.71/.test(joined), joined);
}

console.log('\n[11] findIndex 不该让上一句多赖 0.35 秒');
{
  /* buildSegments 把每句的 end 拉到下一句的 start，句子之间首尾相接。修复前线性
     查找带着 +0.35 的容差从 curIdx 往后扫，播放头已经进了下一句，上一句仍然满足
     条件而且先命中 —— 顺序播放时每一次换句都固定晚半拍，声音到了下一句，字幕还
     挂着上一句。 */
  const segs = segsOf([
    cue(0, 2000, 'The first sentence is long enough to stand on its own here.'),
    cue(2000, 2000, 'The second sentence is also long enough to stand alone.'),
    cue(4000, 2000, 'The third sentence rounds the whole thing off nicely.')
  ]);
  T.st.segments = segs;

  T.st.curIdx = 0;
  check('刚跨进第二句就切过去', T.findIndex(segs[1].start + 0.05) === 1,
        'got ' + T.findIndex(segs[1].start + 0.05));
  check('第二句中段仍是第二句', T.findIndex((segs[1].start + segs[1].end) / 2) === 1);
  check('第一句自己的区间里还是第一句', T.findIndex(segs[0].start + 0.1) === 0);

  // 顺序播放：每 0.1 秒走一步，每一刻都该落在包含它的那一句上
  T.st.curIdx = 0;
  let wrong = 0;
  for (let t = 0; t < segs[segs.length - 1].end; t += 0.1) {
    const want = segs.findIndex((s) => t >= s.start && t < s.end);
    if (want < 0) continue;
    const got = T.findIndex(t);
    if (got !== want) wrong++;
    T.st.curIdx = got;                 // 跟真实播放一样，下一次从这里接着找
  }
  check('整段顺序播放没有一刻落错句', wrong === 0, wrong + ' 处落错');

  // 容差还得留着：句子之间真有空档时，上一句应当继续留在屏幕上
  const gapped = segsOf([
    cue(0, 2000, 'Something is said here and it runs a little while before stopping.'),
    cue(30000, 2000, 'And then much later somebody finally says something else again.')
  ]);
  T.st.segments = gapped;
  T.st.curIdx = 0;
  check('空档里保留上一句', T.findIndex(gapped[0].end + 0.2) === 0,
        'got ' + T.findIndex(gapped[0].end + 0.2));
  T.st.segments = [];
  T.st.curIdx = -1;
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
