import { DEFAULTS, getSettings, setSettings, resolveTargetName, uiLanguage,
         originPattern, hasApiPermission,
         PROFILE_KEYS, getProfiles, saveProfiles, newProfileId, pickProfile, FONT_STACKS,
         t, applyI18n } from '../common.js';

const $ = (id) => document.getElementById(id);

/* 只列设置页里真正存在的控件。分批/并发/温度/附加提示词等仍在 DEFAULTS 里生效，
   只是不再暴露给用户调整（已调好，改动收益低、出错风险高）。 */
const TEXT_FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang',
                     'reasoningStyle', 'layout', 'fontFamily', 'density'];


const FONT_NOTES = {
  serif: () => t('fontSerifNote', '字形有呼吸感，久看不累。'),
  sans: () => t('fontSansNote', '笔画最实，小字号或低画质下最稳。'),
  kai: () => t('fontKaiNote', '有手写味，笔画细，建议配大字号和深底色。')
};
const RANGE_FIELDS = {
  origScale: (v) => Number(v).toFixed(2),
  bgOpacity: (v) => (Number(v) <= 0 ? t('vTransparent', '全透明') : Number(v).toFixed(2)),
  maxWidth: (v) => v + '%',
  cacheDays: (v) => (Number(v) >= 365 ? t('vOneYear', '1 年') : t('vDays', '$1 天', [String(v)])),
  cacheMax: (v) => t('vVideos', '$1 个', [String(v)])
};

const DENSITY_NOTES = {
  compact: () => t('densityCompactNote', '框最矮，长句会切得略碎。'),
  standard: () => t('densityStandardNote', '推荐。整句优先，长句才在逗号处切。'),
  full: () => t('densityFullNote', '译文最连贯，但一屏可能到四行。')
};
const CHECK_FIELDS = ['hideNative', 'autoScale'];

/* 这两项已经从设置页撤掉了：上下文每批只多约 30 token 却直接决定连贯性，
   缓存关掉等于重看一次付一次钱，实际没人会去关。
   但撤掉控件之后，以前手动关过的人就再也打不开了 —— 所以打开设置页时补一次。 */
const FORCED_ON = ['useContext', 'useCache'];

let S = Object.assign({}, DEFAULTS);
let P = { active: '', list: [] };

async function init() {
  applyI18n();                 // 页面上写死的中文先换成当前语言
  paintFoot();
  S = await getSettings();
  P = await getProfiles();

  const stuck = FORCED_ON.filter((k) => !S[k]);
  if (stuck.length) S = await setSettings(Object.fromEntries(stuck.map((k) => [k, true])));

  paintAll();
  bind();
  refreshStats();
}

/* 页脚那句话里带着版本号 —— 以前是写死的 v0.1.0，一路发到 0.3.0 都没人记得改。 */
function paintFoot() {
  let v = '';
  try { v = chrome.runtime.getManifest().version; } catch (_) {}
  $('pageFoot').textContent = t('optFooter', '改动即时生效') + (v ? ' · v' + v : '');
}

/** 把 S / P 整个刷到界面上。初始化和「恢复默认」都走这里。 */
function paintAll() {
  TEXT_FIELDS.forEach((k) => { $(k).value = S[k] ?? ''; });
  Object.keys(RANGE_FIELDS).forEach((k) => {
    $(k).value = S[k];
    $(k + 'V').textContent = RANGE_FIELDS[k]($(k).value);
  });
  CHECK_FIELDS.forEach((k) => { $(k).checked = !!S[k]; });
  hideKey();

  paintProfiles();
  paintPreview();
  paintPos();
  paintPerm();
}

/* ------------------------------------------------------------------ *
 * 危险动作：点第一下只是「上膛」，3 秒内再点一下才真执行。
 * 比弹 confirm 框轻，也不会误触。删除配置、恢复默认都走这里。
 * ------------------------------------------------------------------ */
