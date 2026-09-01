/* 把扩展打进 dist/：node tools/build.mjs
 *
 * 只有内容脚本需要「打包」这一步 —— 它不能是 ES 模块（Chrome 的 content script 只
 * 认普通脚本），可我们又想让它跟 background、popup、options 共用 common.js 里的
 * DEFAULTS 和 FONT_STACKS。以前的办法是在 content 里手抄一份，改默认值要记得同步
 * 三处，忘一处就是「设置页显示的和实际生效的不一样」——最难查的那种 bug。
 *
 * 其余文件原样复制。开发时加载的是 dist/ 这个目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/* 原样进包的东西。白名单，不是黑名单：哪天多一个 notes.md 或者 .env，
 * 黑名单会让它一路跟进商店包。 */
const COPY = [
  'manifest.json',
  'common.js',
  'background.js',
  'content/inject.js',
  'content/overlay.css',
  'popup',
  'options',
  'icons',
  '_locales'
];
const SKIP = /(^|\/)(make-icons\.js|\.DS_Store|.*\.map)$/;

const rel = (p) => p.split(path.sep).join('/');

function copy(src, out) {
  const abs = path.join(root, src);
  if (!fs.existsSync(abs)) return 0;
  if (fs.statSync(abs).isFile()) {
    if (SKIP.test(rel(src))) return 0;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(abs, out);
    return 1;
  }
  let n = 0;
  for (const name of fs.readdirSync(abs)) n += copy(path.join(src, name), path.join(out, name));
  return n;
}

// 每次从头来：留着上一次的产物，删掉一个源文件之后包里还会有它
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

let files = 0;
for (const p of COPY) files += copy(p, path.join(dist, p));

const out = path.join(dist, 'content', 'content.js');
await esbuild.build({
  entryPoints: [path.join(root, 'content', 'src', 'index.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome116',        // 跟 manifest 里的 minimum_chrome_version 一致
  charset: 'utf8',
  legalComments: 'inline',
  outfile: out
});
files += 1;

const size = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`dist/  ${files} 个文件 · content.js ${size} KB`);
