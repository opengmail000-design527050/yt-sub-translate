/* 叠加层：字幕框本身 —— 渲染、字号随画面缩放、拖动与调宽、选中复制、
 * 别被控制栏压住，以及播放器右下角那个「译」按钮。
 * 这个模块是唯一碰 DOM 的地方。
 */
import { DEFAULTS, FONT_STACKS, t } from '../../common.js';
import { S, st, clamp, getVideo, getPlayerEl, patchSettings } from './state.js';
import { schedule, SEEK_JUMP, SEEK_SETTLE } from './scheduler.js';
import { toggle } from './tracks.js';

/* ------------------------------------------------------------------ *
 * 叠加层渲染
 * ------------------------------------------------------------------ */
let overlay = null, box = null, elOrig = null, elTrans = null, chip = null, sizeWatcher = null;

function ensureOverlay() {
  const player = getPlayerEl();
  if (!player) return null;
  if (overlay && overlay.isConnected && overlay.parentElement === player) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'ytst-overlay';
  overlay.innerHTML =
    '<div class="ytst-box">' +
    '<div class="ytst-grip" title="' + t('boxDragTip', '拖动移动字幕 · 双击复位') + '"></div>' +
    '<div class="ytst-edge ytst-edge-l" title="' + t('boxWidthTip', '拖动调整字幕框宽度 · 双击复位') + '"></div>' +
    '<div class="ytst-edge ytst-edge-r" title="' + t('boxWidthTip', '拖动调整字幕框宽度 · 双击复位') + '"></div>' +
    '<div class="ytst-orig"></div>' +
    '<div class="ytst-trans"></div>' +
    '</div>';
  player.appendChild(overlay);
  box = overlay.querySelector('.ytst-box');
  elOrig = overlay.querySelector('.ytst-orig');
  elTrans = overlay.querySelector('.ytst-trans');
  wireBox();

  // 全屏 / 剧场模式 / 拖窗口时字号跟着画面变
  try {
    if (sizeWatcher) sizeWatcher.disconnect();
    sizeWatcher = new ResizeObserver(() => applyScale());
    sizeWatcher.observe(player);
  } catch (_) {}

  applyStyleVars();
  return overlay;
}

export function applyStyleVars() {
  if (!overlay) return;
  overlay.style.setProperty('--ytst-size', S.fontSize + 'px');
  overlay.style.setProperty('--ytst-orig-size', Math.round(S.fontSize * S.origScale) + 'px');
  const bg = Math.max(0, Number(S.bgOpacity) || 0);
  overlay.style.setProperty('--ytst-bg', 'rgba(0,0,0,' + bg + ')');
  // 完全透明时要连毛玻璃一起关，见 overlay.css 里的 .ytst-no-bg
  overlay.classList.toggle('ytst-no-bg', bg <= 0);
  overlay.style.setProperty('--ytst-maxw', (S.maxWidth || 88) + '%');
  overlay.style.setProperty('--ytst-font', FONT_STACKS[S.fontFamily] || FONT_STACKS.serif);
  overlay.classList.toggle('ytst-trans-only', S.layout === 'transOnly');

  const custom = typeof S.posX === 'number' && typeof S.posY === 'number';
  overlay.classList.toggle('ytst-custom', custom);
  if (custom) {
    overlay.style.setProperty('--ytst-x', S.posX + '%');
    overlay.style.setProperty('--ytst-y', S.posY + '%');
  }
  applyScale();
}

/* 字号跟着画面走：小窗口按设定值，全屏/大屏成比例放大。
 * 只放大不缩小，所以滑块上的数字始终是「最小会是多大」。 */
export function applyScale() {
  if (!overlay) return;
  const p = getPlayerEl();
  if (!p) return;
  const h = p.clientHeight || 0;
  const k = (S.autoScale === false || !h) ? 1 : clamp(h / 620, 1, 2.8);
  overlay.style.setProperty('--ytst-scale', k.toFixed(3));
  lastBottom = -1;    // 画面尺寸变了，控制栏高度重新量
  fitWidth();
}

