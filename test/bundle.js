/* 内容脚本现在是打出来的（见 tools/build.mjs），测试跑的就该是真正装进浏览器的
 * 那一份 —— 打包这一步本身也会出错，拿源码去测就永远发现不了。
 * npm test 会先打包；单独跑某个测试文件时，这里给一句人话而不是一个 ENOENT。 */
const fs = require('fs'), path = require('path');

const file = path.join(__dirname, '..', 'dist', 'content', 'content.js');

module.exports = function contentSource() {
  if (!fs.existsSync(file)) {
    console.error('找不到 dist/content/content.js —— 先跑 npm run build（npm test 会自动打包）');
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8');
};
