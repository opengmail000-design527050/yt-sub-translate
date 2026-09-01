/* 固定扩展 ID：node tools/keygen.mjs
 *
 * 「加载已解压」时，扩展 ID 是从目录路径算出来的 —— 换台机器、换个目录，ID 就变，
 * 而 chrome.storage 是按 ID 存的：设置、译文缓存、用量统计全都跟着不见。manifest 里
 * 钉一个公钥就能把 ID 定死。
 *
 * 但这一步有代价，而且是一次性的、不可逆的：ID 现在就会变，当前这个装着的实例里
 * 已有的设置和缓存从此读不到（缓存里是已经付过钱的译文）。所以它不是默认打开的，
 * 由你挑一个合适的时机自己跑 —— 通常是「准备发布 / 准备换机器」之前。
 *
 * 私钥写到 build/extension-key.pem（不进版本库）。它只有在你要自己打 .crx 时才用得上；
 * 上应用商店不需要它，商店会用它自己的密钥。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (manifest.key) {
  console.log('manifest 里已经有 key 了，什么都不做。');
  console.log('扩展 ID：' + idFromKey(manifest.key));
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/** Chrome 的扩展 ID：公钥 SHA-256 的前 16 字节，每个半字节映射到 a-p */
function idFromKey(b64) {
  const hash = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest();
  return [...hash.subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
}

const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });
const pemPath = path.join(outDir, 'extension-key.pem');
fs.writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

// key 放在 name 后面，跟版本号待在一块儿，肉眼好找
const src = fs.readFileSync(manifestPath, 'utf8');
const marker = '"version":';
const i = src.indexOf(marker);
const out = src.slice(0, i) + '"key": "' + pub + '",\n  ' + src.slice(i);
fs.writeFileSync(manifestPath, out);

console.log('已经把公钥写进 manifest.json，私钥在 ' + path.relative(root, pemPath) + '（不进版本库，别弄丢）。');
console.log('扩展 ID 从此固定为：' + idFromKey(pub));
console.log('注意：这个 ID 跟你现在装着的那个不一样 —— 重新加载之后，旧的设置和译文缓存读不到了。');
