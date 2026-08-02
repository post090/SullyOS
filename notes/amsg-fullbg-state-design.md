# 满血后台消息：云端状态表 + 服务端工具链设计

> 什么时候读：做「满血后台消息」（角色到点自动发消息，上下文新鲜、可带工具、全程云端闭环）相关工作前。
> 这份讲 SullyOS 侧的整体设计与分工；上游 amsg-server 要改什么见
> [`amsg-server-fullbg-hooks-prompt.md`](./amsg-server-fullbg-hooks-prompt.md)。
> 更新时间：2026-07-17。

## 一句话目标

主动消息从「排程时冻结一段 prompt，到点一次 LLM」升级成「到点由 worker 现场组装新鲜上下文、
（可选）跑完整工具循环、推送成品」——**中途永远不需要客户端在线**，不会跑一半弹个通知叫用户
回前台取数据。

背景：Instant Push 受平台限制（iOS 杀后台、SSE 寿命等）实际效果有限，转入有限支持；
后台体验的主力改走本方案（amsg2 单用户 worker + D1 那套底座，见
[`amsg2-reenable-guide.md`](./amsg2-reenable-guide.md)）。

## 核心判定原则

**worker 在 fire 时刻要读的数据才需要上云；客户端收到 push 之后才用的，一概留在本地。**

后处理链路（表情包名字→URL 反查、卡片渲染、directive 重放、拟人分泡）全部发生在客户端收到
push 之后（`activeMsgRuntime` / `applyAssistantPostProcessing`），云端只负责产出「带业务标签的
文本 + directive metadata」。表情包表、歌单、卡片逻辑都不上云。

## 工具怎么保证「整条链在云上跑得完」

LLM 每轮要调什么工具是运行时才知道的，所以完备性不能靠猜，靠两件事：

1. **数据源提前就位**（下面的状态表）；
2. **后台模式暴露给 LLM 的工具清单由 worker 注入**——清单里只放云端可满足的工具，
   完备性是构造出来的。没开远端向量库的用户，清单里就没有 recall，而不是跑一半断掉。

按依赖类型把工具切三类，真正要上云的东西立刻收敛：

| 类型 | 例子 | 云端需要什么 | 说明 |
|------|------|------------|------|
| 副作用类 | 表情、poke、转账、日程卡、音乐、XHS 点赞/评论 | **无** | worker 只识别标签 → 塞进 push 的 directive metadata → 客户端收到时重放。LLM 写完标签就继续生成，不等执行结果，链不会断。instant classifier 已是这个模式，直接复用 |
| 外部服务类 | XHS MCP、web_search、Notion/飞书 | 凭据 + 配置（几行 KV） | 数据在外部服务上，worker 直调。XHS 走现成的 `utils/xhsMcpClient.ts`（零依赖叶子，MCP / Bridge 双模式，worker 原样打包）；搜索 / Notion / 飞书经用户的代理 worker 转发（`utils/realtimeFetchCore.ts`）。**硬限制：只有公网可达（或走用户自部署代理）的服务可用**，本地起的 XHS 服务后台够不着——够不着时工具以失败结果回给 LLM 圆场，链不断 |
| 本地数据读取类 | recall 记忆（`char.memories` 月度总结） | 数据进状态表（`tool_pack`） | 真正的同步对象。月度总结是几 KB 文本，直接随 tool_pack 上云，worker 本地过滤月份即可，不需要向量检索 |

## client_state 通用状态表

一份活状态、单写者、按 namespace 组织。不按任务存多份快照——主动消息语义上就该基于
「用户离开时的状态」，快照的"陈旧"是正确语义不是妥协。

```
client_state (user_id, namespace, key, value, updated_at)
PRIMARY KEY (user_id, namespace, key)
```

**v1 实际布局（已落地）**：每角色一个 namespace、单条 `fire_pack`——前端把完整 prompt
拼好、时间性内容（当前时间/离开时长）留 `{{AMSG_*}}` 槽位，worker fire 时只做填槽，
连拼装顺序都不用知道（`chatPrompts` 不进 worker 的红线执行到极限形态）：

| namespace | key | 内容 | 写入时机 |
|-----------|-----|------|---------|
| `amsg:char:<id>` | `fire_pack` | `{ v, template(带时间槽位的完整 prompt), lastUserMessageAt, tzOffsetMin, targetName }` | 每轮聊完（去抖 15s）/ 切后台立即 / 排程成功后 |

代码位置：模板+渲染 `utils/amsgFirePack.ts`（前端兜底与 worker 共用同一份，时间文案单份维护）、
脏标记+批量上传 `utils/amsgStateSync.ts`（挂 useChatAI 轮末 finally）、worker 填槽
`worker/amsg/src/index.ts` 的 onBeforeFire。

