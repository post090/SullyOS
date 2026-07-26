/**
 * SullyOS Native Scheduler - bridges JS timers (Proactive/VR/Task) to Android native recoverable queue.
 *
 * Why this file exists:
 * - WebView JS timers are throttled in background / killed when Android reclaims WebView.
 * - Native Runtime already has a recoverable HTTP job queue with `runAt` that survives process death
 *   and is resumed on START_FOREGROUND / BOOT_COMPLETED.
 * - We reuse that queue as a durable timer: enqueue a tiny 204 request with future runAt.
 *   When it completes, JS layer sees `completed` status and triggers the real work (LLM, VR, etc).
 *
 * This does NOT run LLM in native - it just makes the *trigger* durable. The actual
 * generation still happens in JS via existing OSContext runProactive/runVR flows,
 * but now with a fallback that fires even after WebView was killed.
 */

import {
  enqueueNativeHttpJob,
  listNativeJobs,
  clearNativeJob,
  isNativeRuntimePlatform,
  getPersistentNativeRuntimeUserEnabled,
} from './nativeRuntime';

const TIMER_URL = 'https://www.gstatic.com/generate_204';
const TIMER_TAG_PREFIX = 'sully-timer-';
const TIMER_JOB_PREFIX = 'sully-timer-';

export type NativeTimerKind = 'proactive' | 'vr' | 'world' | 'task' | 'generic';

export interface NativeTimerMeta {
  kind: NativeTimerKind;
  charId?: string;
  worldId?: string;
  taskId?: string;
  tag: string;
}

function isTimerJobId(jobId: string): boolean {
  return jobId.startsWith(TIMER_JOB_PREFIX);
}

function toJobId(tag: string): string {
  const safe = tag.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return `${TIMER_JOB_PREFIX}${safe}`;
}

/**
 * Schedule a durable native timer. If runAt is in the past, it fires ASAP.
 * Overwrites any previous timer with same tag (idempotent).
 */
export async function scheduleNativeTimer(input: {
  tag: string;
  runAt: number;
  kind: NativeTimerKind;
  charId?: string;
  worldId?: string;
  taskId?: string;
  title?: string;
}): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  if (!getPersistentNativeRuntimeUserEnabled()) return; // only when always-on enabled
  const jobId = toJobId(input.tag);
  const runAt = Math.max(Date.now() + 1000, input.runAt);
  try {
    // Best effort: clear previous timer with same tag to keep queue clean
    // (list is small, linear scan is fine)
    await clearNativeJob(jobId).catch(() => {});
  } catch { /* ignore */ }

  try {
    await enqueueNativeHttpJob({
      jobId,
      url: TIMER_URL,
      method: 'GET',
      timeoutMs: 15000,
      runAt,
      responseType: 'text',
      title: input.title || 'SullyOS 正在运行',
      text: '',
      meta: {
        type: 'native-timer',
        kind: input.kind,
        charId: input.charId,
        worldId: input.worldId,
        taskId: input.taskId,
        tag: input.tag,
      } as unknown as Record<string, unknown>,
    });
  } catch (e) {
    console.warn('[NativeScheduler] schedule failed', { tag: input.tag, error: e });
  }
}

export async function cancelNativeTimer(tag: string): Promise<void> {
  if (!isNativeRuntimePlatform()) return;
  const jobId = toJobId(tag);
  try {
    await clearNativeJob(jobId);
  } catch { /* ignore */ }
}

/**
 * Clear ALL durable native timer jobs regardless of status or the enabled flag.
 * Called when the user turns OFF always-on so completed/pending timer jobs do not
 * leak in the native queue (they would never be drained again while disabled).
 * Returns the number of timer jobs cleared.
 */
export async function clearAllNativeTimers(): Promise<number> {
  if (!isNativeRuntimePlatform()) return 0;
  let cleared = 0;
  try {
    const jobs = await listNativeJobs();
    for (const job of jobs) {
      if (!isTimerJobId(job.jobId)) continue;
      await clearNativeJob(job.jobId).catch(() => {});
      cleared += 1;
    }
  } catch (e) {
    console.warn('[NativeScheduler] clearAll failed', e);
  }
  return cleared;
}

/**
 * Poll native jobs for completed timers, dispatch events, and clean up.
 * Returns number of timers drained.
 */
export async function drainNativeTimers(): Promise<number> {
  if (!isNativeRuntimePlatform()) return 0;
  if (!getPersistentNativeRuntimeUserEnabled()) return 0;
  let drained = 0;
  try {
    const jobs = await listNativeJobs();
    const timerJobs = jobs.filter(j => isTimerJobId(j.jobId) && j.status === 'completed');
    for (const job of timerJobs) {
      const meta = (job.meta || {}) as any;
      // Only handle our native-timer type; ignore stray timer jobs
      if (meta?.type !== 'native-timer') {
        // Still clean up old timer jobs without meta to avoid leak
        if (isTimerJobId(job.jobId)) {
          await clearNativeJob(job.jobId).catch(() => {});
        }
        continue;
      }
      const kind = String(meta.kind || 'generic') as NativeTimerKind;
      const tag = String(meta.tag || job.jobId);
      const detail: NativeTimerMeta & { jobId: string } = {
        kind,
        charId: meta.charId,
        worldId: meta.worldId,
        taskId: meta.taskId,
        tag,
        jobId: job.jobId,
      };
      try {
        window.dispatchEvent(new CustomEvent('sully-native-timer', { detail }));
        drained += 1;
      } catch { /* ignore */ }
      // Clean up after dispatch
      await clearNativeJob(job.jobId).catch(() => {});
    }
    // Also clean up failed timer jobs (e.g., network failure on 204) -> treat as firing anyway
    const failedTimers = jobs.filter(j => isTimerJobId(j.jobId) && (j.status === 'failed' || j.status === 'cancelled'));
    for (const job of failedTimers) {
      const meta = (job.meta || {}) as any;
      if (meta?.type === 'native-timer') {
        const kind = String(meta.kind || 'generic') as NativeTimerKind;
        const tag = String(meta.tag || job.jobId);
        const detail: NativeTimerMeta & { jobId: string; failed: boolean } = {
          kind,
          charId: meta.charId,
          worldId: meta.worldId,
          taskId: meta.taskId,
          tag,
          jobId: job.jobId,
          failed: true,
        } as any;
        try {
          window.dispatchEvent(new CustomEvent('sully-native-timer', { detail }));
          drained += 1;
        } catch {}
      }
      await clearNativeJob(job.jobId).catch(() => {});
    }
  } catch (e) {
    console.warn('[NativeScheduler] drain failed', e);
  }
  return drained;
}

/**
 * Convenience: schedule proactive next-fire. Called from ProactiveChat after computing next interval.
 */
export async function scheduleNativeProactiveTimer(charId: string, nextFireAt: number): Promise<void> {
  await scheduleNativeTimer({
    tag: `proactive-${charId}`,
    runAt: nextFireAt,
    kind: 'proactive',
    charId,
    title: 'SullyOS 正在运行',
  });
}

export async function scheduleNativeVrTimer(charId: string, nextFireAt: number): Promise<void> {
  await scheduleNativeTimer({
    tag: `vr-${charId}`,
    runAt: nextFireAt,
    kind: 'vr',
    charId,
    title: 'SullyOS 正在运行',
  });
}

export async function scheduleNativeWorldTimer(worldId: string, nextFireAt: number): Promise<void> {
  await scheduleNativeTimer({
    tag: `world-${worldId}`,
    runAt: nextFireAt,
    kind: 'world',
    worldId,
    title: 'SullyOS 正在运行',
  });
}
