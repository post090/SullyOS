import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { ensureDemoUser, DEMO_PASSWORD, DEMO_USERNAME } from "@/server/seed";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  await ensureDemoUser();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="grid w-full max-w-5xl gap-8 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <section className="hidden lg:block">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1 text-xs text-violet-200">
            AIRP 玩家专用 · AI Gateway Console
          </p>
          <h1 className="text-4xl font-bold leading-tight text-slate-50">
            糯米网关
            <span className="block bg-gradient-to-r from-violet-400 to-cyan-300 bg-clip-text text-transparent">
              把你的一堆 API Key 管明白
            </span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-400">
            渠道轮询、模型别名路由、令牌额度、调用账单，全都在一个台子上。
            数据层走端口抽象，之后可以整包搬进 SullyOS 当一个内置 App —— 详见控制台里的「交接说明」。
          </p>
          <ul className="mt-6 space-y-2 text-sm text-slate-400">
            <li>· 多渠道优先级 / 权重 / 月度预算，一眼看出谁在烧钱</li>
            <li>· 对外模型别名 → 上游真实模型，酒馆里再也不用改配置</li>
            <li>· 令牌按 App 绑定（酒馆 / SullyOS / 脚本），额度用尽自动告警</li>
          </ul>
        </section>
        <LoginForm demoUsername={DEMO_USERNAME} demoPassword={DEMO_PASSWORD} />
      </div>
    </main>
  );
}
