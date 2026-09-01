import { DEFAULTS, getSettings, resolveTargetName, CODE_TO_NAME, hasApiPermission } from './common.js';

/* ------------------------------------------------------------------ *
 * 消息入口
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const tabId = (sender && sender.tab && sender.tab.id) || 0;

  if (msg.type === 'translateBatch') {
    translateBatch(msg.payload, tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }

  /* 内容脚本那边 epoch 一涨（切视频、换字幕轨、改了影响译文的设置），
   * 旧的批次就已经不作数了 —— 这里要真的把 fetch 掐掉，不能只是不采用结果。 */
  if (msg.type === 'cancel') {
    sendResponse({ ok: true, aborted: cancelJobs(tabId, msg.payload || {}) });
    return true;
  }

  if (msg.type === 'testApi') {
    testApi(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }

  /* 缓存的索引和正文都只在这里改，而且共用一条队列 —— 两个标签页看同一个视频时，
   * 谁都不能拿自己那份整个盖掉对方的。 */
  if (msg.type === 'cacheIndex' || msg.type === 'cacheWrite') {
    cacheIndexOp(msg.payload)
      .then((n) => sendResponse({ ok: true, removed: n }))
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }
});

/* 快捷键：Alt+Shift+T */
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }); } catch (_) {}
  }
});

/* ------------------------------------------------------------------ *
 * 翻译
 * ------------------------------------------------------------------ */
function errText(e) {
  return String((e && e.message) || e || 'unknown error');
}

// 非默认 API 地址需要用户在设置页单独授权（manifest 里只静态声明了 api.openai.com）
const PERM_HINT = '还没有访问这个 API 地址的权限：打开设置页，在「API 地址」下面点「授权访问」。';

