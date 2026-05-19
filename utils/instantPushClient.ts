import { InstantPushConfig, APIConfig } from '../types';
import { loadPushVapid, isPushVapidReady } from './pushVapid';
import {
  SUBSCRIBE_SETTLE_MS,
  bytesToB64u,
  isDeadPushEndpoint,
  subscribeWithRetry,
} from './pushSubscribeShared';

export const INSTANT_PUSH_CONFIG_KEY = 'instant_push_config_v1';

// ── Diagnostics ────────────────────────────────────────────────────────────
//
// 错误诊断快照, 给 ErrorDialog 用. 设计原则:
//   - 弹窗里完全不出现 apiKey / apiUrl / workerUrl / push endpoint, 这些走
//     console.error 留给本地 devtools, 用户复制弹窗内容反馈时不漏密.
//   - response snippet 里如果回显了 worker / api host (CF 错误页常见),
//     主动在文本里 mask 掉.

export interface InstantDiagnostics {
  env: {
    ua: string;             // 简化版, 不是原始 UA 串
    online: boolean;
    notif: NotificationPermission | 'unsupported';
    sw: string;             // 'scope=/ active' / 'not-registered' / 'unsupported'
    time: string;
  };
  context?: {
    char?: string;
    model?: string;
    msgCount?: number;
    msgBytes?: number;
  };
  config?: {
    enabled: boolean;
    workerUrlFilled: boolean;
    vapid: 'ready' | '缺公钥' | '缺私钥' | '缺公钥+私钥';
  };
  subscription?: {
    reason?: string;
    notifPermission?: NotificationPermission | 'unsupported';
    swRegistered?: boolean;
    cleanedDeadEndpoint?: boolean;
  };
  http?: {
    status: number;
    statusText?: string;
    bodyBytes: number;
    keepalive: boolean;
    keepaliveLimit: number;
    cfRay?: string;
    responseSnippet?: string;
  };
  fetchError?: {
    name?: string;
    message?: string;
  };
  timeout?: {
    waitedMs: number;
    httpStatusWhenDispatched?: number;
  };
  /**
   * 按 JSON 序列化大小排序的 payload 前 N 个字段路径, 给 413 / 大 payload 定位用.
   * 路径形如 messages[3].content, metadata.charId. 只列大小, 不列值, 路径黑名单已过滤
   * apiKey/apiUrl/endpoint 等密钥与可识别标识.
   */
  payloadTop?: Array<{ path: string; bytes: number }>;
}

function simplifyUserAgent(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) {
    const ios = ua.match(/OS (\d+)_/)?.[1] ?? '?';
    const standalone = typeof navigator !== 'undefined' && (navigator as any).standalone === true;
    return `iOS ${ios} ${standalone ? 'PWA' : 'Safari'}`;
  }
  if (/Android/.test(ua)) {
    const av = ua.match(/Android (\d+)/)?.[1] ?? '?';
    if (/Chrome\/(\d+)/.test(ua)) return `Android ${av} Chrome ${RegExp.$1}`;
    return `Android ${av}`;
  }
  if (/Mac OS X/.test(ua)) {
    if (/Edg\/(\d+)/.test(ua)) return `Mac Edge ${RegExp.$1}`;
    if (/Chrome\/(\d+)/.test(ua)) return `Mac Chrome ${RegExp.$1}`;
    if (/Firefox\/(\d+)/.test(ua)) return `Mac Firefox ${RegExp.$1}`;
    if (/Safari\/\d+/.test(ua)) return 'Mac Safari';
    return 'Mac';
  }
  if (/Windows/.test(ua)) {
    if (/Edg\/(\d+)/.test(ua)) return `Win Edge ${RegExp.$1}`;
    if (/Chrome\/(\d+)/.test(ua)) return `Win Chrome ${RegExp.$1}`;
    if (/Firefox\/(\d+)/.test(ua)) return `Win Firefox ${RegExp.$1}`;
    return 'Windows';
  }
  return ua.slice(0, 60);
}

async function collectEnvSnapshot(): Promise<InstantDiagnostics['env']> {
  const ua = typeof navigator !== 'undefined' ? simplifyUserAgent(navigator.userAgent || '') : 'n/a';
  const online = typeof navigator !== 'undefined' ? navigator.onLine : false;
  let notif: NotificationPermission | 'unsupported' = 'unsupported';
  if (typeof Notification !== 'undefined') {
    try { notif = Notification.permission; } catch { /* ignore */ }
  }
  let sw = 'unsupported';
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        sw = 'not-registered';
      } else {
        const scope = (() => {
          try { return reg.scope.replace(location.origin, '') || '/'; } catch { return reg.scope; }
        })();
        sw = `scope=${scope} ${reg.active ? 'active' : 'inactive'}`;
      }
    } catch { sw = 'error'; }
  }
  return { ua, online, notif, sw, time: new Date().toISOString() };
}

