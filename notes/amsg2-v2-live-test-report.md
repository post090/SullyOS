# amsg2 满血 v2 实机验证报告

> 对应交接单：[`amsg2-v2-live-test-prompt.md`](./amsg2-v2-live-test-prompt.md)。
> 测试时间：2026-07-18。环境：dev 前端部署 Netlify + 自部署 CF Worker（D1 + cron `* * * * *`）+ 真机推送实测。
> 结论先行：**7 个场景全部通过**，过程中揪出并修掉 3 个真 bug（都带回归测试），另有 2 条实测经验记录在案。

## 结论总表（交接单 7 场景）

| # | 测什么 | 结果 | 备注 |
|---|--------|------|------|
| 1 | 查记忆（RECALL，tool_pack 数据路） | ✅ | 消息引用了塞入的月度总结；日志 `tool_request → tool_done(recall) → finish` |
| 2 | 副作用 directives 重放 | ✅ | 戳一戳/日程/写日记系统消息正常出现，重放一次 |
| 3 | 标签分段回归 | ✅ | 标签整块渲染，横幅净化文本，无孤立 `]]` |
| 4 | 多轮组合 + 旁白累积 | ✅ | 多轮 `tool_request`，旁白排正文前不丢（含跨轮标签块拼回，见 bug 3） |
| 5 | 工具优雅降级 | ✅ | `tool_failed` 后角色圆场，链不断 |
| 6 | 无工具数据兜底 | ✅ | fire_pack 读不到时退冻结提示词照发（413 时期反复验证过这条兜底） |
| 7 | Notion / 飞书日记 | ✅ | 日记真实写入（修完 bug 3 之后） |

---

## 实测揪出的 3 个 bug 与修法

### Bug 1：XHS 笔记卡片必掉——round 1 笔记只活在 worker 内存

**现象**：角色到点逛小红书、日志 `tool_request(xhs_search) → tool_done → finish` 一路正常，
但客户端重放 `[[XHS_SHARE: n]]` 时控制台刷
`📕 [XHS] XHS_SHARE 序号越界, 跳过卡片 {idx: …, available: 0}`，卡片静默消失。

**根因**：XHS 分享是两轮协议——round 1 工具抓笔记存进缓冲，round 2 `[[XHS_SHARE: 序号]]`
按序号取卡。instant push 路径的 round 1 在**客户端**跑（instantToolRunner 会
`saveXhsSessionNotes` 落 IndexedDB）；amsg2 满血 v2 的 round 1 在 **worker** 里跑，
笔记只活在 worker 单次 fire 的内存里，从没送到客户端——重放时缓冲永远是空的。
结构性缺口，不是偶发。

**修法**（`worker/amsg/src/agentic.ts` + `index.ts`、`utils/activeMsgRuntime.ts`、
`utils/applyAssistantPostProcessing.ts`）：
- worker finish 时扫 directives，把被 `xhs_share` 引用的笔记（+点赞/评论要用的
  xsecToken）组成 `metadata.xhsSession` 挂**最后一条 push**（与 directives 同车）；
- 只带引用到的最多 4 张、desc 截 120 字——web push 单条 payload ~4KB，全量 8 张
  会把整条 push 撑爆，掉卡片就升级成掉消息；LLM 编造的越界序号 worker 侧直接跳过；
- 客户端收到 `xhsSession` 先按序号重建稀疏数组落库，再走与 instant 共用的既有恢复路；
  `XHS_SHARE` 重放循环补稀疏空洞（null）守卫。

**回归测试**：`agentic.test.ts` 新增 8 例（引用挑选、越界跳过、desc 截断不改原数组、
token 按 noteId 过滤、无 XHS 引用不多挂键、上限 4 张、挂最后一条 push、形状回归）。

### Bug 2：上下文一长 `PUT /client-state` 413——一个胖角色拖垮整批同步

**现象**：角色卡大/世界书长/聊天多的角色，聊完一轮同步即
`413 (Payload Too Large)`。体验上角色到点照样回复（冻结提示词兜底），但满血链路
对这个角色**永远够不着**：上下文冻结在排程那刻、服务端工具循环全废；且
putClientState 是整批请求、服务端校验 all-or-nothing——同批**其他角色**也一起没同步上。

**根因**：amsg-server 对单条 client_state value 有 200KB 硬上限
（`MAX_STATE_VALUE_BYTES`），fire_pack = 完整系统提示词（角色卡+世界书）+ 最近
30 行对话，重角色轻松超限。上传口子有两个（聊完去抖冲刷 + 排任务即时同步），
都会触发。

