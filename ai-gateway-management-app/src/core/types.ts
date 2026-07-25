/**
 * 领域模型（纯 TypeScript，零框架 / 零后端依赖）。
 * SullyOS 迁移时这个文件可以原样复制到 `types/gateway.ts`。
 */

export type VendorId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "moonshot"
  | "zhipu"
  | "custom";

export type ProviderStatus = "active" | "paused" | "error";
export type TokenStatus = "active" | "disabled";
export type CallStatus = "success" | "error" | "timeout";
export type BoundApp = "SillyTavern 酒馆" | "SullyOS" | "Cherry Studio" | "自建脚本" | "其他";

export interface Provider {
  id: string;
  name: string;
  vendor: VendorId;
  baseUrl: string;
  apiKey: string;
  status: ProviderStatus;
  priority: number;
  weight: number;
  rpmLimit: number;
  monthlyBudget: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type ProviderInput = Omit<Provider, "id" | "createdAt" | "updatedAt">;

export interface ModelRoute {
  id: string;
  providerId: string;
  displayName: string;
  upstreamModel: string;
  contextWindow: number;
  inputPrice: number;
  outputPrice: number;
  tags: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ModelRouteInput = Omit<ModelRoute, "id" | "createdAt" | "updatedAt">;

export interface AccessToken {
  id: string;
  name: string;
  secret: string;
  boundApp: BoundApp | string;
  quota: number;
  used: number;
  status: TokenStatus;
  allowedModels: string[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AccessTokenInput = Omit<
  AccessToken,
  "id" | "secret" | "used" | "createdAt" | "updatedAt"
> & { secret?: string; used?: number };

export interface CallLog {
  id: string;
  tokenName: string;
  providerName: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  latencyMs: number;
  status: CallStatus;
  errorMessage: string;
  createdAt: string;
}

export type CallLogInput = Omit<CallLog, "id" | "createdAt"> & { createdAt?: string };

export interface DashboardStats {
  totalCalls: number;
  successRate: number;
  totalCost: number;
  totalTokens: number;
  avgLatency: number;
  activeProviders: number;
  totalProviders: number;
  activeTokens: number;
  daily: { date: string; calls: number; cost: number; errors: number }[];
  topModels: { modelName: string; calls: number; cost: number }[];
}

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
}
