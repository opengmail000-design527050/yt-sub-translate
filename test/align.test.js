/* 验证「模型合并相邻行导致整体错位」被挡住，而不是补翻几行了事。
 * 用桩跑 background.js，不联网。 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};

/* ---- 把 background.js 装进沙箱 ---- */
function load(reply, http) {
  const src = fs.readFileSync(__dirname + '/../background.js', 'utf8')
    .replace(/^import .*$/m, '')
    + '\nglobalThis.__t = { translateBatch, edgeGap };';

  const calls = [];
  const store = {};
  const ctx = {
    console,
    DEFAULTS: {},
    getSettings: async () => ({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'm', targetLang: '简体中文', reasoning: 'none', reasoningStyle: 'off', temperature: '', maxTokens: '', extraPrompt: '', useContext: false }),
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
      const items = user.split('\n').filter((l) => /^\d+\|/.test(l));
      const isRepair = /上一次回复漏掉/.test(user);
      calls.push({ n: items.length, isRepair, lines: items, user });
      // http 桩：模拟 401 / 网络中断这类跟译文格式无关的失败
      if (http) {
        const h = http(calls.length);
        if (h && h.throw) throw new Error(h.throw);
        if (h) return { ok: false, status: h.status, text: async () => h.body || '' };
      }
      const content = reply(items, isRepair, calls.length);
      return { ok: true, status: 200, text: async () => JSON.stringify({
        choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 }
      }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { api: ctx.__t, calls };
}

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, text: 'L' + (i + 1) }));
/* 老老实实逐行翻 */
const honest = (items) => items.map((l) => {
  const [n, ...rest] = l.split('|');
  return n + '|译' + rest.join('|');
}).join('\n');
/* 把第 k、k+1 行并成一句，之后每行都往前顶一位 —— 用户看到的「中文比英文快一句」 */
const mergeAt = (k) => (items) => {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (i === k) { out.push('译' + items[i].split('|')[1] + ' ' + items[i + 1].split('|')[1]); i++; }
    else out.push('译' + items[i].split('|')[1]);
  }
  return out.map((t, i) => (i + 1) + '|' + t).join('\n');
};

