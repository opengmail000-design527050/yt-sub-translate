/* 调度：把句子分批、按播放头决定翻哪几批、收结果、出错了怎么办。
 *
 * 批次大小是自适应的（连续几批干净就加大，一出错位就回落），失败分级（限流自己
 * 回来、配置错误当场认输），每一批都带着 (epoch, batchId) 好让 background 掐得住。
 */
import { S, st, log, flags, updateStatus } from './state.js';
import { wid } from './segments.js';
import { cacheGet, cachePut, cacheKey, cacheIndexOp } from './cache.js';
import { render, renderStatusChip } from './overlay.js';

/* 批次越大越省：那 250 token 的系统提示是按「次」付的，一批装的句子多一倍，
 * 摊到每句就少一半；而且同一批里模型能看见更多上下文，术语和语气反而更稳。
 *
 * 唯一的代价是错位风险 —— 行数一多，模型更容易把相邻两句并成一句，那一批就得
 * 整个作废重来，反而更贵。所以不写死，从用户设的档位起步，连续几批没出问题
 * 就往上加，一出问题立刻回落并且封顶，不再试那一档。 */
const BATCH_TIERS = [1, 1.5, 2];

const TIER_PROMOTE_AFTER = 3;   // 连续这么多批毫无瑕疵，才敢加大

function tierLimits() {
  const k = BATCH_TIERS[Math.min(st.batchTier, BATCH_TIERS.length - 1)] || 1;
  return {
    chars: Math.max(200, Math.round(S.batchChars * k)),
    lines: Math.max(4, Math.round(S.batchLines * k))
  };
}

/** 切出 [from, 末尾] 这一段的批次。from 省略就是整条重切。 */
export function makeBatches(segments, from) {
  const lim = tierLimits();
  const batches = [];
  let start = from || 0, chars = 0, count = 0;
  for (let i = start; i < segments.length; i++) {
    chars += wid(segments[i].text);
    count += 1;
    const last = i === segments.length - 1;
    if (last || chars >= lim.chars || count >= lim.lines) {
      batches.push({ from: start, to: i, state: 'idle', tries: 0 });
      start = i + 1; chars = 0; count = 0;
    }
  }
  return batches;
}

/* 换档之后重切还没翻的那一截。
 *
 * 只动「后面全是 idle」的那条尾巴：done 的边界一改，applyCacheToAll 之外
 * 就没人知道它翻过了；run 的更不能动，在途结果按 id 回填，边界变了会对不上。
 * 译文和缓存都是按句子 id / 原文哈希存的，跟批次边界无关，所以重切是安全的。 */
export function rebuildTail() {
  let k = st.batches.length;
  while (k > 0 && st.batches[k - 1].state === 'idle') k--;
  if (k >= st.batches.length) return;        // 没有可以重切的尾巴
  const from = st.batches[k].from;
  st.batches.length = k;
  for (const b of makeBatches(st.segments, from)) {
    let done = true;
    for (let j = b.from; j <= b.to; j++) if (!st.trans.has(j)) { done = false; break; }
    if (done) b.state = 'done';              // 整批都在缓存里
    st.batches.push(b);
  }
}

/* 连着这么多批错位，才认定「这一档真的不行」并永久封顶。
 *
 * 原来是一次就封。可封顶的代价极不对称：档位是每个视频从 0 重新起步的，tier 已经
 * 是 0 时再出一次错位，这个视频就锁死在 20 句/批 —— 按真实档位逻辑算，两小时的
 * 访谈会从 33 次请求涨到 62 次，光固定开销就多烧约一万五千 token。而模型偶尔把
 * 相邻两句并成一句本来就是常态，单次错位远不足以判死刑。
 *
 * 回落仍然是一次就回落（那一步便宜又可逆），放宽的只是「永远不再试」这个判决。 */
const DIRTY_BEFORE_CEIL = 2;

export function resetTier() {
  st.batchTier = 0;
  st.batchCeil = BATCH_TIERS.length - 1;
  st.batchClean = 0;
  st.batchDirty = 0;
}

/**
 * 一批回来之后调整档位。
 *   bad   —— 出现了错位（后端拆过块，或有行到底也没翻出来）
 *   clean —— 一次就整整齐齐，没补翻也没拆块
 * 网络错误、401、超时跟批次大小无关，两个都传 false，档位不动。
 */
