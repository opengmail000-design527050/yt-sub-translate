/* 「用户读得懂的语言」怎么定：界面文案用哪种、目标语言 auto 译成哪种。
 *
 * 原来只看 chrome.i18n.getUILanguage()。在 Linux 上它取自环境变量 LANG，
 * LANG=C.UTF-8 时就是 en-US —— 哪怕用户在 Chrome 设置里把中文排在第一位。
 * 实测：中文用户拿到一套英文的弹窗和设置页；目标语言 auto 也跟着判成英文，
 * 英文视频干脆「无需翻译」。
 *
 * import common.js 本身，chrome 和 navigator 用最小的桩。
 */
let ui = 'en-US', langs = ['zh-CN', 'zh', 'en-US'];
const EN = { popupReasoning: 'Reasoning effort', popupOff: 'Off' };
globalThis.chrome = {
  i18n: {
    getUILanguage: () => ui,
    // 模拟 Chrome：只会按它自己的界面语言给语言包
    getMessage: (k) => (/^en/.test(ui) ? (EN[k] || '') : '')
  }
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ languages: langs }) });

const { t, uiLanguage, resolveTargetName } = await import('../common.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

console.log('\n[1] Chrome 界面是英文，首选语言是中文（LANG=C.UTF-8 的 Linux）');
ui = 'en-US'; langs = ['zh-CN', 'zh', 'en-US'];
ok('读得懂的语言是中文', uiLanguage() === 'zh-CN', uiLanguage());
ok('界面文案用代码里的中文，不用英文包', t('popupReasoning', '推理强度') === '推理强度', t('popupReasoning', '推理强度'));
ok('目标语言 auto 译成简体中文', resolveTargetName({ targetLang: 'auto' }) === '简体中文',
   resolveTargetName({ targetLang: 'auto' }));

console.log('\n[2] 首选语言本来就是英文：一切照旧');
ui = 'en-US'; langs = ['en-US', 'zh-CN'];
ok('读得懂的语言是英文', uiLanguage() === 'en-US', uiLanguage());
ok('界面用英文包', t('popupOff', '关闭') === 'Off', t('popupOff', '关闭'));

console.log('\n[3] Chrome 界面是中文、首选却是英文：听界面的（那多半是用户自己选的）');
ui = 'zh-CN'; langs = ['en-US'];
ok('读得懂的语言是中文', uiLanguage() === 'zh-CN', uiLanguage());
ok('界面是中文', t('popupOff', '关闭') === '关闭', t('popupOff', '关闭'));

console.log('\n[4] 首选是日文、界面是英文：目标语言跟首选走，界面文案仍用英文包（没有日文包）');
ui = 'en-US'; langs = ['ja-JP', 'en'];
ok('读得懂的语言是日文', uiLanguage() === 'ja-JP', uiLanguage());
ok('没有日文包时界面还是英文，不会掉回中文', t('popupOff', '关闭') === 'Off', t('popupOff', '关闭'));

console.log('\n[5] 读不到首选语言：退回 Chrome 界面语言');
ui = 'en-US'; langs = [];
ok('就是界面语言', uiLanguage() === 'en-US', uiLanguage());

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
