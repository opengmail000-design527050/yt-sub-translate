/* 让正在运行的 Chrome 重载「加载已解压」的这份 dist/：node tools/reload.mjs
 *
 * 需要先 npm run dev（只有开发构建里才有 dev.html）。原理是在已经开着的浏览器里
 * 打开 chrome-extension://<ID>/dev.html，那一页只做一件事：chrome.runtime.reload()。
 * 扩展一重载，那个标签页也跟着关掉。已经开着的 YouTube 页面里内容脚本还是旧的，
 * 要自己刷新一下。
 *
 * ID 是按目录的绝对路径算的（没有 manifest.key 的时候）：sha256 取前 32 个十六进制位，
 * 0-f 映射到 a-p。浏览器按下面的顺序找第一个能启动的，别的用 CHROME=... 指定。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

if (!fs.existsSync(path.join(dist, 'dev.html'))) {
  console.error('dist/ 不是开发构建：先跑 npm run dev');
  process.exit(1);
}
if (JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')).key) {
  console.error('manifest 里有 key，ID 不是按路径算的，这个脚本算不出来');
  process.exit(1);
}

const hex = createHash('sha256').update(dist).digest('hex').slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const BINS = process.env.CHROME ? [process.env.CHROME]
  : ['google-chrome', 'google-chrome-stable', '/opt/google/chrome/chrome', 'chromium'];
const url = `chrome-extension://${id}/dev.html`;
// 浏览器已经开着时这条命令只是把地址交给它，自己马上就退出
const bin = BINS.find((b) => !spawnSync(b, [url], { stdio: 'ignore', timeout: 10000 }).error);
if (!bin) { console.error('找不到 Chrome，用 CHROME=/path/to/chrome 指定'); process.exit(1); }
console.log(`已让 Chrome 重载 ${id}（${bin}）`);
