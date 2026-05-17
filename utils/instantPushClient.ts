import { InstantPushConfig, APIConfig } from '../types';
import { loadPushVapid, isPushVapidReady } from './pushVapid';

export const INSTANT_PUSH_CONFIG_KEY = 'instant_push_config_v1';

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
  // completePrompt 与 messages 二选一：worker 端 amsg-instant 0.5.0 同时认这两路。
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

function b64uToBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const padded = b64u.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isDeadEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  return endpoint.includes('permanently-removed.invalid');
}

function explainSubscribeError(e: unknown): string {
  const err = e as { name?: string; message?: string } | null;
  const name = err?.name || '';
  const msg = err?.message || String(e || '未知错误');
  if (name === 'NotAllowedError') {
    return '浏览器拒绝创建订阅（NotAllowedError）——通常是站点权限被拦截或处于隐身模式';
  }
  if (name === 'NotSupportedError') {
    return '当前浏览器不支持网页推送——国行安卓或自带浏览器常见，换 Chrome / Edge / Firefox 桌面版试试';
  }
  if (name === 'AbortError' || /push service|FCM|network/i.test(msg)) {
    return '连不上推送服务器——常见于无谷歌服务的国行安卓，或网络挡住了推送服务器，建议换装了谷歌服务的设备或桌面 Chrome 试试';
  }
  if (name === 'InvalidStateError') {
    return '订阅状态冲突（InvalidStateError）——可能旧订阅没清干净，刷新页面后重试';
  }
  return `订阅创建失败（${name || 'Error'}：${msg}）`;
}

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

  if (sub && isDeadEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    sub = null;
  }

  if (sub) {
    // Re-subscribe if VAPID key changed
    try {
      const existingKey = bytesToB64u(sub.options.applicationServerKey);
      if (existingKey && existingKey !== pub) {
        await sub.unsubscribe();
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
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uToBytes(pub),
      });
    } catch (e) {
      console.warn('[InstantPush] pushManager.subscribe failed', e);
      return { sub: null, reason: explainSubscribeError(e) };
    }
  }

  if (isDeadEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    return { sub: null, reason: '浏览器返回了 zombie endpoint（permanently-removed.invalid），无法投递' };
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

export async function sendInstantPush(
  payload: InstantPushPayload,
  options: { keepalive?: boolean; onDispatched?: () => void } = {},
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return { ok: false, error: '请先在 Settings → Instant Push 里配置并保存' };
  }
  try {
    const url = `${cfg.workerUrl.replace(/\/+$/, '')}/instant`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.clientToken) headers['X-Client-Token'] = cfg.clientToken;
    const body = JSON.stringify(payload);
    const useKeepalive = !!options.keepalive && body.length <= KEEPALIVE_MAX_BODY;
    // fetch() 同步 return Promise 时，浏览器已把请求排进网络栈，keepalive:true
    // 让浏览器在进程被杀后仍努力送达。这一刻就是"安全可杀"，立刻通知 UI；不能
    // 等 await resolve —— worker 端 LLM + push 全跑完才回 200，那时 push 可能
    // 比 response 更早到达浏览器，UI 会出现"AI 回复都到了气泡还半透明"。
    const fetchPromise = fetch(url, { method: 'POST', headers, body, keepalive: useKeepalive });
    options.onDispatched?.();
    const res = await fetchPromise;
    let parsed: { success?: boolean; data?: unknown; error?: { message?: string } } | null = null;
    try { parsed = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      return { ok: false, error: parsed?.error?.message ?? `HTTP ${res.status}` };
    }
    if (parsed?.success) return { ok: true, data: parsed.data };
    return { ok: false, error: parsed?.error?.message ?? '发送失败' };
  } catch (e) {
    const err = e as { message?: string } | null;
    return { ok: false, error: err?.message ?? String(e) };
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
}

const DEFAULT_INSTANT_TIMEOUT_MS = 90_000;

export async function sendInstantPushAndAwaitReply(
  business: InstantBusinessPayload,
  charId: string,
  timeoutMs: number = DEFAULT_INSTANT_TIMEOUT_MS,
  onPosted?: () => void,
): Promise<InstantAwaitResult> {
  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return { ok: false, outcome: 'config-missing', error: '请先在 Settings → Instant Push 里配置并保存' };
  }

  const { sub, reason } = await getOrCreateInstantSubscription();
  if (!sub) {
    return { ok: false, outcome: 'subscription-failed', error: reason || '无法获取推送订阅' };
  }

  // 必须先挂监听再 send，否则极快的 push 可能漏掉
  let pushResolver: () => void = () => {};
  const pushArrived = new Promise<void>((resolve) => { pushResolver = resolve; });
  const pushHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.charId === charId) pushResolver();
  };
  window.addEventListener('active-msg-received', pushHandler);

  try {
    // keepalive: true 让 fetch 在进程被杀后仍能完成（iOS PWA swipe-kill 关键保障）
    // onDispatched 在 fetch 同步排进网络栈后立刻 fire，UI 此时即可取消"准备中"
    // 半透明态 —— 不等 response，因为 worker 是同步阻塞跑完 LLM+push 才 200
    const sendResult = await sendInstantPush(
      { ...business, pushSubscription: sub },
      { keepalive: true, onDispatched: onPosted },
    );
    if (!sendResult.ok) {
      return { ok: false, outcome: 'send-failed', error: sendResult.error };
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
