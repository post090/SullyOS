# TODO 待办

`/simplify` 扫 amsg2 分支时发现、但当时没做的事。按「值不值得现在做」排。

---

## 见面（DateApp）· 历史加载

三条都是同一个东西引起的：见面消息按 `metadata.source === 'date'` 过滤，但没有对应的索引。

### 1. `getRecentMessagesByCharIdAndSource` 每次扫全量历史

`utils/db.ts:624`。游标走的是 `charId` 索引，不是 `[charId, source]` 复合索引，所以它得把这个角色的**每一条**消息都反序列化出来（含 base64 图片消息），一条条看 `metadata.source` 对不对，直到凑够 limit 条。见面记录稀疏的角色，等于每次都把整部聊天史读一遍。

做法：加复合索引 `['charId', 'metadata.source']`（`db.ts:234` 的 `charId_type` 就是现成的先例），游标只访问见面那些行。

### 2.「加载更多」每点一次都从头重读

`apps/DateApp.tsx:129-132`。`handleLoadMoreDateHistory` 是 `limit += 220` 再查一遍，所以第 k 次点击会把前面 k-1 次已经读过的全部重读一遍，累计约 O(k²·220) 次行反序列化。

做法：改成游标续读（`IDBKeyRange.upperBound(已加载的最旧 id)`），每次只取下一批。

### 3. 加载 effect 挂在整个 `char` 对象上，翻页深度会被悄悄重置

`apps/DateApp.tsx:117-125`。`char = characters.find(...)`，characters 数组一更新（回复后 `updateCharacter`、记忆宫殿回写、情感评估……）`char` 就是个新引用，effect 重跑 → `setDateLoadLimit(220)` + 全量重扫。用户翻到 660 条的位置会被拽回 220，还白付一次重读。

做法：依赖改成 `char?.id`（和 `mode`），别用整个对象。

---

## amsg2 · 跨进程契约还没类型化

任务 metadata 的 6 个键（`amsgExpirePolicy` / `amsgRecurrence` / `amsgAnchorMs` / `amsgClientTaskId` / `amsgOccurrenceMs` / `amsgTaskInstruction`）在三个地方各写一遍：

- 生产：`utils/activeMsgClient.ts` 的 `payload.metadata` 字面量（类型是 `Record<string, any>`）
- 消费：`worker/amsg/src/index.ts` 的 `onBeforeFire`
- 消费：`utils/activeMsgRuntime.ts` 的送达兜底闸

生产方少写一个键、拼错一个字母，编译器不会吭声，要到点了才在 worker 里拿到 `undefined`。

做法：起一个叶子 `utils/amsgTaskMetadata.ts`（跟 `amsgFirePack` / `amsgChatPresence` 同一族），导出 `AmsgTaskMetadata` 接口 + `buildAmsgTaskMetadata()` + `parseAmsgTaskMetadata()`。加字段就变成生产方的编译错误。

---

## amsg2 · 效率（都还没量过，按怀疑度排）

### 4. 每轮聊完的 fire_pack 刷新，把这一轮刚做过的活重做一遍

`utils/activeMsgClient.ts` 的 `syncCharFirePacks` → `buildFirePack`，每个角色都要：读 200 条历史、`DB.getEmojis()`（把整个表情库全捞出来）、`DB.getEmojiCategories()`、再跑一遍 `ChatPrompts.buildSystemPrompt`（内部还会发实时感知的网络请求）。而这份系统提示词，聊天那一轮 15 秒前刚用内存里的数据拼过一次。

而且这事会在切后台（`visibilitychange → hidden`）时立刻触发 —— 正是 iOS 只给几秒存活窗口的那个时刻。多角色还是 `for await` 串行的。

三档做法，由浅到深：
- 把 `getEmojis` / `getEmojiCategories` 提到循环外（它俩是全局的，不按角色变）
- 各角色的 `buildFirePack` 并成 `Promise.all`（互相独立，只有最后那次 PUT 需要合成一次）
- 让聊天那轮把已经拼好的系统提示词经 `AmsgSyncSnapshot` 带过来，冲刷时只重新填模板

### 5. 每次 amsg2 调用都重建 `ReiClient`（多一次 `/get-user-key` 往返）

`initializeClient` 不缓存。聊天期间的 presence 心跳每 15 秒一次，每次都要 2 次 IDB 读 + 2 次网络往返，就为写 ~80 字节。一次 60 秒的生成 = 5 轮。

做法：按 `userId + workerUrl` 记住已初始化的 client，`saveGlobalConfig` 时失效。

### 6. `collectAmsg2TaskContext` 在发送关键路径上重读 200 条历史

`hooks/useChatAI.ts:990`。同一轮里 `useChatAI` 已经读过 `contextLimit` 条了，这里又独立读 200 条（同一个 store、同一个角色、严格子集），而且是在 LLM 请求**之前** await 的，等于给每条消息都加了一段延迟。

做法：把已有的 `contextMsgs` 传进去（它只读 `role` / `timestamp` / `metadata`）。

### 7. `isAmsg2GlobalReady()` 挡在每一次发送前

`hooks/useChatAI.ts:918`。没配过 amsg2 的角色 `isAmsg2EnabledForChar` 默认返回 true，所以 `&&` 右边一定会跑：开 ActiveMsg 库 + 一次 KV 读，inline await。所有用户、每条消息、永远。

做法：`ActiveMsgStore` 里模块级缓存全局配置（只有设置面板会改它），或者每次 hook mount 解析一次存 ref。

### 8. `tool_pack` 每次冲刷都全量重传

`char.memories` 的全部月度总结每次都重新序列化上传，但它大概一个月才变一次。

做法：按角色记住序列化后的 hash，没变就不放进这一批（批量 PUT 本来就是按条目的）。

---

## amsg2 · 已评估但**故意不做**的

- **`ActiveMsgGlobalSettingsModal` 的 `capabilities` 探测**：保留。worker 是用户手动粘贴部署的，前端会自动更新而 worker 不会——这是全链路里唯一一处新旧真会不一致的地方。而且它是给用户看的「该重新部署了」提示，不是静默降级。
- **`agenticTools` 的 `not_configured` 分支**：保留，但保留的理由变小了。提示词本来就按配置裁剪（没配的工具连说明都不注入），正常不会撞上；原先「设置里关掉某个工具」到「下次跟该角色聊天」之间有个窗口，云端提示词还在介绍那个已关掉的工具——这个窗口现在已经由 `refreshAmsgPromptsAfterToolConfigChange` 堵上了（改凭据时 tool_config 和 fire_pack 一起刷）。剩下真正需要它的只有「LLM 幻觉出一个没被介绍过的标签」。