**v2 工具循环分段（已落地）**：

| namespace | key | 内容 | 写入时机 |
|-----------|-----|------|---------|
| `amsg:char:<id>` | `tool_pack` | recall 用的月度总结（`char.memories`）+ `activeMemoryMonths` + XHS 角色开关 + 角色名 | 与 fire_pack 同批 |
| `amsg:global` | `tool_config` | 搜索 / Notion / 飞书凭据 + XHS MCP 配置 + 代理 worker 地址（realtimeConfig 的工具子集） | 与 fire_pack 同批（快照没带 realtimeConfig 时跳过，不覆盖云端已有凭据） |

数据形状与 parse 都在 `utils/amsgToolPack.ts`（前端 / worker 共用叶子）。设计早期
设想过的独立分段最终没有出现：recall 实际读 `char.memories` 月度总结（几 KB 文本），
不需要 embedding / 向量库凭据；情绪快照与用户画像已随 fire_pack 模板整体带上
（模板 = 完整 chat system prompt），不需要单独条目。

要点：

- **写侧**：脏标记 + 去抖，在「一轮聊完」和 `visibilitychange→hidden` 时把变过的 namespace
  **批量一次** upsert。iOS 切后台的存活窗口只有几秒，禁止逐键逐条实时写。
- **读侧**：worker fire 时按需 SELECT，拼 prompt 和工具取数走同一张表。
- **单写者**：客户端写状态，worker 只写自己的 outbound log（已有），天然无冲突。
  多设备场景 v1 用 `updated_at` 最后写赢，不做精细合并。
- **拼 prompt 的分工**：客户端继续负责「拼」（分段上传），worker 只做「组装 + 补时间性内容」
  （当前时间、用户离开多久、worker 自己发过什么）。`chatPrompts.ts` 上千行且常改，
  **不要**移植到 worker 端双份维护。
- **加密**：value 用 amsg-server 现有的 per-user storage 加密落库（同 completePrompt 的待遇）。
- **体量**：单条 value 控制在百 KB 量级；全量向量这类大块头不进这张表（在 Supabase）。

## fire 时的完整链路

```
cron 到点
  → 读 client_state（persona / recent_window / emotion / profile）
  → 组装 prompt（+ 当前时间、离开时长、outbound 历史）
  → LLM 轮 1 → classifier 分类输出
      ├─ 纯文本/副作用标签 → finish：切 push + directive metadata
      └─ 数据标签（recall / MCP_CALL / SEARCH…）→ worker 直调工具 → 结果回填 → LLM 轮 2 …
  → （轮数达上限强制 finish）
  → web push 推出 → SW 落 inbox → 客户端打开时后处理照旧
```

多轮循环的时长大头是等 LLM 的 IO（CF scheduled 里不吃 CPU 配额），但轮数与总时长必须有
兜底：**默认 5 轮 + 240s**，工厂级可配、单次 fire 可覆盖（`onBeforeFire` 返回值携带）——
有些工具（长搜索、外部慢 API）确实更耗时，应用层按任务自行判断放宽。

## 分期

| 期 | 内容 | 备注 |
|----|------|------|
| v1 | 状态表 + 同步层 + fire 时新鲜组装（无工具） | 满血的主要价值（新鲜上下文/情绪/多气泡）在这一期就兑现 |
| v2 | 服务端工具循环：副作用 directive + 九个数据工具就地执行 | **已落地**。classifier 原样复用 instant 那份（`worker/instant-push/src/classifier.ts`）；决策纯逻辑在 `worker/amsg/src/agentic.ts`（旁白 / 副作用跨轮累积，finish 一起出），工具执行走共享的 `utils/agenticTools.ts` dispatch（搜索 / Notion / 飞书的 fetch 核心抽在 `utils/realtimeFetchCore.ts` 叶子里，前端 Manager 委托同一份）。副作用 directives 挂最后一条 push 的 metadata，收侧与 instant 共用重放 |

## 依赖与坑

- **上游 amsg-server 要加东西**（client_state 端点、fire hook、服务端 agentic 循环），
  见交接 prompt。发版链：改库 → next tag → SullyOS 升 devDep → 重打 bundle → 用户重新粘贴部署。
  **worker 先行、前端后上**，前端用版本探测守门。
- 状态表里有真·隐私数据（聊天窗口、人设）。虽然是用户自己的 worker + D1（和 API key 同
  信任级），但设置里要有「清除云端状态」入口；导出/备份后续考虑。
- recall 只对开了 Supabase 远端向量的用户可用，纯本地向量用户的后台工具清单里不出现 recall。
- 群聊暂不在范围内（群聊当前也不走 instant/amsg 生成）。
