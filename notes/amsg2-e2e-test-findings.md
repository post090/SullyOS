# amsg2 自部署全流程实测 · 问题清单

时间：2026-07-26 00:20 – 01:45
环境：全新 D1 + 全新 Worker（Git 导入方式）+ 全新 VAPID，前端 `feat/amsg2-multitask-gate@3b4af16`，sw 1.15.1

跑通的部分见 [`docs/amsg2-setup-walkthrough.md`](../docs/amsg2-setup-walkthrough.md)。下面只列问题。

---

## 一、会真的卡住用户的

### 1. 「共享密钥 · 随机」生成的值拿不到（已修）

`components/settings/ActiveMsgGlobalSettingsModal.tsx` 的 `handleGenerateServerToken`：
生成后只写进一个 `type="password"` 的输入框，既没复制到剪贴板，也没有显示/复制按钮。
Toast 却写着「记得把同样的值填进 Worker 环境变量 AMSG_SERVER_TOKEN」——用户根本读不到那个值，
这一步走不下去（旁边的 `AMSG_MASTER_KEY` 是「生成并复制」+ 明文回显，两者不一致）。

已按 master key 的写法改成：生成 → 写剪贴板 → 下方明文回显（剪贴板失败也能手抄）。

### 2. App 内「部署 Worker」指引还是旧的粘贴流程（已修）

同一个 Modal 里的「部署 Worker（第一次用先做这个）」写的是：

> 点下面「复制 Worker 代码」，去 CF 后台 Create → Worker 建一个空 Worker，进 Edit code 全选粘贴覆盖…
> Settings → Bindings 加一个 D1 database，变量名必须是 DB…
> Settings → Trigger Events 加 Cron Trigger：`* * * * *`…

而现在推的是 fork `sullyos-workers` + Cloudflare 连 Git 的流程，D1 binding 和 cron 都由仓库里的
`wrangler.toml` 自动带上，用户按 App 里的指引反而会多做两步、还可能建出配置不一致的 Worker。
两处说法要统一。

已把这一节改成 fork 流程（含 Fork 仓库 / 图文教程 / CF 面板三个跳转），粘贴那套连同
「复制 Worker 代码」按钮降级成折叠区「没有 GitHub 账号？手动粘贴部署」。「Worker 版本过旧」
的提示也改成先说 Sync fork。

---

## 二、会让人误判「失败了」的显示问题

### 3. 新建/编辑任务后，列表立刻误标「⚠ 远端不存在（可能已发送或在别处取消）」（已修）

复现：任意角色 → ＋ → 主动消息 2.0 → 新建任务 → 提交成功后，新任务卡片下方立刻出现橙色告警。
关掉面板重开就消失。原因是列表拿「创建之前抓的远端快照」去比对刚创建的本地任务。
每次新建都会出现，第一次用的人会以为排程失败。

修法：那份快照现在当底账维护——排程接口回 success 就是「这条在远端存在」的确证，
直接记进去（`applyRemoteTaskDelta`），取消成功则出账，不用重新拉全量。判定挪进
`isRemoteMissingTask`，回归测试在 `utils/amsg2Tasks.test.ts`。

### 4. 取消一个已经触发过的一次性任务 → 「远端取消失败，可重试」（已修）

一次性任务发出去以后远端行会被删掉，此时点「取消」，`DELETE /cancel-message` 找不到目标，
前端直接标成红色的失败并提示重试，但其实没有任何东西需要重试。
应该把「远端已不存在」当成取消成功（或者对已到点的一次性任务干脆不显示「取消」）。

修法：`ActiveMsgClient.cancelTask` 改成幂等——404 `TASK_NOT_FOUND` 算取消成功并回
`alreadyGone: true`，面板据此说「在远端已不存在（多半已经发过了），已从列表移除」；
其余错误照抛。回归测试在 `utils/activeMsgClient.test.ts`。角色工具侧的 cancel 一并受益。

### 5. 每天/每周任务触发后，列表仍显示原始时间 + 「待触发」（已修）

`[8130e324] 2026/7/26 01:12:00 · 每天 … 待触发`，实际远端 `next_send_at` 已顺延到 07-27。
显示的是创建时的锚点而不是下一次触发时间，看起来像「过点了还没触发」。

修法：时间统一走 `currentOccurrenceMs`（本来只有 debug 面板在用，已挪到 `amsg2Tasks`），
按周期推到当前这一次。显示任务时间的三处——设置面板、`list_active_messages` 的返回、
注入角色的排程现状块——全部改用它，口径保持一致。

