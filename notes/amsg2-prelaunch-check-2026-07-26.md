# amsg2 多任务波上线前检查报告

> 检查时间：2026-07-26。范围：`dev` 上 2026-07-18 实机验证之后的整波 amsg2 提交
> （bf23461 防穿帮闸 → 3b4af16 送达归属精确 id，共 12 个），外加全链路回归。
> 结论先行：**可以上线**。全链路本地实测 57/57 通过；查出并修掉 1 个真缺口
> （旧 worker 版本探测不出来，违背「不静默降级」设计），另修 1 个衍生误报徽标。
> 线上给定 worker 因共享密钥未提供只探到 401 边界（见「线上 worker」节）。

## 检查方法

| 项 | 做法 | 结果 |
|----|------|------|
| 静态接线核对 | 精读排程→同步→到点→送达→作废全链 14 个文件，逐字段对 metadata / client_state key / 判定窗口 | 闭合，见下节 |
| 测试基线 | `pnpm vitest run` 全量 | 101 文件 / 1153 例全绿（修复后 102 / 1166） |
| 类型检查 | `npx tsc --noEmit` 全量 | 74 个错误全部为 2026-06-28 之前的历史基线（MemoryPalace / Schedule / Bank / proactive-push 等），amsg2 波及文件 0 错误 |
| bundle 新鲜度 | `pnpm build:workers` 后 `git diff` | 零 diff——提交的 `worker/amsg/worker.bundle.js` 与 `public/amsg-worker.bundle.js` 就是当前源码产物（211.8KB） |
| 全流程实测 | 新增 `scripts/amsg2-e2e-harness.mjs`：本地跑**提交的同一份 bundle**（node:sqlite 模拟 D1 语义、真实 VAPID + RFC8291 aes128gcm 加解密、mock LLM、http 桥 + 前端同款 amsg-client） | **57/57 通过** |

## 全流程实测覆盖（S0-S7）

1. **S0 鉴权/CORS/capabilities**：无/错共享密钥全端点 401；OPTIONS 预检 204 + `*`；
   capabilities 报的 `serverVersion` 与 `package.json` 声明的 amsg-server 一致
   （当前 `2.6.0-next.7`，harness 不写死版本号，顺带能抓「升了依赖忘重打 bundle」），
   六项 features 齐全。
2. **S1 连接流程**：init-tenant 幂等建表、get-user-key 派生加密通道、vapid-public-key 与 env 一致。
3. **S2 fixed 一次性任务**：排程 → cron 到点 → push 解密验文一致；metadata 带
   `amsgClientTaskId`（送达归属键）；GET /messages 行带 charId/clientTaskId 投影；发完出清。
4. **S3 满血 v2 多任务**：fire_pack v2 到点现场渲染（验证吃的是云端模板不是冻结 prompt）、
   时间槽/任务指令槽正确填值、~256KB 大值经存储层分块读回逐字完整、RECALL 工具循环两轮、
   旁白保序、directives 只挂最后一条 push、`amsgOccurrenceMs` 随每条 push、横幅净化文本、
   daily fire 后 next_send_at +24h、cancel 后出清。
5. **S4 防穿帮闸·锚点**：一次性 expire 任务锚点后有新用户消息 → onBeforeFire `{skip}`，
   零 LLM 零 push，任务照常出清（skip 出口不进 failed/重试）。
6. **S5a 活跃租约**：chat_presence 新鲜 → 无 fire_pack 也拦（第一道快速门语义正确）。
7. **S5b 状态不全不降级**：租约过期 + 无 fire_pack → 抛 `AMSG2_FIRE_STATE_MISSING`，
   零 LLM 零 push，任务留在远端等重试（不拿排程时冻结的 prompt 顶包，用户看不出它是旧的）。
8. **S6 force**：新鲜租约 + 锚点已前进也照发，且照走满血渲染（闹钟语义）。
9. **S7 clear-client-state**：设置页「清除云端状态」删干净。

## 静态核对结论（逐环节）

- **排程**：面板与工具两条路径 payload 同构（metadata 五件套
  `amsgClientTaskId / amsgExpirePolicy / amsgRecurrence / amsgAnchorMs / amsgTaskInstruction`
  齐全）；封顶 5 个待触发；替换「先建后删」，取消失败保留旧记录标错不留幽灵任务。
- **同步**：`markAmsgStateDirty` 只对有待触发 AI 任务的角色生效；去抖 15s / 切后台立即；
  租约心跳只在本地 fetch 路径开（instant 路径提前 return，天然不重复）。
- **到点**：worker 闸顺序正确——presence 检查在 fire_pack 缺失判定**之前**（新任务
  fire_pack 没同步上时轻量心跳仍能拦）；云端状态缺任一份（fire_pack / tool_pack /
  tool_config）或任务缺 amsgTaskInstruction 一律抛错不降级；occurrenceMs 从任务行
  next_send_at 摊平透传。
