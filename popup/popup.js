import { DEFAULTS, getSettings, setSettings, CODE_TO_NAME as LANG_NAMES,
         getProfiles, saveProfiles, pickProfile } from '../common.js';

const $ = (id) => document.getElementById(id);
let S = Object.assign({}, DEFAULTS);
let tabId = null;
let P = { active: '', list: [] };   // 存了哪几套接口配置

const STATUS_TEXT = {
  idle: '已关闭',
  waiting: '正在获取字幕…',
  ready: '字幕已就绪',
  translating: '正在翻译…',
  error: '出错了',
  nosub: '这个视频没有英文字幕'
};

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

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

/* content script 只注入 www.youtube.com（见 manifest 的 matches）。
   光看 includes('youtube.com') 会把 music.youtube.com、studio.youtube.com 也认下来，
   而那些页面上没有 content script、getStatus 永远收不到回应，于是状态栏一直写着
   「页面未就绪，刷新一下试试」—— 催用户去刷新一个刷新多少次也不会好的页面。 */
async function connectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && /^https:\/\/www\.youtube\.com\//.test(tab.url)) tabId = tab.id;
}

async function refreshStatus() {
  if (!tabId) {
    $('statusText').textContent = '当前不是 YouTube 页面';
    $('dot').removeAttribute('data-s');
    return;
  }
  let r = null;
  try { r = await chrome.tabs.sendMessage(tabId, { type: 'getStatus' }); } catch (_) {}
  if (!r) {
    $('statusText').textContent = '页面未就绪，刷新一下试试';
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
  if (r.sourceLang && !r.trackLang && key !== 'nosub') {
    text += `　·　识别为 ${langName(r.sourceLang)}`;
  }
  $('statusText').textContent = text;
  $('dot').dataset.s = r.active ? r.status : '';
  $('videoTitle').textContent = r.title || '';
  paintSource(r);
  $('barFill').style.width = r.segments ? Math.round((r.translated / r.segments) * 100) + '%' : '0%';

  const hasErr = !!r.error;
  $('errText').textContent = r.error || '';
  $('errText').classList.toggle('hidden', !hasErr);
  $('retryBtn').classList.toggle('hidden', !hasErr);
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
