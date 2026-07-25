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
