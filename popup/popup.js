import { DEFAULTS, getSettings, setSettings, CODE_TO_NAME as LANG_NAMES,
         getProfiles, saveProfiles, pickProfile } from '../common.js';

const $ = (id) => document.getElementById(id);
let S = Object.assign({}, DEFAULTS);
let tabId = null;
let tabUrl = '';
let P = { active: '', list: [] };   // 存了哪几套接口配置

const STATUS_TEXT = {
  idle: '已关闭',
  waiting: '正在获取字幕…',
  ready: '字幕已就绪',
  translating: '正在翻译…',
  error: '出错了',
  nosub: '这个视频没有可用的字幕轨'
};

/* 说不出原因的等待，比直说「这儿不支持」糟得多 —— 用户会一直以为是自己哪儿没弄对，
   然后反复刷新一个刷新多少次也不会好的页面。 */
const UNSUPPORTED_TEXT = {
  live: '正在直播的视频暂不支持',
  upcoming: '首播还没开始',
  shorts: 'Shorts 暂不支持',
  'no-player': '这个页面上没有播放器'
};

/* 错误码 → 说人话的一句 + 唯一的那个下一步动作。
 *
 * 以前弹窗直接摆服务商的原话（「HTTP 401: Incorrect API key provided: sk-***」），
 * 用户既不知道去哪儿改，也不知道该不该重试。原话仍然留着（挂在 title 上，报障时
 * 唯一能定位的往往就是它），但摆在最前面的是「这是什么事」和「现在该干什么」。
 * fix 为空表示什么都不用做或者只能等。 */
const ERROR_INFO = {
  noKey:   { text: '还没填 API Key', fix: '去设置' },
  noPerm:  { text: '还没授权访问这个 API 地址', fix: '去授权' },
  auth:    { text: 'API Key 不对，或者这个 Key 没有权限', fix: '去设置' },
  model:   { text: '接口拒收了这次请求，多半是模型名或推理参数写法不对', fix: '去设置' },
  rate:    { text: '接口限流，稍后会自动重试', fix: '' },
  server:  { text: '服务商那边出错了', fix: '' },
  timeout: { text: '请求超时', fix: '' },
  format:  { text: '模型没有按行给出译文', fix: '' },
  network: { text: '连不上接口，检查一下网络和 API 地址', fix: '去设置' }
};

/* 重试对这几种没有意义：没填 Key、没授权、以及正在自动重试的限流。 */
const NO_RETRY = ['noKey', 'noPerm', 'rate'];

const HINTS = {
  none: '字幕翻译一般「关闭」就够，最快最省。',
  low: '略微思考，长句、双关和技术梗更稳。',
  medium: '最贴切，但明显更慢更贵，只在难听懂的访谈里用。'
};

async function init() {
  S = await getSettings();
  try { P = await getProfiles(); } catch (_) {}
  paintSettings();
  bind();
  await connectTab();
  refreshStatus();
  refreshUsage();
  setInterval(refreshStatus, 1200);
}

function paintSettings() {
  $('master').checked = !!S.enabled;
  $('autoStart').checked = !!S.autoStart;
  $('fontSize').value = S.fontSize;
  $('fontVal').textContent = S.fontSize;
  setSeg('reasoning', S.reasoning);
  $('reasonHint').textContent = HINTS[S.reasoning] || '';
  paintModel();
  paintSetup();
}

/* 这插件不填接口根本用不了。没有这一条的话，用户要等到打开视频、第一批翻译失败，
   才在错误里看到「还没填 API Key」—— 那已经晚了一步，而且看起来像插件坏了。 */
function paintSetup() {
  $('setupBar').classList.toggle('hidden', !!String(S.apiKey || '').trim());
}

/* 推理三档是对着某一个模型选的 —— 同样的「关闭」，换个模型可能就关不掉了。
   所以把当前模型写在「推理强度」右边，不用为了确认它跑一趟设置页。
   模型名取自 settings（运行时的唯一真相），同时兼作按钮：点开就是已存的
   配置档，换一套接口不用再跑设置页。 */
