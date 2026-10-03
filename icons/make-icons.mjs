/* 生成图标 PNG：node icons/make-icons.mjs（需要先 npx playwright install chromium）
 *
 * 图形是一个浅粉色的对话气泡，中间一个深色播放键 ——「视频 + 有人在说话」。
 * 浅粉就是 Rosé Pine 的 rose（#ebbcba）。播放键不做镂空：气泡这么浅，镂空在浅色
 * 工具栏上几乎看不见，所以用一个深色把它压实。没有底板，纯色扁平，不用渐变和投影。
 * 跟 web-translate 那本灰粉的书是一家。
 *
 * 源文件是两份 SVG：
 *   icon.svg     32 / 48 / 128 共用
 *   icon-16.svg  工具栏那一格。16px 下按比例缩小会落在半个像素上，糊成一片，
 *                所以单独按像素网格画了一份，播放键的竖边压在整数像素上。
 * 用浏览器来栅格化，是因为仓库里本来就有 Playwright（e2e 和截图都靠它），
 * 不必再为这一件事要求装 rsvg / ImageMagick。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const svg = (f) => 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64');

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  const src = svg(size === 16 ? 'icon-16.svg' : 'icon.svg');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block}</style>` +
                        `<img src="${src}" width="${size}" height="${size}">`);
  await page.waitForFunction(() => document.images[0].complete);
  const out = path.join(dir, `icon${size}.png`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', path.relative(process.cwd(), out));
}
await browser.close();
