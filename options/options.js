import { DEFAULTS, getSettings, setSettings, resolveTargetName, uiLanguage,
         originPattern, hasApiPermission,
         PROFILE_KEYS, getProfiles, saveProfiles, newProfileId, pickProfile } from '../common.js';

const $ = (id) => document.getElementById(id);

/* 只列设置页里真正存在的控件。分批/并发/温度/附加提示词等仍在 DEFAULTS 里生效，
   只是不再暴露给用户调整（已调好，改动收益低、出错风险高）。 */
const TEXT_FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang',
                     'reasoningStyle', 'layout', 'fontFamily', 'density'];

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
  origScale: (v) => Number(v).toFixed(2),
  bgOpacity: (v) => (Number(v) <= 0 ? '全透明' : Number(v).toFixed(2)),
  maxWidth: (v) => v + '%',
  cacheDays: (v) => (Number(v) >= 365 ? '1 年' : v + ' 天'),
  cacheMax: (v) => v + ' 个'
};

const DENSITY_NOTES = {
  compact: '句子切得短，中英大多各占一行，字幕框最矮。代价是长句会在逗号处多切几刀，译文偶尔略碎。',
  standard: '推荐。完整句子优先，长句才在逗号处切。通常英文一到两行、中文一行。',
  full: '几乎不拆句，译文最连贯，但一屏可能到四行，框会明显变高。'
};
const CHECK_FIELDS = ['hideNative', 'autoScale'];

/* 这两项已经从设置页撤掉了：上下文每批只多约 30 token 却直接决定连贯性，
   缓存关掉等于重看一次付一次钱，实际没人会去关。
   但撤掉控件之后，以前手动关过的人就再也打不开了 —— 所以打开设置页时补一次。 */
const FORCED_ON = ['useContext', 'useCache'];

let S = Object.assign({}, DEFAULTS);
let P = { active: '', list: [] };

async function init() {
  S = await getSettings();
  P = await getProfiles();

  const stuck = FORCED_ON.filter((k) => !S[k]);
  if (stuck.length) S = await setSettings(Object.fromEntries(stuck.map((k) => [k, true])));

  TEXT_FIELDS.forEach((k) => { $(k).value = S[k] ?? ''; });
  Object.keys(RANGE_FIELDS).forEach((k) => {
    $(k).value = S[k];
    $(k + 'V').textContent = RANGE_FIELDS[k]($(k).value);
  });
  CHECK_FIELDS.forEach((k) => { $(k).checked = !!S[k]; });

  bind();
  paintProfiles();
  paintPreview();
  paintPos();
  paintPerm();
  refreshStats();
}

/* ------------------------------------------------------------------ *
 * 接口配置档
 *
 * P 是「存了哪几套」，settings 是「现在正在用哪一套」。两边都要写：
 * 运行时（background / content）只认 settings，切换才是把某一档灌回 settings；
 * 而在这张卡片里改字段又要顺手存回当前这一档，否则切走再切回来就丢了。
 * ------------------------------------------------------------------ */

function activeProfile() {
  return P.list.find((x) => x.id === P.active) || P.list[0];
}

