/* 打一个可以直接「加载已解压」或上传商店的包：node tools/zip.mjs
 *
 * 自己写 zip 而不是拉一个打包库，理由只有一个：这一步必须在任何机器上、
 * 不装任何依赖就能跑（CI 里、干净的 clone 里、别人拿到源码的第一分钟）。
 * zip 的存储格式就这么点东西，deflate 由 node 自带的 zlib 出。 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 进包的东西。反过来写「排除什么」太容易漏 —— 哪天多一个 .env 或者
 * notes.md 就跟着进了商店包，所以这里是白名单。 */
const INCLUDE = [
  'manifest.json',
  'background.js',
  'common.js',
  'content',
  'popup',
  'options',
  'icons',
  '_locales'
];
/* 目录里仍然要挑一遍：icons/ 下有生成脚本，options/ 下将来可能有草稿 */
const SKIP = /(^|\/)(make-icons\.js|\.DS_Store|.*\.map)$/;

function walk(rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return out;
  const st = fs.statSync(abs);
  if (st.isFile()) { if (!SKIP.test(zipName(rel))) out.push(rel); return out; }
  for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name), out);
  return out;
}

/* ---------- zip 写入 ---------- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* zip 里的路径分隔符永远是 /，Windows 上打的包在 Linux 上才解得开 */
const zipName = (rel) => rel.split(path.sep).join('/');

function build(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const rel of files) {
    const name = Buffer.from(zipName(rel), 'utf8');
    const raw = fs.readFileSync(path.join(root, rel));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 压不动的（png 之类）就原样存，省得比原文件还大
    const useStore = deflated.length >= raw.length;
    const data = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(raw);

    const lf = Buffer.alloc(30);
    lf.writeUInt32LE(0x04034b50, 0);
    lf.writeUInt16LE(20, 4);          // version needed
    lf.writeUInt16LE(0x0800, 6);      // flag: 文件名是 UTF-8
    lf.writeUInt16LE(method, 8);
    lf.writeUInt16LE(0, 10);          // 时间：一律置零，同样的输入打出同样的包
    lf.writeUInt16LE(0x0021, 12);     // 日期：1980-01-01
    lf.writeUInt32LE(crc, 14);
    lf.writeUInt32LE(data.length, 18);
    lf.writeUInt32LE(raw.length, 22);
    lf.writeUInt16LE(name.length, 26);
    lf.writeUInt16LE(0, 28);
    locals.push(lf, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x0021, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += lf.length + name.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const files = INCLUDE.flatMap((p) => walk(p, []));
if (!files.includes('manifest.json')) {
  console.error('没有 manifest.json，这不是扩展目录');
  process.exit(1);
}

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `sub-translator-${manifest.version}.zip`);
const buf = build(files);
fs.writeFileSync(out, buf);
console.log(`${path.relative(root, out)}  ${files.length} 个文件 · ${(buf.length / 1024).toFixed(1)} KB`);