- **送达**：吞没闸只拦 `source==='scheduled'` 且带策略字段的 push；缓存键
  `amsgClientTaskId:occurrenceMs` 同吞同放（5 分钟 TTL 容乱序分段）；循环任务判定
  锚定到点时刻而非送达时刻。
- **作废回执**：检出（±10 分钟对称窗）→ 台账去重（封顶 10 条、未告知优先保留）→
  注入 →发送成功才标已告知；`hasDeliveredProactiveNear` 按精确 clientTaskId 归属，
  不拿别的任务的送达抹本任务的回执。
- **面板**：远端对账失败置 null 不误伤；「关闭 2.0」以远端全量清单为准、
  投影不可用退本地清单、取消失败保留可重试。

## 查出并修掉的问题

### 1. 旧 worker（next.4 时代粘贴部署）探测不出来 → 已修

`ActiveMsgGlobalSettingsModal` 的「重新粘贴部署」探测只查四个 features，但实测对比
npm 上 `amsg-server@2.6.0-next.4` 与 `next.5` 的 `SERVER_FEATURES` **完全相同**，而这波
依赖的两个 next.5 能力（GET /messages 投影、onBeforeFire `{skip}` 出口）没有独立
flag。后果：7-18 实机验证时代的旧部署配上新前端，探测显示「最新」，但防穿帮闸在
worker 侧静默不存在（skip 不生效，靠客户端吞没兜底但通知横幅拦不住）、任务列表因
投影缺失全部误标「远端不存在」——正好违背 capabilities 探测「不静默降级」的设计初衷。

**修法**：新增 `utils/amsgWorkerVersion.ts`（semver + 数字化 prerelease 比较，13 例单测），
探测改为 features 齐全 **且** `serverVersion ≥` 门槛版本；解析不了的版本串按不达标
处理（宁亮牌不静默）。

门槛跟着依赖走，当前钉在 `2.6.0-next.7`（有单测钉住它与 `package.json` 声明一致，
省得升了依赖忘记复核）。next.4 之后加的能力上游都没发独立 flag，features 清单几乎
没动过，只能靠版本号识别：next.6 的任务占位租约（`lease_until`，带工具的 AI 任务经常
跑过一分钟，没有占位会被相邻 cron tick 重复领走、重复推送）、next.7 的 hook `writeState`
与 Web Push 大小护栏。停在旧版的部署重贴一次代码、在设置页点一次「连接」
（走 `POST /init-tenant` 自动补列）即可。

### 2. 旧 worker 下任务列表徽标误报 → 已修

`ActiveMsg2SettingsModal` 远端对账：老 worker 返回的行 charId 全为 null 时，过滤出的
空集合会让每个待触发任务都挂「⚠ 远端不存在」。改为「有行但全无 charId → 视为投影
不可用 → 整体置 null 关掉徽标」，与「关闭 2.0」路径的本地回退同一口径。

### 3. 顺手：文档过期

`notes/amsg2-reenable-guide.md` 停在 2026-07-17（多任务波之前），已刷新：多任务/防穿
帮闸摘要、新增五个模块的接入点表、amsg-server next.7 依赖说明、体检脚本入口。

## 线上 worker（https://sullyos-amsg.yukine0v0.workers.dev/）

所有端点强制校验共享密钥（`X-Client-Token`），未提供密钥只能验证到：401 边界行为
正确、报错格式与 amsg-server 一致（`INVALID_CLIENT_TOKEN`）。**上线前请自查两项**
（任一方式）：
1. 前端设置页连上后看「重新粘贴部署」牌子——修复后的探测会同时查 features 与
   `serverVersion ≥ 2.6.0-next.7`；不亮即为最新 bundle；
2. 或带密钥手查：`curl -H "X-Client-Token: <共享密钥>" <workerUrl>/capabilities`，
   确认 `serverVersion` 为 `2.6.0-next.7`（本仓当前 bundle 内嵌版本）。
若是 7-18 之前粘贴的部署，需要用设置页「复制 Worker 代码」重新粘贴一次
（部署顺序：worker 先于前端发布，顺序反了不炸、只是满血闸等 worker 跟上才生效）。

## 已知设计假设（不是缺陷，上线不阻塞）

- **amsg2 与 instant push 互斥**（代码注释既定假设）：两者同时配置时聊天走 instant
  路径，amsg2 的对话内工具、排程现状块注入、活跃租约心跳不生效；面板排程、到点
  触发、送达兜底不受影响。当前 UI 未强制二选一，靠用户自觉。
- **通知横幅无法追回**：吞没闸拦的是聊天流与副作用，OS 已弹的横幅页面线程无权收回；
  防横幅主力是 worker 预检 + 租约（本次实测均生效）。
- tsc 全量 74 个历史错误与本波无关（基线早于 amsg2，多在 MemoryPalace / Schedule 等），
  `pnpm build` 不跑 tsc 不受影响；建议另开清理任务。
