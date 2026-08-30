import { DEFAULTS, getSettings, setSettings, resolveTargetName, uiLanguage } from '../common.js';

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang', 'temperature', 'maxTokens',
                     'extraPrompt', 'reasoningStyle', 'layout', 'fontFamily', 'density'];

/* 与 content.js 里的 FONT_STACKS 保持一致 */
const FONT_STACKS = {
  serif: '"Georgia", "Iowan Old Style", "Palatino Linotype", Constantia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", STSong, serif',
  sans: '"Inter", "Helvetica Neue", -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  kai: '"Constantia", "Cambria", Georgia, "Kaiti SC", STKaiti, KaiTi, "Noto Serif SC", serif'
};

const FONT_NOTES = {
  serif: '衬线的字形有呼吸感，中文回落到思源宋体，长时间看不累。',
  sans: '最中性、笔画最实，小字号或低画质视频下最稳。',
  kai: '楷体最有手写的味道，但笔画细，建议配合更大的字号和更深的底色。'
};
const RANGE_FIELDS = {
  batchLines: (v) => v,
  batchChars: (v) => v,
  lookahead: (v) => v,
  concurrency: (v) => v,
  origScale: (v) => Number(v).toFixed(2),
  bgOpacity: (v) => Number(v).toFixed(2),
  maxWidth: (v) => v + '%',
  cacheDays: (v) => (Number(v) >= 365 ? '1 年' : v + ' 天'),
  cacheMax: (v) => v + ' 个'
};

const DENSITY_NOTES = {
  compact: '句子切得短，中英大多各占一行，字幕框最矮。代价是长句会在逗号处多切几刀，译文偶尔略碎。',
  standard: '推荐。完整句子优先，长句才在逗号处切。通常英文一到两行、中文一行。',
  full: '几乎不拆句，译文最连贯，但一屏可能到四行，框会明显变高。'
};
const CHECK_FIELDS = ['useContext', 'useCache', 'hideNative', 'autoScale'];

let S = Object.assign({}, DEFAULTS);

async function init() {
  S = await getSettings();

  TEXT_FIELDS.forEach((k) => { $(k).value = S[k] ?? ''; });
  Object.keys(RANGE_FIELDS).forEach((k) => {
    $(k).value = S[k];
    $(k + 'V').textContent = RANGE_FIELDS[k]($(k).value);
  });
  CHECK_FIELDS.forEach((k) => { $(k).checked = !!S[k]; });

  bind();
  paintPreview();
  paintPos();
  refreshStats();
}

function paintPreview() {
  const pv = $('preview');
  const stage = $('previewStage');
  pv.style.fontFamily = FONT_STACKS[S.fontFamily] || FONT_STACKS.serif;
  pv.style.background = 'rgba(0,0,0,' + S.bgOpacity + ')';
  pv.style.maxWidth = (S.maxWidth || 88) + '%';
  if (stage) stage.title = `字幕框最宽 ${S.maxWidth || 88}%`;
  pv.querySelector('.pv-orig').style.fontSize = Math.round(S.fontSize * S.origScale) + 'px';
  pv.querySelector('.pv-trans').style.fontSize = S.fontSize + 'px';
  pv.querySelector('.pv-orig').style.display = S.layout === 'transOnly' ? 'none' : '';
  $('fontNote').textContent = FONT_NOTES[S.fontFamily] || '';
  $('densityNote').textContent = DENSITY_NOTES[S.density] || '';

  const t = String(S.targetLang || 'auto').trim();
  $('langNote').textContent = (!t || t.toLowerCase() === 'auto')
    ? `自动：跟随浏览器界面语言（${uiLanguage()}），当前会译成「${resolveTargetName(S)}」。原声语言由插件自己识别，不用设置。`
    : `固定译成「${t}」。改回 auto 就跟随浏览器界面语言。原声语言由插件自己识别，不用设置。`;
}