function paintModel() {
  const el = $('modelTag');
  const model = String(S.model || '').trim();
  el.textContent = model || '未设置模型';
  el.classList.toggle('none', !model);

  const cur = P.list.find((x) => x.id === P.active);
  el.title = (cur && cur.name ? `配置「${cur.name}」　·　` : '') +
             (model ? '模型 ' + model : '还没填模型，去设置页填一个') +
             '　·　点击切换配置';
}

/* 每次打开都重画一遍：上一次点过之后当前档换了，标记得跟着挪。 */
function paintMenu() {
  const box = $('pfMenu');
  box.innerHTML = '';
  for (const p of P.list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pfItem' + (p.id === P.active ? ' on' : '');
    b.dataset.id = p.id;
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', p.id === P.active ? 'true' : 'false');
    const n = document.createElement('span');
    n.className = 'pfName';
    n.textContent = p.name;
    const m = document.createElement('span');
    m.className = 'pfModel';
    m.textContent = p.model || '未设置模型';
    b.append(n, m);
    box.appendChild(b);
  }
  // 只有一档时这一条就是唯一出口：告诉用户上哪儿再加一档
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'pfItem pfMore';
  more.setAttribute('role', 'menuitem');
  more.textContent = '管理配置…';
  box.appendChild(more);
}

function openMenu(on) {
  const box = $('pfMenu');
  const want = on === undefined ? box.classList.contains('hidden') : on;
  if (want) paintMenu();
  box.classList.toggle('hidden', !want);
  $('modelTag').classList.toggle('open', want);
  $('modelTag').setAttribute('aria-expanded', want ? 'true' : 'false');
}

/* P 是「存了哪几套」，settings 是「现在正在用哪一套」—— 和设置页一样，
   切换就是把某一档的接口字段灌回 settings，运行时只认 settings。
   content 那边收到 settingsChanged 会自己作废旧译文按新配置重来。 */
async function switchProfile(id) {
  const p = P.list.find((x) => x.id === id);
  if (!p || id === P.active) return;
  P = await saveProfiles({ active: id, list: P.list });
  await save(pickProfile(p));
  paintModel();
  paintSetup();          // 换到一档没填 Key 的，横幅得回来
  toast(`已切换到「${p.name}」`);
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1600);
}

function setSeg(id, value) {
  [...$(id).querySelectorAll('button')].forEach((b) => {
    b.classList.toggle('on', b.dataset.v === value);
  });
}

async function save(patch) {
  S = await setSettings(patch);
  if (tabId) { try { await chrome.tabs.sendMessage(tabId, { type: 'settingsChanged' }); } catch (_) {} }
}

function bind() {
  $('master').addEventListener('change', async (e) => {
    await save({ enabled: e.target.checked });
    if (tabId) { try { await chrome.tabs.sendMessage(tabId, { type: 'setActive', value: e.target.checked }); } catch (_) {} }
    refreshStatus();
  });

  $('autoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));

  $('reasoning').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg('reasoning', b.dataset.v);
    $('reasonHint').textContent = HINTS[b.dataset.v] || '';
    save({ reasoning: b.dataset.v });
  });

  $('fontSize').addEventListener('input', (e) => {
    $('fontVal').textContent = e.target.value;
    save({ fontSize: Number(e.target.value) });
  });

  $('retryBtn').addEventListener('click', async () => {
    if (!tabId) return;
    try { await chrome.tabs.sendMessage(tabId, { type: 'retry' }); } catch (_) {}
    refreshStatus();
  });

  /* 错位的译文会按原文哈希存进缓存，刷新页面只会再命中同一份错的。
   * 给一个「把这个视频的缓存扔了重翻」的出口。 */
  $('purgeBtn').addEventListener('click', async () => {
    if (!tabId) return;
    const b = $('purgeBtn');
    b.disabled = true;
    b.textContent = '正在重翻…';
    try { await chrome.tabs.sendMessage(tabId, { type: 'purgeCache' }); } catch (_) {}
    b.disabled = false;
    b.textContent = '译文和原文对不上？重翻本视频';
    refreshStatus();
  });

  $('modelTag').addEventListener('click', (e) => { e.stopPropagation(); openMenu(); });

  $('pfMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    openMenu(false);
    if (b.dataset.id) switchProfile(b.dataset.id);
    else chrome.runtime.openOptionsPage();
  });

  document.addEventListener('click', () => openMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openMenu(false); });

  // 「去设置」「去授权」都落在同一个地方：那两件事都在设置页做
  $('fixBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('setupBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('copyDiag').addEventListener('click', copyDiagnostics);

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

/* content script 只注入 www.youtube.com（见 manifest 的 matches）。
   光看 includes('youtube.com') 会把 music.youtube.com、studio.youtube.com 也认下来，
   而那些页面上没有 content script、getStatus 永远收不到回应，于是状态栏一直写着
   「页面未就绪，刷新一下试试」—— 催用户去刷新一个刷新多少次也不会好的页面。 */
async function connectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabUrl = (tab && tab.url) || '';
  tabId = /^https:\/\/www\.youtube\.com\//.test(tabUrl) ? tab.id : null;
}

