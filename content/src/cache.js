/* 本地缓存：翻过的句子按原文哈希存着，重看不再花钱。
 *
 * 写入一律只发增量给 background，由它在一条队列里合并 —— 同一个视频开两个标签页时，
 * 谁都不能拿自己那份整个盖掉对方的。
 */
import { S, st, hash, debounce } from './state.js';
import { targetCode } from './tracks.js';

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */
/* 凡是会改变译文内容的设置都要进缓存键，否则换了服务商、提示词或推理档位之后
 * 还会命中上一套配置的结果。目标语言用解析后的值，'auto' 在不同浏览器语言下不会串。 */
function cacheSig() {
  const base = String(S.baseUrl || '').trim();
  return [
    S.model || '',
    targetCode() || S.targetLang || '',
    base.endsWith('/') ? base.slice(0, -1) : base,
    /* 推理档位曾经占这一格。它不再参与缓存归属 —— 同一句话开不开推理译出来的是
     * 同一种译文，没道理分开存两份；分开存的直接后果是「难懂的段落临时开中档」
     * 这个 README 明写的用法，会把整片已经买过的译文全部作废重买。
     * 但这一格不能删：删了所有已存的缓存键都会变，用户为一件跟他无关的事
     * 重新付一次钱。所以钉死在老的默认值上，老缓存照常命中。 */
    'none',
    S.reasoningStyle || '',
    String(S.temperature === null || S.temperature === undefined ? '' : S.temperature),
    String(S.maxTokens === null || S.maxTokens === undefined ? '' : S.maxTokens),
    S.useContext ? 'ctx2' : '',
    String(S.extraPrompt || '').trim()
  ].join('|');
}

export function cacheKey(videoId) {
  return 'c_' + videoId + '_' + hash(cacheSig());
}

/* 索引（{ 缓存键: 最后使用时间 }）的读-改-写交给 background 排队执行，不在这儿
 * 直接动 storage：同时开着几个 YouTube 标签页时，两边各读一份旧索引、各写回自己
 * 那份，后写的把先写的整个盖掉 —— 丢了索引的那些缓存正文从此没人清理（淘汰只
 * 遍历索引里的键），存储只增不减。 */
export async function cacheIndexOp(op, key, prune) {
  try { await chrome.runtime.sendMessage({ type: 'cacheIndex', payload: { op, key, prune } }); } catch (_) {}
}

const touchIndex = (key) => cacheIndexOp('touch', key);

export async function loadCache(videoId) {
  if (!S.useCache) { st.cache = { items: {} }; return; }
  try {
    const k = cacheKey(videoId);
    const got = await chrome.storage.local.get(k);
    st.cache = got[k] && got[k].items ? got[k] : { items: {}, ts: Date.now() };
    // 重看也算「用过」，否则常看的视频反而会被当成旧数据淘汰掉
    await touchIndex(k);
  } catch (_) { st.cache = { items: {} }; }
}

/* 落盘。
 *
 * 以前是内容脚本自己把整个 st.cache 写回 storage。同一个视频开两个标签页时，
 * 两边各持有一份 items、各写各的，后写的把先写的整个盖掉 —— 被盖掉的那些译文
 * 下次重看还要再买一次。索引早就为同样的理由搬去 background 排队了，正文没搬。
 *
 * 现在只送增量，合并由 background 在那条队列里做，两个标签页的结果是并集。 */
export async function flushCache() {
  if (!S.useCache || !st.videoId || !st.cache || !st.cacheDirty) return;
  const items = st.cachePending;
  st.cachePending = {};
  st.cacheDirty = false;
  if (!Object.keys(items).length) return;
  const k = cacheKey(st.videoId);
  st.cache.ts = Date.now();
  try {
    // 顺手让 background 淘汰过期和超量的缓存，正好在同一次读写里做掉
    await chrome.runtime.sendMessage({
      type: 'cacheWrite',
      payload: { op: 'write', key: k, items,
                 prune: { days: Number(S.cacheDays) || 60, max: Number(S.cacheMax) || 300 } }
    });
  } catch (_) {
    // 没送出去就还回去，下次再试 —— 别把用户已经买到的译文丢了
    Object.assign(st.cachePending, items);
    st.cacheDirty = true;
  }
}

/* 防抖从 4 秒降到 1.5 秒。以前的算盘是「攒着一起写，省 storage 写入」，可代价是
 * 关页面前最后几秒买到的译文常常还没落盘 —— 那是已经付过钱的东西。现在正文写入
 * 只送增量、合并在 background 做，写一次的开销小得多，没有理由再攒那么久。 */
export const saveCache = debounce(flushCache, 1500);

export function cacheGet(text) {
  if (!S.useCache || !st.cache) return null;
  return st.cache.items[hash(text)] || null;
}

export function cachePut(text, tr) {
  if (!S.useCache || !st.cache) return;
  const h = hash(text);
  st.cache.items[h] = tr;      // 本页自己读的那一份
  st.cachePending[h] = tr;     // 待落盘的增量
  st.cacheDirty = true;
  saveCache();
}

/* 关页面 / 切视频时立刻落盘。这里不能 await（beforeunload 里没有那个时间），
 * 发出去就算 —— 消息本身是同步投递的，background 那边照样排进队列。 */
export function saveCacheNow() {
  const p = flushCache();
  if (p && p.catch) p.catch(() => {});
}

export function applyCacheToAll() {
  let hit = 0;
  for (const seg of st.segments) {
    const c = cacheGet(seg.text);
    if (c) { st.trans.set(seg.id, c); hit++; }
  }
  // 整批命中的直接标记完成
  for (const b of st.batches) {
    let done = true;
    for (let i = b.from; i <= b.to; i++) if (!st.trans.has(i)) { done = false; break; }
    if (done) b.state = 'done';
  }
  return hit;
}
