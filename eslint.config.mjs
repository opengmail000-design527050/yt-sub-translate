import js from '@eslint/js';

/* 最小规则集：只抓「一定是错」的那类问题 —— 拼错的变量名、写了没用的东西、
 * 重复的 case、掉进去的 switch 分支。风格（引号、分号、缩进）一概不管，
 * 这份代码里的风格已经一致，交给规则去改只会制造无谓的 diff。 */
const shared = {
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
  // catch (_) {} 是这份代码里「这里失败了也无所谓」的固定写法
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'smart'],
  'no-irregular-whitespace': ['error', { skipTemplates: true }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }]
};

export default [
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  {
    // 扩展本体：浏览器 + chrome.*
    files: ['background.js', 'common.js', 'content/**/*.js', 'popup/**/*.js', 'options/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        chrome: 'readonly', window: 'readonly', document: 'readonly', navigator: 'readonly',
        location: 'readonly', console: 'readonly', fetch: 'readonly', Response: 'readonly',
        Request: 'readonly', Headers: 'readonly', AbortController: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', requestAnimationFrame: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly',
        DOMParser: 'readonly', XMLHttpRequest: 'readonly', ResizeObserver: 'readonly',
        getComputedStyle: 'readonly', structuredClone: 'readonly',
        performance: 'readonly', crypto: 'readonly', Node: 'readonly', Event: 'readonly',
        CustomEvent: 'readonly', MutationObserver: 'readonly', self: 'readonly'
      }
    },
    rules: shared
  },
  {
    /* inject.js 直接以普通脚本注入页面，不打包也不是模块。
       content/src/ 下的才是模块（打包成 dist/content/content.js）。 */
    files: ['content/inject.js'],
    languageOptions: { sourceType: 'script' }
  },
  {
    // 测试与工具脚本跑在 node 里
    files: ['test/**/*.js', 'tools/**/*.mjs', 'icons/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', __filename: 'readonly', process: 'readonly',
        console: 'readonly', Buffer: 'readonly', global: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', fetch: 'readonly',
        AbortController: 'readonly', structuredClone: 'readonly'
      }
    },
    rules: shared
  },
  {
    files: ['tools/**/*.mjs'],
    languageOptions: { sourceType: 'module' }
  }
];
