# 糯米网关 · 交接说明（Handover）

> 目标读者：接手本项目的开发者 / 打算把它收编进 **SullyOS** 的人。
> 一句话：**这是一个按「以后要被搬进 SullyOS」写的 AI 网关管理台**，
> 技术栈与 SullyOS 对齐（React + TypeScript + Tailwind + Phosphor Icons），
> 数据访问全部走一个存储端口，换存储 = 换一个参数。

---

## 1. 这是什么

面向中文 AIRP（AI 角色扮演）玩家的 **AI 网关管理 App**。解决的痛点是：
玩家手里同时有官转 / 中转 / DeepSeek / Claude 一堆 Key，酒馆、SullyOS、各种脚本都要用，
钱花在哪、哪个渠道崩了、哪个 Key 被薅了，全靠人肉记。

核心资源（都支持完整增删改查）：

| 资源 | 说明 | 页面 |
| --- | --- | --- |
| 渠道 Provider | 上游供应商接入点：Base URL、Key、优先级、权重、RPM、月度预算 | `/providers` |
| 模型路由 ModelRoute | 对外别名 → 上游真实模型，含单价、上下文、标签、上下线开关 | `/models` |
| 访问令牌 AccessToken | 发给客户端的 Key，含额度、有效期、可用模型白名单、绑定 App | `/tokens` |
| 调用日志 CallLog | 每次请求的账单明细，可筛选 / 删除 / 清空 / 模拟写入 | `/logs` |
| 统计 DashboardStats | 7 日调用量、成功率、花费、延迟、Top 模型、渠道健康度 | `/dashboard` |

演示账号：`demo` / `airp2026`（首次访问登录页时自动创建并灌入一周的演示数据）。
新注册的账号同样会自动 seed 一份，保证首屏不空。

---

## 2. 技术栈对照

| 层 | 本项目（Next.js 部署形态） | SullyOS（目标形态） | 是否需要改 |
| --- | --- | --- | --- |
| 视图 | React 19 + TypeScript | React + TypeScript | ❌ 不改 |
| 样式 | Tailwind CSS 4，玻璃拟态 | Tailwind + glassmorphism | ❌ 不改 |
| 图标 | `@phosphor-icons/react` | 同 | ❌ 不改 |
| 构建 | Next.js App Router | Vite | ⚠️ 仅路由与 `next/*` 引用 |
| 存储 | PostgreSQL + Drizzle ORM | IndexedDB（local-first） | ✅ 换适配器 |
| 鉴权 | scrypt + 会话 Cookie | 无（单机） | ✅ 整块删除 |

> 为什么这里用 Postgres 而不是 IndexedDB：本仓库是服务端形态的演示与验证环境。
> **正因为如此，存储从第一天就被抽象成端口**，避免出现「UI 里到处 `await db.xxx`」这种搬不动的代码。

---

## 3. 目录与耦合边界

```
src/
├── core/                     ★ 零依赖内核（可整包复制）
│   ├── types.ts              领域模型：Provider / ModelRoute / AccessToken / CallLog / DashboardStats
│   ├── logic.ts              纯函数：脱敏、格式化、计价、表单校验、computeStats
│   ├── demoData.ts           演示数据工厂（确定性伪随机，服务端 seed 与内存适配器共用）
│   ├── port.ts               ★ GatewayRepository —— 唯一的存储契约
│   └── adapters/
│       ├── httpRepository.ts     走 Next.js REST（当前默认）
│       └── memoryRepository.ts   纯内存（测试 / 离线预览 / IndexedDB 适配器的抄写模板）
├── features/gateway/store.tsx   React Context：加载、乐观更新、回滚、本地重算统计
├── components/                  纯展示层：ui.tsx（Card/Button/Modal/EmptyState/Skeleton…）、toast.tsx、ConsoleShell.tsx
├── app/(console)/*              页面：dashboard / providers / models / tokens / logs / handover
├── app/api/*                    Route Handlers（仅服务端形态）
├── server/                      ⚠️ 仅服务端形态：auth.ts / repository.ts(Drizzle) / seed.ts
└── db/                          ⚠️ 仅服务端形态：schema.ts / index.ts
```

**依赖方向（严格单向）**：

```
app/(console) 页面 ──> features/gateway/store ──> core/port（接口）
        │                                            ▲
        └──> components/ui（纯展示）                  │
                                        adapters/httpRepository（实现之一）
                                        adapters/memoryRepository（实现之一）
                                        server/repository.ts（Drizzle 实现，服务端侧）
```

- **UI 永远不 fetch**，只调用 `useGateway()`。
- **领域类型只有一份**（`core/types.ts`）。Drizzle 行在 `server/repository.ts` 里显式映射成领域对象，
  数据库字段改名不会泄漏到前端。
- **统计逻辑只有一份**（`computeStats`），服务端与前端乐观更新共用，避免「刷新后数字跳变」。
- **多租户 `userId` 只出现在 `src/server/`**。local-first 没有租户概念，删掉即可。

---

## 4. 迁移到 SullyOS 的操作步骤

