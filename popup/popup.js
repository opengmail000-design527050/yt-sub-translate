import { DEFAULTS, getSettings, setSettings, CODE_TO_NAME as LANG_NAMES } from '../common.js';

const $ = (id) => document.getElementById(id);
let S = Object.assign({}, DEFAULTS);
let tabId = null;

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

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

async function connectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('youtube.com')) tabId = tab.id;
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
    text = (r.status === 'translating' ? '正在翻译' : '已翻译') + ` ${r.translated}/${r.segments} 句`;
  } else if (!r.active && r.hasTracks && r.needsTranslation === false) {
    text = '原声已是目标语言，无需翻译';
  }
  if (r.sourceLang && key !== 'nosub') {
    text += `　·　识别为 ${LANG_NAMES[r.sourceLang] || LANG_NAMES[r.sourceLang.split('-')[0]] || r.sourceLang}`;
  }
  $('statusText').textContent = text;
  $('dot').dataset.s = r.active ? r.status : '';
  $('videoTitle').textContent = r.title || '';
  $('barFill').style.width = r.segments ? Math.round((r.translated / r.segments) * 100) + '%' : '0%';

  const hasErr = !!r.error;
  $('errText').textContent = r.error || '';
  $('errText').classList.toggle('hidden', !hasErr);
  $('retryBtn').classList.toggle('hidden', !hasErr);
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
