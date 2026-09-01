/* 用桩环境跑 content.js，验证状态机路径。不联网、不碰真实存储。 */
const fs = require('fs'), vm = require('vm');

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), children: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)); },
      remove(...a) { a.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    dataset: {}, isConnected: true, parentElement: null, offsetParent: null,
    textContent: '', innerHTML: '', title: '', id: '', className: '', type: '',
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 800, height: 450, left: 0, top: 0 }; },
    setAttribute() {}, getAttribute() { return null; }, contains() { return false; }
  };
}

const listeners = { window: {}, document: {} };
const doc = {
  documentElement: makeEl('html'), head: makeEl('head'), body: makeEl('body'),
  createElement: makeEl,
  createRange() { return { selectNodeContents() {}, getClientRects() { return []; } }; },
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  addEventListener(t, f) { (listeners.document[t] = listeners.document[t] || []).push(f); },
  removeEventListener() {}
};

const storage = { settings: {} };
const sent = [];
let runtimeReply = null;

const chrome = {
  runtime: {
    getURL: (p) => 'chrome-extension://x/' + p,
    /* 桩要像 background 一样按消息类型分流：cancel 是「把这一版的在途请求掐掉」的
       通知，跟译文回调毫无关系，交给 runtimeReply 会打乱用例自己的计数。 */
    sendMessage: async (m) => {
      sent.push(m);
      if (m && m.type === 'cancel') return { ok: true, aborted: 0 };
      /* 缓存正文的写入现在是「发增量给 background，由它合并」。桩在这里当一回
         background：把增量并进 storage —— 不然任何跟缓存有关的断言都无从谈起。 */
      if (m && m.type === 'cacheWrite') {
        const p = m.payload || {};
        const cur = (storage[p.key] && storage[p.key].items) ? storage[p.key] : { items: {} };
        Object.assign(cur.items, p.items || {});
        cur.ts = Date.now();
        storage[p.key] = cur;
        return { ok: true };
      }
      return runtimeReply ? runtimeReply(m) : { ok: false, error: 'stub' };
    },
    onMessage: { _l: [], addListener(f) { this._l.push(f); } }
  },
  storage: {
    local: {
      async get(k) {
        if (k === null) return Object.assign({}, storage);
        if (Array.isArray(k)) { const o = {}; k.forEach((x) => { if (x in storage) o[x] = storage[x]; }); return o; }
        return (k in storage) ? { [k]: storage[k] } : {};
      },
      async set(o) { Object.assign(storage, o); Object.keys(o).forEach((k) => fireChange(k, o[k])); },
      async remove(ks) { (Array.isArray(ks) ? ks : [ks]).forEach((k) => delete storage[k]); },
      async getBytesInUse() { return 0; }
    },
    onChanged: { _l: [], addListener(f) { this._l.push(f); } }
  },
  i18n: { getUILanguage: () => 'en-US' }
};
function fireChange(key, val) {
  chrome.storage.onChanged._l.forEach((f) => {
    try { f({ [key]: { newValue: val } }, 'local'); } catch (e) { console.error('onChanged 抛错:', e.message); }
  });
}

const posted = [];
const win = {
  addEventListener(t, f) { (listeners.window[t] = listeners.window[t] || []).push(f); },
  removeEventListener() {},
  postMessage(m) { posted.push(m); },
  getSelection() { return null; },
  requestAnimationFrame() { return 0; },
  /* 把时间轴等比压缩，而不是一律压成 1ms —— 压成 1ms 的话 content.js 那个
     3.5 秒兜底计时器会赶在任何字幕到达之前先烧掉，等于每个视频都在跑兜底路径 */
  setTimeout: (f, ms) => setTimeout(f, Math.min(Math.ceil((ms || 0) / 50), 60)),
  setInterval: () => 0, clearTimeout, clearInterval,
  getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' }),
  DOMParser: class { parseFromString() { return { querySelectorAll: () => [] }; } },
  URL, URLSearchParams,        // content.js 靠它从字幕地址里认出这是哪条轨
  console
};
win.window = win; win.self = win; win.document = doc; win.chrome = chrome;
win.location = { href: 'https://www.youtube.com/watch?v=A', pathname: '/watch' };

const ctx = vm.createContext(win);
vm.runInContext(fs.readFileSync(__dirname + '/../content/content.js', 'utf8'), ctx, { filename: 'content.js' });
/* vm 里的 window 是沙箱全局代理，跟宿主的 win 不是同一个对象；
   content.js 用 e.source !== window 做校验，所以事件里必须带 vm 侧的那个。 */
const vmWindow = vm.runInContext('window', ctx);

const toPage = (type, data) => {
  (listeners.window.message || []).forEach((f) => f({ source: vmWindow, data: { ns: 'ytst', dir: 'p2c', type, data } }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = () => new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'getStatus' }, {}, res)));
const cacheKeys = () => Object.keys(storage).filter((k) => k.startsWith('c_'));