export function noteBatchResult(bad, clean) {
  if (bad) {
    st.batchClean = 0;
    if (st.batchTier > 0) st.batchTier--;
    // 连着第二次才封顶。中间只要有一批干净的，前一次就当它是偶发，既往不咎
    if (++st.batchDirty >= DIRTY_BEFORE_CEIL) st.batchCeil = Math.min(st.batchCeil, st.batchTier);
    rebuildTail();
    return;
  }
  if (!clean) { st.batchClean = 0; return; }
  st.batchDirty = 0;
  if (st.batchTier >= st.batchCeil) return;
  if (++st.batchClean < TIER_PROMOTE_AFTER) return;
  st.batchClean = 0;
  st.batchTier++;
  rebuildTail();
}

/* ------------------------------------------------------------------ *
 * 翻译调度
 * ------------------------------------------------------------------ */
/* 这一版作废了。
 *
 * epoch 涨一格原来只做到「回来的结果不采用」，可 background 那边的 fetch 还在跑，
 * 跑完还会接着走 strict 重问、repair 补翻、错位拆块 —— 并发 3 时一次切视频最多
 * 白付十来次请求，而且这些请求还占着下一个视频的并发额度。
 * 所以涨的同时告诉 background 一声，让它把旧批次真的掐掉。 */
export function bumpEpoch() {
  st.epoch++;
  cancelInflight({ epoch: st.epoch });
}

/** payload: { epoch } 作废比它旧的全部批次；{ epoch, batchId } 只作废那一批 */
export function cancelInflight(payload) {
  try {
    const p = chrome.runtime.sendMessage({ type: 'cancel', payload });
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}

/* 播放头一次跳过这么多句，就认定是拖进度条／连按方向键，而不是正常播放 */
export const SEEK_JUMP = 5;

/* 跳完之后等这么久没有再跳，才真的开始翻 */
export const SEEK_SETTLE = 1200;

export function schedule() {
  if (!st.active || !st.segments.length || !flags.settingsReady) return;
  /* 自带译文轨还在取（pending）或者已经用上（on）：一个请求都不该发。
     pending 时不拦住的话，等它回来这几批就白翻了，钱已经花掉。 */
  if (st.adoptState === 'pending' || st.adoptState === 'on') return;
  /* 还在拖动中：一个请求都不发。
   *
   * 以前 render 里播放头一换句就立刻 schedule，而拖进度条时播放头会连续落在
   * 十几个位置上，每个落点都按 concurrency 发满请求 —— 用户从头拖到尾，
   * 整条视频就被零零散散翻了一遍，而他一句都没看。
   *
   * 顺序播放时 curIdx 每次只 +1，跳变判定不成立，走不到这里。 */
  if (st.settleAt && Date.now() < st.settleAt) return;
  st.settleAt = 0;
  const idx = st.curIdx >= 0 ? st.curIdx : 0;
  const limit = idx + Math.max(5, S.lookahead);

  const candidates = st.batches
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.state === 'idle' && b.to >= idx - 2 && b.from <= limit)
    .sort((a, b) => a.b.from - b.b.from);

  while (st.running < Math.max(1, S.concurrency) && candidates.length) {
    const { i } = candidates.shift();
    runBatch(i);
  }
  updateStatus();
}

/* 往前、往后各多数几句当参考。这里只管备齐候选，真正发多少由 background 按
 * 字符预算裁 —— 句子长短差得很远，按句数卡预算卡不准。 */
const CTX_PREV_LINES = 6;

const CTX_NEXT_LINES = 4;

/* 一批最多等这么久。
 *
 * MV3 的 service worker 空闲三十秒就可能被回收，而一批翻译在慢接口上跑六十秒
 * 是常事。万一回收发生在响应回来之前，sendMessage 的 promise 永远不会 settle——
 * 这一批就永久停在 run，running 计数不减，并发额度从此少一个；攒够三次整个视频
 * 停摆，而屏幕上什么都不会说，用户只看到字幕不再更新。
 *
 * 所以不管后台那边出了什么事，到点就把这批打回 err、把额度还回去，顺带让
 * background 把它掐掉（万一它还活着，别让它继续烧钱）。比接口自己的 90 秒超时
 * 留出一截余量，正常的慢请求仍然由那一层先接住、报得更准。 */
const BATCH_DEADLINE = 120000;

