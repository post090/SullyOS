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
  responseType?: 'text' | 'json';
  title?: string;
  text?: string;
  meta?: Record<string, unknown>;
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
}

const NativeRuntime = registerPlugin<SullyNativeRuntimePlugin>('SullyNativeRuntime');

let availability: boolean | null = null;

export function isNativeRuntimePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function isNativeRuntimeEnabled(): boolean {
  if (!isNativeRuntimePlatform()) return false;
  try {
    // 可在控制台/localStorage 里临时关掉，方便现场排查：localStorage.sully_native_runtime_enabled='0'
    return localStorage.getItem('sully_native_runtime_enabled') !== '0';
  } catch {
    return true;
  }
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
