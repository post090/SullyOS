import { clearNativeJob, getNativeJob } from './nativeRuntime';

const JOBS_KEY = 'sully_chat_generation_jobs_v1';
const MAX_JOBS = 50;

export type ChatGenerationJobStatus = 'running' | 'native_completed' | 'consumed' | 'recovered' | 'failed' | 'interrupted';

export interface ChatGenerationJob {
  id: string;
  nativeJobId: string;
  charId: string;
  charName?: string;
  status: ChatGenerationJobStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  requestHash?: string;
}

export function makeChatGenerationJobId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return `chatgen-${c.randomUUID()}`;
  } catch { /* ignore */ }
  return `chatgen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── 在场名单：本页面会话仍在管的任务 ────────────────────────────
// 根因：切回 App 时 visibilitychange 的恢复扫描和被冻结后解冻的正常流水线会
// 同时处理同一个 native_completed 任务 → 同一条回复入库两次。
// 名单只活在内存里：页面真被杀（WebView 重建）名单自然清空，恢复机制才接手；
// 页面只是冻结过，流水线醒来自己会送达，恢复机制不许抢活。
const liveInPageChatJobs = new Set<string>();

export function registerLiveInPageChatJob(id: string): void {
  liveInPageChatJobs.add(id);
}

export function unregisterLiveInPageChatJob(id?: string): void {
  if (id) liveInPageChatJobs.delete(id);
}

export function isLiveInPageChatJob(id: string): boolean {
  return liveInPageChatJobs.has(id);
}

export function loadChatGenerationJobs(): ChatGenerationJob[] {
  try {
    const raw = localStorage.getItem(JOBS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isJob) : [];
  } catch {
    return [];
  }
}

export function saveChatGenerationJobs(jobs: ChatGenerationJob[]): void {
  try {
    const compact = [...jobs]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_JOBS);
    localStorage.setItem(JOBS_KEY, JSON.stringify(compact));
  } catch {
    // best-effort only
  }
}

export function upsertChatGenerationJob(job: ChatGenerationJob): void {
  const jobs = loadChatGenerationJobs();
  const idx = jobs.findIndex(j => j.id === job.id);
  if (idx >= 0) jobs[idx] = job;
  else jobs.unshift(job);
  saveChatGenerationJobs(jobs);
}

export function createChatGenerationJob(input: {
  id?: string;
  nativeJobId: string;
  charId: string;
  charName?: string;
  requestHash?: string;
}): ChatGenerationJob {
  const now = Date.now();
  const job: ChatGenerationJob = {
    id: input.id || makeChatGenerationJobId(),
    nativeJobId: input.nativeJobId,
    charId: input.charId,
    charName: input.charName,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    requestHash: input.requestHash,
  };
  upsertChatGenerationJob(job);
  // 本页面亲手创建的任务 = 本页面流水线负责送达，恢复扫描不许抢
  registerLiveInPageChatJob(job.id);
  return job;
}

export function patchChatGenerationJob(id: string, patch: Partial<ChatGenerationJob>): ChatGenerationJob | null {
  const jobs = loadChatGenerationJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx < 0) return null;
  const next = { ...jobs[idx], ...patch, updatedAt: Date.now() };
  jobs[idx] = next;
  saveChatGenerationJobs(jobs);
  return next;
}

export function markChatJobNativeCompleted(id: string): void {
  patchChatGenerationJob(id, { status: 'native_completed' });
}

export async function markChatJobConsumed(id?: string): Promise<void> {
  if (!id) return;
  unregisterLiveInPageChatJob(id);
  const job = patchChatGenerationJob(id, { status: 'consumed' });
  if (job?.nativeJobId) {
    try { await clearNativeJob(job.nativeJobId); } catch { /* ignore */ }
  }
}

export function markChatJobFailed(id: string | undefined, error: string): void {
  if (!id) return;
  unregisterLiveInPageChatJob(id);
  const job = patchChatGenerationJob(id, { status: 'failed', error });
  if (job?.nativeJobId) {
    void clearNativeJob(job.nativeJobId).catch(() => {});
  }
}

export function getRecoverableChatJobs(): ChatGenerationJob[] {
  return loadChatGenerationJobs()
    .filter(job => job.status === 'running' || job.status === 'native_completed')
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function hasOpenChatGenerationJobs(): boolean {
  return getRecoverableChatJobs().length > 0;
}

export async function refreshChatJobFromNative(job: ChatGenerationJob): Promise<ChatGenerationJob> {
  if (job.status === 'native_completed') return job;
  const native = await getNativeJob(job.nativeJobId);
  if (!native) return job;
  if (native.status === 'completed') {
    return patchChatGenerationJob(job.id, { status: 'native_completed' }) || job;
  }
  if (native.status === 'failed' || native.status === 'cancelled') {
    return patchChatGenerationJob(job.id, { status: 'failed', error: native.error || `native job ${native.status}` }) || job;
  }
  return job;
}

function isJob(value: any): value is ChatGenerationJob {
  return !!value
    && typeof value.id === 'string'
    && typeof value.nativeJobId === 'string'
    && typeof value.charId === 'string'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
    && typeof value.status === 'string';
}

export function hashChatRequestBody(body: string): string {
  // 简单稳定 hash：只用于同机去重/排查，不作安全用途。
  let h = 2166136261;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