function withDeadline(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error('后台一直没有回应，这一批先放弃了（可以点重试）');
      e.timeout = true;
      reject(e);
    }, ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export async function runBatch(bi) {
  const b = st.batches[bi];
  if (!b || b.state !== 'idle') return;
  const epoch = st.epoch;      // 记下这批属于哪一版，回来时核对
  b.state = 'run';
  st.running++;
  st.status = 'translating';
  renderStatusChip();

  /* 送出去之前先摘两类不必花钱的行：
   * 1. 缓存里已经有的 —— 访谈里「Right.」「Exactly.」这类短句整段视频反复出现，
   *    翻过一次就不用再送（applyCacheToAll 只在载入时跑一次，接不到本次会话新写入的）；
   * 2. 同一批里原文完全相同的 —— 只送一条，回来后写给所有相同的行。 */
  const lines = [];
  const firstOf = new Map();   // 原文 -> 已排进 lines 的那一行 id
  const alias = new Map();     // 被合并掉的行 id -> 代表行 id
  for (let i = b.from; i <= b.to; i++) {
    const seg = st.segments[i];
    if (!seg) continue;
    if (st.trans.has(i)) continue;

    const cached = cacheGet(seg.text);
    if (cached) { st.trans.set(i, cached); st.dropped.delete(i); continue; }

    const rep = firstOf.get(seg.text);
    if (rep !== undefined) { alias.set(i, rep); continue; }
    firstOf.set(seg.text, i);
    lines.push({ id: i, text: seg.text });
  }

  if (!lines.length) { b.state = 'done'; st.running--; schedule(); return; }

  /* 参考上下文。以前只带前一句原文，可访谈里前一句很可能就是「Right.」，等于
   * 没带；批尾那一句更是整批里唯一看不见下文的一行，无标点的轨按停顿切，它
   * 很可能是半截话。
   *
   * 所以两头都给：前面连译文一起给（模型看见自己上一批把 agent 译成了什么，
   * 术语和人称才跨批一致），后面只给原文，它们还没翻。这里只管备齐候选 ——
   * 裁多少、有标点的轨要不要发后文，都由 background 的 refBlocks 决定。 */
  const prev = [], next = [];
  if (S.useContext) {
    for (let i = Math.max(0, b.from - CTX_PREV_LINES); i < b.from; i++) {
      const seg = st.segments[i];
      if (seg) prev.push({ text: seg.text, tr: st.trans.get(i) || '' });
    }
    const end = Math.min(st.segments.length - 1, b.to + CTX_NEXT_LINES);
    for (let i = b.to + 1; i <= end; i++) {
      const seg = st.segments[i];
      if (seg) next.push(seg.text);
    }
  }

  /* epoch 和批次编号一起送过去：background 按 (标签页, epoch, 批次) 登记这次请求，
   * 切视频时按 epoch 一次掐掉一整版，兜底超时时按批次编号点名掐一个。 */
  const batchId = ++st.batchSeq;
  let res = null, err = '';
  try {
    res = await withDeadline(chrome.runtime.sendMessage({
      type: 'translateBatch',
      payload: {
        lines, prev, next, title: st.title,
        sourceLang: st.sourceLang, noPunct: st.noPunct,
        epoch, batchId
      }
    }), BATCH_DEADLINE);
  } catch (e) {
    err = String((e && e.message) || e);
    /* 这一版还作数才点名去掐。已经切走的那些，上面 bumpEpoch 时已经按 epoch
     * 一次全掐过了，再点一次名只是多一条消息。 */
    if (e && e.timeout && epoch === st.epoch) cancelInflight({ epoch, batchId });
  }

  st.running--;   // 名额先还回去，不管这批还算不算数

  /* 等待期间切了视频、改了模型/目标语言、或重新切过句：这批结果已经不对应当前状态。
   * 直接丢弃 —— 尤其不能写缓存，st.segments 可能已经是另一个视频的，
   * 那会把旧视频的译文按新视频的原文哈希存起来，重看时永久错乱。 */
  if (epoch !== st.epoch) return;

  /* background 说这一批被取消了。走到这里说明取消不是因为切视频（那样 epoch 对不上，
   * 上面就返回了），而是我们自己的兜底超时掐的 —— 打回 idle，重试时照常再来一次。 */
  if (res && res.cancelled) { b.state = 'idle'; updateStatus(); return; }

  if (err) {
    log('批次 #' + batchId + ' 失败：' + err);
    b.state = 'err';
    st.error = err;
    // 我们自己的兜底超时算 timeout，其余是消息通道本身出了事
    st.errorCode = 'timeout';
    noteBatchResult(false, false);   // 网络层的错，跟批次大小无关
  } else if (res && res.ok) {
    /* split > 0 = 后端因为错位对半重来过；dropped 非空 = 有行到底也没翻出来。
     * 两者都说明这一批给大了。repaired > 0 是模型留了空、补翻救回来了，
     * 对齐没坏，但也不算干净，只是不再往上加档。 */
    noteBatchResult(
      Number(res.split || 0) > 0 || (res.dropped && res.dropped.length > 0),
      !res.split && !(res.dropped && res.dropped.length) && !res.repaired
    );
    let got = 0;
    for (const k in res.map) {
      const id = Number(k);
      const tr = String(res.map[k] || '').trim();
      if (!tr) continue;
      st.trans.set(id, tr);
      st.dropped.delete(id);
      const seg = st.segments[id];
      if (seg) cachePut(seg.text, tr);
      got++;
    }
    // 批内被合并掉的重复行，跟着代表行一起填上
    for (const [id, repId] of alias) {
      const tr = st.trans.get(repId);
      if (tr) { st.trans.set(id, tr); st.dropped.delete(id); got++; }
    }
    // 补翻之后仍然没回来的行：不再干等，直接只显示原文
    for (const id of (res.dropped || [])) st.dropped.add(Number(id));
    if (got) {
      b.state = 'done';
      st.error = '';
      st.errorCode = '';
    } else {
      // 整批错位时后端不会进补翻，会返回 ok 但空 map。
      // 这里必须留下错误信息，否则状态会显示「已就绪」而 popup 也不给重试入口。
      b.state = 'err';
      st.error = '这一批模型没给出可用的译文，可以点重试';
      st.errorCode = 'format';
    }
  } else {
    b.state = 'err';
    st.error = (res && res.error) || '翻译失败';
    st.errorCode = (res && res.code) || 'network';
    log('批次 #' + batchId + ' [' + st.errorCode + '] ' + st.error);
    // 整批失败：只有拆到底还在错位才算批次太大，401/超时之类不算
    noteBatchResult(Number((res && res.split) || 0) > 0, false);
    /* 限流：background 已经在排队了，这一批自己回来，别让用户去点重试 */
    const wait = Number((res && res.retryAfter) || 0);
    if (autoRetry(b, epoch, wait)) {
      st.error = '接口限流，' + Math.max(1, Math.round(wait / 1000)) + ' 秒后自动重试';
      st.errorCode = 'rate';
    }
  }

  render();
  updateStatus();
  schedule();
}

