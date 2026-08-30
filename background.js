import { DEFAULTS, getSettings, resolveTargetName, CODE_TO_NAME, hasApiPermission } from './common.js';

/* ------------------------------------------------------------------ *
 * 消息入口
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'translateBatch') {
    translateBatch(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }

  if (msg.type === 'testApi') {
    testApi(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }

  if (msg.type === 'addUsage') {
    addUsage(msg.payload).then(() => sendResponse({ ok: true }));
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

function buildSystemPrompt(s, sourceLang) {
  const lang = resolveTargetName(s);
  const srcName = sourceLang ? (CODE_TO_NAME[sourceLang] || CODE_TO_NAME[String(sourceLang).split('-')[0]] || sourceLang) : '';
  const src = srcName ? `${srcName} ` : '';
  const lines = [
    `Translate ${src}subtitle lines from a tech podcast or long-form interview into ${lang}.`,
    `Input: lines of "<n>|<text>". Output: exactly one "<n>|<translation>" per input line — same numbers, same order, same count, nothing else. No markdown, no notes, no blank lines.`,
    `CRITICAL: each line is displayed on screen by itself at its own timestamp. Keep every line's meaning inside that line. Never carry content forward into a later line or pull content back from one, even when natural ${lang} word order differs. Never leave a line empty and never output fewer lines than you were given.`,
    `The lines are one continuous conversation between hosts and guests. Keep the spoken register and each speaker's tone; do not make casual speech sound formal.`,
    `Write natural, concise ${lang} that reads well as a subtitle at a glance. Keep proper nouns, product names and established English acronyms (AI, GPU, LLM, API) unchanged.`,
    `A sentence fragment stays a fragment — translate it as a fragment rather than completing it.`
  ];
  if (s.extraPrompt && s.extraPrompt.trim()) lines.push(s.extraPrompt.trim());
  return lines.join('\n');
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

async function translateBatch(payload) {
  const s = await getSettings();
  if (!s.apiKey) return { ok: false, error: '还没填 API Key（点插件图标 → 设置）' };
  if (!(await hasApiPermission(s.baseUrl))) return { ok: false, error: PERM_HINT };

  const lines = payload.lines || [];
  if (!lines.length) return { ok: true, map: {}, usage: null };

  const ctx = {
    s,
    sourceLang: payload.sourceLang,
    totals: { prompt_tokens: 0, completion_tokens: 0 },
    error: '',
    repaired: 0
  };

  const r = await translateChunk(ctx, lines, 0, payload.context || '');

  const usage = ctx.totals.prompt_tokens || ctx.totals.completion_tokens ? ctx.totals : null;
  if (usage) await addUsage(usage);

  // 一行都没翻出来：当成整批失败，前端才会给重试入口
  if (!r.out.size) return { ok: false, error: ctx.error || '模型没有返回可用的译文', usage };

  const map = {};
  for (const [id, t] of r.out) map[String(id)] = t;

  return {
    ok: true,
    map,
    usage,
    dropped: r.missing.map((m) => m.id),   // 到底也没翻出来的，前端只显示原文
    repaired: ctx.repaired
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
async function translateChunk(ctx, items, depth, prevText) {
  const numbered = items.map((it, i) => ({ n: i + 1, id: it.id, text: it.text }));

  const collect = (m) => {
    const out = new Map();
    for (const it of numbered) {
      const t = String((m && m[it.n]) || '').trim();
      if (t) out.set(it.id, t);
    }
    return out;
  };

  let r = await askModel(ctx.s, numbered, prevText, '', ctx.sourceLang);
  bumpUsage(ctx.totals, r.usage);
  let out = r.error ? new Map() : collect(r.map);

  /* 一行都没认出来。多半是模型压根没按 "<n>|译文" 的格式回 ——
   * 编号一丢就没有任何办法校验对齐，绝不能拿「行数正好相等」当依据照单全收
   * （见 parseLines 里那段注释）。重问一次，把格式要求说死。
   * 只有本来就已经失败的情况才会走到这，正常路径不会多花钱。 */
  if (!out.size) {
    const again = await askModel(ctx.s, numbered, prevText, 'strict', ctx.sourceLang);
    bumpUsage(ctx.totals, again.usage);
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
      const mid = Math.ceil(items.length / 2);
      const a = await translateChunk(ctx, items.slice(0, mid), depth + 1, prevText);
      const b = await translateChunk(ctx, items.slice(mid), depth + 1,
                                     String(items[mid - 1].text || '').slice(-220));
      const out2 = new Map(a.out);
      for (const [k, v] of b.out) out2.set(k, v);
      return { out: out2, missing: a.missing.concat(b.missing) };
    }
    /* 拆到头还在错位：这一块整个不要。宁可这几句只显示原文，
     * 也不能把「快一句」的译文摆上去 —— 那比没有更误导，还会毒化缓存。 */
    if (!ctx.error) ctx.error = '有几行模型反复错位，已跳过（只显示原文）';
    return { out: new Map(), missing: items };
  }

  /* 缺号散在中间：这是模型明确留空了某几行，前后的编号仍然对得上，
   * 单独补翻这几行是安全的。 */
  const fixItems = missing.map((m, i) => ({ n: i + 1, id: m.id, text: m.text }));
  const fix = await askModel(ctx.s, fixItems, '', 'repair', ctx.sourceLang);
  bumpUsage(ctx.totals, fix.usage);
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

