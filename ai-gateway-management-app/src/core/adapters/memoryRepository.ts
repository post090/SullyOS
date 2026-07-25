import { buildDemoDataset } from "../demoData";
import { computeStats, generateTokenSecret } from "../logic";
import type { GatewayRepository } from "../port";
import type { AccessToken, CallLog, ModelRoute, Provider } from "../types";

/**
 * 内存适配器：不依赖任何后端，用于离线预览 / 单元测试。
 * SullyOS 迁移时可以直接照抄这个文件的结构，把 Map 换成 IndexedDB store。
 */
export function createMemoryRepository(now = new Date()): GatewayRepository {
  const iso = now.toISOString();
  const dataset = buildDemoDataset(now);
  const providerIds = new Map<string, string>();
  let seq = 0;
  const id = () => `mem-${(seq += 1)}`;

  const providers: Provider[] = dataset.providers.map((p) => {
    const pid = id();
    providerIds.set(p.key, pid);
    const { key: _key, ...rest } = p;
    void _key;
    return { ...rest, id: pid, createdAt: iso, updatedAt: iso };
  });
  const models: ModelRoute[] = dataset.models.map((m) => {
    const { providerKey, ...rest } = m;
    return { ...rest, providerId: providerIds.get(providerKey) ?? "", id: id(), createdAt: iso, updatedAt: iso };
  });
  const tokens: AccessToken[] = dataset.tokens.map((t) => ({
    ...t,
    id: id(),
    createdAt: iso,
    updatedAt: iso,
  }));
  let logs: CallLog[] = dataset.logs
    .map((l) => ({ ...l, id: id(), createdAt: l.createdAt ?? iso }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const touch = () => new Date().toISOString();

  return {
    async listProviders() {
      return [...providers].sort((a, b) => a.priority - b.priority);
    },
    async createProvider(input) {
      const row: Provider = { ...input, id: id(), createdAt: touch(), updatedAt: touch() };
      providers.push(row);
      return row;
    },
    async updateProvider(pid, input) {
      const idx = providers.findIndex((p) => p.id === pid);
      if (idx < 0) throw new Error("渠道不存在");
      providers[idx] = { ...providers[idx], ...input, updatedAt: touch() };
      return providers[idx];
    },
    async deleteProvider(pid) {
      const idx = providers.findIndex((p) => p.id === pid);
      if (idx >= 0) providers.splice(idx, 1);
    },
    async listModels() {
      return [...models];
    },
    async createModel(input) {
      const row: ModelRoute = { ...input, id: id(), createdAt: touch(), updatedAt: touch() };
      models.push(row);
      return row;
    },
    async updateModel(mid, input) {
      const idx = models.findIndex((m) => m.id === mid);
      if (idx < 0) throw new Error("模型不存在");
      models[idx] = { ...models[idx], ...input, updatedAt: touch() };
      return models[idx];
    },
    async deleteModel(mid) {
      const idx = models.findIndex((m) => m.id === mid);
      if (idx >= 0) models.splice(idx, 1);
    },
    async listTokens() {
      return [...tokens];
    },
    async createToken(input) {
      const row: AccessToken = {
        ...input,
        secret: input.secret ?? generateTokenSecret(),
        used: input.used ?? 0,
        id: id(),
        createdAt: touch(),
        updatedAt: touch(),
      };
      tokens.push(row);
      return row;
    },
    async updateToken(tid, input) {
      const idx = tokens.findIndex((t) => t.id === tid);
      if (idx < 0) throw new Error("令牌不存在");
      tokens[idx] = { ...tokens[idx], ...input, updatedAt: touch() };
      return tokens[idx];
    },
    async deleteToken(tid) {
      const idx = tokens.findIndex((t) => t.id === tid);
      if (idx >= 0) tokens.splice(idx, 1);
    },
    async listLogs(limit = 100) {
      return logs.slice(0, limit);
    },
    async createLog(input) {
      const row: CallLog = { ...input, id: id(), createdAt: input.createdAt ?? touch() };
      logs = [row, ...logs];
      return row;
    },
    async deleteLog(lid) {
      logs = logs.filter((l) => l.id !== lid);
    },
    async clearLogs() {
      logs = [];
    },
    async getStats() {
      return computeStats(providers, tokens, logs);
    },
  };
}
