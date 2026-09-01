/* 切句：把 YouTube 那些两三个词一条的 cue 拼成「一屏读得完」的句子。
 *
 * 这里只跟文本和时间轴打交道，不碰 DOM、不碰 chrome API —— 唯一的外部依赖是
 * 「字幕长度档位」和把「这一轨有没有标点」记回状态。
 */
import { S, st } from './state.js';

/* 中日韩与全角字符按 2 个单位计宽，其余按 1。
 * 这样同一套长度上限在拉丁语系和中日韩之间都说得通 ——
 * 130 个拉丁字符和 65 个汉字，无论信息量还是屏幕宽度都差不多。 */
const WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;

export const isWide = (ch) => !!ch && WIDE_RE.test(ch);

export function wid(s) {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += isWide(s[i]) ? 2 : 1;
  return w;
}

/* 字幕长度档位：soft = 合并短句的上限，hard = 超过才不得不切（单位同上） */
const DENSITY = {
  compact: { soft: 76, hard: 96 },
  standard: { soft: 100, hard: 130 },
  full: { soft: 130, hard: 180 }
};

export function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

/* ------------------------------------------------------------------ *
 * 字幕解析
 * ------------------------------------------------------------------ */
export function parseJson3(body) {
  let j;
  try { j = JSON.parse(body); } catch (_) { return null; }
  if (!j || !Array.isArray(j.events)) return null;
  const cues = [];
  for (const ev of j.events) {
    if (!ev.segs) continue;
    if (ev.aAppend) continue;                       // 自动字幕的滚动补帧，跳过
    const text = ev.segs.map((x) => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = Number(ev.tStartMs || 0) / 1000;
    const dur = Number(ev.dDurationMs || 0) / 1000;
    cues.push({ start, end: start + (dur || 2), text });
  }
  return cues.length ? cues : null;
}

export function parseXml(body) {
  let doc;
  try { doc = new DOMParser().parseFromString(body, 'text/xml'); } catch (_) { return null; }
  const nodes = doc.querySelectorAll('text, p');
  if (!nodes.length) return null;
  const cues = [];
  nodes.forEach((n) => {
    const start = Number(n.getAttribute('start') || (Number(n.getAttribute('t') || 0) / 1000));
    const dur = Number(n.getAttribute('dur') || (Number(n.getAttribute('d') || 0) / 1000)) || 2;
    const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start, end: start + dur, text });
  });
  return cues.length ? cues : null;
}

/* 把碎片化的 cue 合成「句子级」片段：一屏读得完，翻译质量更好，token 也更省。
 * YouTube 的 cue 只有两三个词，句号常落在 cue 中间，所以先把整轨拼成一条文本、
 * 用字符位置反查时间，再按句子边界切。 */
const MIN_CHARS = 26;   // 太短的句子并进下一句，免得字幕一闪而过

const MAX_DUR = 9;

const GAP = 1.4;

