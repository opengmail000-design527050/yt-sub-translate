/* 切句的直接单测：import 模块本身，不假 DOM、不假 chrome、不加载整个内容脚本。
 *
 * 拆模块换来的就是这个 —— 以前想验一句话怎么切，得先摆出 80 行假 DOM 把整个
 * content.js 跑起来，慢、脆，而且切句跟浏览器根本没关系。
 * （segments.test.js 那份仍然留着：它验的是「打出来的那一份装进页面之后」的行为。）
 */
import { buildSegments, parseJson3, wid, isWide } from '../content/src/segments.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

const cue = (start, dur, text) => ({ start, end: start + dur, text });

console.log('\n[1] 宽度：中日韩算两格');
ok('汉字两格', wid('中文') === 4, String(wid('中文')));
ok('拉丁一格', wid('abcd') === 4, String(wid('abcd')));
ok('混排：两个汉字四格，加上 “AI ” 三格', wid('AI 芯片') === 7, String(wid('AI 芯片')));
ok('认得出宽字符', isWide('片') && !isWide('a'));

console.log('\n[2] 句号切句，小数点不切');
{
  const segs = buildSegments([
    cue(0, 4, 'GPT-4.5 came out in 2025 and changed how people priced these things.'),
    cue(4, 4, 'It cost $3.50 per million tokens, which sounded cheap at the time.')
  ]);
  const all = segs.map((s) => s.text).join(' | ');
  ok('版本号没被切在小数点上', all.includes('GPT-4.5'), all);
  ok('价格没被切在小数点上', all.includes('$3.50'), all);
  ok('两句话是两段', segs.length === 2, all);
}

console.log('\n[3] 静音处必须断开');
{
  const segs = buildSegments([
    cue(0, 2, 'So the first thing to say about this is fairly simple'),
    cue(40, 2, 'And now for something completely different indeed')
  ]);
  ok('切成两段', segs.length === 2, JSON.stringify(segs.map((s) => s.text)));
  ok('第二段不会在静音里提前冒出来', segs[1].start >= 39, String(segs[1].start));
  ok('第一段不会一直挂到第二段', segs[0].end < 10, String(segs[0].end));
}

console.log('\n[4] 每句都留得住，且首尾相接');
{
  const cues = Array.from({ length: 30 }, (_, i) =>
    cue(i * 2, 2, 'Sentence number ' + i + ' says something quite ordinary here.'));
  const segs = buildSegments(cues);
  const joined = segs.map((s) => s.text).join(' ');
  const lost = cues.filter((c) => !joined.includes('number ' + c.text.split('number ')[1].split(' ')[0]));
  ok('一句都没丢', lost.length === 0, '丢了 ' + lost.length + ' 句');
  ok('时间轴单调不倒退', segs.every((s, i) => i === 0 || s.start >= segs[i - 1].start));
  ok('每句都有正的时长', segs.every((s) => s.end > s.start));
  ok('编号从 0 连续排下来', segs.every((s, i) => s.id === i));
}

console.log('\n[5] 字幕长度档位真的会改变切法');
{
  const long = [cue(0, 12,
    'The interesting thing about this particular question, and I have thought about it for years, ' +
    'is that it keeps coming back in different forms, which is why I keep asking it.')];
  const compact = buildSegments(long, 'compact');
  const full = buildSegments(long, 'full');
  ok('紧凑档切得更碎', compact.length > full.length, compact.length + ' vs ' + full.length);
  ok('紧凑档每段都不算长', compact.every((s) => wid(s.text) <= 96 + 2),
     JSON.stringify(compact.map((s) => wid(s.text))));
}

console.log('\n[6] json3 解析');
{
  const body = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] },
    { tStartMs: 1500, dDurationMs: 1500, aAppend: 1, segs: [{ utf8: 'hello world' }] },
    { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: '' }] }
  ] });
  const cues = parseJson3(body);
  ok('拼起同一条 cue 的碎片', cues.length === 1 && cues[0].text === 'hello world', JSON.stringify(cues));
  ok('跳过滚动补帧和空行', cues.length === 1, JSON.stringify(cues));
  ok('认不出来的返回 null', parseJson3('不是 json') === null);
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