function describeVapid(): NonNullable<InstantDiagnostics['config']>['vapid'] {
  const v = loadPushVapid();
  const noPub = !v.vapidPublicKey || v.vapidPublicKey.length < 60;
  const noPriv = !v.vapidPrivateKey;
  if (noPub && noPriv) return '缺公钥+私钥';
  if (noPub) return '缺公钥';
  if (noPriv) return '缺私钥';
  return 'ready';
}

function maskHostsInText(text: string, hosts: string[]): string {
  let out = text;
  for (const h of hosts) {
    if (!h) continue;
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '<host-masked>');
  }
  return out;
}

function extractHost(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return ''; }
}

const RESPONSE_SNIPPET_LIMIT = 400;
const PAYLOAD_TOP_LIMIT = 10;

// 走 wire 时这些字段是 secret 或可识别的用户标识, 不能进弹窗
const PAYLOAD_PATH_BLACKLIST = new Set([
  'apiKey',
  'apiUrl',
  'pushSubscription.endpoint',
  'pushSubscription.keys.p256dh',
  'pushSubscription.keys.auth',
]);

/**
 * 递归收集 payload 里每个叶子 (string/number/bool) 的 JSON 大小, 按从大到小排序取前 N.
 * 大小用 JSON.stringify(...).length, 跟 sendInstantPush 里的 body.length 同度量
 * (UTF-16 code units), 加起来能跟 bodyBytes 大致对得上, 方便用户判断"是哪一项把
 * body 撑到 78KB". 不返回值本身, 只返回路径 + 大小, 避免漏密.
 */
