import { Capacitor, registerPlugin } from '@capacitor/core';

export type NativeRuntimeTaskKind = 'chat' | 'call' | 'tts' | 'memory' | 'generic';
export type NativeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface NativeJobRecord {
  jobId: string;
  status: NativeJobStatus;
  createdAt: number;
  updatedAt: number;
  timeoutMs?: number;
  responseType?: 'text' | 'json';
  request?: { url?: string; method?: string };
  response?: { statusCode: number; headers?: Record<string, string>; body?: string };
  meta?: Record<string, unknown>;
  error?: string;
}

interface EnqueueHttpJobInput {
  jobId: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  runAt?: number;
  responseType?: 'text' | 'json';
  title?: string;
  text?: string;
  meta?: Record<string, unknown>;
}

export interface NativeSystemStatus {
  notificationsEnabled: boolean;
  batteryOptimizationIgnored: boolean;
  persistentEnabled: boolean;
  postNotificationGranted: boolean;
}

interface SullyNativeRuntimePlugin {
  ping(): Promise<{ ok: boolean; platform: string }>;
  startForegroundTask(options: { id: string; kind?: NativeRuntimeTaskKind; title: string; text: string; ongoing?: boolean }): Promise<void>;
  stopForegroundTask(options?: { id?: string }): Promise<void>;
  enqueueHttpJob(options: EnqueueHttpJobInput): Promise<{ jobId: string }>;
  getJob(options: { jobId: string }): Promise<{ job: NativeJobRecord | null }>;
  listJobs(): Promise<{ jobs: NativeJobRecord[] }>;
  cancelJob(options: { jobId: string }): Promise<void>;
  clearJob(options: { jobId: string }): Promise<void>;
  showEventNotification(options: { title: string; body: string; tag?: string; route?: string }): Promise<void>;
  setPersistentEnabled(options: { enabled: boolean }): Promise<void>;
  getLaunchRoute(): Promise<{ route?: string }>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  getSystemStatus(): Promise<NativeSystemStatus>;
  requestBatteryOptimizationExemption(): Promise<{ opened: boolean; fallback?: boolean; error?: string }>;
  openNotificationSettings(): Promise<void>;
  openBatterySettings(): Promise<void>;
  startCallNotification(options: { charName: string; charId: string; startedAt: number; avatar?: string }): Promise<void>;
  updateCallNotification(options: { charName: string; charId: string; startedAt: number; avatar?: string }): Promise<void>;
  stopCallNotification(): Promise<void>;
  showMusicNotification(options: { title: string; artist: string; album: string; isPlaying: boolean; isLiked: boolean; songId: string; coverUrl?: string; durationMs?: number; positionMs?: number }): Promise<void>;
  updateMusicNotification(options: { title: string; artist: string; album: string; isPlaying: boolean; isLiked: boolean; songId: string; coverUrl?: string; durationMs?: number; positionMs?: number }): Promise<void>;
  stopMusicNotification(): Promise<void>;
  getPendingMusicAction(): Promise<{ action?: string }>;
  getCallState(): Promise<{ active: boolean; charId?: string; charName?: string; startedAt?: number }>;
}

const NativeRuntime = registerPlugin<SullyNativeRuntimePlugin>('SullyNativeRuntime');

export const NATIVE_RUNTIME_ENABLED_KEY = 'sully_native_runtime_enabled';
export const NATIVE_RUNTIME_CHAT_KEY = 'sully_native_runtime_chat';
export const NATIVE_RUNTIME_PERSISTENT_KEY = 'sully_native_runtime_persistent';

let availability: boolean | null = null;

export function getNativeRuntimeUserEnabled(): boolean {
  try { return localStorage.getItem(NATIVE_RUNTIME_ENABLED_KEY) !== '0'; } catch { return true; }
}

export function setNativeRuntimeUserEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(NATIVE_RUNTIME_ENABLED_KEY);
    else localStorage.setItem(NATIVE_RUNTIME_ENABLED_KEY, '0');
  } catch { /* ignore */ }
  availability = null;
}

export function getPersistentNativeRuntimeUserEnabled(): boolean {
  try { return localStorage.getItem(NATIVE_RUNTIME_PERSISTENT_KEY) === '1'; } catch { return false; }
}

export function setPersistentNativeRuntimeUserEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(NATIVE_RUNTIME_PERSISTENT_KEY, '1');
    else localStorage.removeItem(NATIVE_RUNTIME_PERSISTENT_KEY);
  } catch { /* ignore */ }
  // Notify listeners (e.g. OSContext drain loop) so the always-on toggle takes
  // effect immediately without requiring an app restart.
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sully-persistent-runtime-changed', { detail: { enabled } }));
    }
  } catch { /* ignore */ }
}

