"use client";

import { useMemo, useState } from "react";
import { Broom, Lightning, ScrollIcon, Trash } from "@phosphor-icons/react";
import { useGateway } from "@/features/gateway/store";
import { useToast } from "@/components/toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ListSkeleton,
  Modal,
  cx,
  inputClass,
} from "@/components/ui";
import { estimateCallCost, formatDateTime, formatMoney, formatNumber, relativeTime } from "@/core/logic";
import type { CallStatus } from "@/core/types";

export default function LogsPage() {
  const { logs, models, providers, tokens, loading, createLog, deleteLog, clearLogs } = useGateway();
  const { push } = useToast();
  const [status, setStatus] = useState<"all" | CallStatus>("all");
  const [model, setModel] = useState("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const [simulating, setSimulating] = useState(false);

  const filtered = useMemo(
    () =>
      logs.filter(
        (l) => (status === "all" || l.status === status) && (model === "all" || l.modelName === model),
      ),
    [logs, status, model],
  );

  const totals = useMemo(
    () => ({
      cost: filtered.reduce((s, l) => s + l.cost, 0),
      tokens: filtered.reduce((s, l) => s + l.promptTokens + l.completionTokens, 0),
    }),
    [filtered],
  );

  async function simulate() {
    const usable = models.filter((m) => m.enabled);
    if (usable.length === 0) {
      push("先去「模型路由」上线一个模型再试", "error");
      return;
    }
    setSimulating(true);
    const m = usable[Math.floor(Math.random() * usable.length)];
    const provider = providers.find((p) => p.id === m.providerId);
    const token = tokens.find((t) => t.status === "active") ?? tokens[0];
    const promptTokens = 1500 + Math.floor(Math.random() * 6000);
    const completionTokens = 200 + Math.floor(Math.random() * 800);
    const ok = Math.random() > 0.12;
    await createLog({
      tokenName: token?.name ?? "手动模拟",
      providerName: provider?.name ?? "未知渠道",
      modelName: m.displayName,
      promptTokens,
      completionTokens: ok ? completionTokens : 0,
      cost: ok ? Number(estimateCallCost(m, promptTokens, completionTokens).toFixed(4)) : 0,
      latencyMs: 700 + Math.floor(Math.random() * 3500),
      status: ok ? "success" : "error",
      errorMessage: ok ? "" : "429 Too Many Requests：上游限流",
    });
    setSimulating(false);
    push(ok ? "已模拟一次成功调用" : "模拟了一次失败调用（限流）", ok ? "success" : "info");
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">调用日志</h1>
          <p className="mt-1 text-sm text-slate-400">
            每一次请求的账单明细。成本会实时累加到对应令牌的已用额度上。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void simulate()} disabled={simulating}>
            <Lightning size={15} weight="fill" /> {simulating ? "模拟中…" : "模拟一次调用"}
          </Button>
          <Button variant="danger" onClick={() => setConfirmClear(true)} disabled={logs.length === 0}>
            <Broom size={15} /> 清空
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {([
          ["all", "全部"],
          ["success", "成功"],
          ["error", "失败"],
          ["timeout", "超时"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setStatus(key)}
            className={cx(
              "rounded-full border px-3 py-1 text-xs transition",
              status === key
                ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200",
            )}
          >
            {label}
          </button>
        ))}
        <select
          className={cx(inputClass, "ml-auto w-auto py-1.5 text-xs")}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="all" className="bg-slate-900">全部模型</option>
          {[...new Set(logs.map((l) => l.modelName))].map((name) => (
            <option key={name} value={name} className="bg-slate-900">
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-slate-400">
        <Card className="px-3 py-2">
          共 <span className="font-semibold text-slate-100">{filtered.length}</span> 条
        </Card>
        <Card className="px-3 py-2">
          合计花费 <span className="font-semibold text-slate-100">{formatMoney(totals.cost)}</span>
        </Card>
        <Card className="px-3 py-2">
          合计 tokens <span className="font-semibold text-slate-100">{formatNumber(totals.tokens)}</span>
        </Card>
      </div>

      {loading ? (
        <ListSkeleton rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ScrollIcon size={26} />}
          title={logs.length === 0 ? "还没有任何调用记录" : "没有符合条件的记录"}
          description={
            logs.length === 0
              ? "把令牌填进酒馆或 SullyOS 开始聊天，日志会自动流进来。想先看看效果，点右上角「模拟一次调用」。"
              : "换个筛选条件试试。"
          }
          action={
            <Button size="sm" onClick={() => void simulate()}>
              <Lightning size={14} weight="fill" /> 模拟一次调用
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[1.6fr_1fr_1fr_0.8fr_0.8fr_2rem] gap-3 border-b border-white/5 px-4 py-2.5 text-[11px] font-medium text-slate-500 md:grid">
            <span>模型 / 渠道</span>
            <span>令牌</span>
            <span>Tokens</span>
            <span className="text-right">花费</span>
            <span className="text-right">延迟</span>
            <span />
          </div>
          <ul className="divide-y divide-white/5">
            {filtered.slice(0, 120).map((l) => (
              <li
                key={l.id}
                className="group grid grid-cols-1 gap-2 px-4 py-3 text-xs transition hover:bg-white/[0.02] md:grid-cols-[1.6fr_1fr_1fr_0.8fr_0.8fr_2rem] md:items-center md:gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={cx(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        l.status === "success" ? "bg-emerald-400" : l.status === "timeout" ? "bg-amber-400" : "bg-rose-400",
                      )}
                    />
                    <code className="truncate font-medium text-slate-200">{l.modelName}</code>
                  </div>
                  <p className="mt-0.5 truncate pl-3.5 text-[11px] text-slate-500">
                    {l.providerName} · {formatDateTime(l.createdAt)}（{relativeTime(l.createdAt)}）
                  </p>
                  {l.errorMessage ? (
                    <p className="mt-1 pl-3.5 text-[11px] text-rose-400">{l.errorMessage}</p>
                  ) : null}
                </div>
                <span className="truncate text-slate-400">{l.tokenName}</span>
                <span className="text-slate-400">
                  {formatNumber(l.promptTokens)} <span className="text-slate-600">↑</span>{" "}
                  {formatNumber(l.completionTokens)} <span className="text-slate-600">↓</span>
                </span>
                <span className="text-slate-200 md:text-right">{formatMoney(l.cost)}</span>
                <span className="md:text-right">
                  <Badge tone={l.latencyMs > 8000 ? "rose" : l.latencyMs > 3000 ? "amber" : "slate"}>
                    {l.latencyMs} ms
                  </Badge>
                </span>
                <button
                  onClick={() => void deleteLog(l.id)}
                  title="删除这条"
                  className="justify-self-start text-slate-600 opacity-0 transition hover:text-rose-300 group-hover:opacity-100 md:justify-self-end"
                >
                  <Trash size={14} />
                </button>
              </li>
            ))}
          </ul>
          {filtered.length > 120 ? (
            <p className="border-t border-white/5 px-4 py-2 text-center text-[11px] text-slate-500">
              仅展示最近 120 条，共 {filtered.length} 条
            </p>
          ) : null}
        </Card>
      )}

      <Modal
        open={confirmClear}
        title="清空全部日志？"
        description="所有调用记录会被永久删除，统计图表也会归零。令牌的已用额度不会回退。"
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void clearLogs();
                setConfirmClear(false);
              }}
            >
              确认清空
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">建议先在「总览」截个图存档，不然月底对账会哭。</p>
      </Modal>
    </div>
  );
}
