import type {
  AccessToken,
  CallLog,
  DashboardStats,
  ModelRoute,
  Provider,
  VendorId,
} from "./types";

/** 纯函数工具集：无副作用，可在任何运行时（Next.js / Vite / Worker）复用。 */

export const VENDORS: Record<VendorId, { label: string; baseUrl: string; accent: string; glyph: string }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", accent: "text-emerald-300 bg-emerald-500/10 border-emerald-400/20", glyph: "GPT" },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", accent: "text-orange-300 bg-orange-500/10 border-orange-400/20", glyph: "CLD" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", accent: "text-sky-300 bg-sky-500/10 border-sky-400/20", glyph: "GMN" },
  deepseek: { label: "DeepSeek 深度求索", baseUrl: "https://api.deepseek.com/v1", accent: "text-indigo-300 bg-indigo-500/10 border-indigo-400/20", glyph: "DSK" },
  moonshot: { label: "Moonshot 月之暗面", baseUrl: "https://api.moonshot.cn/v1", accent: "text-violet-300 bg-violet-500/10 border-violet-400/20", glyph: "KIMI" },
  zhipu: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", accent: "text-cyan-300 bg-cyan-500/10 border-cyan-400/20", glyph: "GLM" },
  custom: { label: "自建 / 中转", baseUrl: "https://", accent: "text-slate-300 bg-slate-500/10 border-slate-400/20", glyph: "API" },
};

export const VENDOR_IDS = Object.keys(VENDORS) as VendorId[];

export const BOUND_APPS = ["SillyTavern 酒馆", "SullyOS", "Cherry Studio", "自建脚本", "其他"];

export const MODEL_TAGS = ["角色扮演", "长上下文", "高速", "低成本", "推理", "翻译", "NSFW 宽松", "视觉"];

export function maskSecret(secret: string): string {
  if (!secret) return "——";
  if (secret.length <= 12) return `${secret.slice(0, 3)}••••`;
  return `${secret.slice(0, 7)}••••••${secret.slice(-4)}`;
}

export function formatMoney(value: number): string {
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(value: number): string {
  if (value >= 100000) return `${(value / 10000).toFixed(1)}万`;
  return value.toLocaleString("zh-CN");
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "——";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "——";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

export function generateTokenSecret(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `sk-airp-${out}`;
}

export function tokenUsageRatio(token: AccessToken): number {
  if (token.quota <= 0) return 0;
  return Math.min(1, token.used / token.quota);
}

export function isTokenExpired(token: AccessToken, now = new Date()): boolean {
  if (!token.expiresAt) return false;
  return new Date(token.expiresAt).getTime() < now.getTime();
}

export function estimateCallCost(model: ModelRoute, promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens / 1000) * model.inputPrice + (completionTokens / 1000) * model.outputPrice
  );
}

export interface ProviderValidationErrors {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
}

export function validateProvider(input: { name: string; baseUrl: string; apiKey: string }): ProviderValidationErrors {
  const errors: ProviderValidationErrors = {};
  if (!input.name.trim()) errors.name = "请填写渠道名称";
  if (!/^https?:\/\/.+/.test(input.baseUrl.trim())) errors.baseUrl = "Base URL 需以 http(s):// 开头";
  if (input.apiKey.trim().length < 6) errors.apiKey = "API Key 至少 6 位";
  return errors;
}

export function validateModel(input: { displayName: string; upstreamModel: string; providerId: string }) {
  const errors: Record<string, string> = {};
  if (!input.displayName.trim()) errors.displayName = "请填写对外模型名";
  if (!input.upstreamModel.trim()) errors.upstreamModel = "请填写上游模型名";
  if (!input.providerId) errors.providerId = "请选择所属渠道";
  return errors;
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 由原始数据算出仪表盘统计（服务端与内存适配器共用同一份逻辑）。 */
export function computeStats(
  providers: Provider[],
  tokens: AccessToken[],
  logs: CallLog[],
  now = new Date(),
): DashboardStats {
  const totalCalls = logs.length;
  const success = logs.filter((l) => l.status === "success").length;
  const totalCost = logs.reduce((sum, l) => sum + l.cost, 0);
  const totalTokens = logs.reduce((sum, l) => sum + l.promptTokens + l.completionTokens, 0);
  const avgLatency = totalCalls ? Math.round(logs.reduce((s, l) => s + l.latencyMs, 0) / totalCalls) : 0;

  const daily: DashboardStats["daily"] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const dayLogs = logs.filter((l) => dayKey(new Date(l.createdAt)) === key);
    daily.push({
      date: key.slice(5),
      calls: dayLogs.length,
      cost: Number(dayLogs.reduce((s, l) => s + l.cost, 0).toFixed(4)),
      errors: dayLogs.filter((l) => l.status !== "success").length,
    });
  }

  const modelMap = new Map<string, { calls: number; cost: number }>();
  for (const log of logs) {
    const entry = modelMap.get(log.modelName) ?? { calls: 0, cost: 0 };
    entry.calls += 1;
    entry.cost += log.cost;
    modelMap.set(log.modelName, entry);
  }
  const topModels = [...modelMap.entries()]
    .map(([modelName, v]) => ({ modelName, calls: v.calls, cost: Number(v.cost.toFixed(4)) }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);

  return {
    totalCalls,
    successRate: totalCalls ? Number(((success / totalCalls) * 100).toFixed(1)) : 100,
    totalCost: Number(totalCost.toFixed(2)),
    totalTokens,
    avgLatency,
    activeProviders: providers.filter((p) => p.status === "active").length,
    totalProviders: providers.length,
    activeTokens: tokens.filter((t) => t.status === "active" && !isTokenExpired(t, now)).length,
    daily,
    topModels,
  };
}
