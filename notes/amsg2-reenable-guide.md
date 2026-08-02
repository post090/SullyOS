# 主动消息 2.0（amsg2）单用户模式速查

> 什么时候读这份：改「主动消息 2.0」（角色到点自动发消息、App 关着也能收）相关代码时，照这份快速上手。
> 更新时间：2026-07-26（多任务 + 防穿帮闸波之后）。下面是 `dev` 上的代码现状。

## 一句话现状

amsg2 = 定时主动消息。运行模型是**单用户 + 自带 worker + 自带 DB**：每个用户自己部署一个 Cloudflare Worker（自带 D1 数据库 + Cron Trigger），SullyOS 前端只填「Worker 地址 + 共享密钥」就能用，跟 Instant Push 一个套路。没有多租户、没有 tenant token、没有 Netlify Functions 后端。

**多任务**（2026-07 下旬起）：一个角色可同时挂最多 5 个任务（`ActiveMsg2CharacterConfig.tasks`
清单，短 id = taskUuid 前 8 位）；角色可在对话里用 schedule/cancel/renew/list 四个
function-calling 工具自管排程（`utils/amsg2ToolBridge.ts`），设置面板（`ActiveMsg2SettingsModal`）
全量显示并支持逐个取消/编辑。fire_pack v2 起「本次任务」指令是槽位，随任务 metadata 走、
到点由 worker 填槽，多任务共用每角色一份模板不串味。

**防穿帮闸**（expire_policy，纯判定在 `utils/amsg2ExpireGuard.ts`）：`expire`（默认）任务
到点时若对话已前进（一次性=创建锚点后有真实用户消息；循环=到点前 10 分钟内在聊）或
同角色活跃会话租约（`chat_presence`，15s 心跳 / 45s TTL，`utils/amsgChatPresence.ts`）
仍新鲜，worker onBeforeFire 直接 `{ skip: true }` 作废本次触发，一个生成 token 不花；
剩余竞态由客户端送达兜底闸吞没（`activeMsgRuntime` 的 runtime-expire-swallow，按
`amsgClientTaskId:occurrenceMs` 缓存同吞同放）。作废不是消失：`utils/amsg2TaskContext.ts`
在下一轮组请求时把「进行中任务 + 未告知的作废回执」拼成排程现状块注入 system，由角色
自行决定就地消化 / renew 续期 / 放弃；发送成功后 `markExpiredNoticesNotified` 落账。
`force` 是闹钟语义，全绿灯照发；fixed 任务恒 force（走不了 worker 闸）。

AI 模式任务（自动/提示词）走「满血」链路：前端平时把带时间槽位的完整 prompt
模板（fire_pack）同步到 worker 的 client_state 表，到点由 worker 现场填槽生成——
上下文是用户最后一次聊天时的状态，而不是排程那一刻的。worker 读不到 fire_pack 时
直接抛错、不拿排程时冻结的 prompt 顶包（见下面「状态不完整时不降级」）。设计详见
[`amsg-fullbg-state-design.md`](./amsg-fullbg-state-design.md)。

满血链路带**服务端工具循环**（v2）：LLM 输出里的数据标签（RECALL / SEARCH /
READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*）由 worker 就地执行后回填继续生成
（默认 5 轮 / 240s，客户端全程不用在线）；副作用标签（POKE / TRANSFER / 写日记 /
MUSIC_ACTION / XHS 互动等）结构化成 directives 挂最后一条 push 的 metadata，客户端
收到时重放。classifier 与 instant push 共用同一份（`worker/instant-push/src/classifier.ts`）；
最终正文的分段也与 instant / 客户端气泡共用同一份（`utils/sanitize.ts` 的
`sanitizeIntoSegments`：按换行切，`[[...]]` / `[html]` 等标签块保持原子不被句读劈碎），
push 的 `notification.body` 带净化文本给系统横幅，`message` 保留原始标签给客户端渲染。
工具凭据与 recall 数据由前端随 fire_pack 同批上云（tool_pack / tool_config），
没同步或凭据缺失时工具以正常失败回给 LLM 圆场，不断链。
超 200KB 的大值（胖角色的 fire_pack）由 worker 存储层透明分块
（amsg-server 2.6.0-next.4+），前端整条直传、读回自动拼好；单个坏条目只拒自己
不连坐同批。worker 版本落后时前端用 `GET /capabilities` 探测，设置页亮
「重新粘贴部署」提示，不静默降级。

## 前端接入点

