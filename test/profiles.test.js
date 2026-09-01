/* 覆盖设置页的「接口配置档」：老用户升级后的原地迁移、切换、新建、复制、
 * 重命名、删除，以及「改字段要存回当前那一档」这条最容易漏的路。
 *
 * 把 common.js 和 options.js 去掉 import/export 之后拼进同一个沙箱跑 ——
 * 它俩本来就是同一个模块作用域里的上下文，拼起来等价。 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

/* ---- 一个够用的 DOM 桩：按 id 自动造元素 ---- */
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', type: 'text', disabled: false,
    _kids: [], _on: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)); },
      remove(...a) { a.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { this._kids.push(c); return c; },
    addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); },
    removeEventListener() {},
    querySelector() { return makeEl('_'); },
    focus() {}, select() {}
  };
  // sel.innerHTML = '' 要真的把 option 清掉，否则下拉框会越刷越长
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(v) { if (!v) this._kids.length = 0; }
  });
  return el;
}

const els = {};
const $ = (id) => (els[id] = els[id] || makeEl(id));

const doc = {
  getElementById: $,
  createElement: () => makeEl('_new'),
  querySelector: () => null,
  /* 界面文案现在是运行时按语言换的（applyI18n 扫这几个属性）。桩里没有真的 HTML，
     扫不到东西也没关系 —— 中文兜底由 t() 负责，断言里的中文照样成立。 */
  querySelectorAll: () => []
};

const storage = {};
const chrome = {
  storage: {
    local: {
      async get(k) {
        if (k === null) return Object.assign({}, storage);
        if (Array.isArray(k)) { const o = {}; k.forEach((x) => { if (x in storage) o[x] = storage[x]; }); return o; }
        return (k in storage) ? { [k]: storage[k] } : {};
      },
      async set(o) { Object.assign(storage, o); },
      async remove(ks) { (Array.isArray(ks) ? ks : [ks]).forEach((k) => delete storage[k]); },
      async getBytesInUse() { return 0; }
    },
    onChanged: { addListener() {} }
  },
  runtime: { sendMessage: async () => ({ ok: false, error: 'stub' }) },
  i18n: { getUILanguage: () => 'zh-CN' }
};

const sandbox = { console, document: doc, chrome, setTimeout, clearTimeout, URL, Math, Date, JSON };
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);

/* common.js 去掉 export，options.js 去掉那条 import，拼在一起 */
const common = fs.readFileSync(__dirname + '/../common.js', 'utf8').replace(/^export /gm, '');
const options = fs.readFileSync(__dirname + '/../options/options.js', 'utf8')
  .replace(/^import[\s\S]*?from '\.\.\/common\.js';/m, '');
vm.runInContext(common + '\n' + options + '\nglobalThis.__o = { init, switchProfile, addProfile, deleteProfile, startRename, endRename, activeProfile, getP: () => P, getS: () => S };',
                ctx, { filename: 'options-bundle.js' });

const O = vm.runInContext('globalThis.__o', ctx);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = () => O.getP().list.map((x) => x.name);
const optionTexts = () => $('profileSel')._kids.map((k) => k.textContent);