const armTimers = new WeakMap();

function disarm(btn, label) {
  clearTimeout(armTimers.get(btn));
  armTimers.delete(btn);
  btn.classList.remove('arming');
  btn.textContent = label;
}

/** 返回 true 表示这一下是「确认」，可以执行了 */
function armOnce(btn, label, confirmLabel) {
  if (btn.classList.contains('arming')) { disarm(btn, label); return true; }
  btn.classList.add('arming');
  btn.textContent = confirmLabel;
  armTimers.set(btn, setTimeout(() => disarm(btn, label), 3000));
  return false;
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
  disarm($('pfDel'), t('optDelete', '删除'));
}

function hideKey() {
  $('apiKey').type = 'password';
  $('toggleKey').textContent = t('optShow', '显示');
}

/** 把当前设置里的接口字段刷回表单（切换配置之后用） */
function paintApiFields() {
  for (const k of PROFILE_KEYS) $(k).value = S[k] ?? '';
  hideKey();     // Key 换了一套，重新遮起来
}

async function switchProfile(id) {
  if (id === P.active) return;
  const p = P.list.find((x) => x.id === id);
  if (!p) return;
  P = await saveProfiles({ active: id, list: P.list });
  await commit(pickProfile(p), t('toastSwitched', '已切换到「$1」', [p.name]));
  paintApiFields();
  paintProfiles();
}

/** from 为空 = 建一份干净的；传当前档 = 复制一份 */
async function addProfile(from) {
  const base = from
    ? Object.assign({ id: newProfileId(), name: uniqueName(from.name + ' ' + t('pfCopySuffix', '副本')) }, pickProfile(from))
    : Object.assign({ id: newProfileId(), name: uniqueName(t('pfNewName', '新配置')) }, pickProfile(DEFAULTS), { apiKey: '' });
  P = await saveProfiles({ active: base.id, list: P.list.concat([base]) });
  await commit(pickProfile(base), t('toastCreated', '已新建「$1」', [base.name]));
  paintApiFields();
  paintProfiles();
  startRename();
}

/* 删除是不可逆的（Key 就没了），所以走上膛-确认那一套 */
async function deleteProfile() {
  if (P.list.length <= 1) return;
  if (!armOnce($('pfDel'), t('optDelete', '删除'), t('confirmDelete', '确认删除？'))) return;

  const gone = activeProfile();
  const list = P.list.filter((x) => x.id !== gone.id);
  P = await saveProfiles({ active: list[0].id, list });
  await commit(pickProfile(list[0]), t('toastDeleted', '已删除「$1」', [gone.name]));
  paintApiFields();
  paintProfiles();
}

/* 重命名就是把下拉框换成输入框，回车或失焦生效。 */
function startRename() {
  const sel = $('profileSel'), inp = $('profileName');
  inp.value = activeProfile().name;
  sel.classList.add('hidden');
  inp.classList.remove('hidden');
  $('pfRename').textContent = t('optDone', '完成');
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
      toast(t('toastRenamed', '已重命名'));
    }
  }
  inp.classList.add('hidden');
  sel.classList.remove('hidden');
  $('pfRename').textContent = t('optRename', '重命名');
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
  if (stage) stage.title = t('optMaxWidthTip', '字幕框最宽 $1%', [String(S.maxWidth || 88)]);
  pv.querySelector('.pv-orig').style.fontSize = Math.round(S.fontSize * S.origScale) + 'px';
  pv.querySelector('.pv-trans').style.fontSize = S.fontSize + 'px';
  pv.querySelector('.pv-orig').style.display = S.layout === 'transOnly' ? 'none' : '';
  $('fontNote').textContent = FONT_NOTES[S.fontFamily] ? FONT_NOTES[S.fontFamily]() : '';
  $('densityNote').textContent = DENSITY_NOTES[S.density] ? DENSITY_NOTES[S.density]() : '';

  const tl = String(S.targetLang || 'auto').trim();
  $('langNote').textContent = (!tl || tl.toLowerCase() === 'auto')
    ? t('optLangAuto', 'auto：跟随浏览器（$1），当前译成「$2」。', [uiLanguage(), resolveTargetName(S)])
    : t('optLangFixed', '固定译成「$1」，改回 auto 则跟随浏览器。', [tl]);
}