(async () => {
  console.log('\n[1] edgeGap：缺口碰到任一端 = 编号整体平移');
  const { api: probe } = load(honest);
  ok('缺末行（合并前移）', probe.edgeGap([{ n: 9 }, { n: 10 }], 10));
  ok('缺首行（编号从 2 起）', probe.edgeGap([{ n: 1 }], 10));
  ok('中间的窟窿是真漏译，不算', probe.edgeGap([{ n: 4 }, { n: 7 }], 10) === false);
  ok('一行不缺不算', probe.edgeGap([], 10) === false);

  console.log('\n[2] 模型死活要合并：宁可一行不交，也不能交错位的');
  {
    const { api, calls } = load((items) => (items.length > 1 ? mergeAt(0)(items) : honest(items)));
    const r = await api.translateBatch({ lines: mk(8) });
    ok('拆过块了，不是补翻一次就交差', calls.length > 2);
    ok('整批判失败，前端才会给重试入口', r.ok === false);
    ok('带上原因', /错位/.test(r.error || ''));
  }

  console.log('\n[2b] 只有一半治不好：好的照交，坏的整块丢');
  {
    // 含第一行的块永远被合并，其余老实翻
    const { api } = load((items) => (items.length > 1 && /\|L1$/.test(items[0]) ? mergeAt(0)(items) : honest(items)));
    const r = await api.translateBatch({ lines: mk(8) });
    ok('后半段照常交付', Object.keys(r.map).length > 0);
    ok('没有任何一行是两句并出来的', Object.values(r.map).every((t) => !t.includes(' ')));
    ok('治不好的那几行进 dropped，只显示原文', (r.dropped || []).length > 0);
    ok('每一行要么有译文要么被丢掉，不会凭空少', Object.keys(r.map).length + r.dropped.length === 8);
  }

  console.log('\n[3] 拆小之后模型正常了：应当自愈，不该整批丢掉');
  {
    // 第一次整批合并，之后（块变小）老实翻
    const { api, calls } = load((items, isRepair, nth) => (nth === 1 ? mergeAt(3)(items) : honest(items)));
    const r = await api.translateBatch({ lines: mk(8) });
    ok('八行全部翻出来了', Object.keys(r.map).length === 8);
    ok('没有合并句', Object.values(r.map).every((t) => !t.includes(' ')));
    ok('没有行被丢掉', (r.dropped || []).length === 0);
    ok('确实是靠拆块救回来的', calls.length >= 3);
  }

  console.log('\n[4] 中间漏译：仍然走单独补翻，别浪费钱去拆块');
  {
    const { api, calls } = load((items, isRepair) => {
      if (isRepair) return honest(items);
      return items.map((l, i) => (i === 2 ? '' : (i + 1) + '|译' + l.split('|')[1])).filter(Boolean).join('\n');
    });
    const r = await api.translateBatch({ lines: mk(6) });
    ok('只发了两次请求（原批 + 补翻）', calls.length === 2);
    ok('第二次是补翻', calls[1].isRepair === true);
    ok('六行齐了', Object.keys(r.map).length === 6);
    ok('repaired 记了一笔', r.repaired === 1);
  }

  console.log('\n[5] 模型整批交白卷：报失败，别声称成功');
  {
    const { api } = load(() => '');
    const r = await api.translateBatch({ lines: mk(5) });
    ok('ok=false', r.ok === false);
    ok('带上原因', !!r.error);
  }

  console.log('\n[6] 合并 + 末尾多一句废话：不能被「顺序补齐」糊过去');
  {
    // 合并了一次（少一行），又多带一行没编号的说明 —— 行数正好又对上了
    const { api } = load((items, isRepair, nth) => {
      if (nth > 1) return honest(items);
      return mergeAt(2)(items) + '\n（以上共 ' + (items.length - 1) + ' 行）';
    });
    const r = await api.translateBatch({ lines: mk(8) });
    ok('没把那句说明当译文塞进最后一行', Object.values(r.map || {}).every((t) => !/以上共/.test(t)));
    ok('识别成错位并拆块重来了', Object.keys(r.map || {}).length === 8);
    ok('没有合并句', Object.values(r.map || {}).every((t) => !t.includes(' ')));
  }

  console.log('\n[7] 模型一个编号都不带：不能拿「行数正好相等」照单全收');
  {
    /* 复核里点名的绕过路径：合并第 2、3 句（少一行），末尾补一句「以上共 N 行」（多一行），
     * 行数原样对上。旧代码的无编号兜底会按顺序全盘接收，整批错位还写进缓存。 */
    const strip = (items) => mergeAt(1)(items).split('\n').map((l) => l.split('|')[1])
      .concat('（以上共 ' + (items.length - 1) + ' 行）').join('\n');
    const { api } = load(strip);
    const r = await api.translateBatch({ lines: mk(6) });
    ok('整批判失败，不交出无法校验的对齐', r.ok === false);
    ok('那句说明没被当成译文', !JSON.stringify(r.map || {}).includes('以上共'));
  }

  console.log('\n[8] 头一次没按格式，严格重问一次能救回来');
  {
    const { api, calls } = load((items, isRepair, nth) =>
      (nth === 1 ? items.map((l) => '译' + l.split('|')[1]).join('\n') : honest(items)));
    const r = await api.translateBatch({ lines: mk(6) });
    ok('第二次把格式要求说死了', !!calls[1] && /必须输出正好/.test(calls[1].user), '请求数=' + calls.length);
    ok('六行都翻出来了', Object.keys(r.map || {}).length === 6);
    ok('只多花了一次请求', calls.length === 2);
  }

  console.log('\n[9] 编号整体从 2 开始：不能拿剩下的行去凑第一行');
  {
    // 第一次把编号整体 +1（末尾那个超范围的会掉进 leftovers），之后老实翻
    const { api } = load((items, isRepair, nth) => (nth > 1 ? honest(items)
      : items.map((l, i) => (i + 2) + '|译' + l.split('|')[1]).join('\n')));
    const r = await api.translateBatch({ lines: mk(6) });
    ok('六行齐了（靠拆块重来，不是靠猜）', Object.keys(r.map || {}).length === 6);
    ok('每一行都是自己那句', Object.entries(r.map || {}).every(([id, t]) => t === '译L' + (Number(id) - 99)));
  }

  console.log('\n[10] 中间缺号 + 末尾一句没编号的说明：不许拿它去补洞');
  {
    /* 复核里点名的场景：模型把第 2、3 句并成一句（缺号 3 夹在中间，不碰两端），
     * 末尾又补一句没编号的说明。旧代码「剩余行数正好等于缺失数」就顺序填，
     * 于是那句说明被当成第 3 句的译文摆上屏幕，还整批写进缓存。 */
    const { api } = load((items, isRepair, nth) => {
      if (isRepair) return honest(items);
      if (nth > 1) return honest(items);
      const out = ['1|译L1', '2|译L2 L3', '4|译L4', '5|译L5', '6|译L6', '（以上共 5 行）'];
      return out.join('\n');
    });
    const r = await api.translateBatch({ lines: mk(6) });
    const all = Object.values(r.map || {});
    ok('那句说明没被当成任何一句的译文', all.every((t) => !/以上共/.test(t)));
    ok('第 3 句要么补翻回来、要么只显示原文', !r.map || !/以上共/.test(r.map['102'] || ''));
    ok('缺的那句走的是严格补翻', (r.repaired || 0) + (r.dropped || []).length > 0);
  }

  console.log('\n[11] HTTP 401：认输，别重试也别严格重问');
  {
    const { api, calls } = load(honest, () => ({ status: 401, body: '{"error":{"message":"bad key"}}' }));
    const r = await api.translateBatch({ lines: mk(6) });
    ok('只发了一次请求', calls.length === 1, '请求数=' + calls.length);
    ok('如实报失败', r.ok === false);
    ok('错误里带得上 401', /401/.test(r.error || ''), r.error);
  }

  console.log('\n[12] 网络中断：postJson 自己重试一次就够，不该再叠一轮严格重问');
  {
    const { api, calls } = load(honest, () => ({ throw: 'network down' }));
    const r = await api.translateBatch({ lines: mk(6) });
    ok('总共两次（postJson 的一次重试），不是四次', calls.length === 2, '请求数=' + calls.length);
    ok('如实报失败', r.ok === false);
  }

  console.log('\n[13] 500：仍然该重试，这类是暂时的');
  {
    let n = 0;
    const { api, calls } = load(honest, () => (++n === 1 ? { status: 500, body: 'oops' } : null));
    const r = await api.translateBatch({ lines: mk(6) });
    ok('重试之后成功了', r.ok === true, JSON.stringify(r.error || ''));
    ok('一共两次请求', calls.length === 2, '请求数=' + calls.length);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