顺带把「已到点」拆细了：一次性任务过点后，远端那行还在 = `已到点·待处理`（cron 还没消费），
远端已经没有 = `已触发`（发出去了或被闸作废了），底账没拉到才回到中性的「已到点」。
实测时那两条卡着的任务 debug 面板写「已过点未发」、远端却是 404，就是这一档缺失导致的误读。

---

## 三、噪音 / 小事

### 6. 每次排程都有一条 worker warn（已修）

```
[amsg-server] avatarUrl 不合法，已置空： avatarUrl 不是合法 URL
```

角色头像是本地 base64，不是 URL。功能没受影响，但每条 `schedule-message` 都会刷一条 warn。

修法：客户端用 `toRemoteAvatarUrl` 按 worker 同一把尺（非 `data:`、≤2048 字符、http(s) URL）先筛，
不合格就不带这个字段。它只用于推送通知图标，传了本来也是被置空，行为不变。

### 7. 「编辑」是取消+重建，任务 id 会变（已改文案，不改机制）

worker 日志里是 `POST /schedule-message` 紧跟 `DELETE /cancel-message`。列表里的短 id 会换一个。
功能正常，只是如果有人按 id 追踪任务会困惑。

worker 确实有 `PUT /update-message`，但它能改的字段不含 `messageType` 和 `apiUrl/apiKey/primaryModel`
——「固定 ↔ 自动」这类改模式的编辑还是得重建。为一半的场景引入第二条编辑路径，换来的只是
编号不变，不划算。改成把编号变更说清楚：

- 面板：`任务已更新，编号换成 [xxxxxxxx]。`
- 角色工具：`原任务 [旧] 已换成 [新]（改期是重建，编号会变）。`
  替换时远端取消失败的话也会明说「原任务可能仍会触发，请再取消一次」——这条以前完全没告诉角色。

---

## 四、`docs/self-deploy-workers.md`（= 部署仓库 README）与实际 UI 对不上（已修）

Cloudflare 面板改版后这些名字都变了，照文档找不到：

| 文档里写的 | 实际 |
|---|---|
| Storage & Databases → **D1** | Storage & databases → **D1 SQLite Database** |
| Workers & Pages → **Create** | Workers & Pages → **Create application** |
| 选 **Import a repository** | 选 **Continue with GitHub** |
| **Root directory** 填 `amsg` | Advanced settings 里的 **Path** 填 `/amsg` |
| 「部署设置里找到环境变量 / Secrets」 | 分两处：构建变量在创建向导的 Advanced settings（Variable name / value，别点 Encrypt）；Secrets 要等部署完再去 Settings → **Variables and secrets** |

另外两条：

- FAQ 说「在浏览器直接打开 `/capabilities`，能返回一段 JSON 说明 Worker 活着」——配了
  `AMSG_SERVER_TOKEN` 的话浏览器直接打开会得到 401 `INVALID_CLIENT_TOKEN`。这同样说明 Worker 活着，
  但文档没写，按字面理解会以为部署失败。
- 部署进度页不会自动刷新，会一直停在 Initializing（实测构建 28 秒就完成了，页面卡了 5 分钟）。
  需要提醒用户手动刷新。

已按上表改完，另外补了 Build / Deploy command、Advanced settings 里的 API token、
Secrets 要等部署完再填这几处，开头加了指向 `docs/amsg2-setup-walkthrough.md` 的链接。

---

## 五、跑通了的（回归基线）

- Git 导入部署：`deploy-prepare.sh` 正确把 Database ID 填进 `wrangler.toml`；`env.DB` 绑定、
  `crons = ["* * * * *"]` 都由仓库配置自动带上，不需要手动加
- `/capabilities` → `serverVersion 2.6.0-next.5`，features 含 client-state / chunking /
  partial-failure / agentic-hooks / agentic-scratch / vapid-public-key
- 「连接并启用」幂等建表（`client_state` / `scheduled_messages`）
- 三种消息来源：固定 / 自动 / 提示词，全部到点送达；AI 生成的两种都按角色人设走，多段气泡 + 表情正常渲染
- 三种重复：一次（发完删行）/ 每天（`next_send_at` +1 天）/ 每周（+1 周锚点）
- 编辑、取消（远端行确实被删掉）
- 防穿帮闸：`强制发送` 照发；`自动作废` 在「创建后又聊了天」的情况下正确作废，
  worker 日志出现 `[amsg:expire-skip]`，客户端没收到消息
- 服务端工具循环入口有走到（日志出现 `[amsg:agentic]`）

> 备注：`固定` 类型不显示「到点时用户正在聊天」策略选项（固定内容恒等于强制发送），这是设计如此，不是 bug。