function joinUrl(base) {
  let b = String(base || '').trim().replace(/\s+/g, '');
  if (!b) throw new Error('未设置 API 地址');
  // 末尾带 # 表示「就用这个地址，别自动补路径」
  if (b.endsWith('#')) return b.slice(0, -1);
  b = b.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

/** 标题是从页面上取来的文本，可能带换行、方括号、竖线 —— 这几样正好是提示词里
 *  用来分块和分隔编号的记号。原样插进去，一个精心起名的标题就能伪造出一个块头
 *  骗过模型，所以先把它们抹平再截断。 */
function safeTitle(title) {
  return String(title || '').replace(/[[\]|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function buildSystemPrompt(s, sourceLang, noPunct, title) {
  const lang = resolveTargetName(s);
  const srcName = sourceLang ? (CODE_TO_NAME[sourceLang] || CODE_TO_NAME[String(sourceLang).split('-')[0]] || sourceLang) : '';
  const src = srcName ? `${srcName} ` : '';
  /* 提示词是按「次」付的，一批 20 句时它占输入的四成，所以确实值得收。
   * 但这里是合并冗余，不是删约束 —— 下面每一条约束在改之前都在，改之后也都在，
   * 只是同一件事不再说两遍、并且挪到了它该待的那一行：
   *   「never output fewer lines than you were given」跟第 2 行的 same count 是
   *   同一句话，「never leave a line empty」跟 no blank lines 是同一句话，两处都
   *   归进第 2 行的格式契约；原来单列的「半截句仍是半截句」并进第 3 行 —— 它跟
   *   「意思留在本行」本来就是同一族约束。
   *
   * 为什么不像有些建议说的那样干脆砍到五行、省 170 token：那个数字只有把第 2、3
   * 行砍掉才拿得到（它们俩占了系统提示的一半），而第 3 行是唯一一条「违反了你也
   * 看不见」的约束 —— 模型只要把 N 个编号都给全，内容整体挪一位，translateChunk
   * 里 missing 是空的，这一批照样记成干净。对齐统计只抓得住「编号缺了」，抓不住
   * 「编号齐了但内容错位」，而后者正是用户会亲眼看到的那种中英对不上。
   * 第 1 行的「tech podcast」也去掉了：领域由视频标题那行负责，写死在这里反而会
   * 让非科技视频的语气跑偏，但「spoken conversation」要留着，它决定语域。 */
  const lines = [
    `Translate ${src}subtitle lines from a spoken conversation into ${lang}.`,
    `Input: lines of "<n>|<text>". Output exactly one "<n>|<translation>" per input line — same numbers, same order, same count, nothing else. No markdown, no notes, never an empty or missing line.`,
    `CRITICAL: each line appears on screen alone at its own timestamp. Keep every line's meaning inside its own line — never carry content forward into a later line or pull it back from an earlier one, even when natural ${lang} word order differs. A sentence fragment stays a fragment; do not complete it.`,
    `Consecutive lines of one conversation between hosts and guests: keep each speaker's spoken register and tone, and do not make casual speech sound formal.`,
    `Write natural, concise ${lang} that reads at a glance as a subtitle. Keep proper nouns, product names and established English acronyms (AI, GPU, LLM, API) unchanged.`
  ];
  /* 视频标题。同一个 agent / trait / model，在 AI 播客里和在 Rust 教程里根本不是
     一回事，而光看一批二十句常常判断不出领域。框架文字压到 20 token，加上标题本身
     常见是 25~40 —— 而且它待在系统提示里，不跟待翻的行挨着，不会被误当成输入。 */
  const vt = safeTitle(title);
  if (vt) lines.push(`Video title, for domain terminology only — never translate or output it: "${vt}"`);

  /* 自动字幕：没有标点、没有大写、偶尔听错词。不说清楚的话，模型会把
     "i think its the case that" 这种东西照着字面硬翻，读起来像机器吐的。
     只在真的没标点时才加这几句 —— 有标点的轨不必为此多花 token。 */
  if (noPunct) lines.push(...asrLines(lang));
  if (s.extraPrompt && s.extraPrompt.trim()) lines.push(s.extraPrompt.trim());
  return lines.join('\n');
}

/* 无标点的轨（多半是自动字幕）才追加这两句。抽成函数，测试才能断言「这段在不在」
 * 而不是断言某个词怎么拼 —— 反向断言（有标点的轨不该带这几句）尤其经不起改措辞：
 * 措辞一变它就永远为真，安安静静地不再检查任何东西。 */
function asrLines(lang) {
  return [
    `The input is raw speech recognition: no punctuation, no capitalisation, occasionally a misheard word. Work out the sentence structure yourself and punctuate the ${lang} properly.`,
    `Where a misrecognised word's intent is obvious from context, translate what was meant; where it is not, translate what is there.`
  ];
}

function applyReasoning(body, s) {
  const level = s.reasoning || 'none';
  switch (s.reasoningStyle) {
    case 'off':
      break;
    case 'effort_none':
      body.reasoning_effort = level;
      break;
    case 'enable_thinking':
      body.enable_thinking = level !== 'none';
      if (level === 'low') body.thinking_budget = 512;
      if (level === 'medium') body.thinking_budget = 2048;
      break;
    case 'effort':
    default:
      if (level !== 'none') body.reasoning_effort = level;
      break;
  }
}

/* 一块最多拆多少层。每层对半砍，3 层足以把 20 行的批砍到 2~3 行。 */
const MAX_SPLIT = 3;

/* ------------------------------------------------------------------ *
 * 在途请求登记簿
 *
 * 内容脚本那边早就有 epoch 守卫，可它只做到「不采用结果」：切一次视频，这边的
 * fetch 照样跑完，跑完还接着走 strict 重问、repair 补翻、拆块重来 —— 并发 3 时
 * 一次切视频最多白付十来次请求，而且这些请求还占着下一个视频的并发额度。
 *
 * 所以每一批都在这里登记 (tabId, epoch, batchId)，把它用掉的 AbortController
 * 挂上去。收到 cancel 就 abort，并把 cancelled 立起来 —— 后面几跳都会看这面旗，
 * 已经作废的批次绝不会再发下一个请求。
 * ------------------------------------------------------------------ */
const inflight = new Map();

const jobKey = (tabId, epoch, batchId) => tabId + '|' + epoch + '|' + batchId;

function openJob(tabId, epoch, batchId) {
  const job = {
    key: jobKey(tabId, epoch, batchId),
    tabId: Number(tabId) || 0,
    epoch: Number(epoch) || 0,
    batchId: Number(batchId) || 0,
    cancelled: false,
    ctrls: new Set()
  };
  inflight.set(job.key, job);
  return job;
}

function closeJob(job) {
  if (job) inflight.delete(job.key);
}

function abortJob(job) {
  job.cancelled = true;
  let n = 0;
  for (const c of job.ctrls) { try { c.abort(); n++; } catch (_) {} }
  job.ctrls.clear();
  return n;
}

/**
 * 作废在途请求。
 *   { epoch }            这个标签页里所有比 epoch 旧的批次（切视频、换轨、改设置）
 *   { epoch, batchId }   只作废指定的那一批（内容脚本的兜底超时用）
 */
function cancelJobs(tabId, p) {
  const epoch = Number((p && p.epoch) || 0);
  const one = p && p.batchId !== undefined && p.batchId !== null ? Number(p.batchId) : null;
  let n = 0;
  for (const job of inflight.values()) {
    if (job.tabId !== (Number(tabId) || 0)) continue;
    const hit = one === null ? job.epoch < epoch : (job.epoch === epoch && job.batchId === one);
    if (hit) n += abortJob(job);
  }
  return n;
}

/* 标签页关掉了，它那些还在跑的批次没有任何人在等 */
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const job of inflight.values()) if (job.tabId === tabId) abortJob(job);
  });
} catch (_) {}

/** 这一批已经被判死刑了吗 */
const stopped = (ctx) => !!(ctx.job && ctx.job.cancelled);

function cancelError() {
  const e = new Error('已取消');
  e.cancelled = true;
  e.noRetry = true;
  return e;
}