/* 限流不该变成一条要用户去点的红字。
 *
 * 服务商的配额按分钟算，429 之后等一会儿再来基本就好了 —— background 已经按
 * 接口地址排了队并把「还要等多久」报了回来，这里让那一批自己回到队列里，人什么
 * 都不用做。只在真等得起的时候这么干：次数封顶，免得一个坏掉的接口把电池耗干。 */
const AUTO_RETRY_MAX = 5;

function autoRetry(b, epoch, waitMs) {
  if (!(waitMs > 0) || (b.tries || 0) >= AUTO_RETRY_MAX) return false;
  b.tries = (b.tries || 0) + 1;
  setTimeout(() => {
    if (epoch !== st.epoch || b.state !== 'err') return;
    b.state = 'idle';
    // 别的批次还在错着的话，错误信息得留着
    if (!st.batches.some((x) => x.state === 'err')) { st.error = ''; st.errorCode = ''; }
    schedule();
    updateStatus();
  }, Math.max(1000, waitMs));
  return true;
}

export function retryErrors() {
  for (const b of st.batches) if (b.state === 'err') { b.state = 'idle'; b.tries = 0; }

  // 补翻后仍然缺译文的行所在的批次，也再给一次机会
  if (st.dropped.size) {
    for (const b of st.batches) {
      if (b.state !== 'idle') {
        for (const id of st.dropped) {
          if (id >= b.from && id <= b.to) { b.state = 'idle'; break; }
        }
      }
    }
    st.dropped = new Set();
  }
  st.error = '';
  st.errorCode = '';
  schedule();
}

/* 丢掉这个视频的缓存，从零重翻。
 *
 * 错位的译文是按「原文哈希 -> 译文」存下来的，刷新页面只会原样命中同一份错位结果，
 * 重试按钮也救不回来（runBatch 看到 st.trans 里已经有了就直接跳过这一行）。
 * 这是唯一的出口。 */
export async function purgeCache() {
  bumpEpoch();                // 在途请求作废，别把旧结果又写回来
  st.trans = new Map();
  st.dropped = new Set();
  st.cache = { items: {} };
  st.cachePending = {};
  st.cacheDirty = false;
  st.error = '';
  st.errorCode = '';
  resetTier();
  st.batches = st.segments.length ? makeBatches(st.segments) : [];
  st.curIdx = -1;
  st.settleAt = 0;
  if (st.videoId) {
    // 正文和索引一起交给 background 那条队列去删，才不会被在途的落盘写回来
    try { await cacheIndexOp('forget', cacheKey(st.videoId)); } catch (_) {}
  }
  render();
  updateStatus();
  schedule();
}
