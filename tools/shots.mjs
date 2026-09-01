/* 截几张能直接用的界面图：node tools/shots.mjs（需要先 npx playwright install chromium）
 *
 * 弹窗和设置页是真的界面，拍出来就能用；字幕框那张是在假播放页上拍的，
 * 只能自己看 —— 上架用的那张得在真视频上重拍（见 STORE.md）。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playerHtml, CUES } from '../test/e2e/fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'dist');
const out = path.join(root, 'build', 'shots');
fs.mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run']
});

await ctx.route('https://www.youtube.com/watch**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
                        body: playerHtml('SHOT', [{ lang: 'en', kind: 'asr' }]) });
});
await ctx.route('https://www.youtube.com/api/timedtext**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CUES('Shot')) });
});
await ctx.route('https://api.openai.com/**', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  const user = String((body.messages && body.messages[1] && body.messages[1].content) || '');
  const items = user.split('\n').filter((l) => /^\d+\|/.test(l));
  const content = items.map((l) => l.split('|')[0] + '|所以我一直绕回来的那个问题是，智能到底是什么。').join('\n');
  await route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content } }] }) });
});

const warm = await ctx.newPage();
await warm.goto('https://www.youtube.com/watch?v=SHOT').catch(() => {});
await sleep(1500);
const sw = ctx.serviceWorkers()[0];
const id = sw ? new URL(sw.url()).host : '';
if (!id) { console.error('扩展没加载起来'); await ctx.close(); process.exit(1); }

const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${id}/options/options.html`);
await opts.evaluate(() => chrome.storage.local.set({
  settings: { apiKey: 'sk-demo', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna',
              targetLang: '简体中文', enabled: true, autoStart: true, useCache: false }
}));
await opts.setViewportSize({ width: 1280, height: 900 });
await opts.reload();
await sleep(600);
await opts.screenshot({ path: path.join(out, 'options.png') });
await opts.close();

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 320, height: 460 });
await popup.goto(`chrome-extension://${id}/popup/popup.html`);
await sleep(600);
await popup.screenshot({ path: path.join(out, 'popup.png') });
await popup.close();

const page = await ctx.newPage();
await page.setViewportSize({ width: 900, height: 520 });
await page.goto('https://www.youtube.com/watch?v=SHOT');
await page.waitForFunction(() => {
  const el = document.querySelector('#ytst-overlay .ytst-trans');
  return el && el.textContent && el.textContent.length > 4;
}, null, { timeout: 20000 }).catch(() => {});
await sleep(400);
await page.locator('#movie_player').screenshot({ path: path.join(out, 'subtitle-box.png') });
await page.close();
await warm.close();

console.log('截图在 ' + path.relative(root, out) + '：popup.png / options.png / subtitle-box.png');
console.log('字幕框那张是假播放页，上架前请在真视频上重拍（见 STORE.md）。');
await ctx.close();