async function translateBatch(payload, tabId) {
  const s = await getSettings();
  if (!s.apiKey) return { ok: false, error: '还没填 API Key（点插件图标 → 设置）' };
  if (!(await hasApiPermission(s.baseUrl))) return { ok: false, error: PERM_HINT };

  const lines = payload.lines || [];
  if (!lines.length) return { ok: true, map: {}, usage: null };

  const job = openJob(tabId, payload.epoch, payload.batchId);
  const ctx = {
    s,
    job,
    sourceLang: payload.sourceLang,
    noPunct: !!payload.noPunct,
    title: payload.title || '',
    totals: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cached_reports: 0 },
    error: '',
    repaired: 0,
    retryAfter: 0,  // 撞上限流时「还要等多久」，前端据此自动回到队列，不必人去点重试
    split: 0        // 因为错位而对半重来的次数，前端拿它判断批次是不是给大了
  };

  let r;
  try {
    r = await translateChunk(ctx, lines, 0, payload.prev || [], payload.next || []);
  } finally {
    closeJob(job);
  }

  const usage = ctx.totals.prompt_tokens || ctx.totals.completion_tokens ? ctx.totals : null;

  /* 对齐的账。分开记而不是跟 usage 绑在一起 —— 有些服务商压根不回报 usage，
   * 偏偏那时候更需要知道对齐有没有出问题。
   *
   * 但网络错误、401 这类跟对齐毫无关系的失败绝不能算进来，不然错位率会被冲得
   * 面目全非。判据是：好歹翻出了东西，或者真的因为错位拆过块 —— 只有这两种
   * 情况下这一批才谈得上「对齐得怎么样」。 */
  const countable = r.out.size > 0 || ctx.split > 0;
  const align = countable ? {
    batches: 1,
    split: ctx.split,
    repaired: ctx.repaired,
    dropped: r.missing.length,
    dirty: ctx.split > 0 || r.missing.length > 0 ? 1 : 0
  } : null;

  if (usage || align) await addUsage(usage, align);

  /* 被取消的批次不是失败：内容脚本那边这一版已经作废了，报错只会在弹窗里
   * 留下一条与用户无关的红字，还会把批次档位往下压。 */
  if (job.cancelled) return { ok: false, cancelled: true, error: '已取消', usage };

  // 一行都没翻出来：当成整批失败，前端才会给重试入口
  // split 也要带上：前端靠它区分「批次太大导致错位」和「网络/鉴权失败」
  if (!r.out.size) {
    return {
      ok: false,
      error: ctx.error || '模型没有返回可用的译文',
      usage,
      split: ctx.split,
      retryAfter: ctx.retryAfter || 0
    };
  }

  const map = {};
  for (const [id, t] of r.out) map[String(id)] = t;

  return {
    ok: true,
    map,
    usage,
    dropped: r.missing.map((m) => m.id),   // 到底也没翻出来的，前端只显示原文
    repaired: ctx.repaired,
    split: ctx.split,
    retryAfter: ctx.retryAfter || 0
  };
}

/* 缺号碰到了首行或末行 —— 编号整体平移的指纹，这一块的对齐全都不可信。
 *
 * 最常见的是合并：输入 20 行，模型把第 7、8 行并成一句，于是只输出 19 行、
 * 编号 1..19。每个编号都落在有效区间里，光看编号毫无破绽，可是从第 7 行起
 * 每一行装的都是下一行的内容 —— 译文比原文快一整句，一路错到批尾，缺的是第 20 行。
 * 反过来，模型偶尔会从 2 开始编号，那就整体后移、缺的是第 1 行，一样错。
 *
 * 旧代码把这两种都当成「漏了几行」，只去补翻缺的那一两行，前面错位的一大截
 * 原封不动留下来，还按原文哈希写进了缓存 —— 刷新页面重新命中缓存，
 * 错位就永远回不来了。所以缺口只要碰到任何一端，就得整块作废重来，
 * 而不是把窟窿糊上。只有夹在中间的窟窿，才说明前后编号都对得上、是真的漏译。 */
function edgeGap(missing, total) {
  if (!missing.length) return false;
  return missing[0].n === 1 || missing[missing.length - 1].n === total;
}

/**
 * 翻一块。items = [{id, text}]，返回 { out: Map(id -> 译文), missing: [item] }。
 * 每层内部重新编号 1..N（数字短更省 token，也比全局四位数序号更不容易错位）。
 */
