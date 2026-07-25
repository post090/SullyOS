import { type ApiCallMeta } from '../apiCallLog';
import { isSamplingParamError, modelRejectsSamplingParams, stripSamplingParams } from '../samplingParamCompat';
import { enqueueAndWaitNativeHttp, type NativeHttpResult } from './nativeJobQueue';
import { createChatGenerationJob, hashChatRequestBody, markChatJobFailed, markChatJobNativeCompleted } from './chatJobs';
import { getNativeChatRuntimeUserEnabled, isNativeRuntimeAvailable, isNativeRuntimeEnabled } from './nativeRuntime';

export interface NativeChatAttemptResult extends NativeHttpResult {
  chatJobId?: string;
  headersMs: number;
  totalMs: number;
  requestBody: string;
}

export function shouldUseNativeChatRuntime(url: string, options: RequestInit, meta?: ApiCallMeta): boolean {
  if (!isNativeRuntimeEnabled()) return false;
  if (!url.includes('/chat/completions')) return false;
  // 当前只接主聊天回复。旁路任务继续走原 fetch monkey-patch，保留流式升级/专项自愈。
  if (!(meta?.appName === '消息' && meta?.purpose === '聊天回复')) return false;
  if (!getNativeChatRuntimeUserEnabled()) return false;
  const method = String(options.method || 'GET').toUpperCase();
  return method === 'POST' && typeof options.body === 'string';
}

export async function canUseNativeChatRuntime(url: string, options: RequestInit, meta?: ApiCallMeta): Promise<boolean> {
  return shouldUseNativeChatRuntime(url, options, meta) && await isNativeRuntimeAvailable();
}

export async function sendNativeChatAttempt(input: {
  url: string;
  options: RequestInit;
  timeoutMs: number;
  meta?: ApiCallMeta;
}): Promise<NativeChatAttemptResult> {
  const nativeStartedAt = Date.now();
  const nativeJobId = makeNativeJobId();
  const body = prepareNativeChatBody(String(input.options.body || ''));
  const chatJob = input.meta?.charId ? createChatGenerationJob({
    nativeJobId,
    charId: input.meta.charId,
    charName: input.meta.charName,
    requestHash: hashChatRequestBody(body),
  }) : null;
  const result = await enqueueAndWaitNativeHttp({
    jobId: nativeJobId,
    url: input.url,
    method: String(input.options.method || 'POST').toUpperCase() as 'POST' | 'GET',
    headers: headersInitToRecord(input.options.headers),
    body,
    timeoutMs: input.timeoutMs || 120_000,
    responseType: 'json',
    title: input.meta?.charName ? `${input.meta.charName} 正在回应你` : 'SullyOS 正在生成回复',
    text: input.meta?.purpose || input.meta?.appName || '后台请求处理中',
    meta: input.meta ? {
      appName: input.meta.appName,
      charId: input.meta.charId,
      charName: input.meta.charName,
      purpose: input.meta.purpose,
    } : undefined,
  });
  const totalMs = Date.now() - nativeStartedAt;
  return {
    ...result,
    chatJobId: chatJob?.id,
    headersMs: totalMs,
    totalMs,
    requestBody: body,
  };
}

export function markNativeChatCompleted(chatJobId: string | undefined, data: any): void {
  if (!chatJobId || !data || typeof data !== 'object') return;
  markChatJobNativeCompleted(chatJobId);
  try {
    Object.defineProperty(data, '__sullyChatJobId', { value: chatJobId, enumerable: false });
  } catch {
    data.__sullyChatJobId = chatJobId;
  }
}

export function markNativeChatFailed(chatJobId: string | undefined, error: unknown): void {
  if (!chatJobId) return;
  const message = error instanceof Error ? error.message : String(error);
  markChatJobFailed(chatJobId, message);
}

export function isNativeSamplingError(statusCode: number, body: string): boolean {
  return statusCode === 400 && isSamplingParamError(body || '');
}

export function stripSamplingFromNativeBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    return stripSamplingParams(parsed) ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

function prepareNativeChatBody(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (modelRejectsSamplingParams(parsed?.model) && stripSamplingParams(parsed)) {
      return JSON.stringify(parsed);
    }
  } catch { /* keep original */ }
  return body;
}

function makeNativeJobId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return `chat-${c.randomUUID()}`;
  } catch { /* ignore */ }
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function headersInitToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  try {
    if (headers instanceof Headers) {
      headers.forEach((value, key) => { out[key] = value; });
      return out;
    }
  } catch { /* test env may not expose Headers */ }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key)] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) out[key] = String(value);
  return out;
}
