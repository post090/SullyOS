import { DB } from '../db';
import { applyAssistantPostProcessing, type XhsCaches } from '../applyAssistantPostProcessing';
import { ChatParser } from '../chatParser';
import { CHAT_GEN_EVENTS, announceChatGen } from '../chatGenEvents';
import { appendDevDebugLog } from '../devDebug';
import { sanitizeForNotification } from '../sanitize';
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

  const saved = await replayRecoveredAssistant(job, raw);
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

async function replayRecoveredAssistant(job: ChatGenerationJob, raw: string): Promise<number> {
  const chars = await DB.getAllCharacters();
  const char = chars.find(c => c.id === job.charId);
  const userProfile = await DB.getUserProfile();
  if (!char || !userProfile) return saveRecoveredAssistantMessagesFallback(job, raw);
  const contextMsgs = await DB.getMessagesByCharId(job.charId, true);
  const emojis = await DB.getEmojis();
  let api: any = { baseUrl: '', apiKey: '', model: '' };
  try {
    const saved = JSON.parse(localStorage.getItem('os_api_config') || '{}');
    api = { baseUrl: saved.baseUrl || '', apiKey: saved.apiKey || '', model: saved.model || '' };
  } catch { /* fallback keeps action replay local-only */ }
  let initialData: any = {};
  try { initialData = JSON.parse(raw); } catch { initialData = { choices: [{ message: { content: raw } }] }; }
  const content = initialData?.choices?.[0]?.message?.content || raw;
  const caches: XhsCaches = {
    xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(),
    commentAuthorNameCache: new Map(), commentParentIdCache: new Map(),
  };
  let savedMessages = 0;
  const before = contextMsgs.length;
  await applyAssistantPostProcessing(content, {
    char, userProfile, emojis, contextMsgs, fullMessages: contextMsgs,
    initialData, historyMsgCount: contextMsgs.length, xhsCaches: caches,
    mcdInheritMeta: recoveredMeta(job),
    api: { baseUrl: api.baseUrl, headers: api.apiKey ? { Authorization: `Bearer ${api.apiKey}` } : {}, effectiveApi: api },
    recoveryReplay: true, skipSecondPassLLM: true, instantRender: true,
    hooks: {
      setMessages: msgs => { savedMessages = Math.max(savedMessages, msgs.length - before); },
      addToast: () => {}, setRecallStatus: () => {}, setSearchStatus: () => {},
      setDiaryStatus: () => {}, setXhsStatus: () => {}, updateTokenUsage: () => {},
    },
  });
  return savedMessages > 0 ? savedMessages : countRecoveredMessages(job);
}

async function countRecoveredMessages(job: ChatGenerationJob): Promise<number> {
  const messages = await DB.getMessagesByCharId(job.charId, true);
  return messages.filter(m => m.metadata?.source === 'native-runtime-recovery' && m.metadata?.chatJobId === job.id).length;
}

async function saveRecoveredAssistantMessagesFallback(job: ChatGenerationJob, raw: string): Promise<number> {
  let saved = 0;
  const parts = ChatParser.splitResponse(raw);
  const fallbackParts = parts.length > 0 ? parts : [{ type: 'text' as const, content: raw }];
  for (const part of fallbackParts) {
    const clean = sanitizeRecoveredText(part.content);
    if (!ChatParser.hasDisplayContent(clean)) continue;
    await DB.saveMessage({ charId: job.charId, role: 'assistant', type: part.type === 'emoji' ? 'emoji' : 'text', content: clean, metadata: recoveredMeta(job) } as any);
    saved++;
  }
  return saved;
}

function sanitizeRecoveredText(text: string): string {
  // 恢复路径不能执行二轮副作用，也不能把原始控制标签漏进聊天。
  // notification sanitizer 是终态清洗：会剥 XHS/READ_NOTE/HTML/think 等标签并保留可读文本。
  return ChatParser.sanitize(sanitizeForNotification(text)).trim();
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
    return messages.some(message => message.metadata?.chatJobId === job.id);
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