| 部件 | 文件 | 说明 |
|------|------|------|
| 发请求层 | `utils/activeMsgClient.ts` | 包 `@rei-standard/amsg-client` 的 `ReiClient`，构造用 `baseUrl=workerUrl` + `serverToken`。对外方法：`getGlobalConfig` / `getPushStatus` / `ensurePushSubscription` / `connect` / `listTasks` / `listAllTasks`（分页全量，行带上游投影的 charId/clientTaskId）/ `cancelTask` / `scheduleCharacterTask`（多任务 + replaceTaskUuid 先建后删替换）/ `syncChatPresence` / `getCapabilities` / `clearClientState` |
| 多任务清单派生 | `utils/amsg2Tasks.ts` | 短 id、isPendingTask、pruneStaleTasks（过点 48h 出清单）、hasActiveAiTask（同步门）。清单只存 `scheduled`，已发/作废由消息历史现场推导 |
| 防穿帮闸纯判定 | `utils/amsg2ExpireGuard.ts` | shouldExpireFire / detectExpiredOccurrences / hasDeliveredProactiveNear（按 clientTaskId 精确归属）。⚠ 叶子模块，worker 与浏览器共用 |
| 活跃会话租约 | `utils/amsgChatPresence.ts`（形状/新鲜度判定）+ `utils/amsgStateSync.ts`（15s 心跳 timer）+ useChatAI（本地 fetch 路径开/停租约） | ⚠ 叶子模块。只代表「正在和这个角色交互」，切后台停续租，45s TTL 自然失效 |
| 排程现状块 | `utils/amsg2TaskContext.ts` | useChatAI 每轮组请求时检出作废回执（台账在 `ActiveMsgStore`，封顶 10 条 / 48h TTL）+ 拼进行中任务清单注入 system；发送成功后标已告知 |
| 对话内工具 | `utils/amsg2ToolBridge.ts` | schedule/cancel/renew/list 四个 OpenAI tools + 执行器（useChatAI 工具循环分发）。renew 复用 schedule 的替换语义；远端取消失败绝不静默移除本地记录 |
| 全局配置 Modal | `components/settings/ActiveMsgGlobalSettingsModal.tsx` | 「部署 Worker」引导（复制代码 + CF Dashboard 链接 + env 清单 + Master Key 生成）+ 填 Worker 地址 + 共享密钥 + 「连接」+ 「开启推送」。挂在 `apps/Settings.tsx`（Instant Push 那节旁边）。「重新粘贴部署」探测 = features 齐全 **且** serverVersion ≥ 2.6.0-next.7（`utils/amsgWorkerVersion.ts`；next.4 起 features 清单几乎没动过，投影 / skip / 占位租约 / writeState 都只能靠版本号识别） |
| 角色级调度 Modal | `components/chat/ActiveMsg2SettingsModal.tsx` | 任务列表（全量显示、逐个取消/编辑、远端对账徽标）+ 新建/编辑表单：「固定/自动/提示词」× 「一次/每天/每周」× 防穿帮策略（作废/强制）。入口在聊天加号面板「主动消息 2.0」按钮（闹钟图标） |
| fire_pack 模板 | `utils/amsgFirePack.ts` | 满血链路的 prompt 模板 + 时间槽位渲染，前端兜底与 worker 填槽共用同一份（时间文案单份维护，有回归测试钉住） |
| tool_pack / tool_config | `utils/amsgToolPack.ts` | 服务端工具循环的数据形状：每角色的月度总结 / XHS 开关（tool_pack）+ 全局工具凭据 / 代理地址（tool_config），构建与 parse 前端 worker 共用 |
| 状态同步层 | `utils/amsgStateSync.ts` | 每轮聊完（useChatAI 轮末）打脏标记，去抖 15s / 切后台立即，把 fire_pack + tool_pack + tool_config 批量 `putClientState` 上云 |
| 工具实现（共用叶子） | `utils/agenticTools.ts` + `utils/realtimeFetchCore.ts` + `utils/xhsMcpClient.ts` | 九个数据工具的执行体。agenticTools 是 dispatch 入口（前端二轮 LLM / instant 续跑 / amsg worker 三处共用）；搜索 / Notion / 飞书的纯 fetch 核心在 realtimeFetchCore（realtimeContext 的 Manager 委托它）。**这几份是环境无关叶子，别往里加浏览器依赖**——`pnpm build:workers` 会打进 amsg worker bundle |
| Worker 入口（本仓打包） | `worker/amsg/src/index.ts` + `worker/amsg/src/agentic.ts` | index 配 hooks（onBeforeFire 填槽 + 装工具上下文、executeToolCalls 就地执行）；agentic 是决策纯逻辑（classifier 分类、旁白 / 副作用跨轮累积、finish payload 组装，有单测）。`pnpm build:workers` 产 `worker/amsg/worker.bundle.js` + `public/amsg-worker.bundle.js`（Modal「复制 Worker 代码」读后者） |
| 本地存储 | `utils/activeMsgStore.ts` | `ActiveMsg2GlobalConfig` 存 IndexedDB；收发消息的 inbox/outbound/reasoning 存储与 Instant Push 共用 |
| 类型 | `types.ts` | `ActiveMsg2GlobalConfig` = `{ userId, workerUrl, serverToken?, initializedAt?, updatedAt? }` |
| npm 依赖 | `@rei-standard/amsg-client`（2.9.0-next.4，含 serverToken + getVapidPublicKey + getCapabilities）、`amsg-shared` / `amsg-instant` / `amsg-sw`（latest）、`@rei-standard/amsg-server`（2.6.0-next.7，devDep，含 ctx.scratch + 存储层大值分块 + /capabilities + GET /messages 投影 charId/clientTaskId + onBeforeFire `{ skip: true }` 出口 + 任务占位租约 `lease_until` + hook 的 `ctx.writeState` 与 Web Push 大小护栏 `measurePushPayload`） | amsg-server 只用于打 worker bundle，不进前端运行时。占位租约那列由 `POST /init-tenant` 自动补，升级后在设置页点一次「连接」即可 |
| 全流程体检 | `scripts/amsg2-e2e-harness.mjs` | 本地跑提交的 worker.bundle.js 全流程（node:sqlite 模拟 D1 + 真实 web push 加解密 + mock LLM），覆盖排程→cron→工具循环→push→skip 七组场景。改 worker/amsg 或升 amsg-server 后 `node scripts/amsg2-e2e-harness.mjs` 跑一次 |