function collectPayloadTop(payload: unknown, limit = PAYLOAD_TOP_LIMIT): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (v: unknown, path: string) => {
    if (v === null || v === undefined) return;
    if (PAYLOAD_PATH_BLACKLIST.has(path)) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      // JSON.stringify 给 string 加引号 + 转义, 比 .length 更接近 body 实际占用
      out.push({ path: path || '<root>', bytes: JSON.stringify(v).length });
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`);
      return;
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
    }
  };
  try { walk(payload, ''); } catch { /* defensive: 循环引用等 */ }
  out.sort((a, b) => b.bytes - a.bytes);
  return out.slice(0, limit);
}

/** 把 diagnostics 渲染成 ErrorDialog 用的多行文本. 字段按段分块, 缺失段自动跳过. */
export function formatDiagnostics(
  diag: InstantDiagnostics,
  opts: { outcome: InstantOutcome; reason?: string },
): string {
  const lines: string[] = [];
  lines.push(`outcome: ${opts.outcome}`);
  if (opts.reason) lines.push(`reason: ${opts.reason}`);

  if (diag.http) {
    lines.push('', '— http —');
    const st = diag.http.statusText ? ` ${diag.http.statusText}` : '';
    lines.push(`status: ${diag.http.status}${st}`);
    lines.push(`bodyBytes: ${diag.http.bodyBytes}`);
    lines.push(
      `keepalive: ${diag.http.keepalive ? 'on' : `off (>${diag.http.keepaliveLimit}B 自动降级)`}`,
    );
    if (diag.http.cfRay) lines.push(`cf-ray: ${diag.http.cfRay}`);
    if (diag.http.responseSnippet) {
      lines.push('response:');
      lines.push(diag.http.responseSnippet);
    }
  }
  if (diag.fetchError) {
    lines.push('', '— fetch error —');
    if (diag.fetchError.name) lines.push(`name: ${diag.fetchError.name}`);
    if (diag.fetchError.message) lines.push(`message: ${diag.fetchError.message}`);
  }
  if (diag.config) {
    lines.push('', '— config —');
    lines.push(`enabled: ${diag.config.enabled}`);
    lines.push(`workerUrl: ${diag.config.workerUrlFilled ? '已填' : '未填'}`);
    lines.push(`vapid: ${diag.config.vapid}`);
  }
  if (diag.subscription) {
    lines.push('', '— subscription —');
    if (diag.subscription.reason) lines.push(`reason: ${diag.subscription.reason}`);
    if (diag.subscription.notifPermission) lines.push(`notif: ${diag.subscription.notifPermission}`);
    if (diag.subscription.swRegistered !== undefined) {
      lines.push(`sw: ${diag.subscription.swRegistered ? 'registered' : 'not registered'}`);
    }
    if (diag.subscription.cleanedDeadEndpoint) lines.push('cleaned dead endpoint');
  }
  if (diag.timeout) {
    lines.push('', '— timeout —');
    lines.push(`waited: ${diag.timeout.waitedMs}ms`);
    if (diag.timeout.httpStatusWhenDispatched !== undefined) {
      lines.push(`dispatched: HTTP ${diag.timeout.httpStatusWhenDispatched} (worker 收到了, 但 push 没回来)`);
    } else {
      lines.push('dispatched: 状态未知 (fetch 还没 resolve 就超时)');
    }
  }
  if (diag.payloadTop && diag.payloadTop.length) {
    lines.push('', '— payload top —');
    // 路径太长时右对齐大小不好看, 直接 path: bytes 简单清晰
    const maxPathLen = Math.min(50, Math.max(...diag.payloadTop.map((x) => x.path.length)));
    for (const item of diag.payloadTop) {
      const p = item.path.length > maxPathLen ? item.path.slice(0, maxPathLen - 1) + '…' : item.path;
      lines.push(`${p.padEnd(maxPathLen, ' ')}  ${item.bytes}`);
    }
  }
  if (diag.context) {
    lines.push('', '— context —');
    if (diag.context.char) lines.push(`char: ${diag.context.char}`);
    if (diag.context.model) lines.push(`model: ${diag.context.model}`);
    if (diag.context.msgCount !== undefined) {
      const bytes = diag.context.msgBytes;
      const sizeStr = bytes !== undefined ? ` (~${(bytes / 1024).toFixed(1)}KB)` : '';
      lines.push(`msgs: ${diag.context.msgCount}${sizeStr}`);
    }
  }
  lines.push('', '— env —');
  lines.push(`ua: ${diag.env.ua}`);
  lines.push(`online: ${diag.env.online}`);
  lines.push(`notif: ${diag.env.notif}`);
  lines.push(`sw: ${diag.env.sw}`);
  lines.push(`time: ${diag.env.time}`);
  return lines.join('\n');
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface InstantPushPayload {
  contactName: string;
  apiUrl: string;
  apiKey: string;
  primaryModel: string;
  pushSubscription: PushSubscriptionInfo;
  // completePrompt 与 messages 二选一：worker 端 amsg-instant 0.5.0+ 同时认这两路。
  // avatarUrl: 0.6.0 起 worker 端强制校验, 仅接受 http(s) URL (≤2KB), data: 被拒。
  // - completePrompt：测试推送 / 简单 one-shot 路径继续用
  // - messages：与本地 chat completions 完全等价的 system/user/assistant 数组
  completePrompt?: string;
  messages?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | unknown[];
  }>;
  avatarUrl?: string;
  maxTokens?: number;
  temperature?: number;
  messageSubtype?: string;
  metadata?: Record<string, unknown>;
}

// ── localStorage helpers ───────────────────────────────────────────────────

const DEFAULT_CONFIG: InstantPushConfig = {
  enabled: false,
  workerUrl: '',
};

// 旧版本 (v1 之前) 把 vapidPublicKey 平铺在 InstantPushConfig 里。读取时
// 自动剥离掉，避免类型外泄；真正的 VAPID 现在统一从 pushVapid 读。
function stripLegacyVapid(parsed: Record<string, unknown>): InstantPushConfig {
  const { vapidPublicKey: _drop, ...rest } = parsed as Record<string, unknown> & { vapidPublicKey?: unknown };
  return { ...DEFAULT_CONFIG, ...(rest as Partial<InstantPushConfig>) };
}

export function loadInstantConfig(): InstantPushConfig {
  try {
    const raw = localStorage.getItem(INSTANT_PUSH_CONFIG_KEY);
    if (raw) return stripLegacyVapid(JSON.parse(raw));
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveInstantConfig(cfg: InstantPushConfig): void {
  try {
    localStorage.setItem(INSTANT_PUSH_CONFIG_KEY, JSON.stringify({ ...cfg, updatedAt: Date.now() }));
  } catch { /* ignore */ }
}

export function clearInstantConfig(): void {
  try { localStorage.removeItem(INSTANT_PUSH_CONFIG_KEY); } catch { /* ignore */ }
}

export function isInstantConfigReady(cfg?: InstantPushConfig): boolean {
  const c = cfg ?? loadInstantConfig();
  return (
    c.enabled &&
    c.workerUrl.startsWith('https://') &&
    isPushVapidReady()
  );
}

// ── Web Push subscription helpers ─────────────────────────────────────────
//
// 与 proactivePushConfig 共用一份 race 处理 / encoding helpers, 实现在
// pushSubscribeShared.ts.

export async function getOrCreateInstantSubscription(
  vapidPublicKey?: string,
): Promise<{ sub: PushSubscriptionInfo | null; reason?: string }> {
  // 不传则从 pushVapid 取 — Proactive / Instant 共用一份, 不再互踢订阅.
  const pub = (vapidPublicKey || loadPushVapid().vapidPublicKey || '').trim();
  if (pub.length < 60) {
    return { sub: null, reason: 'VAPID 公钥未配置, 请到 Settings → Instant Push 生成并保存' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { sub: null, reason: '当前浏览器不支持 Service Worker 或 Push API' };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  if (sub && isDeadPushEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    // 等浏览器清内部 removed 标记, 否则下面 subscribe() 又拿到死哨兵
    await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS));
    sub = null;
  }

  if (sub) {
    // Re-subscribe if VAPID key changed
    try {
      const existingKey = bytesToB64u(sub.options.applicationServerKey);
      if (existingKey && existingKey !== pub) {
        await sub.unsubscribe();
        await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS));
        sub = null;
      }
    } catch { /* fall through */ }
  }

  if (!sub) {
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return { sub: null, reason: '通知权限未授予' };
    } else if (Notification.permission === 'denied') {
      return { sub: null, reason: '通知权限已被拒绝（请到浏览器站点设置里手动开启）' };
    }
    const fresh = await subscribeWithRetry(reg, pub, '[InstantPush]');
    if (!fresh.sub) return { sub: null, reason: fresh.reason };
    sub = fresh.sub;
  }

  const p256dh = bytesToB64u(sub.getKey('p256dh'));
  const auth = bytesToB64u(sub.getKey('auth'));
  if (!p256dh || !auth) return { sub: null, reason: '订阅缺少加密公钥（p256dh / auth）' };

  return {
    sub: {
      endpoint: sub.endpoint,
      keys: { p256dh, auth },
    },
  };
}

// ── Send helpers ───────────────────────────────────────────────────────────
//
// 直接走原生 fetch（曾经走 ReiClient，0.5.0 起 amsg 客户端只是 fetch 薄壳，
// 我们改裸 fetch 是为了暴露 `keepalive: true` 选项 —— 浏览器进程被杀（iOS PWA
// swipe-up 是典型场景）时浏览器仍会努力把已 dispatch 的请求送达，避免 worker
// 收不到导致没推送回来。

// `keepalive: true` 限制 body ≤ 64KB。超过则降级为普通 fetch（杀进程会丢包），
// 给点 margin 避免边界 case。
const KEEPALIVE_MAX_BODY = 60 * 1024;

export interface SendInstantPushResult {
  ok: boolean;
  error?: string;
  data?: unknown;
  /** 失败时 (HTTP 非 2xx 或 worker 返回 success:false) 的 http 段诊断 */
  http?: InstantDiagnostics['http'];
  /** fetch throw 时 (网络层 / CORS / AbortError) 的诊断 */
  fetchError?: InstantDiagnostics['fetchError'];
  /** 失败时附 payload top10 字段路径 + 大小, 给 413 / 超大 body 定位用 */
  payloadTop?: InstantDiagnostics['payloadTop'];
}

export async function sendInstantPush(
  payload: InstantPushPayload,
  options: { keepalive?: boolean; onDispatched?: () => void } = {},
): Promise<SendInstantPushResult> {
  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return { ok: false, error: '请先在 Settings → Instant Push 里配置并保存' };
  }
  const url = `${cfg.workerUrl.replace(/\/+$/, '')}/instant`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.clientToken) headers['X-Client-Token'] = cfg.clientToken;
  const body = JSON.stringify(payload);
  const useKeepalive = !!options.keepalive && body.length <= KEEPALIVE_MAX_BODY;
  const maskedHosts = [
    extractHost(cfg.workerUrl),
    extractHost(payload.apiUrl),
    extractHost(payload.pushSubscription?.endpoint),
  ].filter(Boolean);
  try {
    // fetch() 同步 return Promise 时，浏览器已把请求排进网络栈，keepalive:true
    // 让浏览器在进程被杀后仍努力送达。这一刻就是"安全可杀"，立刻通知 UI；不能
    // 等 await resolve —— worker 端 LLM + push 全跑完才回 200，那时 push 可能
    // 比 response 更早到达浏览器，UI 会出现"AI 回复都到了气泡还半透明"。
    const fetchPromise = fetch(url, { method: 'POST', headers, body, keepalive: useKeepalive });
    options.onDispatched?.();
    const res = await fetchPromise;
    // res.text() 只能调一次 —— 拿原文后再 try parse JSON, 比先 json() 后 text() 灵活,
    // 而且 CF 边缘错误页是 HTML, json() 会 throw 丢掉原文.
    const rawText = await res.text().catch(() => '');
    let parsed: { success?: boolean; data?: unknown; error?: { message?: string } } | null = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const snippet = rawText
        ? maskHostsInText(rawText.slice(0, RESPONSE_SNIPPET_LIMIT), maskedHosts)
        : undefined;
      const cfRay = res.headers.get('cf-ray') || undefined;
      const errMsg = parsed?.error?.message ?? `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
      // 完整 URL 等敏感字段不进弹窗, 但写到 console 给本地开发者
      console.error('[InstantPush] HTTP failure', { url, status: res.status, statusText: res.statusText, body: rawText });
      return {
        ok: false,
        error: errMsg,
        http: {
          status: res.status,
          statusText: res.statusText || undefined,
          bodyBytes: body.length,
          keepalive: useKeepalive,
          keepaliveLimit: KEEPALIVE_MAX_BODY,
          cfRay,
          responseSnippet: snippet,
        },
        payloadTop: collectPayloadTop(payload),
      };
    }
    if (parsed?.success) return { ok: true, data: parsed.data };
    return {
      ok: false,
      error: parsed?.error?.message ?? '发送失败',
      http: {
        status: res.status,
        statusText: res.statusText || undefined,
        bodyBytes: body.length,
        keepalive: useKeepalive,
        keepaliveLimit: KEEPALIVE_MAX_BODY,
        cfRay: res.headers.get('cf-ray') || undefined,
        responseSnippet: rawText
          ? maskHostsInText(rawText.slice(0, RESPONSE_SNIPPET_LIMIT), maskedHosts)
          : undefined,
      },
      payloadTop: collectPayloadTop(payload),
    };
  } catch (e) {
    const err = e as { name?: string; message?: string } | null;
    console.error('[InstantPush] fetch threw', { url, err });
    return {
      ok: false,
      error: err?.message ?? String(e),
      fetchError: { name: err?.name, message: err?.message ?? String(e) },
      payloadTop: collectPayloadTop(payload),
    };
  }
}