function paintPos() {
  const custom = typeof S.posX === 'number' && typeof S.posY === 'number';
  $('posOut').textContent = custom
    ? t('optPosCustom', '当前位置 $1% / $2%', [String(Math.round(S.posX)), String(Math.round(S.posY))])
    : t('optPosDefault', '当前是默认位置');
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
  if (!ok) $('permText').textContent = t('optPermMissing', '还没有访问 $1 的权限，翻译会失败。', [origin.slice(0, -2)]);
}

/** 返回是否拿到了权限。必须由用户点击触发，Chrome 才允许弹这个授权框。 */
async function requestApiPermission() {
  const origins = originPattern(S.baseUrl);
  if (!origins) return true;
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origins] }); } catch (_) {}
  await paintPerm();
  if (granted) toast(t('toastGranted', '已授权'));
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
    if (el.type === 'text') hideKey();
    else { el.type = 'text'; $('toggleKey').textContent = t('optHide', '隐藏'); }
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
  $('resetAll').addEventListener('click', resetAll);
  // 勾不勾决定确认时的措辞，改了就把已上膛的按钮放下
  $('keepApi').addEventListener('change', () => disarm($('resetAll'), t('optResetAll', '恢复默认设置')));

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
  toast(msg || t('toastSaved', '已保存'));
  broadcast();
}

/* ------------------------------------------------------------------ *
 * 恢复默认
 *
 * 勾着「保留模型与接口」时，PROFILE_KEYS 那几项原样留下、配置档一个不动；
 * 其余（外观、缓存、字幕框位置…）全部回到 DEFAULTS。这里是整份覆盖写，
 * 不走 setSettings 的合并 —— 否则以前存过的字段会残留下来。
 * 翻译缓存和用量统计另有按钮，这里不碰。
 * ------------------------------------------------------------------ */
async function resetAll() {
  const keep = $('keepApi').checked;
  if (!armOnce($('resetAll'), t('optResetAll', '恢复默认设置'),
                keep ? t('confirmReset', '确认恢复？') : t('confirmResetAll', '确认恢复（含接口）？'))) return;

  const next = Object.assign({}, DEFAULTS);
  if (keep) Object.assign(next, pickProfile(S));
  await chrome.storage.local.set({ settings: next });
  S = next;

  if (!keep) {
    // 接口也一并出厂：只留一档空的「默认」
    const one = Object.assign({ id: newProfileId(), name: t('pfDefaultName', '默认') }, pickProfile(DEFAULTS));
    P = await saveProfiles({ active: one.id, list: [one] });
  }

  $('testCard').classList.add('hidden');
  paintAll();
  toast(keep ? t('toastResetKept', '已恢复默认（模型与接口保留）') : t('toastResetAll', '已全部恢复默认'));
  broadcast();
}

async function broadcast() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    for (const tab of tabs) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'settingsChanged' }); } catch (_) {}
    }
  } catch (_) {}
}

const reasonLevel = (k) => ({
  none: t('popupOff', '关闭'), low: t('popupLow', '低'), medium: t('popupMedium', '中')
}[k] || k);

/* ------------------------------------------------------------------ *
 * 测试连接的结果卡
 *
 * 一张模型卡：抬头是模型名和状态，下面几格全是这次请求的硬数字。
 * 「发出的参数」和「实际推理」要并排看 —— 只看设置判断不出推理关没关，
 * 写法选错时服务商会安安静静退回它自己的默认档，只有账单上看得出来。
 * ------------------------------------------------------------------ */