export function removeOverlay() {
  if (sizeWatcher) { try { sizeWatcher.disconnect(); } catch (_) {} sizeWatcher = null; }
  if (overlay) { overlay.remove(); overlay = null; box = null; elOrig = null; elTrans = null; }
}

/* ---------- 拖动 + 选中 ---------- */
function wireBox() {
  if (!box) return;

  // 字幕框内的点击不该穿透到播放器（否则点一下就暂停/全屏了）
  ['mousedown', 'click', 'dblclick', 'mouseup'].forEach((ev) => {
    box.addEventListener(ev, (e) => e.stopPropagation());
  });

  const grip = box.querySelector('.ytst-grip');
  grip.addEventListener('dblclick', (e) => {
    e.preventDefault();
    persistPos(null, null);
  });

  /* ---- 左右边缘：调整字幕框宽度 ---- */
  const edges = [...box.querySelectorAll('.ytst-edge')];
  let resize = null;

  edges.forEach((edge) => {
    edge.addEventListener('dblclick', (e) => {
      e.preventDefault();
      persistWidth(DEFAULTS.maxWidth);
    });
    edge.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const player = getPlayerEl();
      if (!player) return;
      const pr = player.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      // 框是绕锚点居中的，缩放过程中中心不动，所以只记一次
      resize = { pr, cx: br.left + br.width / 2 };
      edge.setPointerCapture(e.pointerId);
      overlay.classList.add('ytst-resizing');
      e.preventDefault();
      e.stopPropagation();
    });
    edge.addEventListener('pointermove', (e) => {
      if (!resize) return;
      const half = Math.abs(e.clientX - resize.cx);
      const pct = clamp((half * 2 / resize.pr.width) * 100, 20, 96);
      overlay.style.setProperty('--ytst-maxw', pct.toFixed(1) + '%');
      // 拖动时让框实际展开到这个宽度，边缘才跟得住光标；松手后再收回贴合内容
      box.style.width = Math.round(resize.pr.width * pct / 100) + 'px';
      resize.pct = pct;
      e.stopPropagation();
    });
    const endResize = (e) => {
      if (!resize) return;
      try { edge.releasePointerCapture(e.pointerId); } catch (_) {}
      overlay.classList.remove('ytst-resizing');
      if (typeof resize.pct === 'number') persistWidth(Math.round(resize.pct));
      resize = null;
      fitWidth();   // 收回到贴合内容的宽度，刚才拖出来的只是上限
    };
    edge.addEventListener('pointerup', endResize);
    edge.addEventListener('pointercancel', endResize);
  });

  let drag = null;
  const onDown = (e) => {
    // 只从手柄或字幕框的空白处起拖，正文留给文本选中
    if (e.button !== 0) return;
    if (e.target !== grip && e.target !== box) return;
    const player = getPlayerEl();
    if (!player) return;
    const pr = player.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    drag = {
      pr,
      dx: e.clientX - (br.left + br.width / 2),
      dy: e.clientY - (br.top + br.height / 2)
    };
    box.setPointerCapture(e.pointerId);
    overlay.classList.add('ytst-dragging');
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!drag) return;
    const cx = e.clientX - drag.dx - drag.pr.left;
    const cy = e.clientY - drag.dy - drag.pr.top;
    const x = clamp((cx / drag.pr.width) * 100, 6, 94);
    const y = clamp((cy / drag.pr.height) * 100, 6, 94);
    overlay.classList.add('ytst-custom');
    overlay.style.setProperty('--ytst-x', x.toFixed(2) + '%');
    overlay.style.setProperty('--ytst-y', y.toFixed(2) + '%');
    drag.x = x; drag.y = y;
  };

  const onUp = (e) => {
    if (!drag) return;
    try { box.releasePointerCapture(e.pointerId); } catch (_) {}
    overlay.classList.remove('ytst-dragging');
    if (typeof drag.x === 'number') persistPos(drag.x, drag.y);
    drag = null;
  };

  box.addEventListener('pointerdown', onDown);
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', onUp);
  box.addEventListener('pointercancel', onUp);
}

