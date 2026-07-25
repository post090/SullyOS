import { DB } from '../db';
import { ChatParser } from '../chatParser';
import { CHAT_GEN_EVENTS, announceChatGen } from '../chatGenEvents';
import { appendDevDebugLog } from '../devDebug';
import { clearNativeJob, getNativeJob } from './nativeRuntime';
import {
  getRecoverableChatJobs,
  loadChatGenerationJobs,
  patchChatGenerationJob,
  refreshChatJobFromNative,
  saveChatGenerationJobs,
  type ChatGenerationJob,
} from './chatJobs';

const RUNNING_JOB_STALE_MS = 30 * 60 * 1000;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function recoverNativeChatJobs(): Promise<{ recovered: number; failed: number; running: number }> {
  const jobs = getRecoverableChatJobs();
  let recovered = 0;
  let failed = 0;
  let running = 0;

  for (const original of jobs) {
    const job = await refreshChatJobFromNative(original);
    if (job.status === 'native_completed') {
      const ok = await recoverCompletedJob(job);
      if (ok) recovered += 1;
      else failed += 1;
      continue;
    }
    if (job.status === 'failed' || job.status === 'interrupted') {
      await markInterrupted(job, job.error || '后台生成失败');
      failed += 1;
      continue;
    }
    if (Date.now() - job.updatedAt > RUNNING_JOB_STALE_MS) {
      patchChatGenerationJob(job.id, { status: 'interrupted', error: '后台生成超时或被系统中断' });
      await markInterrupted(job, '后台生成超时或被系统中断');
      failed += 1;
      continue;
    }
    running += 1;
  }

  pruneOldJobs();
  return { recovered, failed, running };
}

async function recoverCompletedJob(job: ChatGenerationJob): Promise<boolean> {
  const native = await getNativeJob(job.nativeJobId);
  if (!native || native.status !== 'completed') return false;

  if (await hasRecoveredMessages(job)) {
    patchChatGenerationJob(job.id, { status: 'recovered' });
    try { await clearNativeJob(job.nativeJobId); } catch { /* ignore */ }
    return true;
  }

  const raw = extractAssistantContent(native.response?.body || '');
  if (!raw) return failCompletedJob(job, '后台回复为空');

  const saved = await saveRecoveredAssistantMessages(job, raw);
  if (saved <= 0) return failCompletedJob(job, '后台回复没有可显示内容');

  patchChatGenerationJob(job.id, { status: 'recovered' });
  try { await clearNativeJob(job.nativeJobId); } catch { /* ignore */ }
  logLifecycle('native-runtime chat job recovered', {
    chatJobId: job.id,
    nativeJobId: job.nativeJobId,
    charId: job.charId,
    charName: job.charName,
    messages: saved,
  });
  announceChatGen(CHAT_GEN_EVENTS.replyArrived, { charId: job.charId, charName: job.charName || '角色' });
  return true;
}

async function saveRecoveredAssistantMessages(job: ChatGenerationJob, raw: string): Promise<number> {
  let saved = 0;
  const parts = ChatParser.splitResponse(raw);
  const fallbackParts = parts.length > 0 ? parts : [{ type: 'text' as const, content: raw }];

  for (const part of fallbackParts) {
    if (part.type === 'emoji') {
      const emoji = part.content.trim();
      if (!emoji) continue;
      await DB.saveMessage({
        charId: job.charId,
        role: 'assistant',
        type: 'emoji',
        content: emoji,
        metadata: recoveredMeta(job),
      } as any);
      saved++;
      continue;
    }

    const clean = ChatParser.sanitize(part.content).trim();
    if (!ChatParser.hasDisplayContent(clean)) continue;
    const chunks = ChatParser.chunkText(clean).filter(chunk => ChatParser.hasDisplayContent(chunk));
    for (const chunk of chunks) {
      const text = ChatParser.sanitize(chunk).trim();
      if (!text) continue;
      await DB.saveMessage({
        charId: job.charId,
        role: 'assistant',
        type: 'text',
        content: text,
        metadata: recoveredMeta(job),
      } as any);
      saved++;
    }
  }

  return saved;
}

function recoveredMeta(job: ChatGenerationJob): Record<string, unknown> {
  return {
    source: 'native-runtime-recovery',
    chatJobId: job.id,
    nativeJobId: job.nativeJobId,
    requestHash: job.requestHash,
  };
}

async function hasRecoveredMessages(job: ChatGenerationJob): Promise<boolean> {
  try {
    const messages = await DB.getMessagesByCharId(job.charId, true);
    return messages.some(message => message.metadata?.source === 'native-runtime-recovery' && message.metadata?.chatJobId === job.id);
  } catch {
    return false;
  }
}

async function failCompletedJob(job: ChatGenerationJob, reason: string): Promise<boolean> {
  patchChatGenerationJob(job.id, { status: 'failed', error: reason });
  await markInterrupted(job, reason);
  return false;
}

async function markInterrupted(job: ChatGenerationJob, reason: string): Promise<void> {
  // 用户希望恢复/中断尽量无感：不往聊天记录里插系统消息。
  // 状态只留在本地 job + 开发者日志里，必要时排查可在调试面板打开「前后台」日志。
  patchChatGenerationJob(job.id, { status: 'interrupted', error: reason });
  logLifecycle('native-runtime chat job interrupted', {
    chatJobId: job.id,
    nativeJobId: job.nativeJobId,
    charId: job.charId,
    charName: job.charName,
    reason,
  });
  try { await clearNativeJob(job.nativeJobId); } catch { /* ignore */ }
}

function extractAssistantContent(body: string): string {
  if (!body.trim()) return '';
  try {
    const json = JSON.parse(body);
    return String(json?.choices?.[0]?.message?.content || json?.choices?.[0]?.message?.reasoning_content || '').trim();
  } catch {
    return body.trimStart().startsWith('data:') ? extractFromSse(body) : body.trim();
  }
}

function extractFromSse(body: string): string {
  let out = '';
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      out += chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.message?.content || '';
    } catch { /* ignore */ }
  }
  return out.trim();
}

function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  const keep = loadChatGenerationJobs().filter(job => job.updatedAt >= cutoff || job.status === 'running' || job.status === 'native_completed');
  saveChatGenerationJobs(keep);
}

function logLifecycle(label: string, data: unknown): void {
  try { appendDevDebugLog('lifecycle', { label, data }); } catch { /* ignore */ }
}