// ── 高阶：发 + 等 push 落库 ───────────────────────────────────────────────
//
// 与 safeFetchJson 对称的"发起 + 等回复"单一入口：
// - 内部拿 push subscription、注册 'active-msg-received' 监听、超时兜底
// - 调用方只关心业务 payload (不含 pushSubscription)
// - outcome 区分不同失败成因，方便上层做 toast / 重试策略
//
// 用法：与本地路径 `await safeFetchJson(url, opts)` 完全对称。

export type InstantBusinessPayload = Omit<InstantPushPayload, 'pushSubscription'>;

export type InstantOutcome =
  | 'received'
  | 'timeout'
  | 'config-missing'
  | 'subscription-failed'
  | 'send-failed';

export interface InstantAwaitResult {
  ok: boolean;
  error?: string;
  outcome: InstantOutcome;
  /** 失败时附完整诊断, 给 ErrorDialog 经 formatDiagnostics() 渲染 */
  diagnostics?: InstantDiagnostics;
}

const DEFAULT_INSTANT_TIMEOUT_MS = 90_000;

function buildContextDiag(business: InstantBusinessPayload): InstantDiagnostics['context'] {
  let msgBytes: number | undefined;
  try {
    if (business.messages) msgBytes = JSON.stringify(business.messages).length;
    else if (business.completePrompt) msgBytes = business.completePrompt.length;
  } catch { /* ignore */ }
  return {
    char: business.contactName || undefined,
    model: business.primaryModel || undefined,
    msgCount: business.messages?.length ?? (business.completePrompt ? 1 : undefined),
    msgBytes,
  };
}

