/* 验证「参考上下文」这件事：
 *   - 视频标题进系统提示，且页面来的文本先被抹平（不许伪造块头）
 *   - 前文带着译文、后文只带原文，两块都不编号（编号是唯一的对齐凭据）
 *   - 两块都按字符预算裁，但至少留一行
 *   - 补翻和格式重问不带参考块
 *   - 拆块时两半互为前后文，后半段还能拿到前半段刚翻好的译文
 * 用桩跑 background.js，不联网。 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};

/* ---- 把 background.js 装进沙箱 ---- */
function load(settings, reply) {
  const src = fs.readFileSync(__dirname + '/../background.js', 'utf8')
    .replace(/^import .*$/m, '')
    + '\nglobalThis.__t = { translateBatch, refBlocks, safeTitle };';

  const calls = [];
  const store = {};
  const base = {
    apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'm', targetLang: '简体中文',
    reasoning: 'none', reasoningStyle: 'off', temperature: '', maxTokens: '', extraPrompt: '',
    useContext: true
  };
  const ctx = {
    console,
    DEFAULTS: {},
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
      const body = JSON.parse(init.body);
      const user = body.messages[1].content;
      // 只认「编号|正文」的行 —— 参考块要是带了编号，这里的计数立刻就对不上
      const items = user.split('\n').filter((l) => /^\d+\|/.test(l));
      const mode = /上一次回复漏掉/.test(user) ? 'repair'
                 : /上一次回复没按格式/.test(user) ? 'strict' : '';
      calls.push({ n: items.length, mode, lines: items, user, system: body.messages[0].content });
      return { ok: true, status: 200, text: async () => JSON.stringify({
        choices: [{ message: { content: reply(items, mode, calls.length) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { api: ctx.__t, calls };
}

/* n 行输入，文本是 L1..Ln */
const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, text: 'L' + (i + 1) }));
/* 逐行照翻，译文是「译:原文」 */
const echo = (items) => items.map((l) => {
  const m = l.match(/^(\d+)\|(.*)$/);
  return `${m[1]}|译:${m[2]}`;
}).join('\n');

(async () => {

console.log('\n[1] 视频标题');
{
  const { api, calls } = load({}, echo);
  await api.translateBatch({ lines: mk(3), title: 'Rust 所有权', sourceLang: 'en', noPunct: true });
  ok('标题进了系统提示', /Video title.*"Rust 所有权"/.test(calls[0].system), calls[0].system.slice(-160));
  ok('明确交代了不许把标题译出来', /never translate or output it/.test(calls[0].system));
  ok('标题不出现在用户消息里', !/Rust 所有权/.test(calls[0].user));
}
{
  const { api, calls } = load({}, echo);
  await api.translateBatch({ lines: mk(3), sourceLang: 'en', noPunct: true });
  ok('没有标题就一个字都不提', !/Video title/.test(calls[0].system));
}
{
  const { api } = load({}, echo);
  const t = api.safeTitle;
  const messy = t('讲 [第 3 集] | 所有\n权');
  ok('方括号、竖线、换行都被抹平', messy === '讲 第 3 集 所有 权', JSON.stringify(messy));
  ok('超长标题截到 120 字', t('x'.repeat(300)).length === 120);
  ok('空标题给空串', t(null) === '' && t('   ') === '');
}

console.log('\n[2] 前文带译文、后文只带原文');
{
  const { api, calls } = load({}, echo);
  await api.translateBatch({
    lines: mk(3),
    prev: [{ text: 'we cached the keys', tr: '我们把 key 缓存了' }, { text: 'right', tr: '' }],
    next: ['so it scales linearly', 'which is the whole point'],
    sourceLang: 'en', noPunct: true
  });
  const u = calls[0].user;
  ok('前文以「原文 → 译文」给出', u.includes('we cached the keys → 我们把 key 缓存了'), u);
  ok('没有译文的前文只给原文', /^right$/m.test(u));
  ok('后文原样给出', u.includes('so it scales linearly') && u.includes('which is the whole point'));
  ok('前文块说了不要输出', /前文[\s\S]*?不要输出这里的任何一行/.test(u));
  ok('后文块说了这次不翻', /后文[\s\S]*?这次不翻/.test(u));
  ok('参考块一行都没编号，编号行仍是 3 行', calls[0].n === 3, '实际 ' + calls[0].n);
  ok('抬头写明了要翻几行', u.includes('[以下是需要翻译的 3 行，只输出这些行]'));
}

console.log('\n[3] 预算裁剪');
{
  const { api, calls } = load({}, echo);
  // 每句 100 个英文字符，预算 420 → 只留得下最近 4 句
  const long = (tag) => tag + 'x'.repeat(100 - tag.length);
  await api.translateBatch({
    lines: mk(2),
    prev: [1, 2, 3, 4, 5, 6].map((i) => ({ text: long('P' + i), tr: '' })),
    sourceLang: 'en', noPunct: true
  });
  const u = calls[0].user;
  ok('最近的一句在', u.includes(long('P6')));
  ok('最早的一句被裁掉', !u.includes(long('P1')));
  const kept = [1, 2, 3, 4, 5, 6].filter((i) => u.includes(long('P' + i)));
  ok('裁到 4 句以内', kept.length <= 4 && kept.length >= 3, '留了 ' + kept.length);
  ok('留下来的是挨着批次的那几句', kept[kept.length - 1] === 6 && kept[0] === 6 - kept.length + 1);
}
{
  const { api, calls } = load({}, echo);
  await api.translateBatch({
    lines: mk(2),
    prev: [{ text: 'Z'.repeat(900), tr: '' }],
    next: ['Y'.repeat(900)],
    sourceLang: 'en', noPunct: true
  });
  ok('单句超预算也至少留一句前文', calls[0].user.includes('Z'.repeat(900)));
  ok('后文同理', calls[0].user.includes('Y'.repeat(900)));
}

console.log('\n[4] 关掉上下文');
{
  const { api, calls } = load({ useContext: false }, echo);
  await api.translateBatch({
    lines: mk(3),
    prev: [{ text: 'we cached the keys', tr: '缓存了' }],
    next: ['so it scales'],
    title: 'Rust 所有权',
    sourceLang: 'en', noPunct: true
  });
  ok('一个参考块都不发', !/前文|后文/.test(calls[0].user), calls[0].user);
  ok('标题不受这个开关影响', /Video title.*"Rust 所有权"/.test(calls[0].system));
}

console.log('\n[5] 补翻和格式重问不带参考块');
{
  // 4 行里漏掉中间的第 2 行 —— 缺口没碰到两端，走补翻
  const drop2 = (items) => items.filter((l) => !/^2\|/.test(l))
    .map((l) => { const m = l.match(/^(\d+)\|(.*)$/); return `${m[1]}|译:${m[2]}`; }).join('\n');
  const { api, calls } = load({}, (items, mode) => (mode === 'repair' ? echo(items) : drop2(items)));
  await api.translateBatch({
    lines: mk(4),
    prev: [{ text: 'we cached the keys', tr: '缓存了' }],
    next: ['so it scales'],
    sourceLang: 'en', noPunct: true
  });
  ok('确实走了补翻', calls.length === 2 && calls[1].mode === 'repair', JSON.stringify(calls.map((c) => c.mode)));
  ok('补翻那次不带前文', !calls[1].user.includes('we cached the keys'));
  ok('补翻那次不带后文', !calls[1].user.includes('so it scales'));
  ok('系统提示两次一模一样', calls[1].system === calls[0].system);
}
{
  // 第一次完全不带编号 → 触发 strict 重问
  const { api, calls } = load({}, (items, mode, i) => (i === 1 ? '随便说点什么\n没有编号' : echo(items)));
  await api.translateBatch({
    lines: mk(3),
    prev: [{ text: 'we cached the keys', tr: '缓存了' }],
    next: ['so it scales'],
    sourceLang: 'en', noPunct: true
  });
  ok('确实走了格式重问', calls.length === 2 && calls[1].mode === 'strict', JSON.stringify(calls.map((c) => c.mode)));
  ok('重问那次不带参考块', !calls[1].user.includes('we cached the keys') && !calls[1].user.includes('so it scales'));
}

console.log('\n[6] 拆块时两半互为前后文');
{
  // 6 行只回 5 行 → 缺的是末行，edgeGap 成立，整块对半拆
  const short5 = (items) => items.slice(0, 5)
    .map((l, k) => `${k + 1}|译:${l.split('|')[1]}`).join('\n');
  const { api, calls } = load({}, (items, mode, i) => (i === 1 ? short5(items) : echo(items)));
  const r = await api.translateBatch({
    lines: mk(6),
    prev: [{ text: 'earlier line', tr: '早先那句' }],
    next: ['later line'],
    sourceLang: 'en', noPunct: true
  });
  ok('确实拆过块', r.split > 0, JSON.stringify(r));
  ok('拆成了两次请求', calls.length === 3, '共 ' + calls.length + ' 次');

  const head = calls[1], tail = calls[2];
  ok('前半段拿到 3 行', head.n === 3, '实际 ' + head.n);
  ok('前半段的后文是后半段的开头', head.user.includes('L4'), head.user);
  ok('前半段的前文还是原来那句', head.user.includes('earlier line → 早先那句'));

  ok('后半段拿到 3 行', tail.n === 3, '实际 ' + tail.n);
  ok('后半段的前文来自前半段', tail.user.includes('L3'), tail.user);
  ok('而且带着前半段刚翻好的译文', tail.user.includes('L3 → 译:L3'), tail.user);
  ok('后半段的后文还是原来那句', tail.user.includes('later line'));
  ok('两半合起来六行全翻出来了', Object.keys(r.map).length === 6, JSON.stringify(r.map));
}


console.log('\n[7] 有标点的轨不发后文');
{
  const { api, calls } = load({}, echo);
  await api.translateBatch({
    lines: mk(3),
    prev: [{ text: 'we cached the keys', tr: '缓存了' }],
    next: ['so it scales linearly'],
    sourceLang: 'en'                 // noPunct 缺省 = 这一轨有标点
  });
  const u = calls[0].user;
  ok('后文一个字都没发', !u.includes('so it scales linearly'), u);
  ok('后文块的抬头也没有', !u.includes('[后文'));
  ok('前文照发不误', u.includes('we cached the keys → 缓存了'));
  ok('抬头仍然写明了行数', u.includes('[以下是需要翻译的 3 行，只输出这些行]'));
}
{
  const { api, calls } = load({}, echo);
  await api.translateBatch({ lines: mk(3), next: ['so it scales linearly'], sourceLang: 'en', noPunct: true });
  ok('没标点的轨照发后文', calls[0].user.includes('so it scales linearly'));
  ok('只有后文时不该冒出前文块', !calls[0].user.includes('[前文'));
}
console.log('\n[9] 没有译文的前文，只发给无标点的轨');
{
  /* 带前文的本意是「让模型看见自己上一批把 agent 译成了什么」，靠的是译文。
     没有译文时这个理由不成立 —— 对有标点的轨，那就只是一段长得跟待翻行一模一样
     的英文旁白，白花 token 还多一次被误当成输入的机会。
     无标点的轨另当别论：批首那句是按停顿切的，很可能是半截话，需要知道它从哪儿
     来（跟后文块同一个道理），所以照发。 */
  const bare = [{ text: 'and then the whole thing just fell over', tr: '' }];

  {
    const { api, calls } = load({}, echo);
    await api.translateBatch({ lines: mk(3), prev: bare, sourceLang: 'en', noPunct: false });
    const u = calls[0].user;
    ok('有标点的轨：不发没译文的前文', !u.includes('and then the whole thing just fell over'), u);
    ok('前文块整个不出现', !u.includes('[前文'), u);
    // 没有任何参考块时，那句「以下是需要翻译的 N 行」也就没必要发了
    ok('连抬头都省掉了', !u.includes('[以下是需要翻译的'), u);
  }
  {
    const { api, calls } = load({}, echo);
    await api.translateBatch({ lines: mk(3), prev: bare, sourceLang: 'en', noPunct: true });
    const u = calls[0].user;
    ok('无标点的轨：照发', u.includes('and then the whole thing just fell over'), u);
    ok('前文块出现了', u.includes('[前文'), u);
  }
  {
    // 有译文的前文，两种轨都该发 —— 那才是带前文真正想要的东西
    const withTr = [{ text: 'we cached the keys', tr: '我们把 key 缓存了' }];
    for (const noPunct of [false, true]) {
      const { api, calls } = load({}, echo);
      await api.translateBatch({ lines: mk(3), prev: withTr, sourceLang: 'en', noPunct });
      ok('带译文的前文照发（noPunct=' + noPunct + '）',
         calls[0].user.includes('we cached the keys → 我们把 key 缓存了'), calls[0].user);
    }
  }
  {
    // 混着来：只留下带译文的那些，没译文的被滤掉
    const { api, calls } = load({}, echo);
    await api.translateBatch({
      lines: mk(3),
      prev: [{ text: 'translated line here', tr: '翻过的那句' }, { text: 'untranslated line here', tr: '' }],
      sourceLang: 'en', noPunct: false
    });
    const u = calls[0].user;
    ok('带译文的留下', u.includes('translated line here → 翻过的那句'), u);
    ok('没译文的滤掉', !u.includes('untranslated line here'), u);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
})();
