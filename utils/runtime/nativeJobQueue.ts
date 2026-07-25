import { enqueueNativeHttpJob, getNativeJob, type NativeJobRecord } from './nativeRuntime';

export interface NativeHttpRequest {
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

export interface NativeHttpResult {
  jobId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  job: NativeJobRecord;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function enqueueAndWaitNativeHttp(request: NativeHttpRequest): Promise<NativeHttpResult> {
  await enqueueNativeHttpJob(request);
  const startedAt = Date.now();
  const timeoutMs = Math.max(15_000, request.timeoutMs ?? 120_000);
  let delay = 350;

  while (Date.now() - startedAt <= timeoutMs + 5_000) {
    const job = await getNativeJob(request.jobId);
    if (!job) throw new Error(`Native job not found: ${request.jobId}`);
    if (job.status === 'completed') {
      return {
        jobId: request.jobId,
        statusCode: job.response?.statusCode ?? 0,
        headers: normalizeHeaders(job.response?.headers),
        body: job.response?.body ?? '',
        job,
      };
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error || `Native job ${job.status}`);
    }
    await sleep(delay);
    delay = Math.min(1500, Math.round(delay * 1.25));
  }

  throw new Error(`Native job timeout: ${request.jobId}`);
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!key) continue;
    out[key.toLowerCase()] = String(value ?? '');
  }
  return out;
}