1. **复制内核**：`src/core/` → SullyOS 的 `utils/gateway/`（或 `types/gateway/`）。无需改动。
2. **实现 IndexedDB 适配器**：新建 `adapters/indexedDbRepository.ts`，实现 `GatewayRepository`。
   直接照抄 `memoryRepository.ts`，把数组操作换成 SullyOS 现成的 db 封装（`db.gatewayProviders` 等 store）。
   建议 store 命名：`gw_providers` / `gw_models` / `gw_tokens` / `gw_logs`。
3. **搬 UI**：`components/ui.tsx`、`components/toast.tsx`、`features/gateway/store.tsx`、`app/(console)/*` 页面组件。
   需要手改的 `next/*` 引用只有：
   - `ConsoleShell.tsx`：`Link` / `usePathname` / `useRouter` → 改成 App 内部 tab 状态；
   - `dashboard/page.tsx`、`models/page.tsx`：两三个 `<Link href>` → 改成 `onClick={() => setTab(...)}`；
   - 删掉 `app/(console)/layout.tsx`（服务端鉴权）与 `app/login/*`。
4. **注册成一个 App**（按 SullyOS README 的约定）：
   - `apps/GatewayApp.tsx`：`<GatewayProvider repository={indexedDbRepo}><GatewayTabs/></GatewayProvider>`
   - `types.ts` 的 `AppID` 枚举加 `GATEWAY`
   - `constants.tsx` 的 `INSTALLED_APPS` 注册图标（Phosphor `PlugsConnected`）、名称「网关」、主题色紫色
   - `App.tsx` 的 `renderApp()` 加一个 `case`
5. **打通真实调用**：SullyOS 现有的 LLM 出口（`useChatAI` / ContextBuilder 之后的 fetch 层）
   改为从本 App 读取渠道与模型映射：
   - 选路：按 `status === 'active'` 过滤 → 按 `priority` 升序 → 同级按 `weight` 加权随机；
   - 别名：请求里的模型名先过 `ModelRoute.displayName → upstreamModel` 映射；
   - 记账：响应回来后用 `estimateCallCost(model, promptTokens, completionTokens)` 算钱，
     调 `repo.createLog(...)` 落一条日志，令牌已用额度自增。仪表盘立刻就有数据。
6. **删掉服务端残留**：`src/server/`、`src/db/`、`src/app/api/`、`drizzle.config.json`、`pg`/`drizzle-orm` 依赖。

**验收标准**：删掉 `src/server` 与 `src/app/api` 后，
把 `<GatewayProvider>` 的 `repository` 换成 `createMemoryRepository()`，
整个控制台应当仍然可以完整跑通（增删改查 + 统计 + 空状态）。这就是解耦是否达标的自测方法。

---

## 5. 已知耦合点（迁移时必看）

| 位置 | 耦合内容 | 处理方式 |
| --- | --- | --- |
| `components/ConsoleShell.tsx` | `next/link`、`usePathname`、`useRouter`、登出请求 | 换成 App 内 tab 状态；删除登出 |
| `app/(console)/layout.tsx` | 服务端 `getCurrentUser()` + `redirect` | 整个文件删除 |
| `app/login/*` | 登录 / 注册 / 演示账号 | 整个目录删除 |
| `server/repository.ts` | `userId` 多租户过滤、Drizzle | 由 IndexedDB 适配器替代 |
| `core/adapters/httpRepository.ts` | `fetch` + 相对路径 `/api` | 不删也无害；只是不再被引用 |
| `db/schema.ts` | Postgres 表结构 | 作为 IndexedDB store 字段的参考文档保留即可 |

**没有耦合的部分**（可以放心整包搬）：`core/`（除 httpRepository）、`components/ui.tsx`、
`components/toast.tsx`、`features/gateway/store.tsx`、四个资源页面的表单与列表逻辑。

---

## 6. 本地开发

```bash
npm install
npx drizzle-kit push     # 建表
npm run dev              # http://localhost:3000
```

环境变量：`.env` 中的 `DATABASE_URL`。健康检查：`GET /api/health`。

API 一览（全部要求登录 Cookie）：

```
POST   /api/auth/register | /api/auth/login | /api/auth/logout
GET    /api/auth/me
GET    POST   /api/providers        PATCH DELETE /api/providers/:id
GET    POST   /api/models           PATCH DELETE /api/models/:id
GET    POST   /api/tokens           PATCH DELETE /api/tokens/:id
GET    POST   /api/logs   DELETE /api/logs（清空）   DELETE /api/logs/:id
GET    /api/stats
```

---

## 7. 交互约定（UI 规范，迁移后请保持）

- **空状态**：每个列表都有插画式空状态 + 一句人话说明 + 一个明确的下一步按钮。
- **加载态**：骨架屏（`ListSkeleton` / `Skeleton`），不用转圈遮罩。
- **乐观更新**：新增/编辑/删除/开关立即反映到 UI，失败自动回滚并弹红色 toast。
- **危险操作**：删除一律走确认弹窗，并提示「更安全的替代方案」（暂停 / 下线）。
- **密钥**：默认打码（`maskSecret`），点眼睛才显示，旁边永远有一键复制。
- **响应式**：≥1024px 固定侧边栏；以下折叠为抽屉，表格降级为卡片式行。

> 叮叮叮！按这份文档搬，数据库不会咕咕叫。