async function translateChunk(ctx, items, depth, prev, next) {
  // 拆块是递归的，每一层进来先看一眼这一批还作不作数
  if (stopped(ctx)) return { out: new Map(), missing: items };
  const numbered = items.map((it, i) => ({ n: i + 1, id: it.id, text: it.text }));

  const collect = (m) => {
    const out = new Map();
    for (const it of numbered) {
      const t = String((m && m[it.n]) || '').trim();
      if (t) out.set(it.id, t);
    }
    return out;
  };

  let r = await askModel(ctx.s, numbered, { prev, next }, '', ctx.sourceLang, ctx.noPunct, ctx.title, ctx.job);
  bumpUsage(ctx.totals, r.usage);
  noteRetryAfter(ctx, r);
  let out = r.error ? new Map() : collect(r.map);

  /* 一行都没认出来，而且这次请求本身是成功的 —— 那就是模型没按 "<n>|译文" 回。
   * 编号一丢就没有任何办法校验对齐，绝不能拿「行数正好相等」当依据照单全收
   * （见 parseLines 里那段注释），只能重问一次、把格式要求说死。
   *
   * 必须挡住 r.error：401、网络中断、超时这些跟格式毫无关系，重问一次也还是那个
   * 结果，只会把等待和计费翻倍 —— 90 秒超时的批会变成 3 分钟起。 */
  if (!r.error && !out.size && !stopped(ctx)) {
    const again = await askModel(ctx.s, numbered, { prev, next }, 'strict', ctx.sourceLang, ctx.noPunct, ctx.title, ctx.job);
    bumpUsage(ctx.totals, again.usage);
    noteRetryAfter(ctx, again);
    if (!again.error) { r = again; out = collect(again.map); }
  }

  if (!out.size) {
    if (!ctx.error) ctx.error = r.error || '模型没有按行给出译文';
    return { out: new Map(), missing: items };
  }

  const missing = numbered.filter((it) => !out.has(it.id));
  if (!missing.length) return { out, missing: [] };

  if (edgeGap(missing, numbered.length)) {
    /* 拆成两半重来。块越小，模型越不会去合并相邻行；
     * 而且就算再出错，作废的范围也只有原来的一半。 */
    if (numbered.length > 2 && depth < MAX_SPLIT) {
      ctx.split++;
      const mid = Math.ceil(items.length / 2);
      const head = items.slice(0, mid), tail = items.slice(mid);
      /* 前半段的后文正好是后半段的开头，后半段的前文正好是前半段的结尾 —— 而且
       * 这时前半段刚翻完，把译文一并传过去，术语在拆开的两半之间也不会走样。 */
      const a = await translateChunk(ctx, head, depth + 1, prev, tail.map((it) => it.text));
      const b = await translateChunk(ctx, tail, depth + 1,
                                     head.map((it) => ({ text: it.text, tr: a.out.get(it.id) || '' })), next);
      const out2 = new Map(a.out);
      for (const [k, v] of b.out) out2.set(k, v);
      return { out: out2, missing: a.missing.concat(b.missing) };
    }
    /* 拆到头还在错位：这一块整个不要。宁可这几句只显示原文，
     * 也不能把「快一句」的译文摆上去 —— 那比没有更误导，还会毒化缓存。 */
    if (!ctx.error) ctx.error = '有几行模型反复错位，已跳过（只显示原文）';
    ctx.split++;
    return { out: new Map(), missing: items };
  }

  /* 缺号散在中间：这是模型明确留空了某几行，前后的编号仍然对得上，
   * 单独补翻这几行是安全的。 */
  if (stopped(ctx)) return { out, missing: missing.map((m) => ({ id: m.id, text: m.text })) };

  const fixItems = missing.map((m, i) => ({ n: i + 1, id: m.id, text: m.text }));
  const fix = await askModel(ctx.s, fixItems, null, 'repair', ctx.sourceLang, ctx.noPunct, ctx.title, ctx.job);
  bumpUsage(ctx.totals, fix.usage);
  noteRetryAfter(ctx, fix);
  if (!fix.error) {
    // 补翻也可能合并。只有整整齐齐补全了才敢用，缺一行就整份不要
    const all = fixItems.every((it) => String(fix.map[it.n] || '').trim());
    if (all) {
      for (const it of fixItems) {
        out.set(it.id, String(fix.map[it.n]).trim());
        ctx.repaired++;
      }
      return { out, missing: [] };
    }
  }
  return { out, missing: missing.map((m) => ({ id: m.id, text: m.text })) };
}

/* 这一批里只要有一跳撞上了限流，就把「还要等多久」记下来（取最长的那个）。
 * 拆块之后一批会发好几次请求，报最长的那个才不会让前端太早回来又撞一次。 */
function noteRetryAfter(ctx, r) {
  const ms = Number((r && r.retryAfter) || 0);
  if (ms > 0) ctx.retryAfter = Math.max(Number(ctx.retryAfter) || 0, ms);
}

function bumpUsage(totals, u) {
  if (!u) return;
  totals.prompt_tokens += Number(u.prompt_tokens || u.input_tokens || 0);
  totals.completion_tokens += Number(u.completion_tokens || u.output_tokens || 0);
  /* 前缀缓存命中单独记，而且要分清「服务商压根没回报」和「回报了 0」：前者说明
   * 这个接口不告诉你，后者才说明真的没命中。所以另记一个「有几次回报过」的计数，
   * 一次都没有时设置页就直说没回报，不会拿 0 冒充结论。 */
  const c = cachedTokens(u);
  if (c !== null) {
    totals.cached_tokens += c;
    totals.cached_reports += 1;
  }
}

/** 这次请求里有多少输入 token 是命中前缀缓存的。各家放的位置不一样，取不到返回
 *  null（不是 0）。OpenAI 兼容接口通常要前缀 ≥1024 token 才自动缓存，而这里一批
 *  输入才 900~1400，很可能一次都进不去 —— 但那是推测，得有数才谈得上要不要为它
 *  调整请求结构。 */
function cachedTokens(u) {
  if (!u) return null;
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const n = d.cached_tokens !== undefined ? d.cached_tokens
          : u.cache_read_input_tokens !== undefined ? u.cache_read_input_tokens
          : u.prompt_cache_hit_tokens;
  return typeof n === 'number' ? n : null;
}

/* 参考上下文的预算，按「字符」算，中文折两倍（一个汉字约合一个 token，一个英文
 * 字符约合四分之一）。前文约 110 token，后文约 65 —— 而后文只发给没有标点的轨。
 * 连标题一起算，实测一批 20 句的加权成本：有标点的轨 +3.1%，无标点的轨 +5.3%。
 *
 * 真正的代价从来不是这点 token，而是每多一段「看得见但不许翻」的旁白，模型就多
 * 一次把它当成待翻行的机会 —— 一旦错位，edgeGap 会把整块作废重来，那是 2~4 次
 * 请求；更糟的是 content.js 那边的 noteBatchResult 会就此压死这个视频的批次档位，
 * 而系统提示是按请求付的，档位一低每行摊到的开销立刻翻倍，比这点上下文贵得多。
 * 所以两块都不带编号（编号是唯一的对齐凭据，绝不能让参考行也长得像输入），
 * 而且都紧跟一句「不要输出这里的任何一行」。 */
const REF_PREV_BUDGET = 420;
const REF_NEXT_BUDGET = 260;

