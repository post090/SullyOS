# Fork 治理与开工前必读（本 Fork 专属）

> 这份文档是给 **post090/SullyOS-NuiAPK 这个 Fork** 的维护者（主要是我自己）和协作 AI 看的，不是给原版上游或外部用户当规范的。
> 原版请看 `CLAUDE.md` + 原版 docs，外人看到这篇可以忽略。

什么时候看：
- 你要改持续运行 / 通话 / 音乐 / RSS / 任何 APK 相关逻辑前
- 你要动 `proxyWorker` / `worker/index.js` / 任何网络代理路径前
- 你准备 `git push` 前，怕改坏 APK 打包或把个人配置写死进代码前

---

## 一、Fork 定位

- 自用为主，APK 体验特化版，不接受许愿
- 定期 merge `qegj567-cloud/SullyOS upstream/master`，保留原版 UI 与功能主线
- 代码在遵从原作者 `LICENSE` 与角色 IP 意愿前提下开放，**强烈建议自部署 Worker**，尤其是开启自定义 RSS / 热点 / 音乐等联网能力后，你的请求会打到你自己的 Worker，而不是作者的公共实例

## 二、代码清爽与可维护性（我喜欢的）

- **公共函数抽离**：重复逻辑 >2 处就抽 `utils/`，别在 `apps/` 里复制粘贴
- **单一职责**：一个文件只做一件事，`utils/runtime/` 下按“Job 存储 / 恢复 / 调度 / 通知”拆，不把所有原生逻辑塞一个 1000 行文件
- **可测试**：核心决策函数（如 `shouldSkipProactiveForSleep`、`formatRoleEventNotification`）必须有 `*.test.ts`，`pnpm test:run` 要绿
- **不堆屎山**：修复 BUG 时顺手把 `any` 收窄、把死代码分支删掉，`handleScrollSnapshot` 这种防抖别用 `if (timer) return` 而用 `clearTimeout` 重设
- **本地优先**：聊天记录、角色设定、图片走 IndexedDB Blob，网络请求才走 Worker；别把用户密钥写死进代码，用 `localStorage` + 设置页输入
- **构建产物不提交**：`public/*.bundle.js` / `worker/*/worker.bundle.js` / `dist/` / `node_modules/` 永远不进 git，CI 会自己生成

## 三、开工前必读检查清单（怕自己忘记）

每次改动前跑一遍：

1. **分支最新？** `git fetch upstream && git log --oneline HEAD..upstream/master` 看看上游有没有新功能要先 merge
2. **Worker 地址可配置？** 检查 `utils/proxyWorker.ts` 是否仍用 `getProxyWorkerUrl()` 而非硬编码，有无新增 `https://` 直链绕过代理的
3. **RSS 内置路径？** 内置源只能是 `https://` 或 `/rss/` 开头（Worker 包装器），自定义源校验要允许 `/rss/`（如 `/rss/bunkyo` 文京区区报），否则热点不显示
4. **常驻通知文案固定？** `SullyOS 正在运行` 不能改成技术说明，角色事件通知用角色化短句
5. **事件幂等？** 任何落库带副作用的动作要 `tag` 去重，`roleEventNotification` 的 `claimNotification` 7 天 TTL 是防刷屏，不是业务去重要求“每次都提醒”的场景用 `timestamp+random`
6. **通知路由**：`task:` / `vr:` / `call:` / `music` 前缀要和 `OSContext.openRoute` 对齐，冷/热启动都要测
7. **测试与构建**：`pnpm test:run` 1252+ passed，`pnpm run build` passed，再推
8. **APK 构建**：`.github/workflows/build-apk.yml` 安装 `android-34` + `35`，`plugins/.../build.gradle` 兜底 34，别写 35 单版本导致 CI 找不到 target

## 四、Worker 地址治理

- 默认 `https://sullymeow.ccwu.cc` 来自原作者公共实例
- 本 Fork 额外支持 `VITE_PROXY_WORKER` 环境变量覆盖默认，适合自用版本分发时固化自己的 Worker：`VITE_PROXY_WORKER=https://your.workers.dev pnpm run build`
- 运行时仍可通过“设置 → 自定义网络代理”覆盖，所有联网能力（搜索、热点、RSS、备份、MCP 等）走 `getProxyWorkerUrl()` 中心配置，一处改全切
- 音乐、小红书 Lite 各自有独立输入框，不受中心配置影响，但留空时跟随中心

## 五、RSS 与热点

- 内置源 `RSS_BUILTIN_SOURCES` 10 个，文京区区报 `/rss/bunkyo` 在 Worker 仍保留实现，但已从内置清单移除（太个人），用户可在设置里自定义添加 `https://...` 或 `/rss/bunkyo`
- 自定义校验现在允许 `/rss/` 前缀，否则热点 App 分组里看不到该源
- 热点数据流：`orz.ai` 热榜 + RSS 并发拉取 → 每 5 条插 1 条 RSS → 存 `HotNewsSnapshot` → 热点 App 按 `source` 分组展示 + 角色上下文注入

## 六、持续运行文档在哪

- 旧的 `ALWAYS_ON_RUNTIME_PLAN.md` / `PROGRESS` / `NATIVE_RUNTIME_PLAN.md` 是过程文档，风格与原版 `docs/` 的“什么时候看”表格不统一
- 新的统一入口是本文件 + `docs/always-on-runtime.md`（待归档），旧三份保留作历史，不再作为 Agent 必读
- Agent 开工前必读顺序：`CLAUDE.md` → `README.md` Fork 部分 → 本文件 → 相关功能 doc（如 `dev-debug.md`、`instant-push-dual-channel.md`）

## 七、不接受许愿声明（写给外人）

> 这是自用 Fork，**不接受功能许愿**，Bug 欢迎提 Issue。
> 若你用了本 Fork 的代码，请遵从原作者的 `LICENSE` 与角色 IP 说明，并最好自部署 Worker，别白嫖作者的公共流量。

---

*最后更新：2026-07-25，基于 2f6b548 之后的状态*