async function persistPos(x, y) {
  S.posX = x; S.posY = y;
  applyStyleVars();
  await patchSettings({ posX: x, posY: y });
}

async function persistWidth(pct) {
  S.maxWidth = pct;
  applyStyleVars();
  await patchSettings({ maxWidth: pct });
}

/** 正在框内选中文字时冻结字幕，方便复制 */
function selectionInBox() {
  if (!box) return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  let n = sel.anchorNode;
  if (!n) return false;
  if (n.nodeType !== 1) n = n.parentNode;
  return !!(n && box.contains(n));
}

function setText(el, text) {
  if (el.textContent === text) return false;   // 不无谓重写，否则选中会被清掉
  el.textContent = text;
  return true;
}

/* ---------- 宽度贴合实际折行结果 ---------- */
/* CSS 的 max-content 是按「不折行时的宽度」算的：英文长句折了两行，
 * 框却仍然按最长那一行撑到上限，中文短句左右就空出一大片黑边。
 * 这里量一下真正渲染出来的每一行有多宽，按最宽的那行收紧。 */
function widestLine(el) {
  if (!el || !el.textContent || !el.offsetParent) return 0;
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    let m = 0;
    for (const rect of r.getClientRects()) m = Math.max(m, rect.width);
    return m;
  } catch (_) { return 0; }
}

function fitWidth() {
  if (!box) return;
  const cs = getComputedStyle(box);
  const extra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
                parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);

  box.style.width = '';   // 先让它按 max-content + max-width 正常排一次
  // 两轮：收紧后 text-wrap:balance 可能重新断行，再量一次就收敛了
  for (let i = 0; i < 2; i++) {
    const w = Math.max(widestLine(elOrig), widestLine(elTrans));
    if (w <= 0) return;
    const next = Math.ceil(w + extra + 1);
    if (i > 0 && Math.abs(next - parseFloat(box.style.width || '0')) < 2) break;
    box.style.width = next + 'px';
  }
}

/* ---------- 别被底部控制栏压住 ---------- */
let lastBottom = -1;

function applyLayout() {
  if (!overlay || !box) return;
  const player = getPlayerEl();
  if (!player) return;

  const bar = player.querySelector('.ytp-chrome-bottom');
  const barShown = bar && !player.classList.contains('ytp-autohide');
  const barH = barShown ? bar.getBoundingClientRect().height : 0;
  const bottom = Math.round(barH + 14);

  if (bottom !== lastBottom) {
    lastBottom = bottom;
    overlay.style.setProperty('--ytst-bottom', bottom + 'px');
  }

  // 拖到自定义位置时改用位移把它顶上去，位置本身不改，控制栏收起后会落回原处
  if (!overlay.classList.contains('ytst-custom')) {
    overlay.style.setProperty('--ytst-lift', '0px');
    return;
  }
  const pr = player.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  const cur = parseFloat(overlay.style.getPropertyValue('--ytst-lift')) || 0;
  const over = br.bottom - (pr.bottom - bottom);
  const next = clamp(cur + over, 0, pr.height * 0.6);
  if (Math.abs(next - cur) > 1) overlay.style.setProperty('--ytst-lift', Math.round(next) + 'px');
}

export function findIndex(time) {
  const segs = st.segments;
  if (!segs.length) return -1;
  // 就近线性查找（播放通常是顺序的），失败再二分
  const i = st.curIdx;
  if (i >= 0 && i < segs.length) {
    const stop = Math.min(segs.length, i + 6);
    /* 先按严格区间找。buildSegments 已经把每句的 end 拉到了下一句的 start，句子之间
     * 首尾相接 —— 带着容差从前往后扫，播放头进入下一句之后的 0.35 秒里上一句仍然满足
     * 条件、还会先命中，于是顺序播放时每一次换句都固定晚半拍。 */
    for (let k = i; k < stop; k++) {
      if (time >= segs[k].start && time < segs[k].end) return k;
    }
    // 严格区间里没有：这才轮到容差，它本来就是给句子之间的空隙用的
    for (let k = i; k < stop; k++) {
      if (time >= segs[k].start - 0.15 && time < segs[k].end + 0.35) return k;
    }
  }
  let lo = 0, hi = segs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start - 0.15 <= time) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best >= 0 && time < segs[best].end + 0.35) return best;
  return -1;
}

