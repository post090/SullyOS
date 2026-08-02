# 交接 prompt：把 amsg-server 的 `/cloudflare` 路径改成纯 Web Crypto（去掉 node `crypto`）

> 这份是给在 **ReiStandard** 仓库（`packages/rei-standard-amsg/server`）里干活的实例看的，自包含，
> 不依赖别处上下文。目标只有一个：让单用户 / Cloudflare（`@rei-standard/amsg-server/cloudflare`）
> 那条路径不再 import node 的 `crypto`，从而能像 `amsg-instant` 一样打成**免兼容开关（无
> `nodejs_compat`）的自包含单文件 bundle**，供用户直接粘进 Cloudflare Dashboard。

## 背景（为什么要改）

`amsg-instant` 早已全 Web Crypto，所以它的 bundle 粘进 Dashboard 免开任何 flag。但
`amsg-server/cloudflare` 里**载荷 AES 加密**还在用 node `crypto`（`createCipheriv` 等），
导致 esbuild 纯 `platform=neutral` 打包直接报 `Could not resolve "crypto"`，粘进 Dashboard
必须额外开 `nodejs_compat`。把它港到 Web Crypto 后，这个开关就不需要了。

推送签名那半（`lib/webpush-webcrypto.js`）本来就是 Web Crypto，不用动。

## 精确范围（import 图已追干净）

单用户 / cloudflare 入口链：`cloudflare/single-user-worker.js` → `single-user.js` →
`tenant/single-user-context.js`（干净，无 crypto）+ 各 handler + `lib/run-tick.js` +
`lib/message-processor.js` + `adapters/d1.js`。这条链里**只有下面几处还挂 node `crypto`**：

**要改的：**
1. `server/src/server/lib/encryption.js` —— 主体。`createCipheriv/createDecipheriv`
   （AES-256-GCM）+ `createHash('sha256')`（派生 key）+ `randomBytes`。
2. `server/src/server/lib/message-processor.js` —— 第 22 行 `import { randomUUID } from 'crypto'`。
3. `server/src/server/handlers/schedule-message.js` —— 第 9 行 `import { randomUUID } from 'crypto'`。

**明确不要动（多租户专用，不在 cloudflare import 图里，已确认）：**
- `server/src/server/tenant/token.js`（`createHmac/timingSafeEqual`，HMAC tenant token）
- `server/src/server/tenant/blob-store.js`（Netlify Blob KEK 的 AES）
- `server/src/server/tenant/context.js`（多租户 context 的 hash/random）

> 这三个还用 node crypto 没关系——它们只被 Netlify/Neon 多租户主入口(`index.js`)拉，
> `/cloudflare` 入口不 import 它们，所以不影响 cloudflare bundle 的免 flag 目标。

## 任务 1：port `lib/encryption.js` 到 Web Crypto（★ 兼容是命门）

保持 **5 个导出的函数名、参数、返回结构、线格式逐字节不变**，只把实现从 node crypto 换成
`globalThis.crypto.subtle`。**所有 5 个导出都会变成 `async`**（SubtleCrypto 是异步的）。

### ★★ 必须注意的兼容陷阱 ★★

- **authTag 位置**：Node 的 GCM 把密文和 16 字节 authTag **分开**返回（`cipher.getAuthTag()`）；
  Web Crypto 的 `subtle.encrypt` 把 authTag **拼在密文尾部**。所以：
  - 加密后：把 `subtle.encrypt` 结果的**最后 16 字节切出来当 authTag**，前面当密文。
  - 解密前：把密文和 authTag **重新拼起来**再喂给 `subtle.decrypt`。
  - `tagLength: 128`（=16 字节）。
- **IV 长度保持原样**：`encryptPayload` 用 **12** 字节 IV，`encryptForStorage` 用 **16** 字节 IV。
  别统一成 12，否则老数据解不开。Web Crypto 的 AES-GCM 两种长度都接受。
- **编码保持原样**：payload 格式用**标准 base64**（原来 `Buffer.toString('base64')`）；storage 格式
  用 **hex**、冒号分隔 `iv:authTag:data`。
- **key 派生保持原样**：`sha256(masterKey + userId)` 的 hex，`slice(0, 64)`（32 字节 = AES-256 key）。

