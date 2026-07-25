import type { GatewayRepository } from "../port";
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
} from "../types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** REST 适配器：把领域端口映射到 Next.js Route Handlers。 */
export function createHttpRepository(base = "/api"): GatewayRepository {
  const json = (body: unknown) => ({ body: JSON.stringify(body) });
  return {
    listProviders: () => request<Provider[]>(`${base}/providers`),
    createProvider: (input: ProviderInput) =>
      request<Provider>(`${base}/providers`, { method: "POST", ...json(input) }),
    updateProvider: (id, input) =>
      request<Provider>(`${base}/providers/${id}`, { method: "PATCH", ...json(input) }),
    deleteProvider: (id) => request<void>(`${base}/providers/${id}`, { method: "DELETE" }),

    listModels: () => request<ModelRoute[]>(`${base}/models`),
    createModel: (input: ModelRouteInput) =>
      request<ModelRoute>(`${base}/models`, { method: "POST", ...json(input) }),
    updateModel: (id, input) =>
      request<ModelRoute>(`${base}/models/${id}`, { method: "PATCH", ...json(input) }),
    deleteModel: (id) => request<void>(`${base}/models/${id}`, { method: "DELETE" }),

    listTokens: () => request<AccessToken[]>(`${base}/tokens`),
    createToken: (input: AccessTokenInput) =>
      request<AccessToken>(`${base}/tokens`, { method: "POST", ...json(input) }),
    updateToken: (id, input) =>
      request<AccessToken>(`${base}/tokens/${id}`, { method: "PATCH", ...json(input) }),
    deleteToken: (id) => request<void>(`${base}/tokens/${id}`, { method: "DELETE" }),

    listLogs: (limit = 100) => request<CallLog[]>(`${base}/logs?limit=${limit}`),
    createLog: (input: CallLogInput) =>
      request<CallLog>(`${base}/logs`, { method: "POST", ...json(input) }),
    deleteLog: (id) => request<void>(`${base}/logs/${id}`, { method: "DELETE" }),
    clearLogs: () => request<void>(`${base}/logs`, { method: "DELETE" }),

    getStats: () => request<DashboardStats>(`${base}/stats`),
  };
}