function cardHead(name, state, label) {
  return `<div class="mcard-head"><span class="mcard-name">${esc(name || '—')}</span>` +
         `<span class="pill ${state}">${esc(label)}</span></div>`;
}

function chip(k, v, cls) {
  return `<div class="chip${cls ? ' ' + cls : ''}"><span class="ck">${esc(k)}</span>` +
         `<span class="cv">${v}</span></div>`;
}

function paintTestCard(html) {
  const box = $('testCard');
  box.innerHTML = html;
  box.classList.remove('hidden');
}

function okCard(res) {
  const r = res.reasoning || {};
  const u = res.usage || {};
  const used = r.used;          // null = 服务商没回报，不能当成 0
  const cch = res.cached;
  const pt = Number(u.prompt_tokens || u.input_tokens || 0);
  const ct = Number(u.completion_tokens || u.output_tokens || 0);

  const sent = r.sent && Object.keys(r.sent).length
    ? Object.entries(r.sent).map(([k, v]) => `${esc(k)}=${esc(JSON.stringify(v))}`).join(' ')
    : t('cardNotSent', '不发送');

  const chips = [
    chip(t('cardLevel', '推理档位'), reasonLevel(r.level) || '—'),
    chip(t('cardSent', '发出的参数'), `<code>${sent}</code>`, 'wide'),
    chip(t('cardUsed', '实际推理'), used == null ? t('cardNotReported', '未回报') : used + ' token',
         r.level === 'none' && used > 0 ? 'bad' : ''),
    chip(t('cardPrefixCache', '前缀缓存'), cch == null ? t('cardNotReported', '未回报') : cch + ' token'),
    chip(t('cardUsage', '本次用量'), (pt || ct)
      ? t('cardInOut', '$1 进 / $2 出', [String(pt), String(ct)])
      : t('cardNotReported', '未回报'))
  ];

  let html = cardHead(res.model || S.model, 'ok', t('cardOk', '已连通 · $1 ms', [String(res.ms)])) +
             `<div class="mcard-chips">${chips.join('')}</div>`;

  // 试译回来的是带编号的对齐格式（1|…），卡片里只要译文
  const lines = String(res.sample || '').split('\n')
    .map((x) => x.trim().replace(/^\d+\s*\|\s*/, '')).filter(Boolean);
  if (lines.length) {
    html += `<div class="mcard-sample">${lines.map((x) => `<div>${esc(x)}</div>`).join('')}</div>`;
  }

  /* 最值得报的一种：设成「关闭」了，模型还在烧推理 token。 */
  if (r.level === 'none' && used > 0) {
    html += warnLine(t('cardWarnBurning',
      '设成「关闭」却烧了 $1 个推理 token。换第一种写法再测，服务商拒收就说明这个模型关不掉推理。',
      [String(used)]));
  }
  if (r.level !== 'none' && used === 0) {
    html += warnLine(t('cardWarnIdle',
      '档位是「$1」却一个推理 token 都没花，可能这个模型不支持推理，或者不认这种写法。',
      [reasonLevel(r.level)]));
  }
  return html;
}

function warnLine(text) {
  return `<div class="mcard-warn">${esc(text)}</div>`;
}

function esc(x) {
  return String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function runTest() {
  const btn = $('testBtn');

  // 测试按钮本身就是一次用户手势，顺手把缺的地址权限要了
  if (!(await hasApiPermission(S.baseUrl)) && !(await requestApiPermission())) {
    paintTestCard(cardHead(S.model, 'bad', t('cardNoPerm', '未授权')) +
      '<div class="mcard-err">' + esc(t('cardNoPermBody', '没有访问该 API 地址的权限，已取消。')) + '</div>');
    return;
  }

  paintTestCard(cardHead(S.model, 'wait', t('cardWaiting', '请求中')));
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'testApi', payload: {} });
  btn.disabled = false;

  if (!res || !res.ok) {
    paintTestCard(cardHead(S.model, 'bad', t('cardFailed', '失败')) +
      `<div class="mcard-err">${esc((res && res.error) || t('cardNoResponse', '无响应'))}</div>`);
    return;
  }
  paintTestCard(okCard(res));
  refreshStats();
}