export async function sendInstantPushAndAwaitReply(
  business: InstantBusinessPayload,
  charId: string,
  timeoutMs: number = DEFAULT_INSTANT_TIMEOUT_MS,
  onPosted?: () => void,
): Promise<InstantAwaitResult> {
  const env = await collectEnvSnapshot();
  const context = buildContextDiag(business);

  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return {
      ok: false,
      outcome: 'config-missing',
      error: '请先在 Settings → Instant Push 里配置并保存',
      diagnostics: {
        env, context,
        config: {
          enabled: !!cfg.enabled,
          workerUrlFilled: !!cfg.workerUrl && cfg.workerUrl.startsWith('https://'),
          vapid: describeVapid(),
        },
      },
    };
  }

  const { sub, reason } = await getOrCreateInstantSubscription();
  if (!sub) {
    let swRegistered: boolean | undefined;
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      try { swRegistered = !!(await navigator.serviceWorker.getRegistration()); } catch { /* ignore */ }
    }
    return {
      ok: false,
      outcome: 'subscription-failed',
      error: reason || '无法获取推送订阅',
      diagnostics: {
        env, context,
        subscription: {
          reason,
          notifPermission: env.notif,
          swRegistered,
        },
      },
    };
  }

  // 必须先挂监听再 send，否则极快的 push 可能漏掉
  let pushResolver: () => void = () => {};
  const pushArrived = new Promise<void>((resolve) => { pushResolver = resolve; });
  const pushHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.charId === charId) pushResolver();
  };
  window.addEventListener('active-msg-received', pushHandler);

  const sendStartedAt = Date.now();
  try {
    // keepalive: true 让 fetch 在进程被杀后仍能完成（iOS PWA swipe-kill 关键保障）
    // onDispatched 在 fetch 同步排进网络栈后立刻 fire，UI 此时即可取消"准备中"
    // 半透明态 —— 不等 response，因为 worker 是同步阻塞跑完 LLM+push 才 200
    const sendResult = await sendInstantPush(
      { ...business, pushSubscription: sub },
      { keepalive: true, onDispatched: onPosted },
    );
    if (!sendResult.ok) {
      return {
        ok: false,
        outcome: 'send-failed',
        error: sendResult.error,
        diagnostics: {
          env, context,
          http: sendResult.http,
          fetchError: sendResult.fetchError,
          payloadTop: sendResult.payloadTop,
        },
      };
    }

    const timedOut = await Promise.race([
      pushArrived.then(() => false as const),
      new Promise<true>((r) => setTimeout(() => r(true), timeoutMs)),
    ]);
    if (timedOut) {
      return {
        ok: false,
        outcome: 'timeout',
        error: `AI 回复超时（${Math.round(timeoutMs / 1000)}s 未收到推送，检查 worker 或通知通道）`,
        diagnostics: {
          env, context,
          timeout: {
            waitedMs: Date.now() - sendStartedAt,
            // sendResult.ok=true 走到这里, 说明 worker 至少返了 2xx + success:true,
            // 但 push 没回 SW —— 关键 debug 信号: dispatched 成功只是失败方向缩窄了一半
            httpStatusWhenDispatched: 200,
          },
        },
      };
    }
    return { ok: true, outcome: 'received' };
  } finally {
    window.removeEventListener('active-msg-received', pushHandler);
  }
}

export async function sendTestInstantPush(
  apiConfig: APIConfig,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  if (!apiConfig.baseUrl) {
    return { ok: false, error: '请先在 Settings → API 里配置 Chat API' };
  }

  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return { ok: false, error: '请先配置并保存 Instant Push 设置' };
  }

  const { sub, reason } = await getOrCreateInstantSubscription();
  if (!sub) {
    return { ok: false, error: reason ?? '无法获取推送订阅' };
  }

  // amsg-instant 0.4.0+ runs normalizeAiApiUrl Worker-side; we can forward
  // apiConfig.baseUrl as-is (root / /v1 / full /chat/completions all accepted).
  //
  // metadata.test = true 让 SW push handler 绕过"前台跳过 showNotification"
  // 逻辑 — 测试就是要看到通知, 不能被前台静默吃掉.
  return sendInstantPush({
    contactName: 'Instant Push 测试',
    completePrompt: '用一句话简短地和用户说一声 hi，确认 Instant Push 工作正常',
    apiUrl: apiConfig.baseUrl,
    apiKey: apiConfig.apiKey,
    primaryModel: apiConfig.model,
    pushSubscription: sub,
    metadata: { test: true },
  });
}
