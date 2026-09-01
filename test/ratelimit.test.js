/* 限流退避：429 之后到底等多久、谁在等、恢复之后怎么办。
 * 用桩跑 background.js，不联网。时间是假的 —— 沙箱里的 setTimeout 不真等，
 * 只把「要求等多久」记下来并把假时钟推过去，断言看的就是这串数字。 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};

/* plan(n) 决定第 n 次请求怎么回：
 *   null                      正常返回一行译文
 *   { status, retryAfter? }   按这个状态码失败；retryAfter 原样写进响应头 */
function load(plan) {
  const src = fs.readFileSync(__dirname + '/../background.js', 'utf8')
    .replace(/^import .*$/m, '')
    + '\nglobalThis.__t = { translateBatch, rateWait, rateHit, rateClear, retryAfterMs };';

  const calls = [];        // 每次请求发生时，此前一共睡过几次
  const sleeps = [];       // 睡了多久（毫秒）
  let clock = 1700000000000;
  const store = {};

  const ctx = {
    console,
    DEFAULTS: {},
    getSettings: async () => ({
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', targetLang: '简体中文',
      reasoning: 'none', reasoningStyle: 'off', temperature: '', maxTokens: '', extraPrompt: '',
      useContext: false
    }),
    resolveTargetName: () => '简体中文',
    CODE_TO_NAME: { en: 'English' },
    hasApiPermission: async () => true,
    AbortController, URL,
    /* 90 秒那个取消闹钟也会走这里，按时长把它分出去：只有小于一分钟的才是退避睡眠。
       假时钟跟着睡眠往前走，冷却到期的判断才是真的在判断，不是在等墙上时间。 */
    setTimeout: (f, ms) => {
      if (ms > 0 && ms < 60000) { sleeps.push(ms); clock += ms; }
      return setTimeout(f, 0);
    },
    clearTimeout,
    Date: { now: () => clock, parse: Date.parse },
    chrome: {
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      tabs: { query: async () => [], onRemoved: { addListener() {} } },
      storage: { local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => Object.assign(store, o)
      } }
    },
    fetch: async () => {
      const p = plan(calls.length);
      calls.push({ afterSleeps: sleeps.length });
      if (p) {
        return {
          ok: false,
          status: p.status,
          headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? (p.retryAfter || null) : null) },
          text: async () => JSON.stringify({ error: { message: '慢一点' } })
        };
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ choices: [{ message: { content: '1|译文' } }] })
      };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { api: ctx.__t, calls, sleeps, advance: (ms) => { clock += ms; } };
}

const one = (extra) => Object.assign({ lines: [{ id: 1, text: 'hello' }] }, extra || {});

(async () => {
  console.log('\n[1] 连续 429：等的时间一次比一次长，而且不是固定 1.2 秒');
  {
    const r = load(() => ({ status: 429 }));
    const res = await r.api.translateBatch(one(), 1);
    ok('同一次请求里只为限流重来一次', r.calls.length === 2, '发了 ' + r.calls.length + ' 次');
    ok('第一级台阶是 2 秒', r.sleeps[0] === 2000, JSON.stringify(r.sleeps));
    ok('不再是原来那个固定 1.2 秒', !r.sleeps.includes(1200), JSON.stringify(r.sleeps));
    ok('报回前端的下一次等待翻了倍', res.retryAfter === 4000, JSON.stringify(res));
    ok('这一批算失败，但带着退避时间', res.ok === false && res.retryAfter > 0, JSON.stringify(res));
  }

  console.log('\n[2] 服务商给了 Retry-After 就听它的');
  {
    const r = load((n) => (n === 0 ? { status: 429, retryAfter: '7' } : null));
    const res = await r.api.translateBatch(one(), 1);
    ok('等的是它说的 7 秒，不是我们的台阶', r.sleeps[0] === 7000, JSON.stringify(r.sleeps));
    ok('等完就翻出来了', res.ok === true, JSON.stringify(res));
  }

  console.log('\n[3] Retry-After 也可能是一个日期');
  {
    const r = load(() => null);
    const at = new Date(1700000000000 + 9000).toUTCString();
    ok('日期形式也认得', Math.abs(r.api.retryAfterMs({ headers: { get: () => at } }) - 9000) < 1000,
       String(r.api.retryAfterMs({ headers: { get: () => at } })));
    ok('没有这个头就是 0', r.api.retryAfterMs({ headers: { get: () => null } }) === 0);
    ok('封顶 30 秒，不会被一个离谱的值挂住',
       r.api.retryAfterMs({ headers: { get: () => '86400' } }) === 30000);
  }

  console.log('\n[4] 冷却期内的批次排队，不再各自去撞');
  {
    /* 并发 3 的真实场景：第一批撞上 429 立好冷却，另外两批不该再去撞一次，
       而是等冷却过去。以前是每批各睡 1.2 秒各撞一次，三批一起变成「翻译出错」。 */
    const r = load(() => null);                     // 这一批自己不会撞上什么
    r.api.rateHit('https://api.example.com/v1/chat/completions', 5000);   // 隔壁那批刚撞上
    const res2 = await r.api.translateBatch(one(), 1);
    ok('一个请求都还没发就先睡了 5 秒', r.calls.length === 1 && r.calls[0].afterSleeps === 1,
       JSON.stringify({ sleeps: r.sleeps, calls: r.calls }));
    ok('等的正是冷却剩下的时间', r.sleeps[0] === 5000, JSON.stringify(r.sleeps));
    ok('排完队照常翻出来，没有变成失败', res2.ok === true, JSON.stringify(res2));
  }

  console.log('\n[5] 恢复之后台阶清零');
  {
    const r = load((n) => (n === 0 || n === 2 ? { status: 429 } : null));
    await r.api.translateBatch(one(), 1);           // 撞一次（台阶升到 2 秒）、等完、成功
    const first = r.sleeps.slice();
    await r.api.translateBatch(one(), 1);           // 再撞一次：应该还是从 2 秒起
    const second = r.sleeps.slice(first.length);
    ok('第一次撞是 2 秒', first[0] === 2000, JSON.stringify(first));
    ok('隔了一阵再撞，仍然从 2 秒起而不是接着 4 秒', second[0] === 2000, JSON.stringify(second));
  }

  console.log('\n[6] 5xx 照旧走原来那条重试路，不受退避影响');
  {
    const r = load((n) => (n === 0 ? { status: 503 } : null));
    const res = await r.api.translateBatch(one(), 1);
    ok('重试了一次就成功', r.calls.length === 2 && res.ok === true, JSON.stringify(res));
    ok('用的是 5xx 自己那个 1.2 秒', r.sleeps.includes(1200), JSON.stringify(r.sleeps));
  }

  console.log('\n[7] 401 这类配置错误不该被拖进退避');
  {
    const r = load(() => ({ status: 401 }));
    const res = await r.api.translateBatch(one(), 1);
    ok('只发一次', r.calls.length === 1, '发了 ' + r.calls.length + ' 次');
    ok('不给退避时间（等多久都没用）', !res.retryAfter, JSON.stringify(res));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
