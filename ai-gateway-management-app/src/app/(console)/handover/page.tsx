import { ArrowRight, CheckCircle, Package, Plugs, Warning } from "@phosphor-icons/react/dist/ssr";
import { Badge, Card } from "@/components/ui";

const LAYERS = [
  {
    name: "src/core/*",
    tag: "零依赖内核",
    detail:
      "types.ts（领域模型）、logic.ts（纯函数：脱敏、计价、统计、校验）、demoData.ts（演示数据工厂）、port.ts（存储端口接口）。不 import React、不 import fetch、不 import Drizzle。",
    tone: "green" as const,
  },
  {
    name: "src/core/adapters/*",
    tag: "可替换适配器",
    detail:
      "httpRepository（走 Next.js REST）、memoryRepository（纯内存，测试/离线）。SullyOS 内只需再补一个 indexedDbRepository，实现同一个 GatewayRepository 接口即可。",
    tone: "violet" as const,
  },
  {
    name: "src/features/gateway/store.tsx",
    tag: "状态与乐观更新",
    detail:
      "React Context，构造函数接收 repository 参数（默认 HTTP）。所有乐观更新 / 回滚 / 本地重算统计都在这一层，与具体存储无关。",
    tone: "cyan" as const,
  },
  {
    name: "src/components/* + src/app/(console)/*",
    tag: "纯展示层",
    detail:
      "Tailwind + Phosphor Icons 的玻璃拟态组件，只通过 useGateway() 拿数据。除了 next/link 与 next/navigation，没有其他框架耦合点。",
    tone: "amber" as const,
  },
  {
    name: "src/server/* + src/app/api/*",
    tag: "仅 Next.js 形态需要",
    detail:
      "auth.ts（scrypt + 会话 Cookie）、repository.ts（Drizzle 实现）、seed.ts（演示数据落库）、Route Handlers。迁进 SullyOS 后这整块可以直接删掉。",
    tone: "rose" as const,
  },
];

const STEPS = [
  {
    title: "① 复制内核",
    body: "把 src/core/ 整个目录拷进 SullyOS 的 utils/gateway/（或 types/），无需任何改动，它不依赖 Next.js。",
  },
  {
    title: "② 写 IndexedDB 适配器",
    body: "新建 adapters/indexedDbRepository.ts，用 SullyOS 现成的 db 封装实现 GatewayRepository 的 20 个方法。照抄 memoryRepository.ts 的结构，把数组换成 store 即可。",
  },
  {
    title: "③ 搬 UI",
    body: "components/ui.tsx、components/toast.tsx、features/gateway/store.tsx 与各页面组件直接复制。把 next/link 换成 SullyOS 的页面切换（setActiveTab），把 (console)/layout 的侧边栏换成 App 内的 Tab 栏。",
  },
  {
    title: "④ 注册成一个 App",
    body: "按 SullyOS 的约定：apps/GatewayApp.tsx 里 <GatewayProvider repository={indexedDbRepo}>…；types.ts 的 AppID 加 GATEWAY；constants.tsx 的 INSTALLED_APPS 注册图标；App.tsx 的 renderApp() 加 case。",
  },
  {
    title: "⑤ 打通真实调用",
    body: "SullyOS 的 LLM 请求出口改为读取本 App 的渠道/模型/令牌配置：调用前用 core/logic 的 estimateCallCost 记账，调用后 createLog() 落一条日志，用量统计立刻可视化。",
  },
];

const COUPLING = [
  { ok: true, text: "UI 组件不直接 fetch，一律走 useGateway()，因此换存储不改 UI。" },
  { ok: true, text: "领域类型只有一份（core/types.ts），服务端 Drizzle 行在 repository 里显式映射成领域对象，DB 字段改名不会漏到前端。" },
  { ok: true, text: "统计逻辑 computeStats() 前后端共用，服务端算与前端乐观重算结果一致，不会出现「刷新后数字跳变」。" },
  { ok: true, text: "多租户隔离（userId）只存在于 src/server/repository.ts。local-first 场景没有租户概念，删掉即可，前端无感。" },
  { ok: false, text: "next/link、next/navigation 出现在 ConsoleShell 与少数页面，是迁移时唯一需要手改的地方（约 6 处）。" },
  { ok: false, text: "会话鉴权（Cookie + sessions 表）是服务端形态特有的。SullyOS 是单机应用，迁移后请整体移除，不要试图在浏览器里模拟。" },
];

export default function HandoverPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">交接说明</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
          本项目按「可被 SullyOS 收编」的前提设计：React + TypeScript + Tailwind + Phosphor Icons，
          与 SullyOS 同栈；数据访问全部经过一个存储端口（Port/Adapter），
          当前是 Postgres + Drizzle，迁移后换成 IndexedDB 即可，业务与 UI 代码零改动。
          完整文档见仓库 <code className="text-violet-300">docs/HANDOVER.md</code>。
        </p>
      </header>

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Package size={18} className="text-violet-300" />
          <h2 className="text-sm font-semibold text-slate-200">分层结构与耦合边界</h2>
        </div>
        <ul className="space-y-3">
          {LAYERS.map((l) => (
            <li key={l.name} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs font-semibold text-slate-100">{l.name}</code>
                <Badge tone={l.tone}>{l.tag}</Badge>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-slate-400">{l.detail}</p>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Plugs size={18} className="text-cyan-300" />
          <h2 className="text-sm font-semibold text-slate-200">迁移到 SullyOS 的五步</h2>
        </div>
        <ol className="space-y-3">
          {STEPS.map((s) => (
            <li key={s.title} className="flex gap-3">
              <ArrowRight size={14} className="mt-1 shrink-0 text-violet-400" />
              <div>
                <p className="text-xs font-semibold text-slate-200">{s.title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-slate-400">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Warning size={18} className="text-amber-300" />
          <h2 className="text-sm font-semibold text-slate-200">耦合自查清单</h2>
        </div>
        <ul className="space-y-2">
          {COUPLING.map((c) => (
            <li key={c.text} className="flex items-start gap-2 text-[12px] leading-relaxed">
              {c.ok ? (
                <CheckCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-emerald-400" />
              ) : (
                <Warning size={15} weight="fill" className="mt-0.5 shrink-0 text-amber-400" />
              )}
              <span className={c.ok ? "text-slate-400" : "text-amber-100/80"}>{c.text}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">存储端口速览（GatewayRepository）</h2>
        <pre className="overflow-x-auto rounded-xl border border-white/5 bg-slate-950/70 p-4 text-[11px] leading-relaxed text-slate-300">
{`interface GatewayRepository {
  listProviders(): Promise<Provider[]>
  createProvider(input): Promise<Provider>
  updateProvider(id, patch): Promise<Provider>
  deleteProvider(id): Promise<void>
  // models / tokens / logs 同构
  listLogs(limit?): Promise<CallLog[]>
  clearLogs(): Promise<void>
  getStats(): Promise<DashboardStats>
}

// Next.js 形态
<GatewayProvider />                       // 默认 createHttpRepository()
// SullyOS 形态
<GatewayProvider repository={indexedDb} /> // 换一个参数就行`}
        </pre>
      </Card>
    </div>
  );
}
