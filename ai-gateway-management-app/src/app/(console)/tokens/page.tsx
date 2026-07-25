"use client";

import { useState } from "react";
import { Copy, Eye, EyeSlash, Key, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
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
  ProgressBar,
  cx,
  inputClass,
} from "@/components/ui";
import {
  BOUND_APPS,
  formatDateTime,
  formatMoney,
  generateTokenSecret,
  isTokenExpired,
  maskSecret,
  tokenUsageRatio,
} from "@/core/logic";
import type { AccessToken, AccessTokenInput } from "@/core/types";

const emptyForm: AccessTokenInput = {
  name: "",
  boundApp: "SillyTavern 酒馆",
  quota: 50,
  status: "active",
  allowedModels: [],
  expiresAt: null,
};

export default function TokensPage() {
  const { tokens, models, loading, createToken, updateToken, deleteToken } = useGateway();
  const { push } = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AccessToken | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AccessToken | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">访问令牌</h1>
          <p className="mt-1 text-sm text-slate-400">
            发给各个客户端使用的 Key。可限定可用模型、额度上限与有效期，用完自动停。
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} weight="bold" /> 签发令牌
        </Button>
      </header>

      {loading ? (
        <ListSkeleton rows={3} />
      ) : tokens.length === 0 ? (
        <EmptyState
          icon={<Key size={26} />}
          title="还没有签发令牌"
          description="给酒馆、SullyOS、自建脚本各发一个令牌，这样某个 Key 泄漏时只用吊销那一个。"
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} /> 签发第一个令牌
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {tokens.map((t) => {
            const ratio = tokenUsageRatio(t);
            const expired = isTokenExpired(t);
            const disabled = t.status === "disabled" || expired;
            return (
              <Card key={t.id} className={cx("group p-4", disabled && "opacity-70")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400/20 to-orange-500/10 text-amber-300">
                    <Key size={16} weight="fill" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-slate-100">{t.name}</h3>
                      {expired ? (
                        <Badge tone="rose">已过期</Badge>
                      ) : t.status === "disabled" ? (
                        <Badge tone="slate">已停用</Badge>
                      ) : ratio >= 1 ? (
                        <Badge tone="rose">额度耗尽</Badge>
                      ) : ratio > 0.8 ? (
                        <Badge tone="amber">额度告急</Badge>
                      ) : (
                        <Badge tone="green">正常</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      绑定 {t.boundApp} · 创建于 {formatDateTime(t.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-60 transition group-hover:opacity-100">
                    <Button size="sm" variant="subtle" title="编辑" onClick={() => setEditing(t)}>
                      <PencilSimple size={14} />
                    </Button>
                    <Button size="sm" variant="subtle" title="吊销" onClick={() => setPendingDelete(t)}>
                      <Trash size={14} />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/5 bg-slate-950/50 px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">
                    {revealed[t.id] ? t.secret : maskSecret(t.secret)}
                  </code>
                  <button
                    className="text-slate-500 hover:text-slate-200"
                    onClick={() => setRevealed((r) => ({ ...r, [t.id]: !r[t.id] }))}
                  >
                    {revealed[t.id] ? <EyeSlash size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    className="text-slate-500 hover:text-slate-200"
                    onClick={() => {
                      void navigator.clipboard?.writeText(t.secret);
                      push("令牌已复制，粘贴到客户端即可使用", "info");
                    }}
                  >
                    <Copy size={13} />
                  </button>
                </div>

                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">额度使用</span>
                    <span className="text-slate-300">
                      {formatMoney(t.used)} / {formatMoney(t.quota)}
                    </span>
                  </div>
                  <ProgressBar value={ratio} tone={ratio > 0.9 ? "rose" : ratio > 0.7 ? "amber" : "violet"} />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {t.allowedModels.length === 0 ? (
                    <Badge tone="cyan">全部模型可用</Badge>
                  ) : (
                    t.allowedModels.map((m) => (
                      <Badge key={m} tone="slate">
                        {m}
                      </Badge>
                    ))
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-3 text-[11px] text-slate-500">
                  <span>{t.expiresAt ? `到期 ${formatDateTime(t.expiresAt)}` : "长期有效"}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void updateToken(t.id, { status: t.status === "active" ? "disabled" : "active" })
                    }
                  >
                    {t.status === "active" ? "停用" : "启用"}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <TokenFormModal
        open={creating}
        title="签发新令牌"
        initial={emptyForm}
        modelNames={models.map((m) => m.displayName)}
        onClose={() => setCreating(false)}
        onSubmit={async (data) => {
          await createToken({ ...data, secret: generateTokenSecret() });
          setCreating(false);
        }}
      />
      <TokenFormModal
        open={Boolean(editing)}
        title="编辑令牌"
        initial={editing ?? emptyForm}
        modelNames={models.map((m) => m.displayName)}
        onClose={() => setEditing(null)}
        onSubmit={async (data) => {
          if (editing) await updateToken(editing.id, data);
          setEditing(null);
        }}
      />

      <Modal
        open={Boolean(pendingDelete)}
        title="吊销令牌？"
        description={`「${pendingDelete?.name ?? ""}」将立即失效，使用它的客户端会全部报 401。`}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) void deleteToken(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              确认吊销
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">历史调用日志会保留，方便你事后对账。</p>
      </Modal>
    </div>
  );
}

function TokenFormModal({
  open,
  title,
  initial,
  modelNames,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: AccessTokenInput;
  modelNames: string[];
  onClose: () => void;
  onSubmit: (data: AccessTokenInput) => Promise<void>;
}) {
  const [form, setForm] = useState<AccessTokenInput>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sig, setSig] = useState("");

  const signature = `${open}-${initial.name}-${initial.quota}`;
  if (sig !== signature) {
    setSig(signature);
    setForm(initial);
    setError(null);
  }

  const set = <K extends keyof AccessTokenInput>(field: K, value: AccessTokenInput[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  return (
    <Modal
      open={open}
      title={title}
      description="令牌明文只保存在你的库里，页面上默认打码显示。"
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
              if (!form.name.trim()) {
                setError("请填写令牌名称");
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
        <Field label="令牌名称" error={error ?? undefined}>
          <input
            className={inputClass}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="酒馆主号 / 手机端 / 群友借用"
          />
        </Field>
        <Field label="绑定应用">
          <select
            className={inputClass}
            value={form.boundApp}
            onChange={(e) => set("boundApp", e.target.value)}
          >
            {BOUND_APPS.map((a) => (
              <option key={a} value={a} className="bg-slate-900">
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="额度上限（元）">
          <input
            type="number"
            className={inputClass}
            value={form.quota}
            onChange={(e) => set("quota", Number(e.target.value))}
          />
        </Field>
        <Field label="到期时间" hint="留空则长期有效">
          <input
            type="date"
            className={inputClass}
            value={form.expiresAt ? form.expiresAt.slice(0, 10) : ""}
            onChange={(e) =>
              set("expiresAt", e.target.value ? new Date(e.target.value).toISOString() : null)
            }
          />
        </Field>
        <Field label="可用模型" className="sm:col-span-2" hint="不选则全部可用">
          <div className="flex flex-wrap gap-2 pt-1">
            {modelNames.length === 0 ? (
              <p className="text-[11px] text-slate-500">还没有模型映射，先去「模型路由」建一个。</p>
            ) : (
              modelNames.map((name) => {
                const active = form.allowedModels.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() =>
                      set(
                        "allowedModels",
                        active
                          ? form.allowedModels.filter((m) => m !== name)
                          : [...form.allowedModels, name],
                      )
                    }
                    className={cx(
                      "rounded-full border px-2.5 py-1 text-[11px] transition",
                      active
                        ? "border-violet-400/40 bg-violet-500/20 text-violet-200"
                        : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200",
                    )}
                  >
                    {name}
                  </button>
                );
              })
            )}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