/** 同名会让下拉框认不出谁是谁，自动加序号 */
function uniqueName(base) {
  const used = new Set(P.list.map((x) => x.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(base + ' ' + i)) return base + ' ' + i;
}

function paintProfiles() {
  const sel = $('profileSel');
  sel.innerHTML = '';
  for (const p of P.list) {
    const o = document.createElement('option');
    o.value = p.id;
    // 顺手把模型名带出来，几套配置一眼能分清
    o.textContent = p.name + (p.model ? ' · ' + p.model : '');
    sel.appendChild(o);
  }
  sel.value = P.active;
  // 最后一档不给删，否则就没有任何配置可用了
  $('pfDel').disabled = P.list.length <= 1;
  disarmDelete();
}

/** 把当前设置里的接口字段刷回表单（切换配置之后用） */
function paintApiFields() {
  for (const k of PROFILE_KEYS) $(k).value = S[k] ?? '';
  // Key 换了一套，重新遮起来
  $('apiKey').type = 'password';
  $('toggleKey').textContent = '显示';
}

async function switchProfile(id) {
  if (id === P.active) return;
  const p = P.list.find((x) => x.id === id);
  if (!p) return;
  P = await saveProfiles({ active: id, list: P.list });
  await commit(pickProfile(p), `已切换到「${p.name}」`);
  paintApiFields();
  paintProfiles();
}

/** from 为空 = 建一份干净的；传当前档 = 复制一份 */
async function addProfile(from) {
  const base = from
    ? Object.assign({ id: newProfileId(), name: uniqueName(from.name + ' 副本') }, pickProfile(from))
    : Object.assign({ id: newProfileId(), name: uniqueName('新配置') }, pickProfile(DEFAULTS), { apiKey: '' });
  P = await saveProfiles({ active: base.id, list: P.list.concat([base]) });
  await commit(pickProfile(base), `已新建「${base.name}」`);
  paintApiFields();
  paintProfiles();
  startRename();
}

/* 删除是不可逆的（Key 就没了），所以点第一下只是「上膛」，
   3 秒内再点一下才真删。比弹 confirm 框轻，也不会误触。 */
let delTimer = null;
function disarmDelete() {
  clearTimeout(delTimer);
  delTimer = null;
  $('pfDel').classList.remove('arming');
  $('pfDel').textContent = '删除';
}

async function deleteProfile() {
  if (P.list.length <= 1) return;
  const btn = $('pfDel');
  if (!btn.classList.contains('arming')) {
    btn.classList.add('arming');
    btn.textContent = '确认删除？';
    delTimer = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();

  const gone = activeProfile();
  const list = P.list.filter((x) => x.id !== gone.id);
  P = await saveProfiles({ active: list[0].id, list });
  await commit(pickProfile(list[0]), `已删除「${gone.name}」`);
  paintApiFields();
  paintProfiles();
}

/* 重命名就是把下拉框换成输入框，回车或失焦生效。 */
function startRename() {
  const sel = $('profileSel'), inp = $('profileName');
  inp.value = activeProfile().name;
  sel.classList.add('hidden');
  inp.classList.remove('hidden');
  $('pfRename').textContent = '完成';
  inp.focus();
  inp.select();
}

async function endRename(save) {
  const sel = $('profileSel'), inp = $('profileName');
  if (inp.classList.contains('hidden')) return;
  if (save) {
    const name = inp.value.trim();
    const cur = activeProfile();
    if (name && name !== cur.name) {
      cur.name = uniqueName(name);
      P = await saveProfiles(P);
      toast('已重命名');
    }
  }
  inp.classList.add('hidden');
  sel.classList.remove('hidden');
  $('pfRename').textContent = '重命名';
  paintProfiles();
}

function paintPreview() {
  const pv = $('preview');
  const stage = $('previewStage');
  pv.style.fontFamily = FONT_STACKS[S.fontFamily] || FONT_STACKS.serif;
  const bg = Math.max(0, Number(S.bgOpacity) || 0);
  pv.style.background = 'rgba(0,0,0,' + bg + ')';
  pv.classList.toggle('pv-no-bg', bg <= 0);   // 与播放器里的 .ytst-no-bg 保持一致
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

/* ------------------------------------------------------------------ *
 * 自定义 API 地址的权限
 * manifest 只静态声明了 api.openai.com。填别的地址时在这里按需申请，
 * 这样安装时不用向用户要「所有网站」的权限。
 * ------------------------------------------------------------------ */
async function paintPerm() {
  const note = $('permNote');
  const origin = originPattern(S.baseUrl);
  const ok = !origin || (await hasApiPermission(S.baseUrl));
  note.classList.toggle('hidden', ok);
  if (!ok) $('permText').textContent = `还没有访问 ${origin.slice(0, -2)} 的权限，翻译会失败。`;
}

/** 返回是否拿到了权限。必须由用户点击触发，Chrome 才允许弹这个授权框。 */
async function requestApiPermission() {
  const origins = originPattern(S.baseUrl);
  if (!origins) return true;
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origins] }); } catch (_) {}
  await paintPerm();
  if (granted) toast('已授权');
  return granted;
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

  $('profileSel').addEventListener('change', () => switchProfile($('profileSel').value));
  $('pfNew').addEventListener('click', () => addProfile(null));
  $('pfCopy').addEventListener('click', () => addProfile(activeProfile()));
  $('pfDel').addEventListener('click', deleteProfile);
  /* 输入框失焦会先跑 endRename，把输入框藏起来；那之后按钮的 click 才到，
     看到的是「已经藏起来了」，于是又开一次重命名。按住时不让焦点移走就没这回事。 */
  $('pfRename').addEventListener('mousedown', (e) => {
    if (!$('profileName').classList.contains('hidden')) e.preventDefault();
  });
  $('pfRename').addEventListener('click', () => {
    $('profileName').classList.contains('hidden') ? startRename() : endRename(true);
  });
  $('profileName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') endRename(true);
    if (e.key === 'Escape') endRename(false);
  });
  $('profileName').addEventListener('blur', () => endRename(true));

  $('testBtn').addEventListener('click', runTest);
  $('permBtn').addEventListener('click', requestApiPermission);
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