/* 用户消息里的脚手架，全部用英文 —— 跟系统提示同一种语言。
 *
 * 以前这几句是硬编码中文的。可目标语言是用户设的（DEFAULTS 里还是 'auto'，跟随
 * 浏览器界面语言），日语界面的用户拿到的就是「英文指令 + 中文旁白 + 英文正文 +
 * 要日语输出」—— 四种语言搅在一起，而他根本无从察觉。英文是唯一对所有目标语言
 * 都成立的选择。
 *
 * repair 和 strict 这两句尤其要紧：它们发出去的时机，正是模型上一轮已经出过错
 * 的时候（漏了行、连编号都没带回来），是整条链路上最需要指令被不折不扣执行的
 * 一句话，不该还在换语言。措辞刻意跟系统提示对齐，用同一套 "<n>|<translation>"
 * 记法。
 *
 * 抽成常量是为了让测试断言「有没有这个块」而不是断言某一句怎么写的，
 * 以后再调提示词不会平白弄红一堆测试。 */
const REF_PREV_HEAD =
  '[Earlier lines, already translated. Reference only — match their terminology, names and tone. Do not output these.]';
const REF_NEXT_HEAD =
  '[Next batch, not for translation. Reference only — shows where the last lines are heading. Do not output these.]';
const inputHead = (n) => `[Translate exactly these ${n} lines. Output only these.]`;
const repairHead = (n) =>
  `[Your previous reply omitted these ${n} lines. Translate every one — exactly one "<n>|<translation>" per input line. Do not merge lines. No other text.]`;
const strictHead = (n) =>
  `[Your previous reply did not follow the format. Output exactly ${n} lines, each starting with its input number and a pipe, like "1|translation". Never merge lines. Output nothing else.]`;

function refWidth(t) {
  let w = 0;
  for (const ch of String(t)) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return w;
}

/**
 * 把前后文排成两块无编号的正文。
 *   ref.prev = [{text, tr}]  越靠后离得越近，从后往前取。有译文就一并给出 ——
 *                            让模型看见自己上一批把 agent 译成了什么，术语和人称
 *                            才跨批一致，这是带译文而不是只带原文的全部理由。
 *   ref.next = [text]        下一批的开头，只有原文（它们还没翻）。
 */
function refBlocks(ref, noPunct) {
  const parts = [];

  const prev = [];
  let w = 0;
  const src = (ref && ref.prev) || [];
  for (let i = src.length - 1; i >= 0; i--) {
    const x = src[i];
    if (!x || !x.text) continue;
    /* 没有译文的前文，只对无标点的轨才有意义 —— 那时批首这一句是按停顿切出来的，
     * 很可能是半截话，需要知道它从哪儿来（跟后文块完全是同一个道理）。有标点的轨
     * 批首本来就是句子开头，这种行提供不了任何东西，只是一段长得跟待翻行一模一样
     * 的英文旁白，白花 token 还多给模型一次把它当成输入的机会。
     *
     * 这条分支在默认配置下几乎总会命中：并发是 3，批次成波发出，某一批的前几行
     * 正在隔壁批次里翻着，所以实测「前文带译文」的比例是 0%（并发压到 1 才是
     * 100%）。也就是说带前文的本意 —— 让模型看见自己上一批把 agent 译成了什么 ——
     * 在默认设置下从来没有兑现过，送出去的一直是没翻过的原文。 */
    if (!x.tr && !noPunct) continue;
    const line = x.tr ? `${x.text} → ${x.tr}` : x.text;
    // 至少留一行：头一行就超预算也照给，否则碰上长句整块前文会凭空消失
    if (prev.length && w + refWidth(line) > REF_PREV_BUDGET) break;
    prev.unshift(line);
    w += refWidth(line);
  }
  if (prev.length) {
    parts.push(REF_PREV_HEAD + '\n' + prev.join('\n'));
  }

  /* 后文只给没有标点的轨。有标点时 buildSegments 是按 [.!?。！？] 切的，批尾那一句
     本身就是完整句子，把下一批的开头给它帮不上什么忙 —— 跟系统提示里那两句 ASR
     提示一个道理：有标点的轨不必为此多花 token。
     （超长句仍会被强切在连词处，那种半截确实拿不到后文，但它是少数。） */
  const next = [];
  if (noPunct) {
    let wn = 0;
    for (const t of ((ref && ref.next) || [])) {
      if (!t) continue;
      if (next.length && wn + refWidth(t) > REF_NEXT_BUDGET) break;
      next.push(t);
      wn += refWidth(t);
    }
  }
  if (next.length) {
    /* 无标点的轨是按 0.45 秒停顿切的，停顿不等于句子结束，超长的那些还会被强切在
       连词处 —— 批尾那一句因此可能是半截，而它是整批里唯一看不见下文的一行。
       把下一批的开头给出来，模型才知道这句往哪儿走。 */
    parts.push(REF_NEXT_HEAD + '\n' + next.join('\n'));
  }

  return parts;
}

/**
 * 发一次请求，返回 { map: {n: 译文}, usage, error }。mode：
 *   ''       正常翻
 *   'repair' 补翻上次漏掉的那几行
 *   'strict' 上次连编号都没带回来，把格式要求说死了重问
 */
