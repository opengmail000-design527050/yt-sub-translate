/* 覆盖弹窗里的「点模型名切换配置档」：菜单画得对不对、切换有没有把那一档
 * 灌回 settings、有没有捎带改掉全局设置、页面有没有被通知重来。
 *
 * 和 profiles.test.js 同一套路子：把 common.js 和 popup.js 去掉 import/export
 * 之后拼进同一个沙箱跑。 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

/* ---- 一个够用的 DOM 桩：按 id 自动造元素 ---- */
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', title: '', type: 'text',
    disabled: false, checked: false, className: '',
    dataset: {}, attrs: {}, _kids: [], _on: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)); },
      remove(...a) { a.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { this._kids.push(c); return c; },
    append(...c) { this._kids.push(...c); },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); },
    removeEventListener() {},
    querySelector() { return makeEl('_'); },
    querySelectorAll() { return []; },
    closest() { return el; },        // 菜单里点到的就是按钮本身
    focus() {}, select() {}
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(v) { if (!v) this._kids.length = 0; }
  });
  return el;
}

const els = {};
const $ = (id) => (els[id] = els[id] || makeEl(id));

const docOn = {};
const doc = {
  getElementById: $,
  createElement: () => makeEl('_new'),
  querySelector: () => null,
  /* 界面文案是运行时按语言换的（applyI18n 会扫这些属性）。桩里没有真的 HTML，
     换不换都不影响这些用例 —— 但得让它扫得动。中文兜底由 t() 负责，
     所以断言里的中文照样成立。 */
  querySelectorAll: () => [],
  addEventListener(t, f) { (docOn[t] = docOn[t] || []).push(f); }
};

const storage = {};
const sent = [];              // 发给页面的消息
let optionsOpened = 0;
let statusReply = null;       // content 那边 getStatus 的回应，用例自己摆
let tabUrl = 'https://www.youtube.com/watch?v=abc';

const chrome = {
  storage: {
    local: {
      async get(k) {
        if (k === null) return JSON.parse(JSON.stringify(storage));
        if (Array.isArray(k)) { const o = {}; k.forEach((x) => { if (x in storage) o[x] = JSON.parse(JSON.stringify(storage[x])); }); return o; }
        return (k in storage) ? { [k]: JSON.parse(JSON.stringify(storage[k])) } : {};
      },
      async set(o) { Object.assign(storage, JSON.parse(JSON.stringify(o))); },
      async remove(ks) { (Array.isArray(ks) ? ks : [ks]).forEach((k) => delete storage[k]); }
    },
    onChanged: { addListener() {} }
  },
  tabs: {
    async query() { return [{ id: 7, url: tabUrl }]; },
    async sendMessage(tabId, msg) {
      sent.push(msg);
      return msg && msg.type === 'getStatus' ? statusReply : null;
    }
  },
  runtime: { openOptionsPage() { optionsOpened++; }, sendMessage: async () => ({ ok: false }) },
  i18n: { getUILanguage: () => 'zh-CN' }
};

/* 弹窗每秒刷一次状态，测试里不需要它真的跑起来 */
const timeout = (f, ms) => { const t = setTimeout(f, ms); if (t.unref) t.unref(); return t; };

const sandbox = { console, document: doc, chrome, setTimeout: timeout, clearTimeout,
                  navigator: { userAgent: 'Chrome/测试', clipboard: { async writeText() {} } },
                  setInterval: () => 0, clearInterval: () => {}, URL, Math, Date, JSON };
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);

const common = fs.readFileSync(__dirname + '/../common.js', 'utf8').replace(/^export /gm, '');
const popup = fs.readFileSync(__dirname + '/../popup/popup.js', 'utf8')
  .replace(/^import[\s\S]*?from '\.\.\/common\.js';/m, '')
  .replace(/^init\(\);$/m, '');       // 何时初始化由测试自己决定

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 先把老用户的设置摆好，再让弹窗初始化
storage.settings = {
  baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-old',
  model: 'deepseek-chat', targetLang: '简体中文', reasoningStyle: 'enable_thinking',
  fontSize: 31, reasoning: 'low'
};