### 参考实现（可直接用）

`lib/webcrypto-utils.js` 已导出 `utf8` / `utf8Decode` / `randomBytes` / `concatBytes`。还需要 hex 和
标准 base64 的编解码——先查 `@rei-standard/amsg-shared` 有没有现成的，没有就加到 `webcrypto-utils.js`
（那儿本就是"runtime-neutral 编码 helper"的家），别用 `Buffer`（免 flag bundle 里没有）。

```js
/**
 * Encryption utility library (Web Crypto 版)
 * AES-256-GCM，request/response 与 storage 加密，跑在任何有 globalThis.crypto.subtle 的运行时。
 */
import { utf8, utf8Decode, randomBytes, concatBytes } from './webcrypto-utils.js';

const subtle = globalThis.crypto.subtle;
const TAG_LEN = 16; // AES-GCM auth tag 字节数（tagLength:128）

// —— 编码 helper（若 shared/webcrypto-utils 已有则复用）——
function bytesToHex(b) { let s=''; for (let i=0;i<b.length;i++) s+=b[i].toString(16).padStart(2,'0'); return s; }
function hexToBytes(h) { const o=new Uint8Array(h.length/2); for (let i=0;i<o.length;i++) o[i]=parseInt(h.substr(i*2,2),16); return o; }
function bytesToBase64(b) { let s=''; for (let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
function base64ToBytes(s) { const bin=atob(s); const o=new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) o[i]=bin.charCodeAt(i); return o; }

async function importAesKey(hexKey) {
  return subtle.importKey('raw', hexToBytes(hexKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** sha256(masterKey+userId) 的 hex，取前 64 字符（= 32 字节 AES-256 key）。*/
export async function deriveUserEncryptionKey(userId, masterKey) {
  const digest = await subtle.digest('SHA-256', utf8(masterKey + userId));
  return bytesToHex(new Uint8Array(digest)).slice(0, 64);
}

/** 加密 API 载荷（AES-256-GCM，base64）。返回 { iv, authTag, encryptedData }。*/
export async function encryptPayload(payload, encryptionKey) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const iv = randomBytes(12);
  const key = await importAesKey(encryptionKey);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8(plaintext)));
  return {
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(sealed.slice(sealed.length - TAG_LEN)),
    encryptedData: bytesToBase64(sealed.slice(0, sealed.length - TAG_LEN)),
  };
}

/** 解密客户端加密的请求体（AES-256-GCM，base64）。*/
export async function decryptPayload(encryptedPayload, encryptionKey) {
  const { iv, authTag, encryptedData } = encryptedPayload;
  const key = await importAesKey(encryptionKey);
  const sealed = concatBytes(base64ToBytes(encryptedData), base64ToBytes(authTag));
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), tagLength: 128 }, key, sealed);
  return JSON.parse(utf8Decode(plain));
}

/** 加密入库（AES-256-GCM，hex，格式 iv:authTag:encryptedData）。*/
export async function encryptForStorage(text, encryptionKey) {
  const iv = randomBytes(16);
  const key = await importAesKey(encryptionKey);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8(text)));
  const data = sealed.slice(0, sealed.length - TAG_LEN);
  const tag = sealed.slice(sealed.length - TAG_LEN);
  return `${bytesToHex(iv)}:${bytesToHex(tag)}:${bytesToHex(data)}`;
}

/** 从入库格式解密。*/
export async function decryptFromStorage(encryptedText, encryptionKey) {
  const [ivHex, tagHex, dataHex] = encryptedText.split(':');
  const key = await importAesKey(encryptionKey);
  const sealed = concatBytes(hexToBytes(dataHex), hexToBytes(tagHex));
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex), tagLength: 128 }, key, sealed);
  return utf8Decode(plain);
}
```

## 任务 2：两处 `randomUUID` 去掉 node crypto

- `lib/message-processor.js`：删 `import { randomUUID } from 'crypto'`，改从 `./webcrypto-utils.js`
  引现成的 `randomUUID`。
- `handlers/schedule-message.js`：删 `import { randomUUID } from 'crypto'`，改从 `../lib/webcrypto-utils.js`
  引 `randomUUID`。