export function getNativeChatRuntimeUserEnabled(): boolean {
  try { return localStorage.getItem(NATIVE_RUNTIME_CHAT_KEY) !== '0'; } catch { return true; }
}

export function setNativeChatRuntimeUserEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(NATIVE_RUNTIME_CHAT_KEY);
    else localStorage.setItem(NATIVE_RUNTIME_CHAT_KEY, '0');
  } catch { /* ignore */ }
}

export function isNativeRuntimePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function isNativeRuntimeEnabled(): boolean {
  if (!isNativeRuntimePlatform()) return false;
  return getNativeRuntimeUserEnabled();
}

export async function isNativeRuntimeAvailable(): Promise<boolean> {
  if (!isNativeRuntimeEnabled()) return false;
  if (availability != null) return availability;
  try {
    const res = await NativeRuntime.ping();
    availability = !!res?.ok;
  } catch {
    availability = false;
  }
  return availability;
}

export async function startNativeForegroundTask(options: { id: string; kind?: NativeRuntimeTaskKind; title: string; text: string; ongoing?: boolean }): Promise<void> {
  if (!(await isNativeRuntimeAvailable())) return;
  await NativeRuntime.startForegroundTask(options);
}

export async function stopNativeForegroundTask(id: string = 'sully-runtime'): Promise<void> {
  if (!(await isNativeRuntimeAvailable())) return;
  await NativeRuntime.stopForegroundTask({ id });
}

/** Keeps the Android foreground service alive while the user enables the always-on mode. */
export async function startPersistentNativeRuntime(): Promise<void> {
  if (!(await isNativeRuntimeAvailable())) throw new Error('NativeRuntime unavailable');
  await NativeRuntime.setPersistentEnabled({ enabled: true });
  await startNativeForegroundTask({ id: 'sully-runtime', kind: 'generic', title: 'SullyOS 正在运行', text: '', ongoing: true });
}

export async function stopPersistentNativeRuntime(): Promise<void> {
  if (await isNativeRuntimeAvailable()) await NativeRuntime.setPersistentEnabled({ enabled: false });
  await stopNativeForegroundTask('sully-runtime');
  // Clean up leftover durable timer jobs so they do not leak in the native queue
  // while always-on is off (they would never be drained again). Best-effort.
  try {
    const { clearAllNativeTimers } = await import('./nativeScheduler');
    await clearAllNativeTimers();
  } catch { /* best-effort cleanup */ }
}

export async function getNativeLaunchRoute(): Promise<string | null> {
  if (!isNativeRuntimePlatform()) return null;
  try {
    const result = await NativeRuntime.getLaunchRoute();
    return result?.route || null;
  } catch { return null; }
}

export async function requestNativeNotificationPermission(): Promise<boolean> {
  if (!isNativeRuntimePlatform()) return true;
  try { return !!(await NativeRuntime.requestNotificationPermission())?.granted; } catch { return false; }
}

export async function getNativeSystemStatus(): Promise<NativeSystemStatus | null> {
  if (!isNativeRuntimePlatform()) return null;
  try {
    const res = await NativeRuntime.getSystemStatus();
    return res as NativeSystemStatus;
  } catch {
    return null;
  }
}

export async function requestBatteryOptimizationExemption(): Promise<boolean> {
  if (!isNativeRuntimePlatform()) return true;
  try {
    const res = await NativeRuntime.requestBatteryOptimizationExemption();
    return !!res?.opened;
  } catch { return false; }
}

export async function openNativeNotificationSettings(): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  try { await NativeRuntime.openNotificationSettings(); } catch { /* ignore */ }
}

export async function openBatterySettings(): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  try { await NativeRuntime.openBatterySettings(); } catch { /* ignore */ }
}

export async function showNativeRoleEventNotification(input: { title: string; body: string; tag?: string; route?: string }): Promise<void> {
  if (!getPersistentNativeRuntimeUserEnabled()) return;
  if (!(await isNativeRuntimeAvailable())) return;
  await NativeRuntime.showEventNotification({
    title: String(input.title || 'SullyOS').slice(0, 80),
    body: String(input.body || '').slice(0, 240),
    tag: input.tag,
    route: input.route,
  });
}

export async function enqueueNativeHttpJob(options: EnqueueHttpJobInput): Promise<{ jobId: string }> {
  if (!(await isNativeRuntimeAvailable())) throw new Error('NativeRuntime unavailable');
  return NativeRuntime.enqueueHttpJob({
    method: 'POST',
    headers: {},
    responseType: 'json',
    timeoutMs: 120_000,
    ...options,
  });
}

export async function getNativeJob(jobId: string): Promise<NativeJobRecord | null> {
  if (!(await isNativeRuntimeAvailable())) return null;
  const res = await NativeRuntime.getJob({ jobId });
  return res.job || null;
}