/* 没有 content script 的页面各有各的原因，说清楚是哪一种。
   一律写「当前不是 YouTube 页面」的话，人在 music.youtube.com 上会以为插件坏了。 */
function offsiteText() {
  if (/youtube-nocookie\.com\//.test(tabUrl)) return '嵌入播放器暂不支持，在 YouTube 上打开这个视频';
  if (/^https:\/\/(m|music|studio)\.youtube\.com\//.test(tabUrl)) return '只支持 www.youtube.com 上的视频页';
  return '当前不是 YouTube 页面';
}

async function refreshStatus() {
  if (!tabId) {
    $('statusText').textContent = offsiteText();
    $('dot').removeAttribute('data-s');
    return;
  }
  let r = null;
  try { r = await chrome.tabs.sendMessage(tabId, { type: 'getStatus' }); } catch (_) {}
  if (!r) {
    $('statusText').textContent = '页面未就绪，刷新一下试试';
    return;
  }

  /* YouTube 改版了：我们摸的是它的内部实现，随时可能在某次发版里换掉。坏了要说得出
     坏在哪一件上 —— 用户报障时一句话就能定位，也不必再去猜是不是自己哪儿没弄对。 */
  if (r.playerChanged) {
    $('statusText').textContent = 'YouTube 改版了，插件读不到播放器数据';
    $('dot').removeAttribute('data-s');
    $('videoTitle').textContent = r.title || '';
    const miss = (r.capsMissing || []).join('、');
    $('srcText').textContent = miss ? '缺少：' + miss + '　·　等插件更新' : '等插件更新';
    $('srcText').classList.remove('hidden');
    $('barFill').style.width = '0%';
    $('errText').classList.add('hidden');
    $('retryBtn').classList.add('hidden');
    $('fixBtn').classList.add('hidden');
    $('purgeBtn').classList.add('hidden');
    return;
  }

  /* 不支持的页面压过一切：直播翻不了，再显示「正在获取字幕…」就是在骗人 */
  if (r.unsupported) {
    $('statusText').textContent = UNSUPPORTED_TEXT[r.unsupported] || '这个页面暂不支持';
    $('dot').removeAttribute('data-s');
    $('videoTitle').textContent = r.title || '';
    $('srcText').classList.add('hidden');
    $('barFill').style.width = '0%';
    $('errText').classList.add('hidden');
    $('retryBtn').classList.add('hidden');
    $('fixBtn').classList.add('hidden');
    $('purgeBtn').classList.add('hidden');
    return;
  }

  const key = r.active ? r.status : (r.status === 'nosub' ? 'nosub' : 'idle');
  let text = STATUS_TEXT[key] || '—';
  if (r.active && r.segments) {
    // 用自带字幕时一个字都没翻，别写成「已翻译」
    const verb = r.adopted ? '已配上' : (r.status === 'translating' ? '正在翻译' : '已翻译');
    text = verb + ` ${r.translated}/${r.segments} 句`;
  } else if (!r.active && r.hasTracks && r.needsTranslation === false) {
    text = r.audioDubbed ? '当前是配音音轨，无需翻译' : '原声已是目标语言，无需翻译';
  }
  /* 「没有英文字幕」这句以前是写死的，可源语言是自动识别的 —— 一个法语视频
     照样会看到「没有英文字幕」。把真正识别出来的那个语言写进去。 */
  if (key === 'nosub') {
    const lang = r.audioLang || r.sourceLang;
    if (lang) text = `这个视频没有可用的字幕轨（音轨识别为${langName(lang)}）`;
  }
  if (r.sourceLang && !r.trackLang && key !== 'nosub') {
    text += `　·　识别为 ${langName(r.sourceLang)}`;
  }
  $('statusText').textContent = text;
  $('dot').dataset.s = r.active ? r.status : '';
  $('videoTitle').textContent = r.title || '';
  paintSource(r);
  $('barFill').style.width = r.segments ? Math.round((r.translated / r.segments) * 100) + '%' : '0%';

  const hasErr = !!r.error;
  const info = ERROR_INFO[r.errorCode] || null;
  $('errText').textContent = info ? info.text : (r.error || '');
  $('errText').title = r.error || '';          // 服务商的原话留着，报障时就靠它
  $('errText').classList.toggle('hidden', !hasErr);
  $('retryBtn').classList.toggle('hidden', !(hasErr && NO_RETRY.indexOf(r.errorCode) === -1));
  const fix = (info && info.fix) || '';
  $('fixBtn').textContent = fix;
  $('fixBtn').classList.toggle('hidden', !(hasErr && fix));
  $('purgeBtn').classList.toggle('hidden', !(r.active && r.segments > 0));
}

const baseLang = (c) => String(c || '').toLowerCase().split('-')[0];
const langName = (code) =>
  !code ? '' : (LANG_NAMES[code] || LANG_NAMES[String(code).split('-')[0]] || code);

/* 现在拿哪条轨当原文，以及这个视频一共有哪些轨。
   插件挑的不一定是原声语言 —— 视频可能压根没有原声那条轨（比如过场动画的对白
   是游戏自己烧进画面的，YouTube 上只有别的语言的字幕）。不写出来的话，
   用户只会看到译文莫名其妙，还以为是切换语言没生效。 */
function paintSource(r) {
  const el = $('srcText');
  const parts = [];

  /* 这两条比字幕轨列表更要紧，摆最前面：
     一条解释「为什么这次没花钱」，一条解释「为什么听起来怪」。 */
  if (r.adopted) {
    parts.push(`译文用的是视频自带的${langName(r.adopted)}字幕，没花 token`);
  }
  if (r.audioDubbed && r.audioLang) {
    parts.push(`当前音轨是${langName(r.audioLang)}配音${r.active ? '' : ' · 换回原声音轨就会自动翻译'}`);
  }

  if (r.trackLang) {
    parts.push('字幕源：' + langName(r.trackLang) + (r.trackKind === 'asr' ? '（自动字幕）' : ''));
  }

  const tracks = r.trackList || [];
  const list = tracks.map((t) => langName(t.lang));
  const uniq = [...new Set(list)].filter(Boolean);
  if (uniq.length > 1) {
    const shown = uniq.length > 4 ? uniq.slice(0, 4).join('、') + ` 等 ${uniq.length} 种` : uniq.join('、');
    parts.push('本视频字幕轨：' + shown);
  } else if (tracks.length === 1 && r.trackLang) {
    parts.push('本视频只有这一条字幕轨');
  }

  /* 音频是一种语言、却没有对应的字幕轨 —— 比如对白是游戏烧进画面的。
     这时插件只能拿现有的轨去翻，等于翻「译文的译文」。不点破的话，
     用户会以为是自己在字幕菜单里切换没生效。 */
  const audio = baseLang(r.audioLang);
  const hasAudioTrack = tracks.some((t) => baseLang(t.lang) === audio);
  if (audio && tracks.length && !hasAudioTrack) {
    parts.push(`没有${langName(r.audioLang)}字幕轨，只能拿现有的轨当原文`);
  }

  el.textContent = parts.join('　·　');
  el.classList.toggle('hidden', !parts.length);
}

/* ------------------------------------------------------------------ *
 * 诊断信息
 *
 * 别人机器上的问题只能靠这个查：状态迁移、要了哪条轨、每批的结果、每次请求的
 * 耗时和错误码，加上一份「当前是怎么配的」。
 *
 * 里面绝不能有 API Key —— 用户会把这段话贴到聊天群、贴到 issue 里。地址只留主机名
 * （路径上偶尔挂着令牌），原文和译文一个字都不带（那是他正在看的内容）。
 * ------------------------------------------------------------------ */
function hostOf(u) {
  try { return new URL(String(u)).host; } catch (_) { return String(u || '').slice(0, 40); }
}

function safeUA() {
  try { return navigator.userAgent; } catch (_) { return '未知'; }
}

function version() {
  try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; }
}

async function collectDiagnostics() {
  const out = ['Sub Translator ' + version(), 'UA: ' + safeUA()];
  out.push('配置: 模型=' + (S.model || '空') +
           ' 接口=' + hostOf(S.baseUrl) +
           ' Key=' + (String(S.apiKey || '').trim() ? '已填' : '空') +
           ' 目标语言=' + S.targetLang +
           ' 推理=' + S.reasoning + '/' + S.reasoningStyle);
  out.push('参数: 并发=' + S.concurrency + ' 批次=' + S.batchLines + '行/' + S.batchChars + '字' +
           ' 长度档=' + S.density + ' 缓存=' + (S.useCache ? '开' : '关') +
           ' 上下文=' + (S.useContext ? '开' : '关'));

  let bg = null;
  try { bg = await chrome.runtime.sendMessage({ type: 'getLog' }); } catch (_) {}
  let page = null;
  if (tabId) { try { page = await chrome.tabs.sendMessage(tabId, { type: 'getLog' }); } catch (_) {} }

  if (page) {
    out.push('', '--- 页面 ---',
             '视频=' + (page.videoId || '无') + ' 状态=' + page.status +
             (page.unsupported ? '(' + page.unsupported + ')' : '') +
             ' 句子=' + page.translated + '/' + page.segments + ' 放弃=' + page.dropped,
             '字幕轨=' + (page.trackSig || '无') + ' 源语言=' + (page.sourceLang || '?') +
             ' 自带译文=' + (page.adopt || '无') + ' 批次档=' + page.tier,
             '批次状态串=' + (page.batches || ''),
             (page.capsMissing && page.capsMissing.length ? '自检缺少=' + page.capsMissing.join(',') : '自检正常'),
             ...(page.lines || []));
  } else {
    out.push('', '--- 页面 ---', '（这个标签页上没有内容脚本，或者页面还没就绪）');
  }

  if (bg) {
    out.push('', '--- 后台 ---', '在途请求=' + bg.inflight +
             (bg.cooling && bg.cooling.length ? ' 冷却中: ' + bg.cooling.join(' / ') : ''),
             ...(bg.lines || []));
  }
  return out.join('\n');
}

async function copyDiagnostics() {
  let text = '';
  try { text = await collectDiagnostics(); } catch (e) { text = '收集诊断信息时出错：' + e; }
  try {
    await navigator.clipboard.writeText(text);
    toast('诊断信息已复制（不含 Key）');
  } catch (_) {
    // 剪贴板被策略挡住时，至少让用户能从控制台里拿走
    try { console.log(text); } catch (_) {}
    toast('复制失败，已打印到控制台');
  }
}

async function refreshUsage() {
  const got = await chrome.storage.local.get('stats');
  const s = got.stats;
  if (!s || !s.requests) { $('usage').textContent = '还没用过 token'; return; }
  const total = s.prompt + s.completion;
  $('usage').textContent = `累计 ${fmt(total)} tokens · ${s.requests} 次请求`;
}

function fmt(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}

init();