(async () => {
  /* ---------------------------------------------------------------- *
   * [1] 老用户升级：不能凭空改掉他任何一个字段
   * ---------------------------------------------------------------- */
  console.log('\n[1] 升级迁移：拿现有设置原地立一档');
  storage.settings = {
    baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-old',
    model: 'deepseek-chat', targetLang: '简体中文', reasoningStyle: 'enable_thinking',
    fontSize: 31                       // 全局设置，不该跑进配置档
  };
  await O.init();
  await sleep(10);

  const p0 = O.getP();
  check('立了正好一档', p0.list.length === 1, JSON.stringify(names()));
  check('名字是「默认」', p0.list[0].name === '默认', p0.list[0].name);
  check('照抄了原来的地址', p0.list[0].baseUrl === 'https://api.deepseek.com/v1', p0.list[0].baseUrl);
  check('照抄了原来的 Key', p0.list[0].apiKey === 'sk-old', p0.list[0].apiKey);
  check('照抄了推理参数写法', p0.list[0].reasoningStyle === 'enable_thinking', p0.list[0].reasoningStyle);
  check('全局设置没被卷进配置档', !('fontSize' in p0.list[0]), JSON.stringify(Object.keys(p0.list[0])));
  check('settings 一个字段都没被改动', storage.settings.fontSize === 31 && storage.settings.apiKey === 'sk-old',
        JSON.stringify(storage.settings));
  check('下拉框里带出了模型名', optionTexts()[0] === '默认 · deepseek-chat', JSON.stringify(optionTexts()));

  /* ---------------------------------------------------------------- *
   * [2] 新建一档：不能把上一档的 Key 带过去
   * ---------------------------------------------------------------- */
  console.log('\n[2] 新建');
  await O.addProfile(null);
  await sleep(10);
  check('多了一档', O.getP().list.length === 2, JSON.stringify(names()));
  check('新建的那档是当前档', O.activeProfile().name === '新配置', O.activeProfile().name);
  check('新档没有继承上一档的 Key', O.activeProfile().apiKey === '', JSON.stringify(O.activeProfile()));
  check('settings 也跟着清空了 Key', storage.settings.apiKey === '', JSON.stringify(storage.settings.apiKey));
  check('新建时自动进入重命名', !$('profileName').classList.contains('hidden'));

  /* ---------------------------------------------------------------- *
   * [3] 重命名
   * ---------------------------------------------------------------- */
  console.log('\n[3] 重命名');
  $('profileName').value = '  Kimi  ';
  await O.endRename(true);
  await sleep(10);
  check('两端空白被去掉', names().includes('Kimi'), JSON.stringify(names()));
  check('输入框收了回去', $('profileName').classList.contains('hidden'));
  check('下拉框跟着刷新', optionTexts().some((t) => t.startsWith('Kimi')), JSON.stringify(optionTexts()));

  /* ---------------------------------------------------------------- *
   * [4] 改字段要存回当前这一档，切走再切回来不能丢
   * ---------------------------------------------------------------- */
  console.log('\n[4] 改字段 → 存回当前档 → 切换 → 切回来');
  $('model').value = 'kimi-k2';
  $('apiKey').value = 'sk-kimi';
  await O.getS();                       // 触发一次 await，保证前面的写入落定
  // 直接走 commit 走过的那条路：模拟表单的 change
  for (const k of ['model', 'apiKey']) {
    const fs_ = $(k)._on.change || [];
    for (const f of fs_) await f();
  }
  await sleep(10);
  check('当前档记下了新模型', O.activeProfile().model === 'kimi-k2', O.activeProfile().model);
  check('当前档记下了新 Key', O.activeProfile().apiKey === 'sk-kimi', O.activeProfile().apiKey);
  check('下拉框里的模型名跟着变', optionTexts().some((t) => t === 'Kimi · kimi-k2'), JSON.stringify(optionTexts()));

  const kimiId = O.getP().active;
  const defId = O.getP().list.find((x) => x.name === '默认').id;

  await O.switchProfile(defId);
  await sleep(10);
  check('切回「默认」后 settings 换成了那一档', storage.settings.model === 'deepseek-chat', storage.settings.model);
  check('Key 也换过去了', storage.settings.apiKey === 'sk-old', storage.settings.apiKey);
  check('表单被刷成了新的那一档', $('model').value === 'deepseek-chat', $('model').value);
  check('Key 输入框重新遮上', $('apiKey').type === 'password', $('apiKey').type);

  await O.switchProfile(kimiId);
  await sleep(10);
  check('切回 Kimi，改动还在', storage.settings.model === 'kimi-k2' && storage.settings.apiKey === 'sk-kimi',
        JSON.stringify({ m: storage.settings.model, k: storage.settings.apiKey }));
  check('切换没有动全局设置', storage.settings.fontSize === 31, String(storage.settings.fontSize));

  /* ---------------------------------------------------------------- *
   * [5] 复制
   * ---------------------------------------------------------------- */
  console.log('\n[5] 复制');
  await O.addProfile(O.activeProfile());
  await sleep(10);
  check('名字带「副本」且不撞名', O.activeProfile().name === 'Kimi 副本', O.activeProfile().name);
  check('字段整套复制过来了', O.activeProfile().model === 'kimi-k2' && O.activeProfile().apiKey === 'sk-kimi',
        JSON.stringify(O.activeProfile()));

  await O.endRename(false);             // 复制后会自动进入重命名，这里退出
  await O.addProfile(O.getP().list.find((x) => x.name === 'Kimi'));
  await sleep(10);
  check('再复制一次会自动加序号', O.activeProfile().name === 'Kimi 副本 2', O.activeProfile().name);
  await O.endRename(false);

  /* ---------------------------------------------------------------- *
   * [6] 删除：要点两下，且最后一档删不掉
   * ---------------------------------------------------------------- */
  console.log('\n[6] 删除');
  const before = O.getP().list.length;
  await O.deleteProfile();              // 第一下只上膛
  await sleep(10);
  check('点第一下不删，只是变成确认态', O.getP().list.length === before && $('pfDel').textContent === '确认删除？',
        $('pfDel').textContent);

  await O.deleteProfile();              // 第二下才真删
  await sleep(10);
  check('点第二下才真的删掉', O.getP().list.length === before - 1, JSON.stringify(names()));
  check('删完之后按钮复位', $('pfDel').textContent === '删除', $('pfDel').textContent);
  check('当前档换成了还活着的那一档', O.getP().list.some((x) => x.id === O.getP().active), O.getP().active);
  check('settings 跟着换成了新的当前档',
        storage.settings.model === O.activeProfile().model, storage.settings.model);

  // 一路删到只剩一档
  while (O.getP().list.length > 1) { await O.deleteProfile(); await O.deleteProfile(); await sleep(5); }
  check('删到只剩一档', O.getP().list.length === 1, JSON.stringify(names()));
  await O.deleteProfile();
  await O.deleteProfile();
  await sleep(10);
  check('最后一档删不掉', O.getP().list.length === 1, JSON.stringify(names()));
  check('并且删除按钮是禁用的', $('pfDel').disabled === true);

  /* ---------------------------------------------------------------- *
   * [7] active 指向一个已经不存在的 id：不能白屏，要兜回第一档
   * ---------------------------------------------------------------- */
  console.log('\n[7] 存储里的 active 失效了');
  storage.profiles = {
    active: 'ghost',
    list: [{ id: 'a', name: 'A', baseUrl: 'https://a/v1', apiKey: 'ka', model: 'ma', targetLang: 'auto', reasoningStyle: 'effort' },
           { id: 'b', name: 'B', baseUrl: 'https://b/v1', apiKey: 'kb', model: 'mb', targetLang: 'auto', reasoningStyle: 'effort' }]
  };
  await O.init();
  await sleep(10);
  check('兜回了第一档', O.getP().active === 'a', O.getP().active);
  check('两档都还在', O.getP().list.length === 2, JSON.stringify(names()));

  /* ---------------------------------------------------------------- *
   * [8] 上下文和缓存的开关已经从设置页撤掉了。以前手动关过的人打开设置页时
   *     要被自动打开，否则控件没了就再也开不回来。
   * ---------------------------------------------------------------- */
  console.log('[8] 撤掉的两个开关要自愈');
  storage.settings = {
    baseUrl: 'https://a/v1', apiKey: 'ka', model: 'ma',
    useContext: false, useCache: false, fontSize: 20
  };
  delete storage.profiles;
  await O.init();
  await sleep(10);
  check('上下文被打开', storage.settings.useContext === true, JSON.stringify(storage.settings.useContext));
  check('缓存被打开', storage.settings.useCache === true, JSON.stringify(storage.settings.useCache));
  check('别的设置没被顺手改掉', storage.settings.fontSize === 20, String(storage.settings.fontSize));

  // 本来就开着的，不该产生多余的写入
  const before8 = JSON.stringify(storage.settings);
  await O.init();
  await sleep(10);
  check('已经开着时不重复写', JSON.stringify(storage.settings) === before8);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
