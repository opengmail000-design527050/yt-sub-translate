/* 系统提示的约束清单。
 *
 * 提示词是按「次」付的 —— 一批 20 句时它占输入的四成，所以压缩它一直有诱惑。
 * 危险在于：删掉一条约束，多半不会有任何东西变红，你要在几十个视频之后才会
 * 隐约觉得译文哪里不对。「意思留在本行」那条尤其如此 —— 模型只要把 N 个编号
 * 都给全、内容整体挪一位，translateChunk 里 missing 就是空的，这一批照样记成
 * 干净，对齐统计一个数字都不会动。
 *
 * 所以有了这份清单：措辞随便怎么调，但这些约束一条都不能凭空消失。真要删掉
 * 某一条，就连着这里的断言一起删 —— 那才算一次明知故犯的决定，而不是一次
 * 没人注意到的丢失。
 *
 * 条目是字符串就按原文包含判，是正则就按正则判。 */
const fs = require('fs'), vm = require('vm');
const NL = String.fromCharCode(10);

const src = fs.readFileSync(__dirname + '/../background.js', 'utf8')
  .replace(/^import .*$/m, '')
  + NL + 'globalThis.__m = { buildSystemPrompt };';

const ctx = {
  console, DEFAULTS: {}, getSettings: async () => ({}),
  resolveTargetName: () => '简体中文', CODE_TO_NAME: { en: 'English' },
  hasApiPermission: async () => true, setTimeout, clearTimeout, AbortController, URL,
  fetch: async () => { throw new Error('no net'); },
  chrome: {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: { query: async () => [] },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }
  }
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

const build = (noPunct) =>
  ctx.__m.buildSystemPrompt({ targetLang: '简体中文', extraPrompt: '' }, 'en', noPunct, 'Some Video Title');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

const BASE = [
  ['输入格式 <n>|<text>',        '"<n>|<text>"'],
  ['输出格式 <n>|<translation>', '"<n>|<translation>"'],
  ['一行输入对一行输出',          /exactly one .* per input line/],
  ['编号一致',                   'same numbers'],
  ['顺序一致',                   'same order'],
  ['行数一致',                   'same count'],
  ['不许有多余内容',              'nothing else'],
  ['不许 markdown / 旁注',        'No markdown, no notes'],
  ['不许空行、不许缺行',          /never an empty or missing line/],
  ['CRITICAL 标记还在',           'CRITICAL'],
  ['说明了每行为什么必须自足',     /on screen alone at its own timestamp/],
  ['意思留在本行',                /Keep every line's meaning inside its own line/],
  ['不许把内容前后搬运',          /never carry content forward .* pull it back/],
  ['语序不同也不许搬',            /even when natural .* word order differs/],
  ['半截句仍是半截句',            /fragment stays a fragment/],
  ['连续对话、保持语域',          /Consecutive lines of one conversation/],
  ['不许把口语写成书面语',        'do not make casual speech sound formal'],
  ['自然简洁、一眼读完',          /natural, concise .* reads at a glance/],
  ['专名与缩写保持原样',          /Keep proper nouns, product names and established English acronyms/],
  ['标题只作领域线索、不许翻',     /Video title, for domain terminology only/]
];

const ASR = [
  ['点明这是语音识别结果',        /raw speech recognition/],
  ['要求自己补标点',              /punctuate the .* properly/],
  ['明显听错的词可以改',          /misrecognised word's intent is obvious/],
  ['不明显的不许猜',              /where it is not, translate what is there/]
];

const has = (text, rule) =>
  typeof rule === 'string' ? text.includes(rule) : rule.test(text);

console.log('[1] 有标点的轨：基本约束一条都不能少');
{
  const p = build(false);
  for (const [name, rule] of BASE) ok(name, has(p, rule), p);
}

console.log('');
console.log('[2] 无标点的轨：基本约束照旧，另加语音识别那几条');
{
  const p = build(true);
  for (const [name, rule] of BASE) ok(name, has(p, rule));
  for (const [name, rule] of ASR) ok(name, has(p, rule), p);
}

console.log('');
console.log('[3] 有标点的轨不该白花这几句的 token');
{
  const p = build(false);
  for (const [name, rule] of ASR) ok('不含：' + name, !has(p, rule), p);
}

console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