async function askModel(s, items, ref, mode, sourceLang, noPunct, title, job) {
  const userParts = [];
  if (!mode && s.useContext) {
    const blocks = refBlocks(ref, noPunct);
    // 有参考块时才写这句抬头 —— 没有块的话它只是白花 token
    if (blocks.length) userParts.push(...blocks, inputHead(items.length));
  }
  if (mode === 'repair') userParts.push(repairHead(items.length));
  if (mode === 'strict') userParts.push(strictHead(items.length));
  userParts.push(items.map((it) => `${it.n}|${it.text}`).join('\n'));

  const body = {
    model: s.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(s, sourceLang, noPunct, title) },
      { role: 'user', content: userParts.join('\n') }
    ],
    stream: false
  };
  applyReasoning(body, s);
  if (s.temperature !== '' && s.temperature !== null && !isNaN(Number(s.temperature))) {
    body.temperature = Number(s.temperature);
  }
  if (s.maxTokens !== '' && s.maxTokens !== null && !isNaN(Number(s.maxTokens))) {
    body.max_tokens = Number(s.maxTokens);
  }

  let data;
  try {
    data = await postJson(joinUrl(s.baseUrl), s.apiKey, body, 90000, 1, job);
  } catch (e) {
    // retryAfter 一路带回前端：限流不该变成一条要人去点的红字，等一会儿自己重来就好
    return { map: {}, usage: null, error: errText(e), retryAfter: (e && e.retryAfter) || 0 };
  }

  const content =
    (data && data.choices && data.choices[0] && data.choices[0].message &&
      (data.choices[0].message.content || '')) || '';
  if (!content.trim()) {
    return { map: {}, usage: data && data.usage, error: '模型返回空内容（可能是推理档位太高、max_tokens 太小或模型不支持）' };
  }

  return { map: parseLines(content, items), usage: data.usage || null, error: null };
}

