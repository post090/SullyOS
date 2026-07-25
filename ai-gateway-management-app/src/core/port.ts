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
} from "./types";

/**
 * 存储端口（Port）。UI 与业务逻辑只依赖这个接口，不依赖 fetch / Drizzle / IndexedDB。
 *
 * 当前实现：
 *  - `adapters/httpRepository.ts` —— Next.js REST API（本项目默认）
 *  - `adapters/memoryRepository.ts` —— 内存实现（演示 / 测试 / 离线预览）
 *
 * SullyOS 迁移时新增：
 *  - `adapters/indexedDbRepository.ts` —— 复用 SullyOS 的 db 封装即可，UI 层零改动。
 */
export interface GatewayRepository {
  listProviders(): Promise<Provider[]>;
  createProvider(input: ProviderInput): Promise<Provider>;
  updateProvider(id: string, input: Partial<ProviderInput>): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;

  listModels(): Promise<ModelRoute[]>;
  createModel(input: ModelRouteInput): Promise<ModelRoute>;
  updateModel(id: string, input: Partial<ModelRouteInput>): Promise<ModelRoute>;
  deleteModel(id: string): Promise<void>;

  listTokens(): Promise<AccessToken[]>;
  createToken(input: AccessTokenInput): Promise<AccessToken>;
  updateToken(id: string, input: Partial<AccessTokenInput>): Promise<AccessToken>;
  deleteToken(id: string): Promise<void>;

  listLogs(limit?: number): Promise<CallLog[]>;
  createLog(input: CallLogInput): Promise<CallLog>;
  deleteLog(id: string): Promise<void>;
  clearLogs(): Promise<void>;

  getStats(): Promise<DashboardStats>;
}
