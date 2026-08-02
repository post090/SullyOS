# 交接 prompt：给 amsg-server 单用户/cloudflare 路径加「满血后台消息」支持

> 这份是给在 **ReiStandard** 仓库（`packages/rei-standard-amsg/server`）里干活的实例看的，自包含，
> 不依赖别处上下文。目标：让单用户 / Cloudflare（`@rei-standard/amsg-server/cloudflare`）部署的
> worker 在定时任务触发时，能够 **现场组装 prompt + 在服务端跑多轮工具循环**，而不是只会
> 「取出排程时冻结的 completePrompt → 一次 LLM → 推送」。
>
> 三个交付物：① `client_state` 通用状态表 + 读写端点；② fire 时刻的 hook 契约；
> ③ 服务端 agentic 循环（对齐 amsg-instant 0.8 的 hook 形状）。

## 背景（为什么要改）

下游（SullyOS）的主动消息现在是：客户端在**排程时**把完整 prompt 拼好，冻结进 D1 的任务里；
cron 到点后 worker 拿冻结文本调一次 LLM 就推送。问题：

1. 上下文停留在排程那一刻——每周任务触发时，prompt 里的"最近聊天"可能是七天前的；
2. 完全没有工具：LLM 不能查记忆、不能调 MCP，因为 fire 时刻客户端多半不在线，
   而现有 amsg-instant 的工具模式（推 tool_request 回客户端执行再 POST /continue）依赖客户端活着。

目标形态：客户端平时把状态增量同步到 worker 的 D1（新表 `client_state`）；fire 时 worker
从状态表现场组装 prompt，需要工具时**在 worker 内直接执行**（host 提供执行器），多轮循环
全部在服务端闭环，最后推送成品。中途不需要客户端参与。

## 前置约束（红线，先读）

- **通用抽象，不耦合任何具体应用**。amsg-server 是通用库，本次新增的表、端点、hook 契约
  里不得出现任何下游项目（含 SullyOS）的业务概念——不硬编码业务标签名、工具名、namespace
  命名规范。所有业务语义（输出怎么分类、工具怎么执行、状态里存什么）全部由宿主经 hooks
  注入，库只提供循环骨架和存取通道。写文档举例时用中性示例。
- **纯 Web Crypto / 零 node 内置依赖**。这条路径的主线部署方式是「复制 bundle 粘进
  Cloudflare Dashboard」，不开 `nodejs_compat`。此前已把 `lib/encryption.js` 等全部港到
  Web Crypto（见 encryption.js 头注释），**不要**在新代码里引 `node:crypto` / `Buffer` 等
  把免 flag 目标破坏掉。验收里有打包检查。
- **向后兼容**。没配新 hook 的既有部署（含已经粘贴上线的用户 worker）行为必须一字不变：
  老任务照走冻结 prompt 的老链路。
- **hook 不暴露凭据**。学 amsg-instant `SessionContext` 的做法：hook 收到的 ctx 里没有
  `apiKey` / `pushSubscription` / VAPID，防止 hook 作者一句 `console.log(ctx)` 把密钥打进日志。

## 任务 1：`client_state` 表 + 读写端点

单用户模式下客户端状态的云端镜像。一份活状态（不按任务多份快照），按 namespace 组织，
客户端是唯一写者。

**表（init-tenant 幂等建表，跟现有建表走同一套 migration 机制）：**

```sql
CREATE TABLE IF NOT EXISTS client_state (
  user_id    TEXT NOT NULL,
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,          -- encryptForStorage 密文
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, namespace, key)
);
```

**端点（挂在单用户 worker 的路由上，命名可按仓库惯例调整）：**

| 端点 | 语义 |
|------|------|
| `PUT /client-state` | 批量 upsert。body = `{ entries: [{ namespace, key, value, updatedAt }] }`。服务端按 `updatedAt` 最后写赢（旧于库内的条目跳过），value 用现有 `encryptForStorage`（per-user key）落库 |
| `GET /client-state?namespace=<ns>` | 取一个 namespace 的全部条目（解密后返回，响应走现有 payload 加密） |
| `DELETE /client-state` | 清空该 user 的全部状态（下游设置页的「清除云端状态」按钮用） |

鉴权与加密全部沿用现状：`X-Client-Token` 全端点 all-or-nothing 校验、`X-User-Id`、
请求/响应加密头（`X-Payload-Encrypted` 等）。CORS 同现有端点。

批量 upsert 是唯一写入口——客户端在 iOS 切后台前只有几秒存活窗口，必须一次请求写完，
所以 entries 数组要支持几十条一批。单条 value 约束在 ~200KB（超限回 4xx 带明确报错）。

## 任务 2：fire 时刻的 hook 契约

`createSingleUserCloudflareWorker(...)`（或对应工厂）接受可选 hooks。建议形状
（命名按仓库惯例定，语义别变）：

```js
{
  hooks: {
    // fire 时组装 prompt。返回 messages（或带覆盖项的对象）→ 走新链路；
    // 返回 null/undefined → 回退老链路（冻结 prompt）。
    // ctx: { task, userId, readState(namespace) => Promise<entries>, now }
    //   - task: 任务行（mode / promptHint / charId / contactName 等任务字段，密文已解）
    //   - readState: 读 client_state 的能力句柄（内部已解密）
    // 返回值两种形状都接受：
    //   ChatMessage[]
    //   { messages: ChatMessage[], maxToolIterations?, totalTimeoutMs? }  ← 本次 fire 覆盖工厂默认
    onBeforeFire(ctx) => Promise<ChatMessage[] | { messages, maxToolIterations?, totalTimeoutMs? } | null>,

    // 每轮 LLM 输出后分类。与 amsg-instant 0.8 的 onLLMOutput 同构：
    // ctx = { sessionId, messages, llmResponse, llmOutputText, iteration, metadata, contactName, avatarUrl }
    // 返回 { decision: 'tool-request', toolCalls } | { decision: 'finish', pushPayloads } | { decision: 'skip-push' }
    onLLMOutput(ctx) => Promise<Decision>,

    // 服务端工具执行器（与 amsg-instant 的关键差异：不推 tool_request 回客户端，就地执行）。
    // 返回 OpenAI tool-result 形状：[{ tool_call_id, role: 'tool', content }]
    executeToolCalls(toolCalls, ctx) => Promise<ToolResult[]>,
  },
  maxToolIterations: 5,     // 工厂级默认，宿主可配；onBeforeFire 返回值可按次覆盖
  totalTimeoutMs: 240_000,  // 整链 wall-time 兜底，同样可配可按次覆盖
}
```

