# 交接 prompt：满血后台消息实测后的四个通用缺口补齐

> 这份是给在 **ReiStandard** 仓库（`packages/rei-standard-amsg`）里干活的实例看的，自包含，
> 不依赖别处上下文。背景：下游用 `client_state` + fire hooks + 服务端 agentic 循环
> （amsg-server 2.6.0-next.3 那批契约）跑完了完整实机验证，暴露出四个**任何宿主都会撞上**
> 的通用缺口。按价值排序：① client_state 大值透明分块 + 整批局部失败语义；② fire 级
> scratch 容器进 hook ctx；③ `GET /capabilities` 特性探测端点；④（可选）scheduled 推送
> 的溢出封套对齐 instant。

## 前置约束（红线，与上一批 hooks 交接相同）

- **通用抽象，不耦合任何下游**。新增字段/端点/错误码不得出现下游业务概念，文档举例用中性示例。
- **纯 Web Crypto / 零 node 内置依赖**。主线部署是「bundle 粘贴进 Cloudflare Dashboard」，
  不开 `nodejs_compat`。验收含打包检查。
- **向后兼容**。老客户端打新 worker、新客户端打老 worker，都不能炸：老行为一字不变，
  新能力探测不到就优雅退化。
- **hook ctx 不暴露凭据**（scratch 容器同样适用：库自己不往里写任何东西，也不打日志）。

## 任务 1：client_state 大值透明分块 + 整批局部失败（主菜）

**现状**：单条 value 有 `MAX_STATE_VALUE_BYTES`（200KB）硬上限，超限直接 413；且
`PUT /client-state` 整批 all-or-nothing——批里一个胖条目会把同批**所有**条目一起拒掉。
实测后果：宿主存的状态包（完整 prompt 模板这类）轻松超限，只能在应用层自己发明
「`<key>.0` / `<key>.1` 子条目 + 根条目 meta」的私有分块格式，客户端切、worker 拼，
每个宿主都要重造一遍。

**要做的两件事：**

1. **透明大值**：`putClientState` 接受大 value（工厂配置可设总上限，默认给个宽松值），
   库内部自行跨行存储；`readState` 返回**拼好的原值**，hook 作者无感。存储格式是库的
   内部实现细节，随便选，但注意四个坑（下游都踩过）：
   - 多字节字符/emoji 代理对不能从中间劈；
   - 覆盖写入时新块数 < 旧块数，**旧的尾部块必须删掉**，不能留着下次拼接还魂；
   - 缺块（写到一半断了）→ 该 key 视为不存在，读方拿 null 走自己的兜底，不抛错；
   - `clearClientState` 要连块清干净。
   - 下游有一份带 8 条回归测试的参考实现可抄思路：SullyOS 仓库
     `utils/amsgStateChunks.ts`（分支 `claude/amsg2-v2-live-test-fixes`）。库内做完后
     下游会删掉自己这层——不需要兼容下游的私有格式。
2. **整批局部失败**：per-entry 校验，一个条目超限/非法只拒它自己；响应带每个 key 的
   accepted / rejected（含原因），全部成功时保持现有响应形状不变（老客户端无感）。

## 任务 2：fire 级 scratch 容器进 hook ctx

**现状**：`onBeforeFire` 里准备的工具上下文要传给同一次 fire 的 `executeToolCalls` /
`onLLMOutput`，宿主只能自己维护 `Map<sessionId, state>` 外加容量上限、fire 中途抛错时的
孤儿清理。每个用 agentic hooks 的宿主都得重造这套样板。

**要做**：sessionCtx 加一个 `scratch`（普通对象即可）——单次 fire 开始时创建，同一次 fire
的所有 hook 调用拿到**同一个引用**，fire 结束（finish / skip-push / 抛错 / 轮数超限）后由
库丢弃。不落库、不进日志、不跨 fire 共享。纯增量字段，向后兼容免费。

## 任务 3：`GET /capabilities` 特性探测端点

**现状**：worker 部署版本落后时是**静默降级**（消息照发但新链路不生效），用户只会觉得
「功能没反应」，排查全靠猜。

**要做**：加 `GET /capabilities`，返回 `{ serverVersion, features: string[] }`（feature 名用
库自己的中性命名，如 `client-state` / `agentic-hooks` / `client-state-chunking`，随版本演进
追加）。鉴权与 `/vapid-public-key` 同待遇。client SDK 配 `getCapabilities()`，打到老 worker
（404）时返回 null 不抛错——前端拿它在设置里亮「worker 需要重新部署」的牌子。

## 任务 4（可选，调研后觉得成本合理再做）：scheduled 推送溢出封套

amsg-instant 有 `maxInlineBytes` + `_blob` 封套（超限 payload 落库、push 只带引用、客户端
回取）；amsg-server 的 `sendHookPushPayloads`（scheduled 路径）没有，宿主想在 push metadata
里带大件（实测案例：结构化卡片会话数据）只能手工裁剪迁就 web push ~4KB。把封套机制抽进
amsg-shared 让两条路径共用。改动面涉及 sw 回取路径，先评估再动。

## 验收

- 任务 1：往返测试（含全中文大包、emoji 代理对边界）、缩块覆盖写不残留尾块、缺块返 null、
  局部失败响应形状、老单值路径字节级不变。
- 任务 2：同一 fire 内三个 hook 拿到同一引用；不同 fire 之间隔离；fire 抛错后不泄漏。
- 任务 3：老 worker 探测返回 null 不抛错。
- 通用：打包零 node 内置依赖；红线 grep 零下游标识；changesets + next tag 发预发布版
  （动了哪个包发哪个：amsg-server 必发，动 SDK 加 amsg-client，动封套加 amsg-shared/amsg-sw）。

## 发版后下游会做什么（供理解使用方，不用你做）

下游升 next 版后：删自己的应用层分块、把 sessionId Map 迁到 `ctx.scratch`、设置页接
`getCapabilities()` 亮版本牌，然后重打 bundle 重新部署 worker。
