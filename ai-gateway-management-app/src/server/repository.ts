import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { callLogs, models, providers, tokens } from "@/db/schema";
import { computeStats, generateTokenSecret } from "@/core/logic";
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
  ProviderStatus,
  TokenStatus,
  VendorId,
  CallStatus,
} from "@/core/types";

/**
 * Drizzle 适配器（服务端）。实现 `GatewayRepository` 的语义，
 * 但显式接收 userId —— 多租户隔离只发生在这一层。
 */

type ProviderRow = typeof providers.$inferSelect;
type ModelRow = typeof models.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;
type LogRow = typeof callLogs.$inferSelect;

const toProvider = (r: ProviderRow): Provider => ({
  id: r.id,
  name: r.name,
  vendor: r.vendor as VendorId,
  baseUrl: r.baseUrl,
  apiKey: r.apiKey,
  status: r.status as ProviderStatus,
  priority: r.priority,
  weight: r.weight,
  rpmLimit: r.rpmLimit,
  monthlyBudget: r.monthlyBudget,
  notes: r.notes,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toModel = (r: ModelRow): ModelRoute => ({
  id: r.id,
  providerId: r.providerId,
  displayName: r.displayName,
  upstreamModel: r.upstreamModel,
  contextWindow: r.contextWindow,
  inputPrice: r.inputPrice,
  outputPrice: r.outputPrice,
  tags: r.tags ?? [],
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toToken = (r: TokenRow): AccessToken => ({
  id: r.id,
  name: r.name,
  secret: r.secret,
  boundApp: r.boundApp,
  quota: r.quota,
  used: r.used,
  status: r.status as TokenStatus,
  allowedModels: r.allowedModels ?? [],
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toLog = (r: LogRow): CallLog => ({
  id: r.id,
  tokenName: r.tokenName,
  providerName: r.providerName,
  modelName: r.modelName,
  promptTokens: r.promptTokens,
  completionTokens: r.completionTokens,
  cost: r.cost,
  latencyMs: r.latencyMs,
  status: r.status as CallStatus,
  errorMessage: r.errorMessage,
  createdAt: r.createdAt.toISOString(),
});

export const serverRepo = {
  async listProviders(userId: string): Promise<Provider[]> {
    const rows = await db
      .select()
      .from(providers)
      .where(eq(providers.userId, userId))
      .orderBy(providers.priority, providers.createdAt);
    return rows.map(toProvider);
  },

  async createProvider(userId: string, input: ProviderInput): Promise<Provider> {
    const [row] = await db.insert(providers).values({ ...input, userId }).returning();
    return toProvider(row);
  },

  async updateProvider(userId: string, id: string, input: Partial<ProviderInput>): Promise<Provider> {
    const [row] = await db
      .update(providers)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(providers.id, id), eq(providers.userId, userId)))
      .returning();
    if (!row) throw new Error("渠道不存在");
    return toProvider(row);
  },

  async deleteProvider(userId: string, id: string): Promise<void> {
    await db.delete(providers).where(and(eq(providers.id, id), eq(providers.userId, userId)));
  },

  async listModels(userId: string): Promise<ModelRoute[]> {
    const rows = await db
      .select()
      .from(models)
      .where(eq(models.userId, userId))
      .orderBy(models.displayName);
    return rows.map(toModel);
  },

  async createModel(userId: string, input: ModelRouteInput): Promise<ModelRoute> {
    const [row] = await db.insert(models).values({ ...input, userId }).returning();
    return toModel(row);
  },

  async updateModel(userId: string, id: string, input: Partial<ModelRouteInput>): Promise<ModelRoute> {
    const [row] = await db
      .update(models)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(models.id, id), eq(models.userId, userId)))
      .returning();
    if (!row) throw new Error("模型不存在");
    return toModel(row);
  },

  async deleteModel(userId: string, id: string): Promise<void> {
    await db.delete(models).where(and(eq(models.id, id), eq(models.userId, userId)));
  },

  async listTokens(userId: string): Promise<AccessToken[]> {
    const rows = await db
      .select()
      .from(tokens)
      .where(eq(tokens.userId, userId))
      .orderBy(desc(tokens.createdAt));
    return rows.map(toToken);
  },

  async createToken(userId: string, input: AccessTokenInput): Promise<AccessToken> {
    const [row] = await db
      .insert(tokens)
      .values({
        userId,
        name: input.name,
        secret: input.secret ?? generateTokenSecret(),
        boundApp: input.boundApp,
        quota: input.quota,
        used: input.used ?? 0,
        status: input.status,
        allowedModels: input.allowedModels ?? [],
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning();
    return toToken(row);
  },

  async updateToken(userId: string, id: string, input: Partial<AccessTokenInput>): Promise<AccessToken> {
    const { expiresAt, ...rest } = input;
    const [row] = await db
      .update(tokens)
      .set({
        ...rest,
        ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(tokens.id, id), eq(tokens.userId, userId)))
      .returning();
    if (!row) throw new Error("令牌不存在");
    return toToken(row);
  },

  async deleteToken(userId: string, id: string): Promise<void> {
    await db.delete(tokens).where(and(eq(tokens.id, id), eq(tokens.userId, userId)));
  },

  async listLogs(userId: string, limit = 100): Promise<CallLog[]> {
    const rows = await db
      .select()
      .from(callLogs)
      .where(eq(callLogs.userId, userId))
      .orderBy(desc(callLogs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(toLog);
  },

  async createLog(userId: string, input: CallLogInput): Promise<CallLog> {
    const [row] = await db
      .insert(callLogs)
      .values({
        userId,
        tokenName: input.tokenName,
        providerName: input.providerName,
        modelName: input.modelName,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        cost: input.cost,
        latencyMs: input.latencyMs,
        status: input.status,
        errorMessage: input.errorMessage ?? "",
        ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
      })
      .returning();
    // 同步扣减对应令牌额度（网关真实行为的简化模拟）
    if (input.cost > 0) {
      await db
        .update(tokens)
        .set({ used: sql`${tokens.used} + ${input.cost}` })
        .where(and(eq(tokens.userId, userId), eq(tokens.name, input.tokenName)));
    }
    return toLog(row);
  },

  async deleteLog(userId: string, id: string): Promise<void> {
    await db.delete(callLogs).where(and(eq(callLogs.id, id), eq(callLogs.userId, userId)));
  },

  async clearLogs(userId: string): Promise<void> {
    await db.delete(callLogs).where(eq(callLogs.userId, userId));
  },

  async getStats(userId: string): Promise<DashboardStats> {
    const [providerRows, tokenRows, logRows] = await Promise.all([
      this.listProviders(userId),
      this.listTokens(userId),
      db
        .select()
        .from(callLogs)
        .where(eq(callLogs.userId, userId))
        .orderBy(desc(callLogs.createdAt))
        .limit(2000),
    ]);
    return computeStats(providerRows, tokenRows, logRows.map(toLog));
  },
};