## 任务 3：把 async 涟漪补齐（★ 别漏 await）

`encryption.js` 的 5 个导出变 async 后，**所有调用点都要 `await`**，且外层函数必须是 async。
注意 `encryption.js` 同时被多租户主入口和 cloudflare 入口共用，所以要**全仓改，不只单用户**。
已知调用点（逐个确认外层 async + 加 await）：

- `handlers/get-user-key.js` — `deriveUserEncryptionKey`
- `handlers/schedule-message.js` — `deriveUserEncryptionKey` / `decryptPayload` / `encryptForStorage`
- `handlers/update-message.js` — `deriveUserEncryptionKey` / `decryptPayload` / `encryptForStorage` / `decryptFromStorage`
- `handlers/messages.js` — `deriveUserEncryptionKey` / `decryptFromStorage` / `encryptPayload`
- `lib/run-tick.js` — `deriveUserEncryptionKey` / `decryptFromStorage`
- `lib/message-processor.js` — `deriveUserEncryptionKey` / `decryptFromStorage`

兜底：改完跑全套测试（下），漏 await 会以 "解密拿到 Promise / JSON.parse 报错" 的形式炸出来。

## 任务 4：加回归测试（把兼容钉死）

测试跑在 Node（既有 node `crypto` 也有 `globalThis.crypto.subtle`，Node ≥ 19），所以可以做
**跨实现互通测试**，无需硬编码 fixture：

1. **跨实现互通（最重要，钉线格式）**：用 node 的 `crypto` 按老写法（aes-256-gcm、12/16 字节 IV、
   分离 authTag）造密文 → 断言新的 `decryptPayload` / `decryptFromStorage` 能解出原文；反向再来一遍
   （新 `encryptPayload/encryptForStorage` 产的密文 → 用 node `crypto` 解）。两种格式都覆盖。
   > 这条测试的意义：任何人以后改了算法/IV 长/编码/authTag 处理，它就挂。是防回归的守卫。
2. **派生 key 等价**：node `createHash('sha256').update(masterKey+userId).digest('hex').slice(0,64)`
   与新 `deriveUserEncryptionKey` 输出逐字符相等。
3. **round-trip**：`encrypt* → decrypt*` 原样还原（含中文、含 emoji、空串边界）。
4. **篡改即抛**：改一个字节的密文/authTag，`decrypt*` 必须 reject（GCM 校验生效）。

## 验收标准（都过才算完）

1. `grep -rE "from '(node:)?crypto'" server/src` 结果里**只剩** `tenant/token.js`、
   `tenant/blob-store.js`、`tenant/context.js`（多租户），单用户/cloudflare 链里一个不剩。
2. cloudflare 入口能纯 neutral 打包、无 `Could not resolve "crypto"`：
   ```bash
   # 在装了本包的目录跑（worker.js 内容见下方"消费端"）：
   npx esbuild worker.js --bundle --format=esm --target=es2022 \
     --platform=neutral --conditions=worker,browser,import,default --outfile=/tmp/amsg-neutral.js
   # 期望：exit 0，且 grep -c 'node:' /tmp/amsg-neutral.js 结果为 0
   ```
   其中 `worker.js` = `import { createSingleUserCloudflareWorker, createWebCryptoWebPush } from
   '@rei-standard/amsg-server/cloudflare'; export default createSingleUserCloudflareWorker(...)`。
3. 全套 server 测试通过（含多租户，确保 async 涟漪没漏）。
4. 版本 +1、发 next tag（当前 npm 上 `next` = `2.6.0-next.1`，本次发 `2.6.0-next.2` 或你定），
   `exports` 的 `./cloudflare` 子路径不变。

## 交付后（SullyOS 下游收口，不用你管，仅供了解）

SullyOS 会：升 `@rei-standard/amsg-server` 到新 next（仅构建期 devDep）→ 加 `worker/amsg/src/index.ts`
薄入口 → 进 `scripts/build-workers.mjs` 清单产免 flag 单文件 → 全局 Modal 加「复制 Worker 代码」按钮。
你这边只要保证 `/cloudflare` 免 node crypto、能纯 neutral 打包即可。
