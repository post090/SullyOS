# 糯米网关 · AI Gateway Console

面向中文 **AIRP**（AI 角色扮演）玩家的 AI 网关管理台：把手里一堆官转 / 中转 / DeepSeek / Claude 的 Key
统一管起来 —— 渠道优先级与预算、模型别名路由、令牌额度、调用账单，一个台子看完。

技术栈与 [SullyOS](https://github.com/post090/SullyOS) 对齐：**React + TypeScript + Tailwind + Phosphor Icons**，
数据访问经由存储端口抽象（Port/Adapter），未来可整体迁入 SullyOS 作为一个内置 App。
迁移方案见 **[docs/HANDOVER.md](./docs/HANDOVER.md)**，应用内也有「交接说明」页面。

## 快速开始

```bash
npm install
npx drizzle-kit push
npm run dev
```

访问 <http://localhost:3000>，演示账号 **demo / airp2026**（首访自动创建并灌入一周演示数据；新注册账号同样自动 seed）。

## 功能

- 🔌 **渠道管理**：Base URL / Key / 优先级 / 权重 / RPM / 月度预算，预算进度条与异常告警
- 🤖 **模型路由**：对外别名 → 上游模型，单价、上下文、标签、一键上下线
- 🔑 **访问令牌**：按 App 绑定（酒馆 / SullyOS / 脚本），额度、有效期、模型白名单，打码显示 + 一键复制
- 📜 **调用日志**：账单明细、状态筛选、模拟调用、单条删除与清空
- 📊 **总览仪表盘**：7 日调用量柱图、成功率、花费、延迟、Top 模型、渠道健康度
- 🔐 **账号体系**：scrypt 密码哈希 + HttpOnly 会话 Cookie，多用户数据隔离

UI 约定：空状态 / 骨架屏 / 乐观更新 + 失败回滚 / 危险操作二次确认 / 移动端抽屉导航。

## 架构一览

```
core/            零依赖内核：领域类型、纯逻辑、演示数据、GatewayRepository 端口
core/adapters/   http（Next.js REST）· memory（内存，可当 IndexedDB 适配器模板）
features/        React Context 状态层：乐观更新 / 回滚 / 本地重算统计
components/      纯展示组件（Tailwind 玻璃拟态 + Phosphor）
app/api/ server/ db/   仅 Next.js 部署形态需要，迁到 SullyOS 后整块删除
```