/** 把 "<n>|译文" 解析成 { n: 译文 }。认不出编号的行一律丢掉，绝不猜它属于哪一句。 */
function parseLines(content, items) {
  const map = {};
  const cleaned = content.replace(/\r/g, '').split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !/^```/.test(x));

  const valid = new Set(items.map((it) => String(it.n)));
  for (const line of cleaned) {
    const m = line.match(/^(\d+)\s*[|｜:：]\s*(.*)$/);
    if (!m || !valid.has(m[1])) continue;   // 没编号、或编号超出这一块的范围
    const t = m[2].trim();
    if (t) map[m[1]] = t;
  }

  /* 这里以前有两条「按顺序拿没编号的行去补洞」的兜底，都删了。
   *
   * 一条是「模型完全没带编号，但行数刚好对得上就按顺序对齐」，另一条是
   * 「剩余行数正好等于缺失数就顺序填」。两条都把唯一能校验对齐的信息（编号）
   * 扔掉，只靠行数相等来猜，而行数太容易凑巧：模型把第 2、3 句并成一句（少一行），
   * 末尾又客气地补一句「以上共 N 行」（多一行），行数原样对上 —— 于是第 2 句
   * 装着两句话、第 3 句装着那句客套话，整批还照样写进缓存。
   *
   * 认不出编号就当没给。缺哪几行由上层去严格补翻或拆块重来，
   * 多花一次请求，也好过把一句不知道属于谁的文字摆到屏幕上。 */
  return map;
}

/* ------------------------------------------------------------------ *
 * 限流退避
 *
 * 服务商的配额是按分钟算的，而我们默认并发 3。原来的做法是每个批次各自睡 1.2 秒
 * 再撞一次，第二次多半还是 429 —— 于是三批一起变成「翻译出错」，字幕框写着
 * 「翻译出错」，要用户去弹窗点重试。这套节奏基本必败，而且失败的时机往往是
 * 用户刚打开一个视频、三批同时发出去的那一下。
 *
 * 改成按接口地址记一个「冷却到期时刻」：谁撞上 429 谁把它推后，冷却期内的批次
 * 先排队等着，不再各自去撞。等多久优先听服务商的 Retry-After，没给就 2 / 4 / 8
 * 秒指数退避，封顶 30 秒。冷却过完还没再撞上，台阶清零。
 *
 * 这份状态活在 service worker 里，被回收就没了 —— 那没关系：回收意味着一段时间
 * 没有请求，限流窗口本来也就过去了。
 * ------------------------------------------------------------------ */
const RATE_CAP = 30000;        // 一次最多等这么久
const RATE_BASE = 2000;        // 没有 Retry-After 时的第一级台阶
const RATE_RETRY_IN_REQUEST = 1;   // 同一次请求里最多为限流重来几次，之后交给前端排队

const cooldowns = new Map();   // 接口地址 -> { until, step }

const rateKey = (url) => { try { return new URL(url).origin; } catch (_) { return String(url || ''); } };

/** 现在去撞的话得先等多久（毫秒）。0 = 可以直接发。 */
function rateWait(url) {
  const c = cooldowns.get(rateKey(url));
  return c ? Math.max(0, c.until - Date.now()) : 0;
}

/** 撞上 429 了：推后冷却，返回这次该等多久。 */
function rateHit(url, retryAfter) {
  const k = rateKey(url);
  const c = cooldowns.get(k) || { until: 0, step: 0 };
  const ladder = Math.min(RATE_CAP, RATE_BASE * Math.pow(2, c.step));
  const wait = Math.min(RATE_CAP, retryAfter > 0 ? retryAfter : ladder);
  c.step = Math.min(c.step + 1, 4);
  c.until = Date.now() + wait;
  cooldowns.set(k, c);
  return wait;
}

/** 一次没撞上：冷却期已经过完的话就把台阶收掉，下次限流从头数起。 */
function rateClear(url) {
  const k = rateKey(url);
  const c = cooldowns.get(k);
  if (c && c.until <= Date.now()) cooldowns.delete(k);
}

/** Retry-After 可以是秒数，也可以是一个 HTTP 日期。取不到返回 0。 */
function retryAfterMs(res) {
  let v = '';
  try { v = (res && res.headers && res.headers.get && res.headers.get('Retry-After')) || ''; } catch (_) {}
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(RATE_CAP, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.min(RATE_CAP, Math.max(0, t - Date.now())) : 0;
}

async function postJson(url, key, body, timeoutMs, retries, job) {
  let lastErr = null;
  let rateTries = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (job && job.cancelled) throw cancelError();
    /* 冷却期内：排队等着，别去撞。这是「全局」退避的全部含义 —— 一个批次撞上了，
     * 另外两个并发批次就不必再各自撞一次。 */
    const queued = rateWait(url);
    if (queued > 0) {
      await sleep(queued);
      if (job && job.cancelled) throw cancelError();
    }
    const ctrl = new AbortController();
    // 登记进这一批的名下，切视频时 cancelJobs 才拽得住它
    if (job) job.ctrls.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const done = () => { clearTimeout(timer); if (job) job.ctrls.delete(ctrl); };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      done();

      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          detail = (j.error && (j.error.message || j.error.code)) || detail;
        } catch (_) {}
        const err = new Error(`HTTP ${res.status}: ${detail}`);
        /* 暂时性的才重发：
         *   408 请求超时、425 太早、429 限流，以及所有 5xx。
         * 其余（400 请求不合法、401 key 不对、403 没权限、404 模型名不对、
         * 422 参数不合法……）都是配置或请求内容错了，重发一模一样的请求
         * 只会得到一模一样的拒绝，白等一秒还多烧一次配额。
         *
         * 不重试的要打上 noRetry —— 这个 throw 在 try 块里，会被下面那个 catch
         * 一并接住，不打标记的话它照样睡一秒再发一遍。 */
        /* 429 单独走退避：读 Retry-After，没有就按台阶退。同一次请求里只为它重来
         * 一次，再撞就把「还要等多久」报给前端 —— 让那一批回到队列里等冷却过去，
         * 比在这儿抱着一个请求干等几十秒好（service worker 说不定就被回收了）。 */
        if (res.status === 429) {
          const wait = rateHit(url, retryAfterMs(res));
          if (rateTries++ < RATE_RETRY_IN_REQUEST) { lastErr = err; continue; }
          err.retryAfter = Math.max(wait, rateWait(url));
          err.rate = true;
          err.noRetry = true;
          throw err;
        }
        const transient = res.status === 408 || res.status === 425 || res.status >= 500;
        if (transient) { lastErr = err; await sleep(1200 * (attempt + 1)); continue; }
        err.noRetry = true;
        throw err;
      }
      rateClear(url);      // 这一发过去了，冷却过完就把台阶收掉
      return JSON.parse(text);
    } catch (e) {
      done();
      /* 中止有两个来源：我们自己的超时闹钟，和「这一批已经作废了」。
       * 后者绝不能当成超时去重试 —— 那正是我们刚刚花力气掐掉的那次请求。 */
      if (job && job.cancelled) throw cancelError();
      lastErr = e;
      if (e && e.noRetry) throw e;
      if (e && e.name === 'AbortError') { if (attempt < retries) continue; throw new Error('请求超时'); }
      if (attempt >= retries) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr || new Error('请求失败');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 用量统计
 * ------------------------------------------------------------------ */
/* 统计是「读出来 → 加 → 写回去」，并发的批次同时完成会互相覆盖。
 * 串成一条队列，写入就不会丢。service worker 里只有这一个写入方，够用了。 */
let usageQueue = Promise.resolve();

/* ------------------------------------------------------------------ *
 * 缓存索引
 *
 * { 缓存键: 最后使用时间 }。淘汰旧缓存时只读这一份，不必把所有译文正文读进内存。
 *
 * 维护它同样是「读出来 → 改 → 写回去」，而且写入方不止一个：每个 YouTube 标签页
 * 都在写，设置页清空缓存时也在写。两边各读一份旧索引、各写回自己那份，后写的把
 * 先写的整个盖掉 —— 被盖掉的那些键对应的译文正文从此没人清理（淘汰只遍历索引里
 * 的键），存储只增不减，unlimitedStorage 也扛不住长期这么漏。
 *
 * 所以索引只在这里改，而且跟用量统计一样串成一条队列。内容脚本和设置页都改成
 * 发消息过来，不再各自动 storage。
 * ------------------------------------------------------------------ */
let cacheQueue = Promise.resolve();

/** payload: { op: 'touch' | 'forget' | 'clear' | 'write', key, items?, prune?: { days, max } } */
function cacheIndexOp(payload) {
  const task = cacheQueue.then(() => runCacheOp(payload || {}));
  // 一次失败不能把整条队列卡死，也不能把这次的返回值漏给下一次
  cacheQueue = task.then(() => {}, () => {});
  return task;
}

async function runCacheOp(p) {
  if (p.op === 'clear') {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('c_'));
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.local.set({ cacheIndex: {} });
    return keys.length;
  }

  const key = p.key || '';
  if (!key) return 0;

  /* 正文也走这条队列。以前是内容脚本自己 chrome.storage.local.set 整份写回：
   * 同一个视频开两个标签页，两边各持有一份 items、各写各的，后写的把先写的整个
   * 盖掉 —— 被盖掉的那些译文下次重看再买一次。索引早就为同样的理由搬过来了，
   * 正文没搬。现在内容脚本只发增量，合并在这里做。 */
  if (p.op === 'write') await mergeCacheBody(key, p.items);

  const got = await chrome.storage.local.get('cacheIndex');
  const idx = got.cacheIndex || {};
  if (p.op === 'forget') delete idx[key];
  else idx[key] = Date.now();

  const drop = p.prune ? staleKeys(idx, p.prune) : [];
  for (const k of drop) delete idx[k];
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set({ cacheIndex: idx });
  return drop.length;
}

/** 把这一批新译文并进已经存着的那份。读-改-写全程在队列里，不会跟别人交错。 */
async function mergeCacheBody(key, items) {
  if (!items || typeof items !== 'object') return;
  const keys = Object.keys(items);
  if (!keys.length) return;
  const got = await chrome.storage.local.get(key);
  const cur = (got[key] && got[key].items) ? got[key] : { items: {} };
  for (const k of keys) cur.items[k] = items[k];
  cur.ts = Date.now();
  await chrome.storage.local.set({ [key]: cur });
}

/** 过期的，加上超出条数上限的。刚 touch 过的那条时间最新、排在最前，不会淘汰掉自己。 */
function staleKeys(idx, opt) {
  const days = Number(opt.days) || 60;
  const max = Number(opt.max) || 300;
  const cutoff = Date.now() - days * 86400000;
  const expired = [], live = [];
  for (const k of Object.keys(idx)) ((idx[k] || 0) < cutoff ? expired : live).push(k);
  live.sort((a, b) => (idx[b] || 0) - (idx[a] || 0));
  return expired.concat(live.slice(max));
}

/* ------------------------------------------------------------------ *
 * 用量统计
 * ------------------------------------------------------------------ */
/* align 里那几个计数是拿来回答一个具体问题的：改了提示词或上下文之后，模型的
 * 逐行对齐是变好了还是变差了。翻译好不好没法自动判，但错位有客观指纹 ——
 * 拆过块、留了空、最后放弃了几行，这三样都是现成的。 */
const ALIGN_KEYS = ['batches', 'split', 'repaired', 'dropped', 'dirty'];

function addUsage(usage, align) {
  usageQueue = usageQueue.then(async () => {
    const got = await chrome.storage.local.get('stats');
    const st = got.stats || { requests: 0, prompt: 0, completion: 0, since: Date.now() };
    if (usage) {
      st.requests = (st.requests || 0) + 1;
      st.prompt = (st.prompt || 0) + Number(usage.prompt_tokens || usage.input_tokens || 0);
      st.completion = (st.completion || 0) + Number(usage.completion_tokens || usage.output_tokens || 0);
      st.cached = (st.cached || 0) + Number(usage.cached_tokens || 0);
      st.cachedReports = (st.cachedReports || 0) + Number(usage.cached_reports || 0);
    }
    // 老用户的 stats 里没有这几个键，一律按 0 起算
    if (align) for (const k of ALIGN_KEYS) st[k] = (st[k] || 0) + Number(align[k] || 0);
    await chrome.storage.local.set({ stats: st });
  }).catch(() => {});
  return usageQueue;
}

/* ------------------------------------------------------------------ *
 * 设置页的连通性测试
 * ------------------------------------------------------------------ */
async function testApi(override) {
  const s = Object.assign({}, DEFAULTS, await getSettings(), override || {});
  if (!s.apiKey) return { ok: false, error: '缺少 API Key' };
  if (!(await hasApiPermission(s.baseUrl))) return { ok: false, error: PERM_HINT };

  const body = {
    model: s.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(s, 'en') },
      { role: 'user', content: '1|So the question is, what is intelligence?\n2|Yeah, that’s a hard one.' }
    ],
    stream: false
  };
  applyReasoning(body, s);

  const t0 = Date.now();
  const data = await postJson(joinUrl(s.baseUrl), s.apiKey, body, 60000, 0);
  const content =
    (data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content) || '';
  return {
    ok: true,
    ms: Date.now() - t0,
    sample: content.trim().slice(0, 300),
    usage: data.usage || null,
    model: s.model,
    /* 推理这块光看设置是判断不了的：「推理参数写法」只决定发哪个字段名，
     * 到底关没关得由模型说了算。所以把「我发了什么」和「它烧了多少推理 token」
     * 一起报出来 —— 设成关闭却还在烧，就是选错写法了。 */
    reasoning: {
      level: s.reasoning || 'none',
      style: s.reasoningStyle || 'effort',
      sent: reasoningFields(body),
      used: reasoningTokens(data.usage)
    },
    // 同样地：取不到就是 null，不能写成 0
    cached: cachedTokens(data.usage)
  };
}

/** 这次请求里跟推理有关的字段，原样摘出来给设置页显示 */
function reasoningFields(body) {
  const out = {};
  for (const k of ['reasoning_effort', 'enable_thinking', 'thinking_budget']) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

/** 模型实际花掉的推理 token。各家放的位置不一样，取不到就返回 null（不是 0）。 */
function reasoningTokens(u) {
  if (!u) return null;
  const d = u.completion_tokens_details || u.output_tokens_details || {};
  const n = d.reasoning_tokens !== undefined ? d.reasoning_tokens : u.reasoning_tokens;
  return typeof n === 'number' ? n : null;
}
