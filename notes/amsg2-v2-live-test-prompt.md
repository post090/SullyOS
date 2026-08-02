# 交接任务：amsg2 满血 v2 实机验证

> 给接手的 agent：这是一份端到端实机测试任务，不是写单测。代码都在 `dev` 分支上，
> 细节自己翻 `notes/amsg2-reenable-guide.md`（速查档）和 `notes/amsg-fullbg-state-design.md`（设计）。

## 背景一句话

主动消息 2.0（amsg2）的「满血 v2 服务端工具循环」已上线：到点由用户自部署的
Cloudflare Worker 现场生成消息，LLM 输出里的数据标签（查记忆/搜索/日记/小红书）
worker 就地执行后继续写，副作用标签（戳一戳/日程等）结构化成 directives 随最后
一条 push 下发、客户端收到时重放。目前只实测过「联网搜索」这一条，其余链路要补验证。

## 环境搭建（自己起一套）

1. **前端**：`dev` 分支 `pnpm install` + `pnpm build`，部署到 Netlify（或任何静态托管，
   要 HTTPS 才有 Service Worker / 推送）。
2. **Worker**：设置 → 主动消息 2.0 全局设置 → 「部署 Worker」折叠引导照做
   （复制 `public/amsg-worker.bundle.js` 到 CF 空 Worker、D1 binding `DB`、
   cron `* * * * *`、env 按引导清单填）。**VAPID 必须用前端「推送凭据 (VAPID)」
   面板那一对**，否则推送 403。
3. 前端填 Worker 地址 + 共享密钥 → 连接 → 开启推送。
4. **造测试数据**：建一个角色，往角色档案的月度总结（`char.memories`）里塞 1–2 条
   编造的记忆；如要测搜索/Notion/飞书，在实时信息设置里配对应凭据。
5. **跟角色聊一轮**——工具数据（tool_pack / tool_config）是聊完才同步上云的
   （去抖 15s，切后台立即）。之后在聊天加号面板「主动消息 2.0」排任务。

## 要补的测试（按价值排序）

观测手段统一是：收到的推送/聊天内容 + CF Dashboard worker 日志里的
`[amsg:agentic]`（能看到 `tool_request` → `tool_done`/`tool_failed` → `finish`）。

| # | 测什么 | 方法 | 通过判定 |
|---|--------|------|---------|
| 1 | 查记忆（RECALL，tool_pack 数据路） | 提示词任务：「回忆上个月我们做了什么再来找我聊」 | 消息内容引用了塞进去的月度总结；日志有 recall 的 tool_done |
| 2 | 副作用 directives 重放 | 提示词任务：「到点戳我一下，再帮我记个日程」 | 打开 app 后聊天里出现戳一戳/日程的系统消息；重放只发生一次 |
| 3 | 标签分段回归（刚修过） | 让角色到点发表情包或卡片类 `[[标签]]` 内容 | 标签整块渲染成表情/卡片，横幅显示净化文本，不出现孤立的 `]]` |
| 4 | 多轮组合 + 旁白累积 | 提示词任务同时要求「先回忆再搜索」 | 日志出现 ≥2 轮 tool_request；中间轮的旁白文字排在最终正文前面、没丢 |
| 5 | 工具优雅降级 | xhsMcpConfig 指向一个不可达地址，提示词任务让角色逛小红书 | 日志 tool_failed，但角色自己圆场、消息照常送达（链不断） |
| 6 | 无工具数据兜底 | 新角色不聊天直接排程（或先在全局设置里清除云端状态） | fire 不报错，消息照发（LLM 拿到 no_tool_state 自己圆场） |
| 7 | Notion / 飞书日记（有凭据才测） | 配好凭据后让角色到点读某天日记 | 消息内容反映日记内容 |

## 注意

- Worker 代码有更新时：`pnpm build:workers` 重打 bundle → 先重新部署 worker、再发前端。
- 发现 bug 修复时请配回归测试（现有决策逻辑测试在 `worker/amsg/src/agentic.test.ts`，
  数据形状测试在 `utils/amsgFirePack.test.ts` / `utils/amsgToolPack.test.ts`）。
- 测试结果按上表逐条记录通过/失败与日志摘要即可。
