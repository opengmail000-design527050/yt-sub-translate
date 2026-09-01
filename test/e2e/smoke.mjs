/* 端到端冒烟：真的 Chrome、真的扩展、真的 chrome.storage，只有 YouTube 和模型接口是假的。
 *
 * 单元测试全绿也可能装不起来 —— manifest 写错一个路径、打包漏一个文件、内容脚本在真
 * 浏览器里第一行就抛异常，桩环境统统看不见。这四条就是为了堵这个洞：
 *   冷启动、切视频、换字幕轨、限流恢复。
 *
 * 跑法：npm run e2e（需要先 npx playwright install chromium）
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playerHtml, CUES } from './fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ext = path.join(root, 'dist');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 假接口的账本 ---- */
const api = { calls: [], lines: [], mode: 'ok', rateLeft: 0 };

/* 扩展只有「完整版 Chromium」装得起来：默认那个 headless shell 根本不支持扩展。
   channel: 'chromium' 就是要那一个（Playwright 的新版无头模式）。 */
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--no-first-run'
  ]
});

/* 页面和扩展后台的请求都从这里过 */
await ctx.route('https://www.youtube.com/watch**', async (route) => {
  const url = new URL(route.request().url());
  const v = url.searchParams.get('v') || 'X';
  const tracks = v === 'MULTI'
    ? [{ lang: 'en', kind: 'asr' }, { lang: 'ja' }]
    : [{ lang: 'en', kind: 'asr' }];
  await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: playerHtml(v, tracks) });
});

await ctx.route('https://www.youtube.com/api/timedtext**', async (route) => {
  const url = new URL(route.request().url());
  const lang = url.searchParams.get('lang') || 'en';
  const word = lang === 'ja' ? 'Bravo' : (url.searchParams.get('v') || 'Alpha');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CUES(word)) });
});

await ctx.route('https://api.openai.com/**', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  const user = String((body.messages && body.messages[1] && body.messages[1].content) || '');
  const items = user.split('\n').filter((l) => /^\d+\|/.test(l));
  api.calls.push({ n: items.length, at: Date.now() });
  items.forEach((l) => api.lines.push(l));

  if (api.rateLeft > 0) {
    api.rateLeft--;
    await route.fulfill({ status: 429, headers: { 'Retry-After': '1' },
                          contentType: 'application/json',
                          body: JSON.stringify({ error: { message: 'slow down' } }) });
    return;
  }
  const content = items.map((l) => {
    const [n, ...rest] = l.split('|');
    return n + '|译:' + rest.join('|').slice(0, 20);
  }).join('\n');
  await route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });
});

/* ---- 找到扩展 id，并把设置写进去 ---- */
async function extensionId() {
  for (let i = 0; i < 40; i++) {
    const sw = ctx.serviceWorkers()[0];
    if (sw) return new URL(sw.url()).host;
    const bg = ctx.backgroundPages()[0];
    if (bg) return new URL(bg.url()).host;
    await sleep(250);
  }
  return '';
}

// 打开一个扩展页面就会把 service worker 拉起来
const boot = await ctx.newPage();
await boot.goto('https://www.youtube.com/watch?v=BOOT').catch(() => {});
await sleep(1500);
const id = await extensionId();
if (!id) {
  console.log('  FAIL 扩展没有加载起来（service worker 没出现）');
  console.log('\n结果：0 通过 / 1 失败');
  await ctx.close();
  process.exit(1);
}
console.log('扩展 id:', id);

const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${id}/options/options.html`);
await opts.evaluate(() => chrome.storage.local.set({
  settings: {
    apiKey: 'sk-e2e', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna',
    targetLang: '简体中文', enabled: true, autoStart: true, concurrency: 2,
    useCache: false, batchLines: 8, batchChars: 100000, lookahead: 100
  }
}));
await opts.close();
await boot.close();

const box = '#ytst-overlay .ytst-trans';

console.log('\n[1] 冷启动：装上就能翻');
{
  api.calls.length = 0; api.lines.length = 0;
  const page = await ctx.newPage();
  await page.goto('https://www.youtube.com/watch?v=Alpha');
  await page.waitForSelector('#ytst-overlay', { timeout: 15000 }).catch(() => {});
  ok('字幕框出现在播放器里', await page.locator('#ytst-overlay').count() > 0);
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && el.textContent && el.textContent.indexOf('译:') === 0;
  }, box, { timeout: 20000 }).catch(() => {});
  const text = await page.locator(box).textContent().catch(() => '');
  ok('字幕框里真的出现了译文', String(text).startsWith('译:'), String(text).slice(0, 40));
  ok('确实把行发去翻了', api.calls.length > 0, JSON.stringify(api.calls.length));
  // 按钮是每秒一次的巡逻装上去的，给它一轮时间
  const btn = await page.waitForSelector('#movie_player .ytst-btn', { timeout: 6000 })
    .then(() => true).catch(() => false);
  ok('播放器上多了那个「译」按钮', btn);
  await page.close();
}

console.log('\n[2] 切视频：旧视频的行不再往外发');
{
  const page = await ctx.newPage();
  await page.goto('https://www.youtube.com/watch?v=Charlie');
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && el.textContent && el.textContent.indexOf('译:') === 0;
  }, box, { timeout: 20000 }).catch(() => {});
  api.lines.length = 0;
  await page.goto('https://www.youtube.com/watch?v=Delta');
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && el.textContent && el.textContent.indexOf('译:') === 0;
  }, box, { timeout: 20000 }).catch(() => {});
  ok('切过去之后翻的是新视频的句子', api.lines.some((l) => l.includes('Delta')),
     api.lines.slice(0, 2).join(' / '));

  /* 「切走的那一刻正在飞的那几个请求」不算 —— 它们在浏览器掐断之前就已经到了假接口。
     要验的是方案里那条：切视频 2 秒之后，不该再有属于上一个视频的新请求。 */
  await sleep(2000);
  api.lines.length = 0;
  await sleep(3000);
  ok('切走 2 秒之后不再有属于上一个视频的新请求',
     !api.lines.some((l) => l.includes('Charlie')),
     api.lines.filter((l) => l.includes('Charlie')).slice(0, 2).join(' / '));
  await page.close();
}

console.log('\n[3] 换字幕轨：跟着用户的选择走');
{
  const page = await ctx.newPage();
  await page.goto('https://www.youtube.com/watch?v=MULTI');
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && el.textContent && el.textContent.indexOf('译:') === 0;
  }, box, { timeout: 20000 }).catch(() => {});
  api.lines.length = 0;
  await page.evaluate(() => window.__pickTrack('ja', ''));
  await sleep(5000);
  ok('换轨之后翻的是新轨的句子', api.lines.some((l) => l.includes('Bravo')),
     api.lines.slice(0, 2).join(' / '));
  await page.close();
}

console.log('\n[4] 限流：不用人点，自己会回来');
{
  const page = await ctx.newPage();
  api.rateLeft = 3;                 // 前三次一律 429
  api.lines.length = 0;
  await page.goto('https://www.youtube.com/watch?v=Rate');
  const got = await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && el.textContent && el.textContent.indexOf('译:') === 0;
  }, box, { timeout: 30000 }).then(() => true).catch(() => false);
  ok('撞了三次 429 之后自己翻出来了（没人点重试）', got);
  ok('确实重发过', api.calls.length > 3, '共 ' + api.calls.length + ' 次');
  await page.close();
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
await ctx.close();
process.exit(fail ? 1 : 0);
