import { DB } from '../db';
import { ChatParser } from '../chatParser';
import { CHAT_GEN_EVENTS, announceChatGen } from '../chatGenEvents';
import { clearNativeJob, getNativeJob } from './nativeRuntime';
import {
  getRecoverableChatJobs,
  loadChatGenerationJobs,
  patchChatGenerationJob,
  refreshChatJobFromNative,
  type ChatGenerationJob,
} from './chatJobs';

const RUNNING_JOB_STALE_MS = 30 * 60 * 1000;

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
      await writeInterruptedNotice(job, job.error || '后台生成失败');
      failed += 1;
      continue;
    }
    if (Date.now() - job.updatedAt > RUNNING_JOB_STALE_MS) {
      patchChatGenerationJob(job.id, { status: 'interrupted', error: '后台生成超时或被系统中断' });
      await writeInterruptedNotice(job, '后台生成超时或被系统中断');
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
  const raw = extractAssistantContent(native.response?.body || '');
  if (!raw) {
    patchChatGenerationJob(job.id, { status: 'failed', error: '后台回复为空' });
    await writeInterruptedNotice(job, '后台回复为空');
    return false;
  }

  const clean = ChatParser.sanitize(raw).trim();
  if (!ChatParser.hasDisplayContent(clean)) {
    patchChatGenerationJob(job.id, { status: 'failed', error: '后台回复没有可显示内容' });
    await writeInterruptedNotice(job, '后台回复没有可显示内容');
    return false;
  }

  const chunks = ChatParser.chunkText(clean).filter(chunk => ChatParser.hasDisplayContent(chunk));
  for (const chunk of chunks) {
    const text = ChatParser.sanitize(chunk).trim();
    if (!text) continue;
    await DB.saveMessage({
      charId: job.charId,
      role: 'assistant',
      type: 'text',
      content: text,
      metadata: {
        source: 'native-runtime-recovery',
        chatJobId: job.id,
        nativeJobId: job.nativeJobId,
      },
    } as any);
  }

  patchChatGenerationJob(job.id, { status: 'recovered' });
  try { await clearNativeJob(job.nativeJobId); } catch { /* ignore */ }
  announceChatGen(CHAT_GEN_EVENTS.replyArrived, { charId: job.charId, charName: job.charName || '角色' });
  return true;
}

async function writeInterruptedNotice(job: ChatGenerationJob, reason: string): Promise<void> {
  await DB.saveMessage({
    charId: job.charId,
    role: 'system',
    type: 'text',
    content: `[系统: 上次回复生成中断，可重新发送上一条消息重试。原因：${reason}]`,
    metadata: {
      source: 'native-runtime-recovery',
      chatJobId: job.id,
      nativeJobId: job.nativeJobId,
      interrupted: true,
      reason,
    },
  } as any).catch(() => {});
  patchChatGenerationJob(job.id, { status: 'interrupted', error: reason });
  try { await clearNativeJob(job.nativeJobId); } catch { /* ignore */ }
  announceChatGen(CHAT_GEN_EVENTS.replyArrived, { charId: job.charId, charName: job.charName || '角色' });
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
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const keep = loadChatGenerationJobs().filter(job => job.updatedAt >= cutoff || job.status === 'running' || job.status === 'native_completed');
  try { localStorage.setItem('sully_chat_generation_jobs_v1', JSON.stringify(keep.slice(0, 50))); } catch { /* ignore */ }
}