## 送达层与 Instant Push 共用（收消息侧白送）

worker 推的 web push → Service Worker（`worker/sw-keep-alive.ts`）收 → 写 IndexedDB → `utils/activeMsgRuntime.ts` 落库上屏。这条链和 Instant Push 共用，处理的就是 `ActiveMsg2InboxMessage`（metadata 标 `activeMsg2`）。amsg2 后端按标准 web push 格式推出来，前端收消息侧一行不用改。

## 鉴权与请求头

- 配了 `serverToken` → 每次请求带 `X-Client-Token`；worker 端配了 `AMSG_SERVER_TOKEN` 就**全部端点强制校验**（缺/错回 401，all-or-nothing）。
- 业务端点还带 `X-User-Id` + 加密头（`X-Payload-Encrypted` / `X-Encryption-Version` / `X-Response-Encrypted`）。加密走 client 的 `_encrypt/_decrypt`，key 由 `client.init()`（GET /get-user-key）派生。

## Worker 侧（用户自己部署）

- **主线部署方式 = Dashboard 粘贴**（学 Instant Push，用户不碰终端）：设置 Modal「部署 Worker」点「复制 Worker 代码」拿到 `public/amsg-worker.bundle.js` 全文，去 CF 后台建空 Worker → Edit code 粘贴覆盖 → Deploy。amsg-server 2.6.0-next.2 起全 Web Crypto，bundle 零 node 内置依赖，**不需要 `nodejs_compat` flag**。
- 备选 CLI 方式（wrangler）：`~/Documents/GitHub/amsg-worker/`（不在本仓，含 DEPLOY.md）。上游源码/示例：ReiStandard `packages/rei-standard-amsg/server/examples/cloudflare-single-user/`。
- 端点：`POST /init-tenant`（幂等建表，前端「连接」按钮会打它，用户不用手动执行 schema.sql）、`GET /get-user-key`、`POST /schedule-message`、`GET /messages`、`PUT /update-message?id=`、`DELETE /cancel-message?id=`、`GET /vapid-public-key`、`GET /capabilities`（特性探测：`{ serverVersion, features }`，老部署无此路由 404，前端归一成 null 后亮「重新部署」提示）。定时投递由 Cron Trigger 直接跑 `scheduled()`，无 send-notifications 端点。
- 部署要配：D1 binding 名 `DB`（空库即可，建表交给「连接」）、cron `* * * * *`、env `AMSG_MASTER_KEY`(32B hex，Modal 里可一键生成) + `VAPID_EMAIL/PUBLIC_KEY/PRIVATE_KEY`（必须和「推送凭据 (VAPID)」面板同一对，见下节）+ 可选 `AMSG_SERVER_TOKEN`。
- **跨源必须配 CORS**：本仓入口默认 `cors: { origin: '*' }`，想收紧自行改成站点域名。没配 CORS 时浏览器 preflight 被 worker 404。
- 定时推送 TTL 默认 4 周。