export async function listNativeJobs(): Promise<NativeJobRecord[]> {
  if (!(await isNativeRuntimeAvailable())) return [];
  const res = await NativeRuntime.listJobs();
  return Array.isArray(res.jobs) ? res.jobs : [];
}

export async function cancelNativeJob(jobId: string): Promise<void> {
  if (!(await isNativeRuntimeAvailable())) return;
  await NativeRuntime.cancelJob({ jobId });
}

export async function clearNativeJob(jobId: string): Promise<void> {
  if (!(await isNativeRuntimeAvailable())) return;
  await NativeRuntime.clearJob({ jobId });
}

export async function startNativeCallNotification(input: { charName: string; charId: string; startedAt?: number; avatar?: string }): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  try {
    await NativeRuntime.startCallNotification({
      charName: input.charName,
      charId: input.charId,
      startedAt: input.startedAt || Date.now(),
      avatar: await prepareCallAvatar(input.avatar),
    });
  } catch {}
}

export async function updateNativeCallNotification(input: { charName: string; charId: string; startedAt?: number; avatar?: string }): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  try {
    await NativeRuntime.updateCallNotification({
      charName: input.charName,
      charId: input.charId,
      startedAt: input.startedAt || 0,
      avatar: await prepareCallAvatar(input.avatar),
    });
  } catch {}
}

// 头像缩小成 192px JPEG dataURL 后再传给原生（Intent extras 有体积上限，大 base64 会抛
// TransactionTooLarge）；远程 http(s) 头像 canvas 会被跨域污染，直接交给原生自己下载。
const avatarCache = new Map<string, string>();
async function prepareCallAvatar(avatar?: string): Promise<string> {
  const src = (avatar || '').trim();
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src.length < 2000 ? src : '';
  if (!src.startsWith('data:image') && !src.startsWith('blob:')) return '';
  const cached = avatarCache.get(src);
  if (cached != null) return cached;
  // data URI 直接透传 —— Intent extras 上限 1MB，给到 800KB 余量；
  // 不在 JS 端再走 canvas 压缩（APK WebView 里 canvas 跨域/tainted 容易失败，反而丢头像）
  if (src.startsWith('data:image')) {
    const out = src.length < 800_000 ? src : '';
    avatarCache.clear();
    avatarCache.set(src, out);
    return out;
  }
  // blob: 走 canvas 压缩成 dataURL 再传
  let out = '';
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('avatar load failed'));
      img.src = src;
    });
    const size = 192;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx && img.width > 0 && img.height > 0) {
      // 居中裁成正方形（cover）
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      if (dataUrl.length < 800_000) out = dataUrl;
    }
  } catch { /* 取不到就不带头像 */ }
  avatarCache.clear();
  avatarCache.set(src, out);
  return out;
}

export async function stopNativeCallNotification(): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  try { await NativeRuntime.stopCallNotification(); } catch {}
}

export interface NativeMusicNotificationInput {
  title: string;
  artist: string;
  album?: string;
  isPlaying: boolean;
  isLiked: boolean;
  songId?: string;
  /** 专辑封面 http(s) URL，原生侧下载后渲染媒体卡片 */
  coverUrl?: string;
  durationMs?: number;
  positionMs?: number;
}

export async function showNativeMusicNotification(input: NativeMusicNotificationInput): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  try {
    await NativeRuntime.showMusicNotification({
      title: input.title,
      artist: input.artist,
      album: input.album || '',
      isPlaying: input.isPlaying,
      isLiked: input.isLiked,
      songId: input.songId || '',
      coverUrl: input.coverUrl || '',
      durationMs: Math.max(0, Math.round(input.durationMs || 0)),
      positionMs: Math.max(0, Math.round(input.positionMs || 0)),
    });
  } catch {}
}

export async function updateNativeMusicNotification(input: NativeMusicNotificationInput): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  try {
    await NativeRuntime.updateMusicNotification({
      title: input.title,
      artist: input.artist,
      album: input.album || '',
      isPlaying: input.isPlaying,
      isLiked: input.isLiked,
      songId: input.songId || '',
      coverUrl: input.coverUrl || '',
      durationMs: Math.max(0, Math.round(input.durationMs || 0)),
      positionMs: Math.max(0, Math.round(input.positionMs || 0)),
    });
  } catch {}
}

export async function stopNativeMusicNotification(): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  try { await NativeRuntime.stopMusicNotification(); } catch {}
}

export async function getPendingNativeMusicAction(): Promise<string | null> {
  if (!isNativeRuntimePlatform()) return null;
  try {
    const res = await NativeRuntime.getPendingMusicAction();
    return res?.action || null;
  } catch { return null; }
}

export async function getNativeCallState(): Promise<{ active: boolean; charId?: string; charName?: string; startedAt?: number } | null> {
  if (!isNativeRuntimePlatform()) return null;
  try {
    return await NativeRuntime.getCallState();
  } catch { return null; }
}
