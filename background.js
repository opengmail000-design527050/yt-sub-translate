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

async function translateBatch(payload) {
  const s = await getSettings();
  if (!s.apiKey) return { ok: false, error: '还没填 API Key（点插件图标 → 设置）' };
  if (!(await hasApiPermission(s.baseUrl))) return { ok: false, error: PERM_HINT };

  const lines = payload.lines || [];
  if (!lines.length) return { ok: true, map: {}, usage: null };

  // 批内重新编号 1..N：数字短更省 token，也比全局序号（可能是四位数）更不容易错位
  const items = lines.map((l, i) => ({ n: i + 1, id: l.id, text: l.text }));

  const totals = { prompt_tokens: 0, completion_tokens: 0 };
  const bump = (u) => {
    if (!u) return;
    totals.prompt_tokens += Number(u.prompt_tokens || u.input_tokens || 0);
    totals.completion_tokens += Number(u.completion_tokens || u.output_tokens || 0);
  };

  const first = await askModel(s, items, payload.context, false, payload.sourceLang);
  bump(first.usage);
  if (first.error) return { ok: false, error: first.error };
  const got = first.map;

  // 模型把相邻几行并成一句、剩下的留空 —— 这是字幕翻译最常见的失败，单独补翻一次
  let missing = items.filter((it) => !got[it.n] || !got[it.n].trim());
  let repaired = 0;
  if (missing.length && missing.length < items.length) {
    const fix = await askModel(s, missing.map((m, i) => ({ n: i + 1, id: m.id, text: m.text })),
                               payload.context, true, payload.sourceLang);
    bump(fix.usage);
    missing.forEach((m, i) => {
      const t = fix.map[i + 1];
      if (t && t.trim()) { got[m.n] = t.trim(); repaired++; }
    });
    missing = items.filter((it) => !got[it.n] || !got[it.n].trim());
  }

  // 映射回全局 segment id
  const map = {};
  for (const it of items) {
    const t = got[it.n];
    if (t && t.trim()) map[String(it.id)] = t.trim();
  }

  const usage = totals.prompt_tokens || totals.completion_tokens ? totals : null;
  if (usage) await addUsage(usage);

  return {
    ok: true,
    map,
    usage,
    dropped: missing.map((m) => m.id),   // 补翻后仍然缺的，前端只显示原文
    repaired
  };
}

/** 发一次请求，返回 { map: {n: 译文}, usage, error } */
async function askModel(s, items, context, isRepair, sourceLang) {
  const userParts = [];
  if (!isRepair && s.useContext && context) {
    userParts.push('[前文，仅供参考，不要翻译]\n' + context + '\n[以下是需要翻译的行]');
  }
  if (isRepair) {
    userParts.push(`[上一次回复漏掉了这 ${items.length} 行。逐行翻译，一行输入对应一行 "<n>|<译文>"，不要合并，不要多余文字]`);
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

  // 模型完全没带编号，但行数刚好对得上：按顺序对齐
  if (!Object.keys(map).length && leftovers.length === items.length) {
    items.forEach((it, i) => { if (leftovers[i]) map[String(it.n)] = leftovers[i]; });
    return map;
  }

  // 部分缺失，且剩余行数正好等于缺失数：按顺序补上
  const missing = items.filter((it) => !map[String(it.n)]);
  if (missing.length && leftovers.length === missing.length) {
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
async function addUsage(usage) {
  const got = await chrome.storage.local.get('stats');
  const st = got.stats || { requests: 0, prompt: 0, completion: 0, since: Date.now() };
  st.requests += 1;
  st.prompt += Number(usage.prompt_tokens || usage.input_tokens || 0);
  st.completion += Number(usage.completion_tokens || usage.output_tokens || 0);
  await chrome.storage.local.set({ stats: st });
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