## 云端状态里有什么（爆炸半径）

满血 v2 的服务端工具循环要在到点时自己调 Notion / 飞书 / 搜索 / 小红书，所以这些凭据得放在 worker 能拿到的地方。前端在排程和去抖同步时把三份数据写进 worker 的 `client_state`：

| key | namespace | 内容 |
|---|---|---|
| `fire_pack` | `amsg:char:<charId>` | 完整 prompt 模板（角色卡、世界书、最近上下文），时间处留槽位 |
| `tool_pack` | `amsg:char:<charId>` | 该角色的月度总结、小红书开关、角色名 |
| `tool_config` | `amsg:global` | Notion / 飞书 / news 的 key，小红书 cookie，代理 worker 地址 |

传输走 client 的 `_encrypt`（key 由 `AMSG_MASTER_KEY` 派生），但 worker 到点必须解密才能用。所以实际的安全边界是 **worker 自身**：拿到 worker 的 env（`AMSG_MASTER_KEY`）就能解出上面全部内容，包括那几个第三方凭据。

这是把工具循环搬到服务端的固有成本，不是实现漏洞。想缩小暴露面的话：不需要的工具在「实时感知」里关掉，`buildToolConfig` 只上传已启用项的凭据（`utils/amsgToolPack.ts`）。另外 `AMSG_SERVER_TOKEN` 建议配上——不配的话端点无鉴权，虽然读消息内容仍需要加密 key，但 `DELETE /cancel-message`、`POST /init-tenant` 这类不带 payload 的操作，知道 worker 地址就能打。

## 状态不完整时不降级

排程链的顺序是**先传云端状态、成功了再建任务**（`putClientStateOrThrow`：网络抖动重试两次，最终失败抛错让整个排程失败）。这样上传失败时远端还没有任务，不需要回滚，也不会出现「用户看到排程失败、远端却会到点触发」。

对应地，worker 到点读不到 `fire_pack`（或解析失败、或任务缺 `amsgTaskInstruction`）时直接抛 `AMSG2_FIRE_STATE_MISSING`，不会退回任何冻结的 prompt——任务体里也没有第二份 prompt 可退（`messages` 只有一条占位，正常路径下会被 `onBeforeFire` 的返回值覆盖）。抛错走库的投递失败路径，重试 3 次后任务标 `failed`，日志里有 `[amsg:fire-state-missing]`。

回归守卫在 `worker/amsg/src/index.test.ts`（四道门与顺序）和 `utils/activeMsgClient.test.ts`（上传失败必须抛错）。

## VAPID 公钥

前端订阅时 `applicationServerKey` 必须是**这个 worker 自己**签推送用的公钥，否则推不动会 403。所以 `ensurePushSubscription` 运行时从 worker 拉公钥，不再用 build-time env。

- 用 `client.getVapidPublicKey()`（amsg-client 2.9.0-next.1 新增）→ `GET {workerUrl}/vapid-public-key`，带 X-Client-Token，返回 `publicKey` 字符串。worker 未配 VAPID 时返回 503 `VAPID_NOT_CONFIGURED`。
- worker 侧端点在 amsg-server 2.6.0-next.1+；部署时 worker env 要有 `VAPID_PUBLIC_KEY`，且和签推送用的是同一对密钥。
- **worker env 的 VAPID 必须填「推送凭据 (VAPID)」面板里那对**（`utils/pushVapid.ts` 共享存储，与 Instant Push / Proactive Push 同一对）：一个 origin 只有一个浏览器 push 订阅，`ensurePushSubscription` 有现成订阅就直接复用，amsg worker 用别的密钥对签推送会 403。

## 联调防坑

- `@rei-standard/amsg-*` 源仓改完 `link:../ReiStandard` 联调时，**提交前 grep `pnpm-lock.yaml` 别让 `ReiStandard` 写进去**，否则 Netlify frozen install 失败。
- `amsg-shared` / `amsg-instant` / `amsg-sw` 的 npm `next` tag 是老的低版本，别误 `@next` 升（会降级）。要 next 的只有 `amsg-client`。