async function commit(patch, msg) {
  S = await setSettings(patch);

  /* 改的是接口字段就顺手存回当前配置档。切换/新建/删除也会走到这里，
     那时候写进去的正是刚灌进 settings 的同一份值，是幂等的。 */
  const cur = activeProfile();
  if (cur && PROFILE_KEYS.some((k) => k in patch)) {
    for (const k of PROFILE_KEYS) if (k in patch) cur[k] = S[k];
    await saveProfiles(P);
    paintProfiles();      // 下拉框里带着模型名，改了模型要跟着变
  }

  paintPreview();
  paintPos();
  if ('baseUrl' in patch) paintPerm();
  toast(msg || '已保存');
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

const REASON_LEVEL = { none: '关闭', low: '低', medium: '中' };
const REASON_STYLE = {
  effort_none: 'reasoning_effort 含 "none"',
  effort: 'reasoning_effort，关闭时不发',
  enable_thinking: 'enable_thinking',
  off: '从不发送'
};

/* 把「设置里选的档位」「实际发出去的字段」「模型真的烧了多少推理 token」
   三件事摆在一起。只看设置是判断不出推理关没关的 —— 写法选错时，
   服务商会安安静静地退回它自己的默认档，账单上才看得出来。 */
function paintTestDetail(res) {
  const box = $('testDetail');
  const r = res.reasoning || {};
  const u = res.usage || {};
  const rows = [];

  rows.push(row('模型', `<code>${esc(res.model || S.model)}</code>`));

  const sent = r.sent && Object.keys(r.sent).length
    ? Object.entries(r.sent).map(([k, v]) => `<code>${esc(k)}: ${esc(JSON.stringify(v))}</code>`).join(' ')
    : '<code>不发送任何推理参数</code>';
  rows.push(row('推理',
    `${REASON_LEVEL[r.level] || r.level || '—'} · 写法「${esc(REASON_STYLE[r.style] || r.style || '—')}」→ ${sent}`));

  // 拿不到就说拿不到，别拿 0 冒充「确实没推理」
  const used = r.used;
  const usedTxt = (used === null || used === undefined) ? '该服务商没有回报' : `${used} token`;
  rows.push(row('实际推理', used > 0 ? `<span class="warn">${usedTxt}</span>` : usedTxt));

  // 前缀缓存同理：拿不到就说拿不到，别拿 0 冒充「确实没命中」
  const cch = res.cached;
  rows.push(row('前缀缓存', (cch === null || cch === undefined) ? '该服务商没有回报' : `命中 ${cch} token`));

  const pt = Number(u.prompt_tokens || u.input_tokens || 0);
  const ct = Number(u.completion_tokens || u.output_tokens || 0);
  if (pt || ct) rows.push(row('本次用量', `输入 ${pt} · 输出 ${ct}`));

  let html = rows.join('');

  /* 最值得报的一种：设成「关闭」了，模型还在烧推理 token。
     README 里那句「不发字段 ≠ 不推理」说的就是这个。 */
  if (r.level === 'none' && used > 0) {
    html += `<div class="warnLine">设成了「关闭」，模型却花掉 ${used} 个推理 token —— 这个写法没能真正关掉推理。改用第一项「reasoning_effort 含 &quot;none&quot;」再测一次；如果服务商拒收，说明这个模型关不掉推理，换个模型更省。</div>`;
  }
  if (r.level !== 'none' && used === 0) {
    html += `<div class="warnLine">档位是「${REASON_LEVEL[r.level] || r.level}」，模型却一个推理 token 都没花 —— 可能是这个模型不支持推理，或者不认这种参数写法。</div>`;
  }

  box.innerHTML = html;
  box.classList.remove('hidden');
}

function row(k, v) {
  return `<div><span class="k">${esc(k)}</span>${v}</div>`;
}

function esc(x) {
  return String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function runTest() {
  const out = $('testOut');
  out.className = 'testOut';
  $('testDetail').classList.add('hidden');

  // 测试按钮本身就是一次用户手势，顺手把缺的地址权限要了
  if (!(await hasApiPermission(S.baseUrl)) && !(await requestApiPermission())) {
    out.className = 'testOut bad';
    out.textContent = '没有访问该 API 地址的权限，已取消';
    return;
  }

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
  out.textContent = `通了（${res.ms}ms）→ ${res.sample.replace(/\n/g, ' / ')}`;
  paintTestDetail(res);
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

  /* 对齐的账。改了提示词或上下文之后，就靠这一行判断模型的逐行对齐是变好还是
     变差 —— 译文好不好没法自动判，错位有客观指纹。 */
  if (s && s.batches) {
    const pct = Math.round((s.dirty || 0) / s.batches * 100);
    const bits = [`翻了 ${s.batches} 批`];
    bits.push(s.dirty ? `错位 ${s.dirty} 批（${pct}%）` : '没出过错位');
    if (s.split) bits.push(`拆块 ${s.split} 次`);
    if (s.repaired) bits.push(`补翻 ${s.repaired} 行`);
    if (s.dropped) bits.push(`放弃 ${s.dropped} 行`);
    parts.push(bits.join('，'));
  }

  /* 前缀缓存命中率。OpenAI 兼容接口通常要前缀 ≥1024 token 才自动缓存，而这里一批
     输入才 900~1400，很可能一次都进不去。是不是这样，看这行数字才知道 ——
     在有数之前，不值得为了凑够 1024 去给请求垫字（垫到 1024 拿五折等于 512，
     比现在 900 不缓存还贵）。 */
  if (s && s.requests) {
    if (!s.cachedReports) {
      parts.push('前缀缓存：服务商没回报');
    } else {
      const pct = s.prompt ? Math.round((s.cached || 0) / s.prompt * 100) : 0;
      parts.push(`前缀缓存命中 ${fmt(s.cached || 0)}（占输入 ${pct}%）`);
    }
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

/* 清空也走 background：索引的读-改-写全都排在那一条队列上。自己在这儿删，
   正在看视频的标签页可能刚好把它读到一半的旧索引整个写回来，抵消掉这次清空。 */
async function clearCache() {
  let res = null;
  try { res = await chrome.runtime.sendMessage({ type: 'cacheIndex', payload: { op: 'clear' } }); } catch (_) {}
  toast(res && res.ok ? `已清空 ${res.removed} 个视频的缓存` : '清空失败，请重试');
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