循环由库驱动（host 只写业务）：

```
onBeforeFire → messages
  → callLLM → onLLMOutput
      ├─ 'finish'        → 推送 pushPayloads，写 outbound log，完
      ├─ 'skip-push'     → 记录后结束（沿用 amsg-instant 语义）
      └─ 'tool-request'  → executeToolCalls → messages 追加 assistant(toolCalls)+tool results
                           → iteration+1 → 回到 callLLM（≤ maxToolIterations）
```

实现提醒：

- **多轮循环的实现 amsg-instant 0.8 已经有一遍**（`/instant` + `/continue` 那套的服务端）。
  优先把可共用的部分（decision 处理、iteration 校验、push 切分调度）抽到共享层复用，
  而不是在 amsg-server 里再抄一份。怎么抽（进 amsg-shared 还是 server 内部模块）你定，
  contract 形状对齐 amsg-instant 即可——下游要把 instant 的 classifier 原样复用到这里。
- LLM 调用复用现有 `callLlmRaw` 系（注意工具轮的响应可能没有 content，
  `requireContent` 要放行这种情况，amsg-instant 已有先例）。
- cron `scheduled()` 里等 LLM 是 IO 等待，不吃 CF 的 CPU 配额，但整链 wall-time 必须有
  总超时兜底（`totalTimeoutMs`，默认 240s），超时带着已有内容强制 finish 或按失败记录，
  别让 tick 悬死。**轮数与总超时都要工厂级可配 + fire 级可覆盖**——宿主可能有明确更耗时的
  工具（长搜索、外部 API 慢路径），由宿主在 onBeforeFire 里按任务自行判断放宽。
- 失败语义沿用现有任务失败处理（重试/标记），工具执行抛错时把错误文本作为 tool result
  回填给 LLM 让它自己圆场，而不是整条链失败。

## 任务 3：run-tick / message-processor 接入

`lib/run-tick.js` → `lib/message-processor.js` 这条 fire 链里：

- 任务是需要 LLM 生成的类型（非固定文本）且 host 配了 `onBeforeFire` → 走任务 2 的新链路；
- `onBeforeFire` 未配置、或返回 null → **老链路原样**（取冻结 completePrompt 一次 LLM）。
  固定文本类任务永远走老链路。

## 任务 4：测试

1. **向后兼容守卫**：不配 hooks 时，现有全部 server 测试原样通过；一个 mode=auto 的任务
   走完老链路，行为与改动前一致（这条要能在「以后有人把老链路删了」时挂掉）。
2. **新链路 happy path**：mock LLM，onBeforeFire 组装 → 一轮 tool-request →
   executeToolCalls → 第二轮 finish → 断言推送 payload 与 outbound log。
3. **轮数上限与覆盖**：LLM 永远返回 tool-request，断言在 maxToolIterations 处强制收尾；
   onBeforeFire 返回覆盖值时按覆盖值收尾（totalTimeoutMs 覆盖同理）。
4. **client_state**：批量 upsert（含 updatedAt 旧值跳过）→ GET 解密还原 → DELETE 清空；
   value 超限 4xx；未带 token 401（all-or-nothing 生效）。
5. **凭据不泄露**：断言传给各 hook 的 ctx 上没有 apiKey / pushSubscription / vapid 字段。

## 验收标准（都过才算完）

1. cloudflare 入口仍能纯 neutral 打包：
   ```bash
   npx esbuild worker.js --bundle --format=esm --target=es2022 \
     --platform=neutral --conditions=worker,browser,import,default --outfile=/tmp/amsg-neutral.js
   # 期望：exit 0，且 grep -c 'node:' /tmp/amsg-neutral.js 结果为 0
   ```
2. 全套 server 测试通过（含多租户回归——共用文件的改动别把 Netlify 主入口弄炸）。
3. 不配 hooks 的部署行为与当前版本逐字节一致（老 completePrompt 链路）。
4. 新增代码里 grep 不到任何下游业务标识（业务标签名 / 具体应用名），hook 契约文档的示例
   全部是中性示例。
5. 版本 +1、发 next tag（当前 npm `@rei-standard/amsg-server` 的 next = 2.6.0-next.2，
   本次往上发），`exports` 的 `./cloudflare` 子路径不变。README/JSDoc 给 hooks 一段
   「这是啥 / 啥时候用」说明。

## 交付后（SullyOS 下游收口，不用你管，仅供了解）

下游会：升 devDep 重打 `worker/amsg` bundle → wrapper 里配 hooks（onLLMOutput 复用
instant-push 的业务标签 classifier；executeToolCalls 按工具名分发到 recall/Supabase 查询、
MCP mini client、web_search 等 adapter）→ 前端加状态同步层（脏标记 + 切后台批量 upsert
client_state）→ 设置页加「清除云端状态」。你这边只要保证 hook 契约、client_state 端点和
免 flag 打包三件事稳定即可。
