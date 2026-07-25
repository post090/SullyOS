"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createHttpRepository } from "@/core/adapters/httpRepository";
import { computeStats } from "@/core/logic";
import type { GatewayRepository } from "@/core/port";
import type {
  AccessToken,
  AccessTokenInput,
  CallLog,
  CallLogInput,
  DashboardStats,
  ModelRoute,
  ModelRouteInput,
  Provider,
  ProviderInput,
} from "@/core/types";
import { useToast } from "@/components/toast";

/**
 * 应用状态层：只依赖 `GatewayRepository` 端口。
 * 换后端 = 换传进来的 repository，UI 与本文件都不用改。
 */

interface GatewayContextValue {
  loading: boolean;
  error: string | null;
  providers: Provider[];
  models: ModelRoute[];
  tokens: AccessToken[];
  logs: CallLog[];
  stats: DashboardStats | null;
  refresh: () => Promise<void>;
  createProvider: (input: ProviderInput) => Promise<void>;
  updateProvider: (id: string, patch: Partial<ProviderInput>) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  createModel: (input: ModelRouteInput) => Promise<void>;
  updateModel: (id: string, patch: Partial<ModelRouteInput>) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  createToken: (input: AccessTokenInput) => Promise<AccessToken | null>;
  updateToken: (id: string, patch: Partial<AccessTokenInput>) => Promise<void>;
  deleteToken: (id: string) => Promise<void>;
  createLog: (input: CallLogInput) => Promise<void>;
  deleteLog: (id: string) => Promise<void>;
  clearLogs: () => Promise<void>;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

const tempId = () => `temp-${Math.random().toString(36).slice(2)}`;

export function GatewayProvider({
  children,
  repository,
}: {
  children: ReactNode;
  repository?: GatewayRepository;
}) {
  const repoRef = useRef<GatewayRepository>(repository ?? createHttpRepository());
  const repo = repoRef.current;
  const { push } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<ModelRoute[]>([]);
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [p, m, t, l, s] = await Promise.all([
        repo.listProviders(),
        repo.listModels(),
        repo.listTokens(),
        repo.listLogs(200),
        repo.getStats(),
      ]);
      setProviders(p);
      setModels(m);
      setTokens(t);
      setLogs(l);
      setStats(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 本地重算统计，避免每次改动都往服务端多打一次请求（乐观 UI）。 */
  const recomputeStats = useCallback(
    (p: Provider[], t: AccessToken[], l: CallLog[]) => setStats(computeStats(p, t, l)),
    [],
  );

  const fail = useCallback(
    (e: unknown, fallback: string) => {
      push(e instanceof Error ? e.message : fallback, "error");
    },
    [push],
  );

  // ---------- 渠道 ----------
  const createProvider = useCallback(
    async (input: ProviderInput) => {
      const optimistic: Provider = {
        ...input,
        id: tempId(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setProviders((prev) => [...prev, optimistic]);
      try {
        const saved = await repo.createProvider(input);
        setProviders((prev) => prev.map((p) => (p.id === optimistic.id ? saved : p)));
        push(`渠道「${saved.name}」已创建`);
      } catch (e) {
        setProviders((prev) => prev.filter((p) => p.id !== optimistic.id));
        fail(e, "创建渠道失败");
      }
    },
    [repo, push, fail],
  );

  const updateProvider = useCallback(
    async (id: string, patch: Partial<ProviderInput>) => {
      const snapshot = providers;
      setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
      try {
        const saved = await repo.updateProvider(id, patch);
        setProviders((prev) => prev.map((p) => (p.id === id ? saved : p)));
      } catch (e) {
        setProviders(snapshot);
        fail(e, "更新渠道失败");
      }
    },
    [repo, providers, fail],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      const snapshot = providers;
      const modelSnapshot = models;
      setProviders((prev) => prev.filter((p) => p.id !== id));
      setModels((prev) => prev.filter((m) => m.providerId !== id));
      try {
        await repo.deleteProvider(id);
        push("渠道已删除，关联模型一并移除", "info");
      } catch (e) {
        setProviders(snapshot);
        setModels(modelSnapshot);
        fail(e, "删除渠道失败");
      }
    },
    [repo, providers, models, push, fail],
  );

  // ---------- 模型 ----------
  const createModel = useCallback(
    async (input: ModelRouteInput) => {
      const optimistic: ModelRoute = {
        ...input,
        id: tempId(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setModels((prev) => [...prev, optimistic]);
      try {
        const saved = await repo.createModel(input);
        setModels((prev) => prev.map((m) => (m.id === optimistic.id ? saved : m)));
        push(`模型「${saved.displayName}」已上线`);
      } catch (e) {
        setModels((prev) => prev.filter((m) => m.id !== optimistic.id));
        fail(e, "创建模型失败");
      }
    },
    [repo, push, fail],
  );

  const updateModel = useCallback(
    async (id: string, patch: Partial<ModelRouteInput>) => {
      const snapshot = models;
      setModels((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
      try {
        const saved = await repo.updateModel(id, patch);
        setModels((prev) => prev.map((m) => (m.id === id ? saved : m)));
      } catch (e) {
        setModels(snapshot);
        fail(e, "更新模型失败");
      }
    },
    [repo, models, fail],
  );

  const deleteModel = useCallback(
    async (id: string) => {
      const snapshot = models;
      setModels((prev) => prev.filter((m) => m.id !== id));
      try {
        await repo.deleteModel(id);
        push("模型映射已删除", "info");
      } catch (e) {
        setModels(snapshot);
        fail(e, "删除模型失败");
      }
    },
    [repo, models, push, fail],
  );

  // ---------- 令牌 ----------
  const createToken = useCallback(
    async (input: AccessTokenInput) => {
      try {
        const saved = await repo.createToken(input);
        setTokens((prev) => [saved, ...prev]);
        recomputeStats(providers, [saved, ...tokens], logs);
        push(`令牌「${saved.name}」已签发`);
        return saved;
      } catch (e) {
        fail(e, "签发令牌失败");
        return null;
      }
    },
    [repo, providers, tokens, logs, recomputeStats, push, fail],
  );

  const updateToken = useCallback(
    async (id: string, patch: Partial<AccessTokenInput>) => {
      const snapshot = tokens;
      const next = tokens.map((t) => (t.id === id ? { ...t, ...patch } : t));
      setTokens(next);
      recomputeStats(providers, next, logs);
      try {
        const saved = await repo.updateToken(id, patch);
        setTokens((prev) => prev.map((t) => (t.id === id ? saved : t)));
      } catch (e) {
        setTokens(snapshot);
        recomputeStats(providers, snapshot, logs);
        fail(e, "更新令牌失败");
      }
    },
    [repo, tokens, providers, logs, recomputeStats, fail],
  );

  const deleteToken = useCallback(
    async (id: string) => {
      const snapshot = tokens;
      const next = tokens.filter((t) => t.id !== id);
      setTokens(next);
      recomputeStats(providers, next, logs);
      try {
        await repo.deleteToken(id);
        push("令牌已吊销", "info");
      } catch (e) {
        setTokens(snapshot);
        recomputeStats(providers, snapshot, logs);
        fail(e, "吊销令牌失败");
      }
    },
    [repo, tokens, providers, logs, recomputeStats, push, fail],
  );

  // ---------- 日志 ----------
  const createLog = useCallback(
    async (input: CallLogInput) => {
      const optimistic: CallLog = {
        ...input,
        id: tempId(),
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      const next = [optimistic, ...logs];
      setLogs(next);
      recomputeStats(providers, tokens, next);
      try {
        const saved = await repo.createLog(input);
        setLogs((prev) => prev.map((l) => (l.id === optimistic.id ? saved : l)));
        setTokens((prev) =>
          prev.map((t) => (t.name === input.tokenName ? { ...t, used: t.used + input.cost } : t)),
        );
      } catch (e) {
        setLogs(logs);
        recomputeStats(providers, tokens, logs);
        fail(e, "写入日志失败");
      }
    },
    [repo, logs, providers, tokens, recomputeStats, fail],
  );

  const deleteLog = useCallback(
    async (id: string) => {
      const snapshot = logs;
      const next = logs.filter((l) => l.id !== id);
      setLogs(next);
      recomputeStats(providers, tokens, next);
      try {
        await repo.deleteLog(id);
      } catch (e) {
        setLogs(snapshot);
        recomputeStats(providers, tokens, snapshot);
        fail(e, "删除日志失败");
      }
    },
    [repo, logs, providers, tokens, recomputeStats, fail],
  );

  const clearLogs = useCallback(async () => {
    const snapshot = logs;
    setLogs([]);
    recomputeStats(providers, tokens, []);
    try {
      await repo.clearLogs();
      push("日志已清空", "info");
    } catch (e) {
      setLogs(snapshot);
      recomputeStats(providers, tokens, snapshot);
      fail(e, "清空日志失败");
    }
  }, [repo, logs, providers, tokens, recomputeStats, push, fail]);

  const value = useMemo<GatewayContextValue>(
    () => ({
      loading,
      error,
      providers,
      models,
      tokens,
      logs,
      stats,
      refresh,
      createProvider,
      updateProvider,
      deleteProvider,
      createModel,
      updateModel,
      deleteModel,
      createToken,
      updateToken,
      deleteToken,
      createLog,
      deleteLog,
      clearLogs,
    }),
    [
      loading,
      error,
      providers,
      models,
      tokens,
      logs,
      stats,
      refresh,
      createProvider,
      updateProvider,
      deleteProvider,
      createModel,
      updateModel,
      deleteModel,
      createToken,
      updateToken,
      deleteToken,
      createLog,
      deleteLog,
      clearLogs,
    ],
  );

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway() {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error("useGateway 必须在 GatewayProvider 内使用");
  return ctx;
}
