"use client";

import { useMemo, useState } from "react";
import {
  Copy,
  DotsThreeVertical,
  Eye,
  EyeSlash,
  PencilSimple,
  Plus,
  PlugsConnected,
  Trash,
} from "@phosphor-icons/react";
import { useGateway } from "@/features/gateway/store";
import { useToast } from "@/components/toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  ListSkeleton,
  Modal,
  cx,
  inputClass,
} from "@/components/ui";
import { VENDORS, VENDOR_IDS, formatMoney, maskSecret, validateProvider } from "@/core/logic";
import type { Provider, ProviderInput, ProviderStatus, VendorId } from "@/core/types";

const emptyForm: ProviderInput = {
  name: "",
  vendor: "openai",
  baseUrl: VENDORS.openai.baseUrl,
  apiKey: "",
  status: "active",
  priority: 10,
  weight: 50,
  rpmLimit: 60,
  monthlyBudget: 100,
  notes: "",
};

export default function ProvidersPage() {
  const { providers, models, logs, loading, createProvider, updateProvider, deleteProvider } = useGateway();
  const { push } = useToast();
  const [editing, setEditing] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Provider | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<"all" | ProviderStatus>("all");

  const visible = useMemo(
    () => (filter === "all" ? providers : providers.filter((p) => p.status === filter)),
    [providers, filter],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">渠道管理</h1>
          <p className="mt-1 text-sm text-slate-400">
            上游供应商接入点。优先级数字越小越先被使用，权重决定同级之间的分流比例。
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} weight="bold" /> 添加渠道
        </Button>
      </header>

      <div className="flex flex-wrap gap-2">
        {([
          ["all", "全部"],
          ["active", "运行中"],
          ["paused", "已暂停"],
          ["error", "异常"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cx(
              "rounded-full border px-3 py-1 text-xs transition",
              filter === key
                ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200",
            )}
          >
            {label}
            <span className="ml-1 text-[10px] text-slate-500">
              {key === "all" ? providers.length : providers.filter((p) => p.status === key).length}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<PlugsConnected size={26} />}
          title={providers.length === 0 ? "还没有接入渠道" : "该状态下没有渠道"}
          description={
            providers.length === 0
              ? "添加你的第一个上游供应商：OpenAI 官转、国内中转、DeepSeek、Claude 都行。API Key 只在你自己的数据库里。"
              : "换个筛选条件看看，或者新建一个渠道。"
          }
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} /> 添加渠道
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((p) => {
            const modelCount = models.filter((m) => m.providerId === p.id).length;
            const spent = logs.filter((l) => l.providerName === p.name).reduce((s, l) => s + l.cost, 0);
            const budgetRatio = p.monthlyBudget > 0 ? spent / p.monthlyBudget : 0;
            return (
              <Card key={p.id} className="group p-4 transition hover:border-white/20">
                <div className="flex items-start gap-3">
                  <span className={cx("rounded-lg border px-2 py-1 text-[10px] font-bold", VENDORS[p.vendor].accent)}>
                    {VENDORS[p.vendor].glyph}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-slate-100">{p.name}</h3>
                      <Badge tone={p.status === "active" ? "green" : p.status === "paused" ? "amber" : "rose"}>
                        {p.status === "active" ? "运行中" : p.status === "paused" ? "已暂停" : "异常"}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">{p.baseUrl}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-60 transition group-hover:opacity-100">
                    <Button size="sm" variant="subtle" title="编辑" onClick={() => setEditing(p)}>
                      <PencilSimple size={14} />
                    </Button>
                    <Button size="sm" variant="subtle" title="删除" onClick={() => setPendingDelete(p)}>
                      <Trash size={14} />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/5 bg-slate-950/50 px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">
                    {revealed[p.id] ? p.apiKey : maskSecret(p.apiKey)}
                  </code>
                  <button
                    className="text-slate-500 hover:text-slate-200"
                    onClick={() => setRevealed((r) => ({ ...r, [p.id]: !r[p.id] }))}
                    title={revealed[p.id] ? "隐藏" : "显示"}
                  >
                    {revealed[p.id] ? <EyeSlash size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    className="text-slate-500 hover:text-slate-200"
                    title="复制 Key"
                    onClick={() => {
                      void navigator.clipboard?.writeText(p.apiKey);
                      push("API Key 已复制到剪贴板", "info");
                    }}
                  >
                    <Copy size={13} />
                  </button>
                </div>

                <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
                  <Metric label="优先级" value={`P${p.priority}`} />
                  <Metric label="权重" value={`${p.weight}%`} />
                  <Metric label="RPM" value={String(p.rpmLimit)} />
                  <Metric label="模型" value={String(modelCount)} />
                </dl>

                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">本期消耗</span>
                    <span className={cx(budgetRatio > 0.9 ? "text-rose-300" : "text-slate-300")}>
                      {formatMoney(spent)} / {p.monthlyBudget > 0 ? formatMoney(p.monthlyBudget) : "不限"}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className={cx(
                        "h-full rounded-full bg-gradient-to-r transition-all duration-500",
                        budgetRatio > 0.9 ? "from-rose-500 to-red-500" : "from-violet-500 to-fuchsia-500",
                      )}
                      style={{ width: `${Math.min(100, budgetRatio * 100)}%` }}
                    />
                  </div>
                </div>

                {p.notes ? <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{p.notes}</p> : null}

                <div className="mt-3 flex gap-2 border-t border-white/5 pt-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void updateProvider(p.id, { status: p.status === "active" ? "paused" : "active" })
                    }
                  >
                    <DotsThreeVertical size={14} />
                    {p.status === "active" ? "暂停此渠道" : "恢复启用"}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ProviderFormModal
        open={creating}
        title="添加渠道"
        initial={emptyForm}
        onClose={() => setCreating(false)}
        onSubmit={async (data) => {
          await createProvider(data);
          setCreating(false);
        }}
      />
      <ProviderFormModal
        open={Boolean(editing)}
        title="编辑渠道"
        initial={editing ?? emptyForm}
        onClose={() => setEditing(null)}
        onSubmit={async (data) => {
          if (editing) await updateProvider(editing.id, data);
          setEditing(null);
        }}
      />

      <Modal
        open={Boolean(pendingDelete)}
        title="删除渠道？"
        description={`「${pendingDelete?.name ?? ""}」及其下所有模型映射都会被移除，此操作不可撤销。`}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) void deleteProvider(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">
          如果只是临时不想用，建议改成「已暂停」，这样历史账单和模型映射都会保留。
        </p>
      </Modal>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] py-1.5">
      <dt className="text-[10px] text-slate-500">{label}</dt>
      <dd className="text-xs font-semibold text-slate-200">{value}</dd>
    </div>
  );
}

function ProviderFormModal({
  open,
  title,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: ProviderInput;
  onClose: () => void;
  onSubmit: (data: ProviderInput) => Promise<void>;
}) {
  const [form, setForm] = useState<ProviderInput>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState("");

  // 打开时同步一次初始值
  const signature = `${open}-${initial.name}-${initial.apiKey}`;
  if (key !== signature) {
    setKey(signature);
    setForm(initial);
    setErrors({});
  }

  const set = <K extends keyof ProviderInput>(field: K, value: ProviderInput[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  async function submit() {
    const found = validateProvider(form);
    if (Object.keys(found).length > 0) {
      setErrors(found as Record<string, string>);
      return;
    }
    setSaving(true);
    await onSubmit(form);
    setSaving(false);
  }

  return (
    <Modal
      open={open}
      title={title}
      description="所有字段都可以之后再改，API Key 仅保存在你自己的数据库中。"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="渠道名称" error={errors.name}>
          <input
            className={inputClass}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="例如：主力中转 · Azure 池"
          />
        </Field>
        <Field label="供应商类型">
          <select
            className={inputClass}
            value={form.vendor}
            onChange={(e) => {
              const vendor = e.target.value as VendorId;
              setForm((f) => ({ ...f, vendor, baseUrl: VENDORS[vendor].baseUrl }));
            }}
          >
            {VENDOR_IDS.map((v) => (
              <option key={v} value={v} className="bg-slate-900">
                {VENDORS[v].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Base URL" className="sm:col-span-2" error={errors.baseUrl}>
          <input
            className={inputClass}
            value={form.baseUrl}
            onChange={(e) => set("baseUrl", e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <Field label="API Key" className="sm:col-span-2" error={errors.apiKey}>
          <input
            className={inputClass}
            value={form.apiKey}
            onChange={(e) => set("apiKey", e.target.value)}
            placeholder="sk-..."
          />
        </Field>
        <Field label="状态">
          <select
            className={inputClass}
            value={form.status}
            onChange={(e) => set("status", e.target.value as ProviderStatus)}
          >
            <option value="active" className="bg-slate-900">运行中</option>
            <option value="paused" className="bg-slate-900">已暂停</option>
            <option value="error" className="bg-slate-900">异常</option>
          </select>
        </Field>
        <Field label="优先级" hint="数字越小越优先">
          <input
            type="number"
            className={inputClass}
            value={form.priority}
            onChange={(e) => set("priority", Number(e.target.value))}
          />
        </Field>
        <Field label="权重" hint="同优先级分流比">
          <input
            type="number"
            className={inputClass}
            value={form.weight}
            onChange={(e) => set("weight", Number(e.target.value))}
          />
        </Field>
        <Field label="RPM 上限">
          <input
            type="number"
            className={inputClass}
            value={form.rpmLimit}
            onChange={(e) => set("rpmLimit", Number(e.target.value))}
          />
        </Field>
        <Field label="月度预算（元）" hint="0 表示不限">
          <input
            type="number"
            className={inputClass}
            value={form.monthlyBudget}
            onChange={(e) => set("monthlyBudget", Number(e.target.value))}
          />
        </Field>
        <Field label="备注" className="sm:col-span-2">
          <textarea
            className={cx(inputClass, "h-20 resize-none")}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="这个渠道适合干什么、有什么坑…"
          />
        </Field>
      </div>
    </Modal>
  );
}