**修法**（新增 `utils/amsgStateChunks.ts`，改 `utils/activeMsgClient.ts`、
`worker/amsg/src/index.ts`）——**分块上传，内容零损失**（明确不裁用户内容）：
- 值 ≤196KB → 单条原样直传（与历史行为字节级一致）；
- 超限 → 切成 `<key>.0` / `<key>.1` … 子条目（每块 6 万 UTF-16 units，全中文
  最坏 180KB，必在限内；切点避开 emoji 代理对），根条目写一份小 meta
  `{__chunked:1, chunks:N}`；
- worker 到点读 fire_pack / tool_pack / tool_config 时先按 meta 拼回原文再 parse；
  缺块（同步被打断）→ null → 照旧退冻结提示词；
- 兼容性：老 worker 读到 meta 根条目时 `parseFirePack`/`parseToolPack` 形状校验
  不过 → null → 走既有兜底，链不断（有测试钉住）。

**回归测试**：新增 `utils/amsgStateChunks.test.ts` 8 例（小值直传、1.2MB 中文包
逐块限内且拼回逐字一致、emoji 不劈半、缺块退兜底、老形态透传、meta 喂
parseFirePack 得 null、entries 键名/同批同 updatedAt）。

### Bug 3：写日记写一半去查记忆——长形态标签块被数据标签劈成两轮

**现象**：推送横幅直接出现裸标签 `[[DIARY_START: 专属点读机 | 傲娇]]` 和
`[[DIARY_END]]`（各占一条 push），日记没写进 Notion，打开 App 聊天里也什么都没有。

**根因**：LLM 输出
`[[DIARY_START: …]]\n内容…[[RECALL: …]]（工具轮）…内容\n[[DIARY_END]]`——
数据标签把文本劈成两轮。老逻辑**逐轮**扫副作用标签，而日记长形态正则要求
START/END 同轮配对：两半各自配不上 → directive 没生成（日记丢）、裸标签当正文
漏进 push（横幅难看）、客户端收到孤立标签又被净化剥掉（聊天空白）。三个症状同根。

**修法**（`worker/amsg/src/agentic.ts`）：中间轮旁白改存**原始文本**（不逐轮剥
副作用标签），finish 时把「全部旁白 + 最终正文」拼回一份全文统一 classify——
被劈开的标签块自然合体，一次扫出全部 directives。飞书长形态同款免疫。

**回归测试**：`agentic.test.ts` 新增 2 例（Notion 日记劈两轮拼回后
title/mood/跨轮内容齐全、正文无裸标签；飞书同款），并更新旁白语义相关断言。

---

## 实测经验（不是 bug，但会让人白排查半天）

1. **「需要二次调用的工具一个都不动」大概率是没配凭据，不是链路坏了。**
   Notion/飞书/搜索/小红书的标签指令是按「实时信息设置里开关+凭据齐全」**逐个门控**
   注入系统提示的（`chatPrompts.ts`）；没配 → 提示词里压根没有那个标签的说明 →
   LLM 不知道自己会 → 日志只有一条 `finish`、零 `tool_request`。
   **配完必须再跟角色聊一轮**（工具指令是聊天时烤进 fire_pack、凭据打进 tool_config
   同批上云的），然后再排任务。RECALL 是无条件开放的，适合先拿它验证工具循环
   端到端通不通，再逐个加凭据类工具。
2. **部署顺序**：worker 代码更新（`pnpm build:workers` → CF 粘贴）要**先于**前端
   发布。顺序反了不炸——老 worker 读到新格式自动落兜底——但满血链路要等 worker
   跟上才生效。

## 改动清单

| 文件 | 改动 |
|------|------|
| `worker/amsg/src/agentic.ts` | finish 全文统一 classify（bug 3）+ `buildXhsSessionPayload`（bug 1） |
| `worker/amsg/src/index.ts` | XHS 快照传入决策逻辑（bug 1）+ 三份 client_state 拼块读回（bug 2） |
| `utils/amsgStateChunks.ts` | 新增：client_state 大值分块/拼回纯逻辑（bug 2） |
| `utils/activeMsgClient.ts` | 两个上传口子改走分块 entries（bug 2） |
| `utils/activeMsgRuntime.ts` | push 携带的 xhsSession 落库复用 instant 恢复路（bug 1） |
| `utils/applyAssistantPostProcessing.ts` | XHS_SHARE 稀疏数组空洞守卫（bug 1） |
| `worker/amsg/src/agentic.test.ts` | +10 例回归 |
| `utils/amsgStateChunks.test.ts` | 新增 8 例回归 |
| bundles | `worker/amsg/worker.bundle.js` + `public/amsg-worker.bundle.js` 已重打 |

测试基线：`pnpm vitest run` 相关套件全绿（agentic 19 + stateChunks 8 + firePack 15 +
toolPack 6 + sanitize 66 + pushDecision 28）；`tsc --noEmit` 触及文件零新增错误。