function bumpUsage(totals, u) {
  if (!u) return;
  totals.prompt_tokens += Number(u.prompt_tokens || u.input_tokens || 0);
  totals.completion_tokens += Number(u.completion_tokens || u.output_tokens || 0);
}

/**
 * 发一次请求，返回 { map: {n: 译文}, usage, error }。mode：
 *   ''       正常翻
 *   'repair' 补翻上次漏掉的那几行
 *   'strict' 上次连编号都没带回来，把格式要求说死了重问
 */
async function askModel(s, items, context, mode, sourceLang) {
  const userParts = [];
  if (!mode && s.useContext && context) {
    userParts.push('[前文，仅供参考，不要翻译]\n' + context + '\n[以下是需要翻译的行]');
  }
  if (mode === 'repair') {
    userParts.push(`[上一次回复漏掉了这 ${items.length} 行。逐行翻译，一行输入对应一行 "<n>|<译文>"，不要合并，不要多余文字]`);
  }
  if (mode === 'strict') {
    userParts.push(`[上一次回复没按格式。这次必须输出正好 ${items.length} 行，每行以输入的编号加竖线开头，形如 "1|译文"。不要合并任何两行，不要写编号以外的任何内容]`);
  }
  userParts.push(items.map((it) => `${it.n}|${it.text}`).join('\n'));

  const body = {
    model: s.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(s, sourceLang) },
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
    data = await postJson(joinUrl(s.baseUrl), s.apiKey, body, 90000, 1);
  } catch (e) {
    return { map: {}, usage: null, error: errText(e) };
  }

  const content =
    (data && data.choices && data.choices[0] && data.choices[0].message &&
      (data.choices[0].message.content || '')) || '';
  if (!content.trim()) {
    return { map: {}, usage: data && data.usage, error: '模型返回空内容（可能是推理档位太高、max_tokens 太小或模型不支持）' };
  }

  return { map: parseLines(content, items), usage: data.usage || null, error: null };
}

/** 把 "<n>|译文" 解析成 { n: 译文 }；模型不带编号时按顺序兜底对齐。 */
function parseLines(content, items) {
  const map = {};
  const cleaned = content.replace(/\r/g, '').split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !/^```/.test(x));

  const valid = new Set(items.map((it) => String(it.n)));
  const leftovers = [];
  for (const line of cleaned) {
    const m = line.match(/^(\d+)\s*[|｜:：]\s*(.*)$/);
    if (m && valid.has(m[1])) {
      const t = m[2].trim();
      if (t) map[m[1]] = t;
    } else {
      leftovers.push(line.replace(/^\d+\s*[|｜:：]\s*/, '').trim());
    }
  }

  /* 这里以前还有一条「模型完全没带编号，但行数刚好对得上就按顺序对齐」的兜底。
   * 它已经删掉了 —— 那条路把唯一能校验对齐的信息（编号）扔了，
   * 只剩「行数相等」这一个条件，而行数太容易凑巧相等：
   * 模型把第 2、3 句并成一句（少一行），末尾又客气地补一句「以上共 3 行」（多一行），
   * 行数原样对上，于是从第 2 句起整体前移的译文被照单全收，还顺手写进了缓存。
   * 拿不准就别猜：交给上层当「这次没给出可用译文」处理，重问一次比错一整批便宜。 */

  /* 部分缺失，且剩余行数正好等于缺失数：按顺序补上。
   * 但缺口碰到首行或末行时不能填 —— 那是编号整体平移的指纹（见 edgeGap），
   * 顺序补齐等于替模型把窟窿糊上，上层再也看不出这一批已经整体错位了。
   * 只有窟窿夹在中间时，前后编号都对得上，按顺序填才是安全的。 */
  const missing = items.filter((it) => !map[String(it.n)]);
  if (missing.length && !edgeGap(missing, items.length) && leftovers.length === missing.length) {
    missing.forEach((it, i) => { if (leftovers[i]) map[String(it.n)] = leftovers[i]; });
  }
  return map;
}

async function postJson(url, key, body, timeoutMs, retries) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
      clearTimeout(timer);

      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          detail = (j.error && (j.error.message || j.error.code)) || detail;
        } catch (_) {}
        const err = new Error(`HTTP ${res.status}: ${detail}`);
        if (res.status === 429 || res.status >= 500) { lastErr = err; await sleep(1200 * (attempt + 1)); continue; }
        throw err;
      }
      return JSON.parse(text);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
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

function addUsage(usage) {
  usageQueue = usageQueue.then(async () => {
    const got = await chrome.storage.local.get('stats');
    const st = got.stats || { requests: 0, prompt: 0, completion: 0, since: Date.now() };
    st.requests += 1;
    st.prompt += Number(usage.prompt_tokens || usage.input_tokens || 0);
    st.completion += Number(usage.completion_tokens || usage.output_tokens || 0);
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
    usage: data.usage || null
  };
}