export function render() {
  if (!st.active) { removeOverlay(); return; }
  const v = getVideo();
  const player = getPlayerEl();
  if (!v || !player) return;
  if (!ensureOverlay()) return;

  // 广告期间不显示
  if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
    overlay.classList.add('ytst-hidden');
    return;
  }
  overlay.classList.remove('ytst-hidden');

  const idx = findIndex(v.currentTime);
  if (idx !== st.curIdx) {
    // 跳着走的先记下时刻、不调度；顺着走的照旧立刻调度
    const jumped = st.curIdx >= 0 && idx >= 0 && Math.abs(idx - st.curIdx) > SEEK_JUMP;
    st.curIdx = idx;
    if (jumped) st.settleAt = Date.now() + SEEK_SETTLE;
    else schedule();
  } else if (st.settleAt && Date.now() >= st.settleAt) {
    schedule();   // 停稳了，补上这一次
  }

  // 正在选中框内文字时不刷新内容，让你把这句复制走
  const frozen = selectionInBox();
  overlay.classList.toggle('ytst-frozen', frozen);
  if (frozen) { overlay.classList.remove('ytst-empty'); return; }

  if (idx < 0) {
    setText(elOrig, '');
    setText(elTrans, '');
    overlay.classList.add('ytst-empty');
    return;
  }
  overlay.classList.remove('ytst-empty');

  const seg = st.segments[idx];
  const tr = st.trans.get(idx);
  let changed = setText(elOrig, seg.text);

  if (tr) {
    changed = setText(elTrans, tr) || changed;
    elTrans.classList.remove('ytst-pending');
    overlay.classList.remove('ytst-no-trans');
  } else if (st.dropped.has(idx)) {
    // 模型两次都没给这一行译文，与其挂着省略号，不如干脆只显示原文
    changed = setText(elTrans, '') || changed;
    elTrans.classList.remove('ytst-pending');
    overlay.classList.add('ytst-no-trans');
  } else {
    changed = setText(elTrans, st.error ? t('boxError', '· 翻译出错，点插件图标查看 ·') : '···') || changed;
    elTrans.classList.add('ytst-pending');
    overlay.classList.remove('ytst-no-trans');
  }

  if (changed) fitWidth();
  applyLayout();
}

/* 状态小圆点（在播放器按钮上） */
export function renderStatusChip() {
  if (!chip) return;
  chip.dataset.state = st.status;
}

/* ------------------------------------------------------------------ *
 * 播放器按钮
 * ------------------------------------------------------------------ */
export function ensureButton() {
  const right = document.querySelector('#movie_player .ytp-right-controls');
  if (!right) return;
  let btn = right.querySelector('.ytst-btn');
  if (btn && btn.isConnected) { syncButton(); return; }

  btn = document.createElement('button');
  btn.className = 'ytp-button ytst-btn';
  btn.title = t('btnTitle', '双语字幕翻译 (Alt+Shift+T)');
  // 按钮上那个字也跟着语言走：英文界面下一个「译」字反而认不出来
  btn.innerHTML = '<span class="ytst-btn-label">' + t('btnLabel', '译') + '</span><span class="ytst-dot"></span>';
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  const settings = right.querySelector('.ytp-settings-button');
  if (settings) right.insertBefore(btn, settings); else right.insertBefore(btn, right.firstChild);
  chip = btn.querySelector('.ytst-dot');
  syncButton();
}

export function syncButton() {
  const btn = document.querySelector('#movie_player .ytst-btn');
  if (!btn) return;
  btn.classList.toggle('ytst-on', st.active);
  chip = btn.querySelector('.ytst-dot');
  renderStatusChip();
}
