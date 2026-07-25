"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, MagnifyingGlass, PencilSimple, Plus, Robot, Trash } from "@phosphor-icons/react";
import { useGateway } from "@/features/gateway/store";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  ListSkeleton,
  Modal,
  Toggle,
  cx,
  inputClass,
} from "@/components/ui";
import { MODEL_TAGS, VENDORS, formatNumber, validateModel } from "@/core/logic";
import type { ModelRoute, ModelRouteInput } from "@/core/types";

const emptyForm: ModelRouteInput = {
  providerId: "",
  displayName: "",
  upstreamModel: "",
  contextWindow: 128000,
  inputPrice: 0.01,
  outputPrice: 0.03,
  tags: [],
  enabled: true,
};

export default function ModelsPage() {
  const { models, providers, logs, loading, createModel, updateModel, deleteModel } = useGateway();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ModelRoute | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ModelRoute | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.upstreamModel.toLowerCase().includes(q) ||
        m.tags.some((t) => t.includes(q)),
    );
  }, [models, query]);

  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? "（渠道已删除）";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">模型路由</h1>
          <p className="mt-1 text-sm text-slate-400">
            对外模型别名 → 上游真实模型。酒馆里只填别名，换供应商时改这里就行。
          </p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={providers.length === 0}>
          <Plus size={16} weight="bold" /> 新增映射
        </Button>
      </header>

      <div className="relative">
        <MagnifyingGlass size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          className={cx(inputClass, "pl-9")}
          placeholder="搜索模型别名 / 上游名 / 标签"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : providers.length === 0 ? (
        <EmptyState
          icon={<Robot size={26} />}
          title="先去接一个渠道"
          description="模型映射必须挂在某个上游渠道下，所以第一步是去「渠道管理」添加供应商。"
          action={
            <Link href="/providers">
              <Button size="sm">
                去添加渠道 <ArrowRight size={14} />
              </Button>
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Robot size={26} />}
          title={models.length === 0 ? "还没有模型映射" : "没有匹配的模型"}
          description={
            models.length === 0
              ? "给上游模型起一个好记的别名，比如把 claude-3-opus 映射成「claude-opus-剧情」。"
              : "换个关键词试试。"
          }
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} /> 新增映射
            </Button>
          }
        />
      ) : (
        <Card className="divide-y divide-white/5 overflow-hidden">
          {filtered.map((m) => {
            const provider = providers.find((p) => p.id === m.providerId);
            const calls = logs.filter((l) => l.modelName === m.displayName).length;
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-3 p-4 transition hover:bg-white/[0.02]">
                <span
                  className={cx(
                    "rounded-lg border px-2 py-1 text-[10px] font-bold",
                    provider ? VENDORS[provider.vendor].accent : "border-white/10 text-slate-400",
                  )}
                >
                  {provider ? VENDORS[provider.vendor].glyph : "?"}
                </span>
                <div className="min-w-[12rem] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm font-semibold text-slate-100">{m.displayName}</code>
                    {!m.enabled ? <Badge tone="slate">已下线</Badge> : null}
                    {m.tags.map((t) => (
                      <Badge key={t} tone="violet">
                        {t}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    → {m.upstreamModel} · {providerName(m.providerId)} · 上下文 {formatNumber(m.contextWindow)}
                  </p>
                </div>
                <div className="text-right text-[11px] text-slate-400">
                  <p>
                    ¥{m.inputPrice.toFixed(3)} / ¥{m.outputPrice.toFixed(3)}
                    <span className="text-slate-600"> 每千 tok</span>
                  </p>
                  <p className="text-slate-500">近期调用 {calls} 次</p>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle checked={m.enabled} onChange={(v) => void updateModel(m.id, { enabled: v })} />
                  <Button size="sm" variant="subtle" title="编辑" onClick={() => setEditing(m)}>
                    <PencilSimple size={14} />
                  </Button>
                  <Button size="sm" variant="subtle" title="删除" onClick={() => setPendingDelete(m)}>
                    <Trash size={14} />
                  </Button>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <ModelFormModal
        open={creating}
        title="新增模型映射"
        initial={{ ...emptyForm, providerId: providers[0]?.id ?? "" }}
        onClose={() => setCreating(false)}
        onSubmit={async (data) => {
          await createModel(data);
          setCreating(false);
        }}
      />
      <ModelFormModal
        open={Boolean(editing)}
        title="编辑模型映射"
        initial={editing ?? emptyForm}
        onClose={() => setEditing(null)}
        onSubmit={async (data) => {
          if (editing) await updateModel(editing.id, data);
          setEditing(null);
        }}
      />

      <Modal
        open={Boolean(pendingDelete)}
        title="删除模型映射？"
        description={`别名「${pendingDelete?.displayName ?? ""}」将立即失效，正在使用它的客户端会收到 404。`}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) void deleteModel(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">只是暂时不用的话，右侧开关下线更安全。</p>
      </Modal>
    </div>
  );
}

function ModelFormModal({
  open,
  title,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: ModelRouteInput;
  onClose: () => void;
  onSubmit: (data: ModelRouteInput) => Promise<void>;
}) {
  const { providers } = useGateway();
  const [form, setForm] = useState<ModelRouteInput>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [sig, setSig] = useState("");

  const signature = `${open}-${initial.displayName}-${initial.upstreamModel}`;
  if (sig !== signature) {
    setSig(signature);
    setForm(initial);
    setErrors({});
  }

  const set = <K extends keyof ModelRouteInput>(field: K, value: ModelRouteInput[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  return (
    <Modal
      open={open}
      title={title}
      description="别名建议起得像人话，酒馆里选起来方便。"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={saving}
            onClick={async () => {
              const found = validateModel(form);
              if (Object.keys(found).length > 0) {
                setErrors(found);
                return;
              }
              setSaving(true);
              await onSubmit(form);
              setSaving(false);
            }}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="对外模型别名" error={errors.displayName}>
          <input
            className={inputClass}
            value={form.displayName}
            onChange={(e) => set("displayName", e.target.value)}
            placeholder="claude-opus-剧情"
          />
        </Field>
        <Field label="上游真实模型名" error={errors.upstreamModel}>
          <input
            className={inputClass}
            value={form.upstreamModel}
            onChange={(e) => set("upstreamModel", e.target.value)}
            placeholder="claude-3-opus-20240229"
          />
        </Field>
        <Field label="所属渠道" error={errors.providerId}>
          <select
            className={inputClass}
            value={form.providerId}
            onChange={(e) => set("providerId", e.target.value)}
          >
            <option value="" className="bg-slate-900">请选择…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id} className="bg-slate-900">
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="上下文长度">
          <input
            type="number"
            className={inputClass}
            value={form.contextWindow}
            onChange={(e) => set("contextWindow", Number(e.target.value))}
          />
        </Field>
        <Field label="输入价（元 / 千 tokens）">
          <input
            type="number"
            step="0.001"
            className={inputClass}
            value={form.inputPrice}
            onChange={(e) => set("inputPrice", Number(e.target.value))}
          />
        </Field>
        <Field label="输出价（元 / 千 tokens）">
          <input
            type="number"
            step="0.001"
            className={inputClass}
            value={form.outputPrice}
            onChange={(e) => set("outputPrice", Number(e.target.value))}
          />
        </Field>
        <Field label="标签" className="sm:col-span-2" hint="点击切换">
          <div className="flex flex-wrap gap-2 pt-1">
            {MODEL_TAGS.map((tag) => {
              const active = form.tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() =>
                    set("tags", active ? form.tags.filter((t) => t !== tag) : [...form.tags, tag])
                  }
                  className={cx(
                    "rounded-full border px-2.5 py-1 text-[11px] transition",
                    active
                      ? "border-violet-400/40 bg-violet-500/20 text-violet-200"
                      : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200",
                  )}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="sm:col-span-2">
          <Toggle checked={form.enabled} onChange={(v) => set("enabled", v)} label="立即上线该模型" />
        </div>
      </div>
    </Modal>
  );
}
