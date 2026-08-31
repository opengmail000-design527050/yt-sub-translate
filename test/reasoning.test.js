/* 「测试连接」要如实报出推理这块的真相：
 *   - 这次请求到底发出去了哪几个推理字段（四种写法各不相同）
 *   - 模型实际烧了多少推理 token（各家放在 usage 的不同位置）
 *   - 取不到就要报 null，绝不能拿 0 冒充「确实没推理」—— 那正好把
 *     「设了关闭却还在推理」这个最该报的问题盖掉了。
 * 用桩跑 background.js，不联网。 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};

/**
 * settings —— 覆盖到默认设置上
 * usage    —— 让服务商回这一份 usage
 * 返回 { res, body }：body 是真正发出去的请求体
 */
function run(settings, usage) {
  const src = fs.readFileSync(__dirname + '/../background.js', 'utf8')
    .replace(/^import .*$/m, '')
    + '\nglobalThis.__t = { testApi };';

  let sentBody = null;
  const store = {};
  const base = {
    apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna',
    targetLang: '简体中文', reasoning: 'none', reasoningStyle: 'effort_none',
    temperature: '', maxTokens: '', extraPrompt: '', useContext: true
  };
  const ctx = {
    console,
    DEFAULTS: base,
    getSettings: async () => Object.assign({}, base, settings || {}),
    resolveTargetName: () => '简体中文',
    CODE_TO_NAME: { en: 'English' },
    hasApiPermission: async () => true,
    setTimeout, clearTimeout, AbortController, URL,
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      tabs: { query: async () => [] },
      storage: { local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => Object.assign(store, o)
      } }
    },
    fetch: async (url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({
        choices: [{ message: { content: '1|所以问题是，什么是智能？\n2|是啊，这问题很难。' } }],
        usage: usage === undefined ? { prompt_tokens: 120, completion_tokens: 30 } : usage
      }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.__t.testApi({}).then((res) => ({ res, body: sentBody }));
}

(async () => {
  /* ---------------------------------------------------------------- *
   * 四种写法，各自到底发了什么
   * ---------------------------------------------------------------- */
  console.log('\n[1] reasoning_effort 含 "none"：三档都真发出去');
  let { res, body } = await run({ reasoningStyle: 'effort_none', reasoning: 'none' });
  ok('请求体里确实带了 reasoning_effort:"none"', body.reasoning_effort === 'none', JSON.stringify(body.reasoning_effort));
  ok('报告里如实列出这个字段', res.reasoning.sent.reasoning_effort === 'none', JSON.stringify(res.reasoning.sent));
  ok('档位报「none」', res.reasoning.level === 'none', res.reasoning.level);
  ok('写法报「effort_none」', res.reasoning.style === 'effort_none', res.reasoning.style);
  ok('模型名也带出来', res.model === 'gpt-5.6-luna', res.model);

  console.log('\n[2] reasoning_effort 关闭时不发字段：报告必须显示「什么都没发」');
  ({ res, body } = await run({ reasoningStyle: 'effort', reasoning: 'none' }));
  ok('请求体里确实没有 reasoning_effort', !('reasoning_effort' in body), JSON.stringify(body));
  ok('报告里也是空的', Object.keys(res.reasoning.sent).length === 0, JSON.stringify(res.reasoning.sent));

  ({ res, body } = await run({ reasoningStyle: 'effort', reasoning: 'low' }));
  ok('但档位不是关闭时照发', res.reasoning.sent.reasoning_effort === 'low', JSON.stringify(res.reasoning.sent));

  console.log('\n[3] enable_thinking 风格：连 thinking_budget 一起报');
  ({ res } = await run({ reasoningStyle: 'enable_thinking', reasoning: 'low' }));
  ok('enable_thinking 为 true', res.reasoning.sent.enable_thinking === true, JSON.stringify(res.reasoning.sent));
  ok('带上了 thinking_budget 512', res.reasoning.sent.thinking_budget === 512, JSON.stringify(res.reasoning.sent));

  ({ res } = await run({ reasoningStyle: 'enable_thinking', reasoning: 'none' }));
  ok('关闭时 enable_thinking 为 false', res.reasoning.sent.enable_thinking === false, JSON.stringify(res.reasoning.sent));
  ok('关闭时不带 thinking_budget', !('thinking_budget' in res.reasoning.sent), JSON.stringify(res.reasoning.sent));

  console.log('\n[4] 从不发送：哪一档都不发');
  ({ res, body } = await run({ reasoningStyle: 'off', reasoning: 'medium' }));
  ok('请求体干干净净', !('reasoning_effort' in body) && !('enable_thinking' in body), JSON.stringify(body));
  ok('报告里也是空的', Object.keys(res.reasoning.sent).length === 0, JSON.stringify(res.reasoning.sent));

  /* ---------------------------------------------------------------- *
   * 实际烧了多少推理 token —— 各家放的位置不一样
   * ---------------------------------------------------------------- */
  console.log('\n[5] 推理 token 的三种回报位置都要认得');
  ({ res } = await run({}, { prompt_tokens: 100, completion_tokens: 400,
                             completion_tokens_details: { reasoning_tokens: 320 } }));
  ok('completion_tokens_details.reasoning_tokens', res.reasoning.used === 320, String(res.reasoning.used));

  ({ res } = await run({}, { input_tokens: 100, output_tokens: 400,
                             output_tokens_details: { reasoning_tokens: 256 } }));
  ok('output_tokens_details.reasoning_tokens', res.reasoning.used === 256, String(res.reasoning.used));

  ({ res } = await run({}, { prompt_tokens: 100, completion_tokens: 400, reasoning_tokens: 88 }));
  ok('顶层 reasoning_tokens', res.reasoning.used === 88, String(res.reasoning.used));

  console.log('\n[6] 服务商没回报时必须是 null，不能是 0');
  ({ res } = await run({}, { prompt_tokens: 100, completion_tokens: 30 }));
  ok('取不到就报 null', res.reasoning.used === null, JSON.stringify(res.reasoning.used));
  ok('而不是 0（0 会被当成「确实没推理」，把问题盖掉）', res.reasoning.used !== 0, JSON.stringify(res.reasoning.used));

  ({ res } = await run({}, null));
  ok('整个 usage 都没有也不炸', res.ok === true && res.reasoning.used === null, JSON.stringify(res.reasoning));

  console.log('\n[7] 真的推理了就要报出来（设置页据此告警）');
  ({ res } = await run({ reasoning: 'none', reasoningStyle: 'effort' },
                       { prompt_tokens: 100, completion_tokens: 500,
                         completion_tokens_details: { reasoning_tokens: 470 } }));
  ok('档位是关闭', res.reasoning.level === 'none', res.reasoning.level);
  ok('却烧了 470 个推理 token', res.reasoning.used === 470, String(res.reasoning.used));
  ok('而且这次什么推理字段都没发出去', Object.keys(res.reasoning.sent).length === 0, JSON.stringify(res.reasoning.sent));

  console.log('\n[8] 连通性本身照旧');
  ({ res } = await run({}));
  ok('ok 为 true', res.ok === true);
  ok('有耗时', typeof res.ms === 'number');
  ok('有样例译文', /智能/.test(res.sample), res.sample);
  ok('usage 原样带回', res.usage && res.usage.prompt_tokens === 120, JSON.stringify(res.usage));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
