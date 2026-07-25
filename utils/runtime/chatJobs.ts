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
}

export function makeChatGenerationJobId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return `chatgen-${c.randomUUID()}`;
  } catch { /* ignore */ }
  return `chatgen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  };
  upsertChatGenerationJob(job);
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
  const job = patchChatGenerationJob(id, { status: 'consumed' });
  if (job?.nativeJobId) {
    try { await clearNativeJob(job.nativeJobId); } catch { /* ignore */ }
  }
}

export function markChatJobFailed(id: string | undefined, error: string): void {
  if (!id) return;
  patchChatGenerationJob(id, { status: 'failed', error });
}

export function getRecoverableChatJobs(): ChatGenerationJob[] {
  return loadChatGenerationJobs().filter(job => job.status === 'running' || job.status === 'native_completed');
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