export function buildSegments(cues) {
  const d = DENSITY[S.density] || DENSITY.standard;
  const SOFT_MAX = d.soft;   // 翻译单元的目标长度，超了才考虑切
  const HARD_MAX = d.hard;   // 超过这个不得不切，否则一屏放不下

  const clean = cues
    .map((c) => ({ start: c.start, end: c.end, text: decodeEntities(c.text).replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.text && !/^\[[^\]]*\]$/.test(c.text));
  if (!clean.length) return [];

  // 自动字幕的 cue 时长常常盖过下一条（播放器靠它做滚动效果），
  // 不修掉的话按字符插值出来的时间会整体偏晚
  for (let i = 0; i < clean.length - 1; i++) {
    if (clean[i].end > clean[i + 1].start) clean[i].end = clean[i + 1].start;
    if (clean[i].end <= clean[i].start) clean[i].end = clean[i].start + 0.25;
  }

  /* 静音前的最后一条 cue，时长常常一路拉到下一条开口的地方 —— 自动字幕尤其如此，
   * 播放器靠它把这行字一直挂在屏幕上。可那几十秒里根本没人说话：照它插值，这条
   * cue 后半句的时间会被摊进静音里，下面的静音检测也就看不见这个洞了。
   * 按文本长度给单条 cue 的时长封顶，说得再慢也用不了这么久。 */
  for (const c of clean) {
    const cap = Math.max(2, 0.5 + wid(c.text) * 0.14);
    if (c.end - c.start > cap) c.end = c.start + cap;
  }

  // 拼成整条文本，同时记录每个 cue 的字符区间用于时间插值。
  // 中日韩之间不能补空格，否则会在词中间插进空隙。
  let full = '';
  const marks = [];
  for (const c of clean) {
    if (full && !(isWide(full[full.length - 1]) && isWide(c.text[0]))) full += ' ';
    marks.push({ pos: full.length, len: Math.max(1, c.text.length), start: c.start, end: c.end });
    full += c.text;
  }

  // 前缀宽度表：之后判断「这一段有多长」都是 O(1)，不用反复扫字符串
  const pw = new Int32Array(full.length + 1);
  for (let i = 0; i < full.length; i++) pw[i + 1] = pw[i] + (isWide(full[i]) ? 2 : 1);
  const widthOf = (a, b) => pw[b] - pw[a];
  /** 从 s 出发、宽度不超过 w 的最远字符位置 */
  const advance = (s, w) => {
    const target = pw[s] + w;
    let lo = s, hi = full.length, best = s;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pw[mid] <= target) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };

  /* 句子边界落在 cue 之间的空格上，而空格在字符表里算作上一条 cue 的尾巴。
   * 直接拿边界位置反查时间，新句子的开始就会被算成上一句的结束 ——
   * 中间隔着几十秒静音时，下一句会提前几十秒冒出来。取时间前先跳过两端空白。 */
  const skipL = (a, b) => { while (a < b && /\s/.test(full[a])) a++; return a; };
  const skipR = (a, b) => { while (b > a && /\s/.test(full[b - 1])) b--; return b; };

  const timeAt = (idx) => {
    let lo = 0, hi = marks.length - 1, k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].pos <= idx) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const m = marks[k];
    const frac = Math.min(1, Math.max(0, (idx - m.pos) / m.len));
    return m.start + frac * (m.end - m.start);
  };

  // 全角句号后面通常不跟空格，所以单独判
  const hasPunct = /[。！？]|[.!?]["'’”)\]]?(\s|$)/.test(full.slice(0, 4000));
  /* 给翻译请求带上。用「有没有标点」而不是「是不是 asr 轨」来判断：
     有些自动字幕带标点（不需要额外提示），有些人工上传的反而不带（需要）。 */
  st.noPunct = !hasPunct;

  // 1. 先切成句子（无标点的自动字幕退回按 cue 边界分组）
  let pieces = [];
  if (hasPunct) {
    /* 半角句点只有在后面跟着空白（或者到头了）时才算句子结束。
     * 以前是见点就断，于是 GPT-4.5 被切成 "GPT-4." + "5"、$3.50 切成 "$3." + "50"、
     * Python 3.12 切成 "Python 3." + "12" —— 科技访谈里版本号和价格满地都是。切坏的
     * 半截既照原样显示在屏幕上、也照原样发给模型翻，而且第 3 步合并短句时会在接缝处
     * 补一个空格（"GPT-4. 5"），原文哈希跟着变，缓存也一起弄脏。
     * 全角句号本来就不跟空格，照旧见点就断。
     *
     * 写法上不能给旧正则挂个 lookahead 了事：旧正则靠开头那段 [^.!?…。！？]* 保证两次
     * 匹配首尾相接，一旦某个点因为不满足条件被跳过，它前面那段文字就会掉在两次匹配
     * 之间被无声丢掉。所以改成只扫标点本身，自己拿 last 游标接住中间的文字。 */
    const re = /[.!?…。！？]+["'’”)\]」』】]*/g;
    let m, last = 0;
    while ((m = re.exec(full)) !== null) {
      const e = m.index + m[0].length;
      const cjkStop = /[…。！？]/.test(m[0]);
      if (!cjkStop && e < full.length && !/\s/.test(full[e])) continue;   // 小数点、版本号
      pieces.push({ s: last, e });
      last = e;
    }
    if (last < full.length && full.slice(last).trim()) pieces.push({ s: last, e: full.length });
  } else {
    /* 自动字幕没有标点。以前这里拿 cue 边界当句子边界 —— 可 cue 边界只是
     * 「每两三个词换一屏」的显示节奏，跟语义毫无关系，于是每一句都被切在
     * 半截上（"so the question I keep coming" / "back to is what intelligence
     * really"），模型只能照着半截短语硬翻，而系统提示又明令禁止它跨行搬运语义。
     *
     * 改成只在「真的停顿了」的地方断开：前面已经把重叠的 cue 时长削平，
     * 滚动字幕的相邻 cue 因此严格首尾相接，gap 只会出现在真实的静音处。
     * 断不开的长句交给下面第 2 步，它会优先切在 and / because / so 这些
     * 连词前，比按显示节奏乱切近得多。 */
    const PAUSE = 0.45;
    let s0 = marks[0].pos, prevEnd = marks[0].end;
    for (let i = 1; i < marks.length; i++) {
      const mk = marks[i];
      if (mk.start - prevEnd > PAUSE) {
        const prev = marks[i - 1];
        pieces.push({ s: s0, e: prev.pos + prev.len });
        s0 = mk.pos;
      }
      prevEnd = mk.end;
    }
    pieces.push({ s: s0, e: full.length });
  }

  /* 1.5 静音处一律断开，跟这条轨有没有标点无关。
   * 上面按标点切句有个前提：句末真的有标点。说话人拖长音收尾、或者自动字幕漏掉
   * 那个句号时，一个「句子」就会横跨几十秒静音 —— 它的 start 落在静音之前，于是
   * 整段静音里屏幕上挂着的，是后面才说出口的下一段对白。无标点那条分支已经按
   * 停顿切过了，这里再拿一个更宽的阈值兜住有标点的轨：2 秒以上的空档，正常语句
   * 内部不会出现，出现了就一定是真的没人说话。 */
  const HOLE = 2;
  const holes = [];                       // 静音之后那条 cue 的起始字符位置
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].start - marks[i - 1].end > HOLE) holes.push(marks[i].pos);
  }
  if (holes.length) {
    const broken = [];
    for (const p of pieces) {
      let s0 = p.s;
      for (const h of holes) {
        if (h > s0 && h < p.e) { broken.push({ s: s0, e: h }); s0 = h; }
      }
      broken.push({ s: s0, e: p.e });
    }
    pieces = broken;
  }

  // 2. 只有真的过长才切，而且尽量只在强标点处切。
  //    在连词/空格处切会造出半截片段，译文必然要跨行调语序，
  //    模型就会把好几行并成一句塞进第一行、后面留空 —— 中英不同步就是这么来的。
  const split = [];
  for (const p of pieces) {
    let s = p.s;
    while (widthOf(s, p.e) > HARD_MAX) {
      const stop = advance(s, HARD_MAX);        // 这一刀最远能切到哪
      const win = full.slice(s, stop);
      const floorIdx = advance(s, HARD_MAX * 0.3) - s;   // 太靠前的位置不切
      let cut = -1;

      // 逗号 / 分号 / 破折号之后 —— 语义完整，译文不会跨界。
      // 拉丁标点要求后面跟空格（免得切进 "1,000"），全角标点本来就不带空格。
      const punct = win.match(/^.*(?:[,;:—–]\s|[，、；：])/);
      if (punct && punct[0].length > floorIdx) cut = punct[0].length;

      // 没有标点可切时才退而求其次，让连词起下一句（只对有空格的语言有效）
      if (cut < 0) {
        const re = /\s(and|but|so|because|which|that|when|if|though|while)\s/gi;
        let mm, best = -1;
        while ((mm = re.exec(win)) !== null) {
          if (mm.index + 1 > floorIdx) best = mm.index + 1;
          re.lastIndex = mm.index + 1;
        }
        if (best > 0) cut = best;
      }

      if (cut < 0) {
        const sp = win.lastIndexOf(' ');
        if (sp > floorIdx) cut = sp + 1;
      }
      // 中日韩没有空格可依，最后只能按宽度硬切
      if (cut <= 0) cut = Math.max(1, stop - s);
      split.push({ s, e: s + cut });
      s += cut;
    }
    if (p.e > s) split.push({ s, e: p.e });
  }

  // 3. 太短的往后并，直到读得舒服为止
  const out = [];
  let cur = null;
  for (const p of split) {
    const ps = skipL(p.s, p.e), pe = skipR(p.s, p.e);
    const text = full.slice(ps, pe).trim();
    if (!text) continue;
    const start = timeAt(ps), end = timeAt(pe);
    if (!cur) { cur = { start, end, text }; continue; }
    const joiner = (isWide(cur.text[cur.text.length - 1]) && isWide(text[0])) ? '' : ' ';
    const merged = wid(cur.text) + wid(joiner) + wid(text);
    if (wid(cur.text) < MIN_CHARS &&
        merged <= SOFT_MAX &&
        (start - cur.end) <= GAP &&
        (end - cur.start) <= MAX_DUR) {
      cur.text += joiner + text;
      cur.end = end;
    } else {
      out.push(cur);
      cur = { start, end, text };
    }
  }
  if (cur) out.push(cur);

  const segs = out
    .map((s, i) => ({ id: i, start: s.start, end: s.end, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text);

  // 一句留在屏幕上直到下一句开始（静音处最多多留 1.2 秒），
  // 免得译文一闪就没、给人「中文比英文快」的错觉
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    const cap = segs[i].end + 1.2;
    segs[i].end = next ? Math.min(next.start, cap) : cap;
    if (segs[i].end <= segs[i].start) segs[i].end = segs[i].start + 0.7;
  }
  segs.forEach((s, i) => { s.id = i; });
  return segs;
}
