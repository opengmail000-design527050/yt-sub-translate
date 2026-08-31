/* background 的缓存索引队列。索引是「读出来 → 改 → 写回去」，而写入方不止一个：
 * 每个 YouTube 标签页都在写，设置页清空缓存时也在写。以前各写各的，后写的把先写的
 * 整个盖掉 —— 丢了索引的那些缓存正文从此没人清理（淘汰只遍历索引里的键），
 * 存储只增不减。现在只在 background 里改，而且串成一条队列。
 * 用桩跑 background.js，不联网、不碰真实存储。 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

/* 这个桩有两处必须跟真的 chrome.storage 一样，否则测不出并发覆盖：
 *   1. get/set 各让出一次事件循环 —— 覆盖正是发生在「读完还没写回」这个空档里；
 *   2. get 返回的是一份独立副本 —— 真实存储要过一遍序列化，两个调用方各拿各的。
 *      桩要是把同一个对象交出去，两边改的其实是同一份，怎么并发都不会丢东西，
 *      测试就会在没有队列的情况下照样全绿。 */
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function load(initial) {
  const src = fs.readFileSync(__dirname + '/../background.js', 'utf8')
    .replace(/^import .*$/m, '')
    + '\nglobalThis.__t = { cacheIndexOp, staleKeys };';

  const store = Object.assign({}, initial);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ctx = {
    console, DEFAULTS: {},
    getSettings: async () => ({}),
    resolveTargetName: () => '简体中文',
    CODE_TO_NAME: {}, hasApiPermission: async () => true,
    setTimeout, clearTimeout, AbortController, URL, fetch: async () => { throw new Error('no net'); },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      tabs: { query: async () => [] },
      storage: { local: {
        get: async (k) => {
          await tick();
          if (k === null) return copy(store);
          return (k in store) ? { [k]: copy(store[k]) } : {};
        },
        set: async (o) => { await tick(); Object.assign(store, copy(o)); },
        remove: async (ks) => { await tick(); (Array.isArray(ks) ? ks : [ks]).forEach((k) => delete store[k]); }
      } }
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { api: ctx.__t, store };
}

const DAY = 86400000;

(async () => {
  console.log('\n[1] 并发 touch 一条都不能丢');
  {
    /* 这是整条队列存在的理由。两个标签页同时看视频，各自 touch 自己的键：
       不排队的话两边都读到同一份旧索引，各自加上自己那条写回去，后写的赢，
       另一条就此消失 —— 它的缓存正文再也不会被淘汰，也再也不算数。 */
    const { api, store } = load({ cacheIndex: {} });
    await Promise.all(['c_a', 'c_b', 'c_c', 'c_d', 'c_e', 'c_f', 'c_g', 'c_h']
      .map((k) => api.cacheIndexOp({ op: 'touch', key: k })));
    const keys = Object.keys(store.cacheIndex).sort();
    check('八次并发写入全部留下', keys.length === 8, JSON.stringify(keys));
    check('时间戳都是数字', Object.values(store.cacheIndex).every((v) => typeof v === 'number' && v > 0));
  }

  console.log('\n[2] touch 会刷新时间，forget 会删掉');
  {
    const old = Date.now() - 10 * DAY;
    const { api, store } = load({ cacheIndex: { c_x: old, c_y: old } });
    await api.cacheIndexOp({ op: 'touch', key: 'c_x' });
    check('重看过的那条时间被刷新', store.cacheIndex.c_x > old, String(store.cacheIndex.c_x));
    check('没碰过的那条原样不动', store.cacheIndex.c_y === old);
    await api.cacheIndexOp({ op: 'forget', key: 'c_x' });
    check('forget 之后索引里没有它了', !('c_x' in store.cacheIndex), JSON.stringify(store.cacheIndex));
    check('forget 不牵连别人', store.cacheIndex.c_y === old);
  }

  console.log('\n[3] 淘汰：过期的和超量的');
  {
    const now = Date.now();
    const idx = { c_old1: now - 90 * DAY, c_old2: now - 61 * DAY, c_fresh: now - 1 * DAY };
    const body = { c_old1: { items: {} }, c_old2: { items: {} }, c_fresh: { items: {} } };
    const { api, store } = load(Object.assign({ cacheIndex: idx }, body));
    await api.cacheIndexOp({ op: 'touch', key: 'c_new', prune: { days: 60, max: 300 } });
    check('两条过期的被清掉', !('c_old1' in store.cacheIndex) && !('c_old2' in store.cacheIndex),
          JSON.stringify(Object.keys(store.cacheIndex)));
    check('过期缓存的正文也一起删了', !('c_old1' in store) && !('c_old2' in store),
          JSON.stringify(Object.keys(store)));
    check('没过期的留着', 'c_fresh' in store.cacheIndex);
    check('刚 touch 的那条留着', 'c_new' in store.cacheIndex);
  }

  console.log('\n[4] 超量淘汰不能把刚用的那条自己淘汰掉');
  {
    /* 上限是 2，而刚 touch 的这条时间最新，必须排在最前。要是排序写反了，
       用户正在看的这个视频的缓存会当场被自己的写入淘汰掉，下次重看照样付钱。 */
    const now = Date.now();
    const idx = {};
    for (let i = 0; i < 5; i++) idx['c_' + i] = now - (5 - i) * 1000;
    const { api, store } = load({ cacheIndex: idx });
    await api.cacheIndexOp({ op: 'touch', key: 'c_now', prune: { days: 60, max: 2 } });
    const left = Object.keys(store.cacheIndex);
    check('只留下上限条数', left.length === 2, JSON.stringify(left));
    check('刚用过的那条一定在', left.includes('c_now'), JSON.stringify(left));
    check('留下的是最近用过的', left.includes('c_4'), JSON.stringify(left));
  }

  console.log('\n[5] clear 清空正文和索引，并报出清了几个');
  {
    const { api, store } = load({
      cacheIndex: { c_a: 1, c_b: 2 },
      c_a: { items: { x: '译' } }, c_b: { items: {} },
      settings: { apiKey: 'keep' }, stats: { requests: 3 }
    });
    const n = await api.cacheIndexOp({ op: 'clear' });
    check('报出清掉了 2 个视频', n === 2, String(n));
    check('缓存正文都没了', !('c_a' in store) && !('c_b' in store), JSON.stringify(Object.keys(store)));
    check('索引清空', Object.keys(store.cacheIndex).length === 0);
    check('设置和用量统计不受牵连', store.settings.apiKey === 'keep' && store.stats.requests === 3,
          JSON.stringify({ s: store.settings, st: store.stats }));
  }

  console.log('\n[6] clear 和 touch 并发时不会互相抵消');
  {
    /* 设置页点「清空缓存」的同时，另一个标签页正好在落盘。排队之后无论谁先，
       结果都得是一致的：要么这条留着，要么没有，绝不能出现「索引里没有、
       正文还在」这种没人管得着的孤儿。 */
    const { api, store } = load({ cacheIndex: { c_a: 1 }, c_a: { items: {} } });
    await Promise.all([
      api.cacheIndexOp({ op: 'clear' }),
      api.cacheIndexOp({ op: 'touch', key: 'c_b' })
    ]);
    const indexed = Object.keys(store.cacheIndex);
    const bodies = Object.keys(store).filter((k) => k.startsWith('c_'));
    check('没有留下索引不认识的缓存正文', bodies.every((k) => indexed.includes(k)),
          JSON.stringify({ indexed, bodies }));
  }

  console.log('\n[7] 一次失败不能把整条队列卡死');
  {
    const { api, store } = load({ cacheIndex: {} });
    let boom = null;
    await api.cacheIndexOp(null).catch((e) => { boom = e; });   // 空 payload
    await api.cacheIndexOp({ op: 'touch', key: 'c_after' });
    check('后面的写入照常生效', 'c_after' in store.cacheIndex, JSON.stringify(store.cacheIndex));
  }

  console.log('\n[8] 没有键的操作什么都不做');
  {
    const { api, store } = load({ cacheIndex: { c_a: 1 } });
    await api.cacheIndexOp({ op: 'touch', key: '' });
    check('索引原样不动', JSON.stringify(store.cacheIndex) === JSON.stringify({ c_a: 1 }),
          JSON.stringify(store.cacheIndex));
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
