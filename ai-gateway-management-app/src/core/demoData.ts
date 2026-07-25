import type { AccessTokenInput, CallLogInput, ModelRouteInput, ProviderInput } from "./types";

/** 演示数据工厂（纯函数，服务端 seed 与内存适配器共用）。 */

export interface DemoDataset {
  providers: (ProviderInput & { key: string })[];
  models: (Omit<ModelRouteInput, "providerId"> & { providerKey: string })[];
  tokens: (AccessTokenInput & { secret: string; used: number })[];
  logs: CallLogInput[];
}

function rand(seedRef: { v: number }): number {
  seedRef.v = (seedRef.v * 1664525 + 1013904223) % 4294967296;
  return seedRef.v / 4294967296;
}

export function buildDemoDataset(now = new Date()): DemoDataset {
  const nowIso = now.toISOString();

  const providers: DemoDataset["providers"] = [
    {
      key: "azure-main",
      name: "主力中转 · Azure 池",
      vendor: "openai",
      baseUrl: "https://api.gpt-relay.cn/v1",
      apiKey: "sk-relay-9f2c8d41ab7e4c0f9b3a",
      status: "active",
      priority: 1,
      weight: 60,
      rpmLimit: 240,
      monthlyBudget: 300,
      notes: "国内直连，走 Azure 多区域轮询，酒馆长文本主力。",
    },
    {
      key: "claude-hk",
      name: "香港节点 · Claude 官转",
      vendor: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-api03-7b21ce55d0f34a89",
      status: "active",
      priority: 2,
      weight: 30,
      rpmLimit: 90,
      monthlyBudget: 400,
      notes: "Opus 情感戏最好，价格贵，仅高优先级角色使用。",
    },
    {
      key: "deepseek",
      name: "DeepSeek 官方",
      vendor: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-ds-4c9b2e7a15f84d63",
      status: "active",
      priority: 3,
      weight: 40,
      rpmLimit: 300,
      monthlyBudget: 60,
      notes: "白菜价兜底渠道，日常闲聊、总结记忆都丢这儿。",
    },
    {
      key: "gemini",
      name: "Gemini 免费额度",
      vendor: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AIzaSyD8k2mQ1x77vLpR0",
      status: "paused",
      priority: 5,
      weight: 10,
      rpmLimit: 15,
      monthlyBudget: 0,
      notes: "免费额度经常 429，暂停中，作为灾备。",
    },
    {
      key: "kimi",
      name: "Kimi 长文本",
      vendor: "moonshot",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-moon-11ff09aa8823bd45",
      status: "error",
      priority: 4,
      weight: 20,
      rpmLimit: 60,
      monthlyBudget: 80,
      notes: "昨晚开始 401，怀疑余额欠费，待排查。",
    },
  ];

  const models: DemoDataset["models"] = [
    { providerKey: "azure-main", displayName: "gpt-4o-airp", upstreamModel: "gpt-4o", contextWindow: 128000, inputPrice: 0.018, outputPrice: 0.072, tags: ["角色扮演", "长上下文"], enabled: true },
    { providerKey: "azure-main", displayName: "gpt-4o-mini-cheap", upstreamModel: "gpt-4o-mini", contextWindow: 128000, inputPrice: 0.001, outputPrice: 0.004, tags: ["低成本", "高速"], enabled: true },
    { providerKey: "claude-hk", displayName: "claude-opus-剧情", upstreamModel: "claude-3-opus-20240229", contextWindow: 200000, inputPrice: 0.108, outputPrice: 0.54, tags: ["角色扮演", "NSFW 宽松"], enabled: true },
    { providerKey: "claude-hk", displayName: "claude-sonnet-日常", upstreamModel: "claude-3-5-sonnet-20241022", contextWindow: 200000, inputPrice: 0.022, outputPrice: 0.108, tags: ["角色扮演", "长上下文"], enabled: true },
    { providerKey: "deepseek", displayName: "deepseek-chat", upstreamModel: "deepseek-chat", contextWindow: 64000, inputPrice: 0.001, outputPrice: 0.002, tags: ["低成本", "高速"], enabled: true },
    { providerKey: "deepseek", displayName: "deepseek-r1-推理", upstreamModel: "deepseek-reasoner", contextWindow: 64000, inputPrice: 0.004, outputPrice: 0.016, tags: ["推理"], enabled: true },
    { providerKey: "kimi", displayName: "kimi-128k", upstreamModel: "moonshot-v1-128k", contextWindow: 128000, inputPrice: 0.06, outputPrice: 0.06, tags: ["长上下文", "翻译"], enabled: false },
    { providerKey: "gemini", displayName: "gemini-flash-备用", upstreamModel: "gemini-2.0-flash", contextWindow: 1000000, inputPrice: 0, outputPrice: 0, tags: ["低成本", "视觉"], enabled: false },
  ];

  const tokens: DemoDataset["tokens"] = [
    { name: "酒馆主号", secret: "sk-airp-tavern7f21c9de44ab0e5583be21cc90", boundApp: "SillyTavern 酒馆", quota: 200, used: 86.4, status: "active", allowedModels: ["gpt-4o-airp", "claude-opus-剧情", "claude-sonnet-日常"], expiresAt: new Date(now.getTime() + 86400000 * 45).toISOString() },
    { name: "SullyOS 手机端", secret: "sk-airp-sully22aa910bd7fe3c4488ee0177", boundApp: "SullyOS", quota: 100, used: 23.15, status: "active", allowedModels: ["deepseek-chat", "gpt-4o-mini-cheap"], expiresAt: null },
    { name: "记忆宫殿向量专用", secret: "sk-airp-memory55cc31ef08ba9d7712aa4409", boundApp: "自建脚本", quota: 30, used: 29.6, status: "active", allowedModels: ["deepseek-chat"], expiresAt: new Date(now.getTime() + 86400000 * 9).toISOString() },
    { name: "借给群友（已停）", secret: "sk-airp-guest88de17ba3f0c62e9911d55aa", boundApp: "其他", quota: 20, used: 20, status: "disabled", allowedModels: [], expiresAt: new Date(now.getTime() - 86400000 * 3).toISOString() },
  ];

  const seedRef = { v: 20260214 };
  const logs: CallLogInput[] = [];
  const combos = [
    { token: "酒馆主号", provider: "主力中转 · Azure 池", model: "gpt-4o-airp", inP: 0.018, outP: 0.072, weight: 34 },
    { token: "酒馆主号", provider: "香港节点 · Claude 官转", model: "claude-opus-剧情", inP: 0.108, outP: 0.54, weight: 14 },
    { token: "酒馆主号", provider: "香港节点 · Claude 官转", model: "claude-sonnet-日常", inP: 0.022, outP: 0.108, weight: 18 },
    { token: "SullyOS 手机端", provider: "DeepSeek 官方", model: "deepseek-chat", inP: 0.001, outP: 0.002, weight: 26 },
    { token: "SullyOS 手机端", provider: "主力中转 · Azure 池", model: "gpt-4o-mini-cheap", inP: 0.001, outP: 0.004, weight: 20 },
    { token: "记忆宫殿向量专用", provider: "DeepSeek 官方", model: "deepseek-chat", inP: 0.001, outP: 0.002, weight: 22 },
    { token: "酒馆主号", provider: "Kimi 长文本", model: "kimi-128k", inP: 0.06, outP: 0.06, weight: 6 },
  ];
  const pool = combos.flatMap((c) => Array.from({ length: c.weight }, () => c));

  for (let i = 0; i < 260; i += 1) {
    const c = pool[Math.floor(rand(seedRef) * pool.length)];
    const daysAgo = Math.floor(rand(seedRef) * 7);
    const created = new Date(now.getTime() - daysAgo * 86400000 - Math.floor(rand(seedRef) * 86400000));
    const promptTokens = 1200 + Math.floor(rand(seedRef) * 9000);
    const completionTokens = 180 + Math.floor(rand(seedRef) * 900);
    const roll = rand(seedRef);
    const failing = c.provider === "Kimi 长文本";
    const status: CallLogInput["status"] = failing
      ? roll > 0.25 ? "error" : "success"
      : roll > 0.965
        ? roll > 0.99 ? "timeout" : "error"
        : "success";
    logs.push({
      tokenName: c.token,
      providerName: c.provider,
      modelName: c.model,
      promptTokens,
      completionTokens: status === "success" ? completionTokens : 0,
      cost: status === "success"
        ? Number(((promptTokens / 1000) * c.inP + (completionTokens / 1000) * c.outP).toFixed(4))
        : 0,
      latencyMs: status === "timeout" ? 30000 : 600 + Math.floor(rand(seedRef) * 4200),
      status,
      errorMessage:
        status === "error"
          ? failing
            ? "401 Unauthorized：上游余额不足"
            : "429 Too Many Requests：上游限流"
          : status === "timeout"
            ? "上游 30s 无响应，已熔断切换"
            : "",
      createdAt: created.toISOString(),
    });
  }

  logs.sort((a, b) => (a.createdAt ?? nowIso).localeCompare(b.createdAt ?? nowIso));
  return { providers, models, tokens, logs };
}
