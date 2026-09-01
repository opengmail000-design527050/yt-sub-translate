/* 语言包别漏键。
 *
 * 界面文案的取法是 t('key', '中文兜底')：拿不到翻译就显示代码里那句中文。
 * 好处是永远不会变成空白，坏处是漏一条根本看不出来 —— 英文界面下会突然蹦出一句
 * 中文，而写代码的人（中文界面）永远遇不到。所以在这里机械地对一遍：
 * 代码和 HTML 里出现过的每一个 key，_locales/en 里都必须有；反过来，
 * 语言包里也不该留着已经没人用的键。
 */
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SRC = ['common.js', 'background.js', 'popup/popup.js', 'options/options.js']
  .concat(fs.readdirSync(path.join(root, 'content', 'src')).map((f) => 'content/src/' + f));
const HTML = ['popup/popup.html', 'options/options.html'];

const used = new Map();          // key -> 出现在哪个文件
for (const p of SRC) {
  const s = read(p);
  for (const m of s.matchAll(/[^\w]t\(\s*'([A-Za-z0-9_]+)'/g)) used.set(m[1], p);
}
for (const p of HTML) {
  const s = read(p);
  for (const m of s.matchAll(/data-i18n(?:-title|-ph)?="([A-Za-z0-9_]+)"/g)) used.set(m[1], p);
}
// manifest 里的 __MSG_x__ 走的是另一条路（没有代码兜底），漏了直接显示原样
for (const m of read('manifest.json').matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.set(m[1], 'manifest.json');

const en = JSON.parse(read('_locales/en/messages.json'));
const zh = JSON.parse(read('_locales/zh_CN/messages.json'));

console.log('\n[1] 英文包覆盖到每一个 key');
{
  const missing = [...used.keys()].filter((k) => !en[k] || !en[k].message);
  check('一条都没漏（共 ' + used.size + ' 个 key）', missing.length === 0,
        missing.map((k) => k + ' ← ' + used.get(k)).join(', '));
}

console.log('\n[2] 语言包里没有已经没人用的键');
{
  const stale = Object.keys(en).filter((k) => !used.has(k));
  check('英文包没有多余的键', stale.length === 0, stale.join(', '));
  const staleZh = Object.keys(zh).filter((k) => !used.has(k));
  check('中文包没有多余的键', staleZh.length === 0, staleZh.join(', '));
}

console.log('\n[3] manifest 用到的键，两种语言都得有');
{
  const need = [...read('manifest.json').matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]);
  check('manifest 确实用了 __MSG__', need.length > 0, JSON.stringify(need));
  check('中文包齐全（default_locale 是它，缺了就显示原样）',
        need.every((k) => zh[k] && zh[k].message), JSON.stringify(need.filter((k) => !zh[k])));
  check('英文包齐全', need.every((k) => en[k] && en[k].message));
}

console.log('\n[4] 占位符对得上');
{
  /* $1 $2 是按位置替换的。译文里的占位符不能比原文多 —— 多出来的那个永远填不上，
     会原样出现在界面上。 */
  const bad = [];
  for (const [k, v] of Object.entries(en)) {
    const n = Math.max(0, ...[...String(v.message).matchAll(/\$(\d)/g)].map((m) => Number(m[1])));
    if (n > 4) bad.push(k + ' 用到了 $' + n);
  }
  check('没有离谱的占位符编号', bad.length === 0, bad.join(', '));
}

console.log('\n[5] 英文包里不该出现中文');
{
  const cjk = Object.entries(en).filter(([, v]) => /[一-鿿]/.test(v.message)).map(([k]) => k);
  check('没有漏翻的条目', cjk.length === 0, cjk.join(', '));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