function paintPos() {
  const custom = typeof S.posX === 'number' && typeof S.posY === 'number';
  $('posOut').textContent = custom
    ? `当前位置 ${Math.round(S.posX)}% / ${Math.round(S.posY)}%`
    : '当前是默认位置';
  $('resetPos').disabled = !custom;
}

function bind() {
  TEXT_FIELDS.forEach((k) => {
    $(k).addEventListener('change', () => commit({ [k]: $(k).value.trim() }));
  });

  Object.keys(RANGE_FIELDS).forEach((k) => {
    $(k).addEventListener('input', () => {
      $(k + 'V').textContent = RANGE_FIELDS[k]($(k).value);
      S[k] = Number($(k).value);
      paintPreview();
    });
    $(k).addEventListener('change', () => commit({ [k]: Number($(k).value) }));
  });

  CHECK_FIELDS.forEach((k) => {
    $(k).addEventListener('change', () => commit({ [k]: $(k).checked }));
  });

  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    const shown = el.type === 'text';
    el.type = shown ? 'password' : 'text';
    $('toggleKey').textContent = shown ? '显示' : '隐藏';
  });

  $('testBtn').addEventListener('click', runTest);
  $('clearCache').addEventListener('click', clearCache);
  $('resetStats').addEventListener('click', resetStats);
  $('resetPos').addEventListener('click', () => commit({ posX: null, posY: null }));

  // 视频里拖动过字幕框后，这里的位置显示跟着更新
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.settings) return;
    S = Object.assign({}, DEFAULTS, ch.settings.newValue || {});
    paintPos();
  });
}

async function commit(patch) {
  S = await setSettings(patch);
  paintPreview();
  paintPos();
  toast('已保存');
  broadcast();
}

async function broadcast() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    for (const t of tabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: 'settingsChanged' }); } catch (_) {}
    }
  } catch (_) {}
}

async function runTest() {
  const out = $('testOut');
  out.className = 'testOut';
  out.textContent = '请求中…';
  $('testBtn').disabled = true;

  const res = await chrome.runtime.sendMessage({ type: 'testApi', payload: {} });
  $('testBtn').disabled = false;

  if (!res || !res.ok) {
    out.className = 'testOut bad';
    out.textContent = '失败：' + ((res && res.error) || '无响应');
    return;
  }
  out.className = 'testOut ok';
  const u = res.usage;
  const tok = u ? ` · ${(u.prompt_tokens || 0) + (u.completion_tokens || 0)} tokens` : '';
  out.textContent = `通了（${res.ms}ms${tok}）→ ${res.sample.replace(/\n/g, ' / ')}`;
  refreshStats();
}

async function refreshStats() {
  const got = await chrome.storage.local.get(['stats', 'cacheIndex']);
  const s = got.stats;
  const idx = got.cacheIndex || {};
  const keys = Object.keys(idx);

  const parts = [];
  if (s && s.requests) {
    parts.push(`累计 ${s.requests} 次请求`);
    parts.push(`输入 ${fmt(s.prompt)} / 输出 ${fmt(s.completion)} tokens`);
  } else {
    parts.push('还没有用量记录');
  }

  let bytes = 0;
  try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (_) {}
  parts.push(`已缓存 ${keys.length} 个视频${bytes ? '（' + fmtBytes(bytes) + '）' : ''}`);

  if (keys.length) {
    const oldest = Math.min(...keys.map((k) => idx[k] || Date.now()));
    const days = Math.floor((Date.now() - oldest) / 86400000);
    parts.push(`最早一条 ${days} 天前用过`);
  }

  $('statLine').textContent = parts.join(' · ');
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('c_'));
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ cacheIndex: {} });
  toast(`已清空 ${keys.length} 个视频的缓存`);
  refreshStats();
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function resetStats() {
  await chrome.storage.local.remove('stats');
  toast('用量已归零');
  refreshStats();
}

function fmt(n) {
  n = Number(n || 0);
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

init();
