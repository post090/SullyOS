"use client";

import Link from "next/link";
import {
  ArrowRight,
  ArrowsClockwise,
  Coins,
  CurrencyCny,
  Lightning,
  PlugsConnected,
  Pulse,
  Timer,
} from "@phosphor-icons/react";
import { useGateway } from "@/features/gateway/store";
import { Badge, Button, Card, EmptyState, ListSkeleton, Skeleton, cx } from "@/components/ui";
import { VENDORS, formatMoney, formatNumber, relativeTime } from "@/core/logic";

export default function DashboardPage() {
  const { stats, loading, providers, logs, tokens, refresh } = useGateway();

  const maxCalls = Math.max(1, ...(stats?.daily.map((d) => d.calls) ?? [1]));
  const brokenProviders = providers.filter((p) => p.status === "error");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">总览</h1>
          <p className="mt-1 text-sm text-slate-400">最近 7 天的网关运行情况，数据每次进入页面自动刷新。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          <ArrowsClockwise size={14} /> 刷新
        </Button>
      </header>

      {brokenProviders.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          <Pulse size={16} weight="fill" />
          <span>
            有 {brokenProviders.length} 个渠道处于异常状态：
            {brokenProviders.map((p) => p.name).join("、")}
          </span>
          <Link href="/providers" className="ml-auto inline-flex items-center gap-1 text-xs underline">
            去处理 <ArrowRight size={12} />
          </Link>
        </div>
      ) : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading || !stats ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <StatCard
              icon={<Lightning size={16} weight="fill" />}
              label="总调用次数"
              value={formatNumber(stats.totalCalls)}
              sub={`成功率 ${stats.successRate}%`}
              tone="violet"
            />
            <StatCard
              icon={<CurrencyCny size={16} weight="bold" />}
              label="累计花费"
              value={formatMoney(stats.totalCost)}
              sub={`${formatNumber(stats.totalTokens)} tokens`}
              tone="cyan"
            />
            <StatCard
              icon={<Timer size={16} weight="fill" />}
              label="平均延迟"
              value={`${stats.avgLatency} ms`}
              sub={stats.avgLatency > 3000 ? "偏慢，建议调权重" : "响应正常"}
              tone={stats.avgLatency > 3000 ? "amber" : "green"}
            />
            <StatCard
              icon={<PlugsConnected size={16} weight="fill" />}
              label="在线渠道"
              value={`${stats.activeProviders}/${stats.totalProviders}`}
              sub={`${stats.activeTokens} 个令牌可用`}
              tone="green"
            />
          </>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">每日调用量</h2>
            <Badge tone="slate">近 7 天</Badge>
          </div>
          {loading || !stats ? (
            <Skeleton className="h-44 w-full" />
          ) : stats.totalCalls === 0 ? (
            <EmptyState
              icon={<Lightning size={24} />}
              title="还没有调用记录"
              description="去「调用日志」里点一下「模拟一次调用」，或者把令牌接进酒馆开聊，这里就会热闹起来。"
              action={
                <Link href="/logs">
                  <Button size="sm">去看日志</Button>
                </Link>
              }
            />
          ) : (
            <div className="flex h-44 items-end gap-2">
              {stats.daily.map((d) => (
                <div key={d.date} className="group flex flex-1 flex-col items-center gap-2">
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className="relative w-full overflow-hidden rounded-t-lg bg-gradient-to-t from-violet-600/70 to-fuchsia-400/80 transition-all duration-500 group-hover:brightness-125"
                      style={{ height: `${Math.max(6, (d.calls / maxCalls) * 100)}%` }}
                    >
                      {d.errors > 0 ? (
                        <div
                          className="absolute bottom-0 w-full bg-rose-500/70"
                          style={{ height: `${(d.errors / Math.max(1, d.calls)) * 100}%` }}
                        />
                      ) : null}
                    </div>
                  </div>
                  <div className="text-center">
                    <p className="text-[11px] font-medium text-slate-300">{d.calls}</p>
                    <p className="text-[10px] text-slate-500">{d.date}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] text-slate-500">紫色为调用总量，底部红色部分为失败次数。</p>
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-200">热门模型 Top 5</h2>
          {loading || !stats ? (
            <ListSkeleton rows={3} />
          ) : stats.topModels.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-500">暂无数据</p>
          ) : (
            <ul className="space-y-3">
              {stats.topModels.map((m, i) => (
                <li key={m.modelName} className="flex items-center gap-3">
                  <span
                    className={cx(
                      "flex h-6 w-6 items-center justify-center rounded-lg text-[11px] font-bold",
                      i === 0 ? "bg-violet-500/25 text-violet-200" : "bg-white/5 text-slate-400",
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-slate-200">{m.modelName}</p>
                    <p className="text-[11px] text-slate-500">{m.calls} 次 · {formatMoney(m.cost)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">渠道健康度</h2>
            <Link href="/providers" className="text-xs text-violet-300 hover:underline">
              管理渠道
            </Link>
          </div>
          {loading ? (
            <ListSkeleton rows={3} />
          ) : providers.length === 0 ? (
            <EmptyState
              icon={<PlugsConnected size={24} />}
              title="还没有接入任何渠道"
              description="先添加一个上游供应商（官转、中转、自建都行），才能开始路由请求。"
              action={
                <Link href="/providers">
                  <Button size="sm">添加渠道</Button>
                </Link>
              }
            />
          ) : (
            <ul className="space-y-2">
              {providers.slice(0, 5).map((p) => {
                const spent = logs
                  .filter((l) => l.providerName === p.name)
                  .reduce((s, l) => s + l.cost, 0);
                return (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5"
                  >
                    <span
                      className={cx(
                        "rounded-lg border px-1.5 py-0.5 text-[10px] font-bold",
                        VENDORS[p.vendor].accent,
                      )}
                    >
                      {VENDORS[p.vendor].glyph}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-slate-200">{p.name}</p>
                      <p className="text-[11px] text-slate-500">
                        本期 {formatMoney(spent)} / 预算 {formatMoney(p.monthlyBudget)}
                      </p>
                    </div>
                    <Badge tone={p.status === "active" ? "green" : p.status === "paused" ? "amber" : "rose"}>
                      {p.status === "active" ? "运行中" : p.status === "paused" ? "已暂停" : "异常"}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">最近调用</h2>
            <Link href="/logs" className="text-xs text-violet-300 hover:underline">
              全部日志
            </Link>
          </div>
          {loading ? (
            <ListSkeleton rows={3} />
          ) : logs.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-500">还没有调用记录</p>
          ) : (
            <ul className="space-y-2">
              {logs.slice(0, 5).map((l) => (
                <li key={l.id} className="flex items-center gap-3 text-xs">
                  <span
                    className={cx(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      l.status === "success" ? "bg-emerald-400" : "bg-rose-400",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-slate-300">{l.modelName}</span>
                  <span className="shrink-0 text-slate-500">{formatMoney(l.cost)}</span>
                  <span className="shrink-0 text-slate-600">{relativeTime(l.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          {tokens.length > 0 ? (
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px] text-slate-400">
              <Coins size={14} className="text-amber-300" />
              共 {tokens.length} 个令牌，累计已用{" "}
              {formatMoney(tokens.reduce((s, t) => s + t.used, 0))}
            </div>
          ) : null}
        </Card>
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: "violet" | "cyan" | "green" | "amber";
}) {
  const tones = {
    violet: "text-violet-300 bg-violet-500/10",
    cyan: "text-cyan-300 bg-cyan-500/10",
    green: "text-emerald-300 bg-emerald-500/10",
    amber: "text-amber-300 bg-amber-500/10",
  };
  return (
    <Card className="p-4">
      <div className={cx("mb-3 inline-flex h-8 w-8 items-center justify-center rounded-lg", tones[tone])}>
        {icon}
      </div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-0.5 text-xl font-bold tracking-tight text-slate-50">{value}</p>
      <p className="mt-1 text-[11px] text-slate-500">{sub}</p>
    </Card>
  );
}