async function refreshStats() {
  const got = await chrome.storage.local.get(['stats', 'cacheIndex']);
  const s = got.stats;
  const idx = got.cacheIndex || {};
  const keys = Object.keys(idx);

  const parts = [];
  if (s && s.requests) {
    parts.push(t('statRequests', '累计 $1 次请求', [String(s.requests)]));
    parts.push(t('statTokens', '输入 $1 / 输出 $2 tokens', [fmt(s.prompt), fmt(s.completion)]));
  } else {
    parts.push(t('statNone', '还没有用量记录'));
  }

  /* 对齐的账。改了提示词或上下文之后，就靠这一行判断模型的逐行对齐是变好还是
     变差 —— 译文好不好没法自动判，错位有客观指纹。 */
  if (s && s.batches) {
    const pct = Math.round((s.dirty || 0) / s.batches * 100);
    const bits = [t('statBatches', '翻了 $1 批', [String(s.batches)])];
    bits.push(s.dirty
      ? t('statDirty', '错位 $1 批（$2%）', [String(s.dirty), String(pct)])
      : t('statClean', '没出过错位'));
    if (s.split) bits.push(t('statSplit', '拆块 $1 次', [String(s.split)]));
    if (s.repaired) bits.push(t('statRepaired', '补翻 $1 行', [String(s.repaired)]));
    if (s.dropped) bits.push(t('statDropped', '放弃 $1 行', [String(s.dropped)]));
    parts.push(bits.join('，'));
  }

  /* 前缀缓存命中率。OpenAI 兼容接口通常要前缀 ≥1024 token 才自动缓存，而这里一批
     输入才 900~1400，很可能一次都进不去。是不是这样，看这行数字才知道 ——
     在有数之前，不值得为了凑够 1024 去给请求垫字（垫到 1024 拿五折等于 512，
     比现在 900 不缓存还贵）。 */
  if (s && s.requests) {
    if (!s.cachedReports) {
      parts.push(t('statNoPrefixReport', '前缀缓存：服务商没回报'));
    } else {
      const pct = s.prompt ? Math.round((s.cached || 0) / s.prompt * 100) : 0;
      parts.push(t('statPrefixHit', '前缀缓存命中 $1（占输入 $2%）', [fmt(s.cached || 0), String(pct)]));
    }
  }

  let bytes = 0;
  try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (_) {}
  parts.push(t('statCached', '已缓存 $1 个视频', [String(keys.length)]) +
             (bytes ? '（' + fmtBytes(bytes) + '）' : ''));

  if (keys.length) {
    const oldest = Math.min(...keys.map((k) => idx[k] || Date.now()));
    const days = Math.floor((Date.now() - oldest) / 86400000);
    parts.push(t('statOldest', '最早一条 $1 天前用过', [String(days)]));
  }

  $('statLine').textContent = parts.join(' · ');
}

/* 清空也走 background：索引的读-改-写全都排在那一条队列上。自己在这儿删，
   正在看视频的标签页可能刚好把它读到一半的旧索引整个写回来，抵消掉这次清空。 */
async function clearCache() {
  let res = null;
  try { res = await chrome.runtime.sendMessage({ type: 'cacheIndex', payload: { op: 'clear' } }); } catch (_) {}
  toast(res && res.ok
    ? t('toastCacheCleared', '已清空 $1 个视频的缓存', [String(res.removed)])
    : t('toastCacheClearFailed', '清空失败，请重试'));
  refreshStats();
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function resetStats() {
  await chrome.storage.local.remove('stats');
  toast(t('toastStatsReset', '用量已归零'));
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