/* popup.js 里 LANG_NAMES 是 import 时起的别名，import 被剥掉之后就没人定义它了。
   在两段代码中间补一句，等价于那句 import。 */
const alias = 'const LANG_NAMES = CODE_TO_NAME;';

vm.runInContext(common + alias + '\n' + popup + '\nglobalThis.__p = { init, getP: () => P, getS: () => S, refreshStatus };',
                ctx, { filename: 'popup-bundle.js' });
const O = vm.runInContext('globalThis.__p', ctx);

/* 弹窗在真实 HTML 里是新开一个页面，重开一次就是重新绑一遍事件。
   这里手工把上一次绑的清掉，否则同一个按钮会被点两下。 */
function freshPopup() {
  for (const el of Object.values(els)) el._on = {};
  for (const k of Object.keys(docOn)) delete docOn[k];
  return O.init();
}

// 这两个元素在 HTML 里就写着 hidden
$('pfMenu').classList.add('hidden');
$('toast').classList.add('hidden');

const fire = (el, type, ev) => (el._on[type] || []).map((f) => f(ev || { stopPropagation() {}, preventDefault() {} }));
const clickTag = () => fire($('modelTag'), 'click');
const items = () => $('pfMenu')._kids;
const itemText = (b) => b._kids.map((k) => k.textContent).join(' · ') || b.textContent;