function track(n, word) {
  return JSON.stringify({
    events: Array.from({ length: n }, (_, i) => ({
      tStartMs: i * 2000, dDurationMs: 2000,
      segs: [{ utf8: word + ' sentence number ' + i + ' about something reasonably long indeed.' }]
    }))
  });
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

(async () => {
  await sleep(30);

  /* 桩里的浏览器界面语言是 en-US。干净安装时 targetLang 应当解析成英语，
     英文视频于是「无需翻译」。修复前 content.js 的 DEFAULTS 写死简体中文，
     这里会判成需要翻译，然后拿去请求一个实际会译成英文的后端。 */
  console.log('\n[1] 干净安装 + 英文界面浏览器 + 英文视频');
  runtimeReply = async () => ({ ok: true, map: {}, dropped: [] });
  toPage('player', { videoId: 'A0', title: 'a0', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(20);
  const s0 = await ask();
  check('默认目标语言跟随浏览器，英文视频判定为无需翻译', s0.needsTranslation === false && !s0.active,
        JSON.stringify(s0));
  check('因此不会去拉字幕、不会发请求', !posted.some((p) => p.type === 'fetchTrack'),
        'posted=' + JSON.stringify(posted.map((p) => p.type)));

  /* 之后的用例把目标语言显式设成中文，让英文视频确实需要翻译 */
  await chrome.storage.local.set({ settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1 } });
  await sleep(20);

  console.log('\n[2] 视频切换：旧响应不得写入新视频');
  posted.length = 0; sent.length = 0;
  toPage('player', { videoId: 'A', title: 'a', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(20);
  let release; const gate = new Promise((r) => { release = r; });
  runtimeReply = async (m) => {
    await gate;
    return { ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '旧视频译文'])), dropped: [] };
  };
  toPage('track', { videoId: 'A', body: track(40, 'Alpha') });
  await sleep(20);
  const inflight = sent.length;
  toPage('player', { videoId: 'B', title: 'b', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(10);
  runtimeReply = async (m) => ({ ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '新视频译文'])), dropped: [] });
  toPage('track', { videoId: 'B', body: track(40, 'Bravo') });
  release();
  await sleep(80);
  const polluted = cacheKeys().some((k) => Object.values((storage[k] || {}).items || {}).includes('旧视频译文'));
  check('切走时确实有在途请求', inflight > 0, 'inflight=' + inflight);
  check('旧视频译文没被写进任何缓存', !polluted,
        JSON.stringify(cacheKeys().map((k) => Object.values(storage[k].items || {})[0])));

  console.log('\n[3] 字幕轨迟到');
  posted.length = 0;
  toPage('player', { videoId: 'C', title: 'c', audioLang: 'en', tracks: [] });
  await sleep(15);
  const s1 = await ask();
  check('先报无字幕', s1.status === 'nosub', s1.status);
  toPage('player', { videoId: 'C', title: 'c', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(25);
  const s2 = await ask();
  check('轨道到了以后恢复并自动开始', s2.status !== 'nosub' && s2.active, JSON.stringify(s2));

  console.log('\n[4] 播放中换模型');
  runtimeReply = async (m) => ({ ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, 'A模型译文'])), dropped: [] });
  toPage('track', { videoId: 'C', body: track(30, 'Charlie') });
  await sleep(80);
  const before = await ask();
  check('先翻出了一部分', before.translated > 0, JSON.stringify(before));

  const keysBefore = cacheKeys().length;
  runtimeReply = async (m) => ({ ok: true, map: {}, dropped: m.payload.lines.map((l) => l.id) });
  await chrome.storage.local.set({ settings: Object.assign({}, storage.settings, { model: 'another-model' }) });
  await sleep(80);
  const after = await ask();
  check('换模型后旧译文清空，不会中英混排', after.translated === 0, JSON.stringify(after));

  console.log('\n[5] 整批错位（后端返回 ok 但空 map）');
  check('状态是 error 且 error 文案非空（popup 才会给重试入口）',
        after.status === 'error' && !!after.error, JSON.stringify(after));

  console.log('\n[6] 缓存键覆盖附加提示词');
  runtimeReply = async (m) => ({ ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '文言译文'])), dropped: [] });
  await chrome.storage.local.set({ settings: Object.assign({}, storage.settings, { extraPrompt: '全部用文言文' }) });
  await sleep(120);
  check('改提示词后写入了新的缓存键', cacheKeys().length > keysBefore, keysBefore + ' -> ' + cacheKeys().length);

  console.log('[7] 重复原文不重复付费');
  const seen = [];
  runtimeReply = async (m) => {
    m.payload.lines.forEach((l) => seen.push(l.text));
    return { ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '译:' + l.text.slice(0, 6)])), dropped: [] };
  };
  await chrome.storage.local.set({
    settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1, useCache: true, extraPrompt: 'dedup' }
  });
  await sleep(30);
  // 同一句口头禅反复出现，中间夹着各不相同的长句
  const evs = [];
  for (let i = 0; i < 60; i++) {
    const t = (i % 2 === 0)
      ? 'Right, exactly, that is what I have been saying all along here.'
      : 'A distinct sentence number ' + i + ' that appears exactly once in this transcript.';
    evs.push({ tStartMs: i * 4000, dDurationMs: 4000, segs: [{ utf8: t }] });
  }
  toPage('player', { videoId: 'D', title: 'd', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(30);
  seen.length = 0;            // 只统计视频 D，排除上一个视频遗留的批次
  toPage('track', { videoId: 'D', body: JSON.stringify({ events: evs }) });
  await sleep(250);
  const d = await ask();
  const uniqueSent = new Set(seen).size;
  check('重复句只送一次', seen.length === uniqueSent, '送出 ' + seen.length + ' 行，其中不重复 ' + uniqueSent + ' 行');
  check('所有行仍然都拿到了译文', d.translated === d.segments, JSON.stringify(d));
  check('实际送出的行数少于总行数 (送出 ' + seen.length + ' / 共 ' + d.segments + ' 行)', seen.length < d.segments);

  /* 字幕地址里一定带着 v=，inject.js 就是靠它认出这份字幕属于哪个视频 */
  const tt = (vid, q) => 'https://www.youtube.com/api/timedtext?v=' + vid + '&' + q + '&fmt=json3';
  const lastReq = () => {
    const p = posted.filter((x) => x.type === 'fetchTrack').pop();
    return p ? p.data : null;
  };

  console.log('\n[8] 在 YouTube 里换字幕语言');
  runtimeReply = async (m) => {
    m.payload.lines.forEach((l) => seen.push(l.text));
    return { ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '译:' + l.id])), dropped: [] };
  };
  toPage('player', {
    videoId: 'E', title: 'e', audioLang: 'en',
    tracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'ja', kind: '' }]
  });
  await sleep(30);
  seen.length = 0;
  toPage('track', { videoId: 'E', url: tt('E', 'lang=en&kind=asr'), body: track(20, 'Alpha') });
  await sleep(150);
  const e1 = await ask();
  check('先按英文轨翻好', e1.translated > 0 && seen.some((t) => t.includes('Alpha')), JSON.stringify(e1));

  /* 用户在 CC 菜单里换成日文轨。播放器可能直接吃自己的缓存、根本不发请求，
     所以内容脚本必须自己点名去要这条轨。 */
  posted.length = 0;
  toPage('captiontrack', { languageCode: 'ja', kind: '', tlang: '' });
  await sleep(25);
  const req = lastReq();
  check('立刻按用户选的那条轨点名去要',
        !!req && req.exact === true && req.lang === 'ja' && req.reqId > 0, JSON.stringify(req));

  seen.length = 0;
  toPage('track', { videoId: 'E', reqId: req.reqId, url: tt('E', 'lang=ja'), body: track(20, 'Bravo') });
  await sleep(200);
  const e2 = await ask();
  check('翻译框换成新轨的内容', seen.some((t) => t.includes('Bravo')), '送出 ' + seen.length + ' 行');
  check('旧轨的句子不再送去翻译', !seen.some((t) => t.includes('Alpha')));
  check('原声语言跟着改成 ja', e2.sourceLang === 'ja', e2.sourceLang);

  /* 我们自己那次请求会被自己的 fetch 劫持再截一遍，回来时不带编号 */
  seen.length = 0;
  toPage('track', { videoId: 'E', url: tt('E', 'lang=ja'), body: track(20, 'Bravo') });
  await sleep(120);
  check('同一次请求被劫持回声不会重来一轮', seen.length === 0, '又送了 ' + seen.length + ' 行');

  console.log('\n[9] 播放器自己发的字幕请求不算换轨');
  toPage('player', {
    videoId: 'F', title: 'f', audioLang: 'en',
    tracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'ja', kind: '' }]
  });
  await sleep(30);
  toPage('track', { videoId: 'F', url: tt('F', 'lang=en&kind=asr'), body: track(20, 'Charlie') });
  await sleep(150);
  seen.length = 0;
  // 预加载 / 失败重试 / 别处触发的请求：没有编号
  toPage('track', { videoId: 'F', url: tt('F', 'lang=ja'), body: track(20, 'Delta') });
  await sleep(80);
  // 编号对不上的（比如上一次点名早就作废了）同样不认
  toPage('track', { videoId: 'F', reqId: 999999, url: tt('F', 'lang=ja'), body: track(20, 'Delta') });
  await sleep(120);
  const f1 = await ask();
  check('没点名的字幕不会顶掉当前轨', !seen.some((t) => t.includes('Delta')), '送出 ' + seen.length + ' 行');
  check('译文没有被白清一遍', f1.translated > 0, JSON.stringify(f1));

  console.log('\n[10] 切视频时上一个视频迟到的字幕');
  toPage('player', { videoId: 'G', title: 'g', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(30);
  seen.length = 0;
  /* 播放器自己发的请求不经过我们，inject.js 只能从字幕地址里的 v= 认出归属。
     这一份是上一个视频 F 的，迟到落在 G 上，绝不能收。 */
  toPage('track', { url: tt('F', 'lang=en&kind=asr'), body: track(20, 'Foxtrot') });
  await sleep(120);
  const g1 = await ask();
  check('认出这是上一个视频的字幕，不收', g1.segments === 0, JSON.stringify(g1));
  check('也没拿它去翻译', !seen.some((t) => t.includes('Foxtrot')), '送出 ' + seen.length + ' 行');
  toPage('track', { videoId: 'G', url: tt('G', 'lang=en&kind=asr'), body: track(20, 'Golf') });
  await sleep(150);
  check('本视频自己的字幕照收不误', (await ask()).segments > 0);

  /* 换一个干净的视频：上一节故意让 G 在兜底计时器窗口里一直没有字幕，
     兜底名额早就烧掉了，在那上面验「有没有动兜底」是验不出来的。 */
  console.log('\n[11] 点名要的那条轨不存在');
  toPage('player', {
    videoId: 'H', title: 'h', audioLang: 'en',
    tracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'ja', kind: '' }]
  });
  await sleep(15);
  toPage('track', { videoId: 'H', url: tt('H', 'lang=en&kind=asr'), body: track(20, 'India') });
  await sleep(150);
  posted.length = 0;
  toPage('captiontrack', { languageCode: 'de', kind: '', tlang: '' });
  await sleep(25);
  const missing = lastReq();
  check('照样点名去要', !!missing && missing.lang === 'de', JSON.stringify(missing));

  /* 失败时最要命的不是没换成，而是去动兜底逻辑：enableNative 会按我们自己的
     猜测替用户重选一条轨，等于把他选的语言悄悄换掉。 */
  posted.length = 0;
  seen.length = 0;
  toPage('trackfail', { reason: 'no-such-track', videoId: 'H', reqId: missing.reqId });
  await sleep(120);
  const h2 = await ask();
  check('不去替用户重选字幕轨', !posted.some((p) => p.type === 'enableNative'),
        JSON.stringify(posted.map((p) => p.type)));
  check('维持原来那条轨照常翻译', h2.segments > 0 && h2.active, JSON.stringify(h2));

  console.log('\n[12] 回来的语言跟点名要的对不上');
  posted.length = 0;
  toPage('captiontrack', { languageCode: 'de', kind: '', tlang: '' });
  await sleep(25);
  const de = lastReq();
  check('又点了一次名', !!de && de.lang === 'de', JSON.stringify(de));
  seen.length = 0;
  // 编号对得上，但送回来的是日文轨 —— 宁可维持现状也不能翻成另一种语言
  toPage('track', { videoId: 'H', reqId: de.reqId, url: tt('H', 'lang=ja'), body: track(20, 'Hotel') });
  await sleep(150);
  const h3 = await ask();
  check('不认这份，不会翻成没要过的语言', !seen.some((t) => t.includes('Hotel')),
        '送出 ' + seen.length + ' 行');
  check('原声语言没被改掉', h3.sourceLang === 'en', h3.sourceLang);

  console.log('\n[13] 选了目标语言的字幕就不必再翻');
  posted.length = 0;
  toPage('captiontrack', { languageCode: 'zh-CN', kind: '', tlang: '' });
  await sleep(25);
  const zh = lastReq();
  toPage('track', { videoId: 'H', reqId: zh.reqId, url: tt('H', 'lang=zh-CN'), body: track(20, 'Echo') });
  await sleep(150);
  const g4 = await ask();
  check('自动关掉，让位给 YouTube 自己的中文字幕', g4.active === false, JSON.stringify(g4));

  /* 视频原声是英文，但页面上同时有一条西班牙语轨，而且播放器自己先把它拉回来了
     （账号开了自动翻译、或者视频默认轨就不是原声语言）。
     先到先得的话，插件会拿西班牙语当原文翻 —— 等于翻「译文的译文」，
     而且用户在 CC 菜单里怎么点都换不回来，因为这个视频根本没有英文人工轨。 */
  console.log('\n[14] 播放器抢先拉回了另一种语言的轨');
  posted.length = 0;
  toPage('player', {
    videoId: 'J', title: 'j', audioLang: 'en',
    tracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'es', kind: '' }]
  });
  await sleep(30);
  const initReq = lastReq();
  check('我们自己那次请求也带编号', !!initReq && initReq.reqId > 0, JSON.stringify(initReq));

  seen.length = 0;
  // 播放器拉的西班牙语轨先到
  toPage('track', { videoId: 'J', url: tt('J', 'lang=es'), body: track(20, 'Sierra') });
  await sleep(80);
  check('没有别的可用就先拿它顶上', seen.some((t) => t.includes('Sierra')), '送出 ' + seen.length + ' 行');

  // 我们点名要的英文轨随后到达，必须盖过它
  seen.length = 0;
  toPage('track', {
    videoId: 'J', reqId: initReq.reqId,
    url: tt('J', 'lang=en&kind=asr'), body: track(20, 'Tango')
  });
  await sleep(200);
  const j = await ask();
  check('英文轨到了之后盖过西班牙语', j.trackLang === 'en' && j.sourceLang === 'en', JSON.stringify(j));
  check('改用英文原文重翻', seen.some((t) => t.includes('Tango')), '送出 ' + seen.length + ' 行');
  check('弹窗能看出这视频有哪些轨', (j.trackList || []).map((t) => t.lang).join(',') === 'en,es',
        JSON.stringify(j.trackList));

  /* 这才是那次「切不到英文」的真实场景：音频是英文，但对白是游戏烧进画面的，
     YouTube 上只挂了一条西班牙语轨。插件不是切换失败，是从一开始就只有这一条轨
     可选 —— 在字幕菜单里怎么点都点不出不存在的英文轨。 */
  console.log('\n[15] 视频压根没有原声语言那条轨');
  toPage('player', {
    videoId: 'K', title: 'k', audioLang: 'en',
    tracks: [{ languageCode: 'es', kind: '' }]
  });
  await sleep(30);
  toPage('track', { videoId: 'K', url: tt('K', 'lang=es'), body: track(20, 'Uniform') });
  await sleep(200);
  const k = await ask();
  check('只能拿现有的西班牙语轨当原文', k.trackLang === 'es' && k.sourceLang === 'es', JSON.stringify(k));
  check('音频语言照实报出来，弹窗才能点破不匹配', k.audioLang === 'en', String(k.audioLang));
  check('轨列表里确实没有英语', !(k.trackList || []).some((t) => t.lang === 'en'),
        JSON.stringify(k.trackList));

  console.log('\n[16] 首份字幕还在路上时就换语言');
  posted.length = 0;
  toPage('player', {
    videoId: 'L', title: 'l', audioLang: 'en',
    tracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'ja', kind: '' }]
  });
  await sleep(20);
  const first = lastReq();
  toPage('captiontrack', { languageCode: 'ja', kind: '', tlang: '' });
  await sleep(25);
  const second = lastReq();
  check('还在等首份字幕时也会按新选择重新点名',
        !!second && second.lang === 'ja' && second.reqId !== first.reqId,
        JSON.stringify([first, second]));

  // 在途的旧请求先落地，用户选的那条随后到达，必须盖过它
  toPage('track', { videoId: 'L', reqId: first.reqId, url: tt('L', 'lang=en&kind=asr'), body: track(20, 'Victor') });
  await sleep(80);
  toPage('track', { videoId: 'L', reqId: second.reqId, url: tt('L', 'lang=ja'), body: track(20, 'Whiskey') });
  await sleep(200);
  const l = await ask();
  check('用户刚选的语言最终生效，没被在途的旧请求吃掉', l.trackLang === 'ja', JSON.stringify(l));

  console.log('\n[17] 认不出归属的字幕一律不收');
  toPage('player', { videoId: 'M', title: 'm', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
  await sleep(30);
  seen.length = 0;
  // 地址里没有 v=、消息里也没带 videoId：无从判断这份属于哪个视频
  toPage('track', { url: 'https://www.youtube.com/api/timedtext?lang=en&fmt=json3', body: track(20, 'Xray') });
  await sleep(120);
  const m = await ask();
  check('来路不明的不收', m.segments === 0, JSON.stringify(m));
  check('也没拿它去翻译', !seen.some((t) => t.includes('Xray')), '送出 ' + seen.length + ' 行');

  console.log('\n[18] 送出去的参考上下文');
  {
    /* 并发压到 1，一批一批地翻 —— 第二批发出去的时候第一批已经落进 st.trans，
       前文才带得上译文。 */
    const sent = [];
    runtimeReply = async (m) => {
      sent.push(m.payload);
      return { ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '译:' + l.id])), dropped: [] };
    };
    await chrome.storage.local.set({
      settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1, useCache: false,
                  batchLines: 5, batchChars: 100000, useContext: true, extraPrompt: 'ctxcase' }
    });
    await sleep(30);
    toPage('player', { videoId: 'N', title: 'Rust 所有权入门', audioLang: 'en',
                       tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(30);
    sent.length = 0;
    toPage('track', { videoId: 'N', body: track(20, 'Yankee') });
    await sleep(300);

    const idOf = (t) => Number((String(t).match(/number (\d+)/) || [])[1]);
    const firstId = (p) => p.lines[0].id;
    const lastId = (p) => p.lines[p.lines.length - 1].id;

    check('确实翻了不止一批', sent.length > 1, '共 ' + sent.length + ' 批');
    check('每批都带上了视频标题', sent.every((p) => p.title === 'Rust 所有权入门'),
          JSON.stringify(sent.map((p) => p.title)));

    check('第一批没有前文', sent[0].prev.length === 0, JSON.stringify(sent[0].prev));
    check('第一批已经有后文了', sent[0].next.length > 0);

    const later = sent.find((p) => p.prev.length > 0);
    check('后面的批次带上了前文', !!later);
    check('前文最多 6 句', later.prev.length <= 6, '带了 ' + later.prev.length + ' 句');
    check('后文最多 4 句', later.next.length <= 4, '带了 ' + later.next.length + ' 句');
    check('前文里带着已经翻好的译文', later.prev.some((x) => x.tr), JSON.stringify(later.prev.slice(-2)));
    check('前文紧挨着本批第一行', idOf(later.prev[later.prev.length - 1].text) === firstId(later) - 1,
          JSON.stringify({ prev: later.prev[later.prev.length - 1].text, first: firstId(later) }));
    check('后文紧接着本批最后一行', idOf(later.next[0]) === lastId(later) + 1,
          JSON.stringify({ next: later.next[0], last: lastId(later) }));
    check('前文一路排到本批开头，中间不跳句',
          later.prev.every((x, i) => idOf(x.text) === firstId(later) - later.prev.length + i));

    const last = sent[sent.length - 1];
    check('最后一批没有后文', last.next.length === 0, JSON.stringify(last.next));
  }

  console.log('\n[19] 缓存索引只经由 background 改写');
  {
    /* 索引是「读出来 → 改 → 写回去」，而写入方不止一个：每个 YouTube 标签页都在写，
       设置页清空缓存时也在写。以前 content.js 自己动 storage，两个标签页各写各的，
       后写的把先写的整个盖掉 —— 丢了索引的缓存正文从此没人清理（淘汰只遍历索引里
       的键），存储只增不减。现在一律发消息给 background 排队处理。 */
    delete storage.cacheIndex;
    /* 缓存相关的消息一律从 sent 里看：正文写入被桩当场当成 background 处理掉了，
       走不到 runtimeReply。 */
    const ops = () => sent
      .filter((m) => m.type === 'cacheIndex' || m.type === 'cacheWrite')
      .map((m) => m.payload);
    runtimeReply = async (m) => {
      if (m.type === 'cacheIndex') return { ok: true, removed: 0 };
      return { ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '译:' + l.id])), dropped: [] };
    };
    sent.length = 0;
    await chrome.storage.local.set({
      settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1, useCache: true, extraPrompt: 'idx' }
    });
    await sleep(30);
    toPage('player', { videoId: 'IDX', title: 'idx', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(30);
    toPage('track', { videoId: 'IDX', body: track(8, 'Indexed') });
    await sleep(260);

    check('载入缓存时报了一次 touch', ops().some((o) => o.op === 'touch'),
          JSON.stringify(ops()));
    const pruning = ops().find((o) => o.op === 'write' && o.prune);
    check('落盘那次顺带带上了淘汰参数', !!pruning && pruning.prune.days > 0 && pruning.prune.max > 0,
          JSON.stringify(ops()));
    check('落盘送的是增量而不是整份', !!pruning && pruning.items && Object.keys(pruning.items).length > 0,
          JSON.stringify(pruning && pruning.items));
    check('content 自己没有直接写 cacheIndex', storage.cacheIndex === undefined,
          JSON.stringify(storage.cacheIndex));

    sent.length = 0;
    await new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'purgeCache' }, {}, res)));
    await sleep(60);
    check('重翻本视频是让 background 把这条索引忘掉', ops().some((o) => o.op === 'forget'),
          JSON.stringify(ops()));
    check('重翻仍然直接删掉了缓存正文', !cacheKeys().some((k) => k.includes('IDX')), JSON.stringify(cacheKeys()));
  }

  console.log('\n[20] 兜底开过的原生字幕要还回去');
  {
    /* 取字幕失败时我们会替用户打开原生字幕，好让播放器自己去拉、我们从劫持里截获。
       翻译开着的时候它被 CSS 藏着，看不出来；可一旦关掉翻译，用户面前就凭空多出
       一条自己没开过的字幕，而且从来没人负责关 —— disableNative 以前是死代码。 */
    runtimeReply = async () => ({ ok: true, map: {}, dropped: [] });
    await chrome.storage.local.set({
      settings: { targetLang: '简体中文', apiKey: 'x', autoStart: true, extraPrompt: 'native' }
    });
    await sleep(30);
    posted.length = 0;
    // 给了字幕轨，但一份字幕体都不回 —— 兜底计时器会走到 enableNative
    toPage('player', { videoId: 'NAT', title: 'nat', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(200);
    check('取不到字幕时确实兜底开了原生字幕', posted.some((p) => p.type === 'enableNative'),
          JSON.stringify(posted.map((p) => p.type)));
    check('这时还没有关字幕的动作', !posted.some((p) => p.type === 'disableNative'));

    await new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'setActive', value: false }, {}, res)));
    await sleep(20);
    check('关掉翻译时把原生字幕还了回去', posted.some((p) => p.type === 'disableNative'),
          JSON.stringify(posted.map((p) => p.type)));

    // 再关一次不该重复发：没开过就不该去动用户的字幕
    posted.length = 0;
    await new Promise((res) => chrome.runtime.onMessage._l.forEach((f) => f({ type: 'setActive', value: false }, {}, res)));
    await sleep(20);
    check('没开过就不去动用户的字幕', !posted.some((p) => p.type === 'disableNative'),
          JSON.stringify(posted.map((p) => p.type)));
  }

  console.log('\n[21] 播放中切推理档位');
  {
    /* README 推荐的用法是「难懂的段落临时开中档」。可 reasoning 以前既在 OUTPUT_KEYS 里
       又在缓存键里，切一下的实际后果是：整片译文清空 + 换一把缓存键，已经买过的全部
       重新买一遍 —— 正好是那个推荐用法在触发它。
       档位对后续批次的生效不在这里验：background 每次请求都现读 settings，
       到底发哪几个推理字段由 reasoning.test.js 盯着。 */
    const asked = [];
    runtimeReply = async (m) => {
      if (m.type === 'cacheIndex') return { ok: true, removed: 0 };
      m.payload.lines.forEach((l) => asked.push(l.text));
      return { ok: true, map: Object.fromEntries(m.payload.lines.map((l) => [l.id, '译:' + l.id])), dropped: [] };
    };
    await chrome.storage.local.set({
      settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1, useCache: true, extraPrompt: 'tier' }
    });
    await sleep(30);
    toPage('player', { videoId: 'RSN', title: 'rsn', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(30);
    toPage('track', { videoId: 'RSN', body: track(12, 'Reason') });
    await sleep(260);
    const b4 = await ask();
    check('先翻好一部分', b4.translated > 0, JSON.stringify(b4));

    asked.length = 0;
    const keysBeforeTier = cacheKeys().length;
    await chrome.storage.local.set({ settings: Object.assign({}, storage.settings, { reasoning: 'medium' }) });
    await sleep(180);
    const aft = await ask();
    check('切档不清空已经翻好的译文', aft.translated === b4.translated,
          b4.translated + ' -> ' + aft.translated);
    check('切档不重新买一遍', asked.length === 0, '又送了 ' + asked.length + ' 行');
    check('缓存键没换一把', cacheKeys().length === keysBeforeTier,
          keysBeforeTier + ' -> ' + cacheKeys().length);

    /* 关掉缓存再来一遍。开着缓存时就算真的作废了，译文也会立刻从缓存里回填，
       看不出差别 —— 这一段才真正验的是「档位不在 OUTPUT_KEYS 里」。 */
    await chrome.storage.local.set({
      settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1, useCache: false, extraPrompt: 'tier2' }
    });
    await sleep(30);
    toPage('player', { videoId: 'RSN2', title: 'rsn2', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(30);
    toPage('track', { videoId: 'RSN2', body: track(12, 'Reason') });
    await sleep(260);
    const n1 = await ask();
    check('无缓存时也先翻好', n1.translated > 0, JSON.stringify(n1));
    asked.length = 0;
    await chrome.storage.local.set({ settings: Object.assign({}, storage.settings, { reasoning: 'low' }) });
    await sleep(200);
    const n2 = await ask();
    check('无缓存兜底时切档也不作废译文', n2.translated === n1.translated,
          n1.translated + ' -> ' + n2.translated);
    check('无缓存兜底时切档也不重发请求', asked.length === 0, '又送了 ' + asked.length + ' 行');

    /* 换模型仍然必须作废 —— 那才真的是另一套译文 */
    asked.length = 0;
    await chrome.storage.local.set({ settings: Object.assign({}, storage.settings, { model: 'other-model' }) });
    await sleep(180);
    check('换模型照旧作废重翻', asked.length > 0, '送出 ' + asked.length + ' 行');
  }

  console.log('\n[22] 切视频要把在途请求真的掐掉，而不是只丢结果');
  {
    /* epoch 守卫只做到「回来的结果不采用」，可 background 那边的 fetch 还在跑，
       跑完还会接着 strict / repair / 拆块。并发 3 时一次切视频最多白付十来次请求，
       而且这些请求还占着下一个视频的并发额度。 */
    runtimeReply = async (m) => {
      if (m.type === 'cacheIndex') return { ok: true, removed: 0 };
      await sleep(200);        // 一直不回来，模拟慢接口
      return { ok: true, map: {}, dropped: [] };
    };
    await chrome.storage.local.set({
      settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 3, useCache: false, extraPrompt: 'cancel' }
    });
    await sleep(30);
    toPage('player', { videoId: 'CX1', title: 'cx1', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(30);
    toPage('track', { videoId: 'CX1', body: track(60, 'Cancel') });
    await sleep(60);
    const running = (await ask()).running;
    check('确实有在途批次', running > 0, '在途 ' + running);

    sent.length = 0;
    toPage('player', { videoId: 'CX2', title: 'cx2', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(40);
    const cancels = sent.filter((m) => m.type === 'cancel');
    check('切视频时通知 background 掐掉旧批次', cancels.length > 0, JSON.stringify(sent.map((m) => m.type)));
    check('掐的是「比这一版旧的全部」，不点名某一批',
          cancels.every((c) => c.payload && c.payload.epoch > 0 && c.payload.batchId === undefined),
          JSON.stringify(cancels.map((c) => c.payload)));
    /* 送出去的每一批都要带身份，background 才登记得起来 */
    const batchMsgs = sent.filter((m) => m.type === 'translateBatch');
    await sleep(240);
    const after = await ask();
    check('切走之后在途计数归零', after.running === 0, '在途 ' + after.running);
    check('批次带着 epoch 和批次编号发出去',
          batchMsgs.length === 0 || batchMsgs.every((m) => typeof m.payload.epoch === 'number' && m.payload.batchId > 0),
          JSON.stringify(batchMsgs.map((m) => ({ e: m.payload.epoch, b: m.payload.batchId }))));
  }

  console.log('\n[23] 后台永远不回应时的客户端兜底');
  {
    /* MV3 的 service worker 空闲会被回收。回收发生在响应回来之前的话，sendMessage
       的 promise 永远不会 settle —— 这一批永久停在 run，running 不减，并发额度从此
       少一个，攒够三次整个视频停摆，而屏幕上什么都不说。
       桩里的计时器是按 1/50 压缩的，120 秒兜底在这里是 60 毫秒。 */
    runtimeReply = async (m) => {
      if (m.type === 'cacheIndex') return { ok: true, removed: 0 };
      return new Promise(() => {});      // 永不 settle
    };
    await chrome.storage.local.set({
      settings: { targetLang: '简体中文', apiKey: 'x', concurrency: 1, useCache: false, extraPrompt: 'deadline' }
    });
    await sleep(30);
    toPage('player', { videoId: 'DL', title: 'dl', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(30);
    sent.length = 0;
    toPage('track', { videoId: 'DL', body: track(20, 'Deadline') });
    await sleep(40);
    const mid = await ask();
    check('这一批确实卡住了', mid.running > 0 && mid.status === 'translating', JSON.stringify(mid));

    await sleep(200);
    const end = await ask();
    check('到点把额度还回来', end.running === 0, '在途 ' + end.running);
    check('状态说得出出了什么事', end.status === 'error' && !!end.error, JSON.stringify(end));
    const one = sent.filter((m) => m.type === 'cancel' && m.payload && m.payload.batchId > 0);
    check('顺带点名让 background 把那一批掐掉', one.length > 0,
          JSON.stringify(sent.filter((m) => m.type === 'cancel').map((m) => m.payload)));
  }

  console.log('\n[24] 正在直播的视频');
  {
    /* 以前这里的表现是永远转圈：卡在「正在获取字幕…」，每 8 秒重新要一次轨、
       每 3.5 秒试着替用户打开原生字幕，无止境。说不出原因的等待比直说「不支持」
       糟得多 —— 用户会一直以为是自己哪儿没弄对。 */
    runtimeReply = async (m) => (m.type === 'cacheIndex' ? { ok: true } : { ok: true, map: {}, dropped: [] });
    posted.length = 0;
    toPage('player', {
      videoId: 'LIVE', title: 'live', audioLang: 'en', isLive: true, isLiveContent: true,
      tracks: [{ languageCode: 'en', kind: 'asr' }]
    });
    await sleep(200);
    const s = await ask();
    check('状态说得出原因', s.status === 'unsupported' && s.unsupported === 'live', JSON.stringify(s));
    check('不去要字幕轨', !posted.some((p) => p.type === 'fetchTrack'),
          JSON.stringify(posted.map((p) => p.type)));
    check('也不替用户打开原生字幕', !posted.some((p) => p.type === 'enableNative'),
          JSON.stringify(posted.map((p) => p.type)));
    check('没有自动开启', s.active === false, JSON.stringify(s));
  }

  console.log('\n[25] 直播的录播照常翻');
  {
    /* isLive 和 isLiveContent 是两回事：后者对「曾经是直播」的录播也为真。
       拿它当判据的话，一大半播客（都是直播完再挂上来的）会被一并挡掉。 */
    posted.length = 0;
    toPage('player', {
      videoId: 'VOD', title: 'vod', audioLang: 'en', isLive: false, isLiveContent: true,
      tracks: [{ languageCode: 'en', kind: 'asr' }]
    });
    await sleep(60);
    const s = await ask();
    check('录播不算不支持', !s.unsupported, JSON.stringify(s));
    check('照常去要字幕轨', posted.some((p) => p.type === 'fetchTrack'),
          JSON.stringify(posted.map((p) => p.type)));
    toPage('track', { videoId: 'VOD', body: track(10, 'Vod') });
    await sleep(150);
    check('照常翻出来', (await ask()).segments > 0);
  }

  console.log('\n[26] Shorts');
  {
    posted.length = 0;
    win.location.pathname = '/shorts/abcdefg';
    toPage('player', { videoId: 'SH', title: 'sh', audioLang: 'en', tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(120);
    const s = await ask();
    check('直说 Shorts 不支持', s.status === 'unsupported' && s.unsupported === 'shorts', JSON.stringify(s));
    check('不空转着要字幕', !posted.some((p) => p.type === 'fetchTrack'),
          JSON.stringify(posted.map((p) => p.type)));
    win.location.pathname = '/watch';
  }

  console.log('\n[27] 首播开始之后自己接上');
  {
    posted.length = 0;
    toPage('player', { videoId: 'PRE', title: 'pre', audioLang: 'en', isUpcoming: true,
                       tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(80);
    const before = await ask();
    check('还没开始时说清楚', before.unsupported === 'upcoming', JSON.stringify(before));

    // 开播了：同一个 videoId，只是标记变了
    toPage('player', { videoId: 'PRE', title: 'pre', audioLang: 'en', isUpcoming: false,
                       tracks: [{ languageCode: 'en', kind: 'asr' }] });
    await sleep(120);
    const after = await ask();
    check('标记一变就不再挡着', !after.unsupported, JSON.stringify(after));
    check('该要的字幕轨也去要了', posted.some((p) => p.type === 'fetchTrack'),
          JSON.stringify(posted.map((p) => p.type)));
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
