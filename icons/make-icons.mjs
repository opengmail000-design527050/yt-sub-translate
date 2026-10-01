/* 生成图标 PNG：node icons/make-icons.mjs（需要先 npx playwright install chromium）
 *
 * 图形是深色圆角底 + 一个粉色字幕气泡，气泡里两行：上面淡的是原文，下面实的是译文 ——
 * 跟播放器里字幕框「原文小、译文大」是同一套主次。
 *
 * 源文件是两份 SVG：
 *   icon.svg     32 / 48 / 128 共用
 *   icon-16.svg  工具栏那一格。16px 下按比例缩小的线条会落在半个像素上，糊成一片灰，
 *                所以单独按像素网格画了一份，横线都压在整数像素上。
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