(async () => {
  /* ---------------------------------------------------------------- *
   * [1] 打开弹窗：拿现有设置原地立一档，模型名照常显示
   * ---------------------------------------------------------------- */
  console.log('[1] 初始化');
  await freshPopup();
  await sleep(10);
  check('立了正好一档', O.getP().list.length === 1, JSON.stringify(O.getP().list));
  check('模型名写在标签上', $('modelTag').textContent === 'deepseek-chat', $('modelTag').textContent);
  check('标签提示里带着配置名', $('modelTag').title.includes('默认') && $('modelTag').title.includes('点击切换配置'),
        $('modelTag').title);
  check('菜单一开始是收起的', $('pfMenu').classList.contains('hidden'));
  check('settings 一个字段都没被改动', storage.settings.fontSize === 31 && storage.settings.apiKey === 'sk-old',
        JSON.stringify(storage.settings));

  /* ---------------------------------------------------------------- *
   * [2] 点模型名：菜单展开，条目 = 每档一条 + 「管理配置…」
   * ---------------------------------------------------------------- */
  console.log('\n[2] 展开菜单');
  // 直接往 storage 里塞第二档，模拟在设置页里加过一档
  const P0 = JSON.parse(JSON.stringify(storage.profiles));
  P0.list.push({ id: 'p2', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1',
                 apiKey: 'sk-kimi', model: 'kimi-k2', targetLang: 'auto', reasoningStyle: 'effort' });
  storage.profiles = P0;
  await freshPopup();                 // 重开弹窗
  await sleep(10);

  clickTag();
  check('菜单展开了', !$('pfMenu').classList.contains('hidden'));
  check('每档一条，外加「管理配置…」', items().length === 3, JSON.stringify(items().map(itemText)));
  check('条目里带着名字和模型', itemText(items()[1]) === 'Kimi · kimi-k2', itemText(items()[1]));
  check('当前档有标记', items()[0].className.includes('on') && !items()[1].className.includes('on'),
        items()[0].className + ' | ' + items()[1].className);
  check('最后一条是管理入口', items()[2].textContent === '管理配置…' && !items()[2].dataset.id,
        items()[2].textContent);

  /* ---------------------------------------------------------------- *
   * [3] 点另一档：灌回 settings，通知页面，菜单收起
   * ---------------------------------------------------------------- */
  console.log('\n[3] 切换到另一档');
  sent.length = 0;
  const kimiBtn = items()[1];
  await Promise.all(fire($('pfMenu'), 'click', { target: kimiBtn, stopPropagation() {} }));
  await sleep(10);

  check('active 指向了新的那档', storage.profiles.active === 'p2', storage.profiles.active);
  check('模型换过去了', storage.settings.model === 'kimi-k2', storage.settings.model);
  check('Key 换过去了', storage.settings.apiKey === 'sk-kimi', storage.settings.apiKey);
  check('地址换过去了', storage.settings.baseUrl === 'https://api.moonshot.cn/v1', storage.settings.baseUrl);
  check('推理参数写法换过去了', storage.settings.reasoningStyle === 'effort', storage.settings.reasoningStyle);
  check('全局设置没被顺手改掉', storage.settings.fontSize === 31 && storage.settings.reasoning === 'low',
        JSON.stringify(storage.settings));
  check('标签跟着变了', $('modelTag').textContent === 'kimi-k2', $('modelTag').textContent);
  check('提示里的配置名也跟着变', $('modelTag').title.includes('Kimi'), $('modelTag').title);
  check('菜单收起了', $('pfMenu').classList.contains('hidden'));
  check('给页面发了 settingsChanged', sent.some((m) => m.type === 'settingsChanged'), JSON.stringify(sent));
  check('切完给了一句确认', !$('toast').classList.contains('hidden') && $('toast').textContent.includes('Kimi'),
        $('toast').textContent);

  /* ---------------------------------------------------------------- *
   * [4] 点当前这一档：什么都不该发生
   * ---------------------------------------------------------------- */
  console.log('\n[4] 点当前档是空操作');
  clickTag();
  const cur = items().find((b) => b.className.includes('on'));
  check('标记跟着切到了新的当前档', cur && cur.dataset.id === 'p2', cur && cur.dataset.id);
  sent.length = 0;
  const before = JSON.stringify(storage);
  await Promise.all(fire($('pfMenu'), 'click', { target: cur, stopPropagation() {} }));
  await sleep(10);
  check('存储一个字节都没动', JSON.stringify(storage) === before);
  check('没给页面发多余的消息', sent.length === 0, JSON.stringify(sent));
  check('菜单还是收起了', $('pfMenu').classList.contains('hidden'));

  /* ---------------------------------------------------------------- *
   * [5] 「管理配置…」只负责打开设置页
   * ---------------------------------------------------------------- */
  console.log('\n[5] 管理配置');
  clickTag();
  const more = items()[items().length - 1];
  sent.length = 0;
  const before5 = JSON.stringify(storage);
  await Promise.all(fire($('pfMenu'), 'click', { target: more, stopPropagation() {} }));
  await sleep(10);
  check('打开了设置页', optionsOpened === 1, String(optionsOpened));
  check('没改任何设置', JSON.stringify(storage) === before5);

  /* ---------------------------------------------------------------- *
   * [6] 菜单是每次打开时才画的：设置页刚改过也能看见
   * ---------------------------------------------------------------- */
  console.log('\n[6] 每次打开都重画');
  clickTag();                          // 展开
  const n6 = items().length;
  clickTag();                          // 收起
  check('再点一下收起', $('pfMenu').classList.contains('hidden'));
  O.getP().list.push({ id: 'p3', name: '本地', baseUrl: 'http://127.0.0.1:1234/v1',
                       apiKey: '', model: '', targetLang: 'auto', reasoningStyle: 'off' });
  clickTag();
  check('新加的一档出现在菜单里', items().length === n6 + 1, JSON.stringify(items().map(itemText)));
  check('没填模型的那档写「未设置模型」',
        items()[2]._kids[1].textContent === '未设置模型', itemText(items()[2]));
  check('菜单没有越点越长', items().filter((b) => b.dataset.id).length === 3,
        JSON.stringify(items().map(itemText)));

  /* ---------------------------------------------------------------- *
   * [7] 点别处 / 按 Esc 收起
   * ---------------------------------------------------------------- */
  console.log('\n[7] 收起');
  (docOn.click || []).forEach((f) => f({ target: $('statusCard') }));
  check('点空白处收起', $('pfMenu').classList.contains('hidden'));
  clickTag();
  (docOn.keydown || []).forEach((f) => f({ key: 'Escape' }));
  check('Esc 收起', $('pfMenu').classList.contains('hidden'));
  clickTag();
  (docOn.keydown || []).forEach((f) => f({ key: 'a' }));
  check('别的键不受影响', !$('pfMenu').classList.contains('hidden'));

  /* ---------------------------------------------------------------- *
   * [8] 错误码：每一种都有说人话的一句和唯一的那个下一步
   * ---------------------------------------------------------------- */
  console.log('\n[8] 错误码决定文案和按钮');
  const shown = (id) => !$(id).classList.contains('hidden');
  const say = async (r) => { statusReply = r; await O.refreshStatus(); };

  await say({ onYoutube: true, active: true, status: 'error', segments: 10, translated: 0,
              error: 'HTTP 401: Incorrect API key provided: sk-xxx', errorCode: 'auth' });
  check('说的是「Key 不对」而不是一串 HTTP', $('errText').textContent.includes('API Key 不对'),
        $('errText').textContent);
  check('服务商的原话留在 title 里，报障时还找得回来',
        $('errText').title.includes('Incorrect API key'), $('errText').title);
  check('给了「去设置」这个下一步', shown('fixBtn') && $('fixBtn').textContent === '去设置',
        $('fixBtn').textContent);
  const openedBefore = optionsOpened;
  fire($('fixBtn'), 'click');
  check('点它就打开设置页', optionsOpened > openedBefore, String(optionsOpened));

  await say({ onYoutube: true, active: true, status: 'error', segments: 10, translated: 3,
              error: 'HTTP 429: rate limited', errorCode: 'rate' });
  check('限流不给重试按钮（正在自动重试，点它没有意义）', !shown('retryBtn'));
  check('限流也不催人去改设置', !shown('fixBtn'));
  check('文案说清楚会自己重试', $('errText').textContent.includes('自动重试'), $('errText').textContent);

  await say({ onYoutube: true, active: true, status: 'error', segments: 10, translated: 3,
              error: '请求超时', errorCode: 'timeout' });
  check('超时给重试', shown('retryBtn'));
  check('超时不催人去改设置', !shown('fixBtn'));

  await say({ onYoutube: true, active: false, status: 'error', segments: 0, translated: 0,
              error: '还没填 API Key（点插件图标 → 设置）', errorCode: 'noKey' });
  check('没填 Key 时不给重试（重试多少次都一样）', !shown('retryBtn'));
  check('给的是「去设置」', shown('fixBtn') && $('fixBtn').textContent === '去设置');

  await say({ onYoutube: true, active: true, status: 'ready', segments: 10, translated: 10, error: '' });
  check('没出错时按钮都收起来', !shown('errText') && !shown('retryBtn') && !shown('fixBtn'));

  /* ---------------------------------------------------------------- *
   * [9] 没有字幕轨时，说的是真正识别出来的那个语言
   * ---------------------------------------------------------------- */
  console.log('\n[9] 没有字幕轨');
  await say({ onYoutube: true, active: false, status: 'nosub', segments: 0, translated: 0,
              audioLang: 'fr', hasTracks: false });
  check('不再写死「没有英文字幕」', !$('statusText').textContent.includes('英文'),
        $('statusText').textContent);
  check('写的是识别出来的那个语言', $('statusText').textContent.includes('Français'),
        $('statusText').textContent);

  /* ---------------------------------------------------------------- *
   * [10] 不支持的页面直说原因
   * ---------------------------------------------------------------- */
  console.log('\n[10] 不支持的页面');
  await say({ onYoutube: true, active: false, status: 'unsupported', unsupported: 'live',
              segments: 0, translated: 0 });
  check('直播直说不支持', $('statusText').textContent.includes('直播'), $('statusText').textContent);
  check('不再显示「正在获取字幕…」', !$('statusText').textContent.includes('获取字幕'));

  tabUrl = 'https://www.youtube-nocookie.com/embed/abc';
  statusReply = null;
  await freshPopup();
  await sleep(10);
  check('嵌入页说的是「在 YouTube 上打开」，不是「不是 YouTube 页面」',
        $('statusText').textContent.includes('嵌入'), $('statusText').textContent);
  tabUrl = 'https://www.youtube.com/watch?v=abc';

  /* ---------------------------------------------------------------- *
   * [11] 没配 Key 时的引导 + 诊断信息
   * ---------------------------------------------------------------- */
  console.log('\n[11] 引导与诊断');
  {
    statusReply = null;
    storage.settings = Object.assign({}, storage.settings, { apiKey: '' });
    delete storage.profiles;
    await freshPopup();
    await sleep(10);
    check('没填 Key 时横幅出来了', !$('setupBar').classList.contains('hidden'));
    const opened = optionsOpened;
    fire($('setupBtn'), 'click');
    check('点横幅就去设置页', optionsOpened > opened);

    storage.settings = Object.assign({}, storage.settings, { apiKey: 'sk-secret-value-123' });
    delete storage.profiles;
    await freshPopup();
    await sleep(10);
    check('填了就不再挡在最上面', $('setupBar').classList.contains('hidden'));

    /* 诊断信息会被贴到聊天群和 issue 里，绝不能带 Key。 */
    statusReply = { onYoutube: true, active: true, status: 'ready', segments: 8, translated: 8 };
    let copied = '';
    sandbox.navigator = { userAgent: 'Chrome/测试', clipboard: { writeText: async (t) => { copied = t; } } };
    fire($('copyDiag'), 'click');
    await sleep(30);
    check('复制出了东西', copied.length > 0, String(copied.length));
    check('一个字都没有 Key', !copied.includes('sk-secret-value-123'), copied.slice(0, 200));
    check('只写「已填」', copied.includes('Key=已填'), copied.split('\n')[2]);
    check('带上了版本和配置', copied.includes('Sub Translator') && copied.includes('模型='),
          copied.slice(0, 120));
    check('接口只留主机名', !copied.includes('/v1'), copied.slice(0, 200));
  }

  /* ---------------------------------------------------------------- *
   * [12] 英文界面：接上语言包之后真的换语言
   * ---------------------------------------------------------------- */
  console.log('\n[12] 英文界面');
  {
    /* 用真的 _locales/en/messages.json，不在测试里另抄一份 —— 抄一份就等于
       在验「我抄得对不对」。 */
    const en = JSON.parse(require('fs').readFileSync(__dirname + '/../_locales/en/messages.json', 'utf8'));
    chrome.i18n.getMessage = (k, subs) => {
      const m = en[k] && en[k].message;
      if (!m) return '';
      const arr = Array.isArray(subs) ? subs : (subs === undefined ? [] : [subs]);
      return m.replace(/\$(\d)/g, (x, i) => (arr[Number(i) - 1] === undefined ? x : arr[Number(i) - 1]));
    };

    statusReply = { onYoutube: true, active: true, status: 'error', segments: 10, translated: 4,
                    error: 'HTTP 401: nope', errorCode: 'auth' };
    await freshPopup();
    await sleep(10);
    check('错误说的是英文', $('errText').textContent.includes('API key'), $('errText').textContent);
    check('按钮也是英文', $('fixBtn').textContent === 'Open options', $('fixBtn').textContent);
    check('进度也换了语言', $('statusText').textContent.includes('Translated 4/10'),
          $('statusText').textContent);
    check('推理提示也换了', $('reasonHint').textContent.includes('subtitles') ||
          $('reasonHint').textContent.includes('thinking') || $('reasonHint').textContent.includes('faithful'),
          $('reasonHint').textContent);
    check('一个中文字都没剩下', !/[一-鿿]/.test($('errText').textContent + $('fixBtn').textContent +
          $('statusText').textContent + $('reasonHint').textContent),
          $('statusText').textContent);

    chrome.i18n.getMessage = undefined;      // 还回去，后面的用例照旧看中文
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
