import { beforeEach, describe, expect, it } from 'vitest';
import {
  createChatGenerationJob,
  getRecoverableChatJobs,
  hasOpenChatGenerationJobs,
  loadChatGenerationJobs,
  markChatJobConsumed,
  markChatJobFailed,
  markChatJobNativeCompleted,
  patchChatGenerationJob,
  saveChatGenerationJobs,
} from './chatJobs';

const KEY = 'sully_chat_generation_jobs_v1';

describe('ChatGenerationJob store', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
  });

  it('creates running jobs and lists them as recoverable', () => {
    const job = createChatGenerationJob({
      nativeJobId: 'native-1',
      charId: 'char-1',
      charName: '阿澄',
      requestHash: 'abc',
    });

    expect(job.status).toBe('running');
    expect(hasOpenChatGenerationJobs()).toBe(true);
    expect(getRecoverableChatJobs().map(j => j.id)).toEqual([job.id]);
    expect(loadChatGenerationJobs()[0].requestHash).toBe('abc');
  });

  it('does not treat consumed or failed jobs as recoverable', async () => {
    const done = createChatGenerationJob({ nativeJobId: 'native-done', charId: 'char-1' });
    markChatJobNativeCompleted(done.id);
    await markChatJobConsumed(done.id);

    const failed = createChatGenerationJob({ nativeJobId: 'native-failed', charId: 'char-1' });
    markChatJobFailed(failed.id, 'boom');

    expect(getRecoverableChatJobs()).toEqual([]);
    expect(loadChatGenerationJobs().map(j => j.status).sort()).toEqual(['consumed', 'failed']);
  });

  it('keeps recoverable jobs ordered from oldest to newest', () => {
    const newer = createChatGenerationJob({ nativeJobId: 'n2', charId: 'char-1' });
    const older = createChatGenerationJob({ nativeJobId: 'n1', charId: 'char-1' });
    patchChatGenerationJob(older.id, { createdAt: 1, updatedAt: 1 });
    patchChatGenerationJob(newer.id, { createdAt: 2, updatedAt: 2 });

    expect(getRecoverableChatJobs().map(j => j.nativeJobId)).toEqual(['n1', 'n2']);
  });

  it('caps persisted jobs to avoid unbounded localStorage growth', () => {
    const jobs = Array.from({ length: 80 }, (_, i) => ({
      id: `j${i}`,
      nativeJobId: `n${i}`,
      charId: 'char-1',
      status: 'consumed' as const,
      createdAt: i,
      updatedAt: i,
    }));
    saveChatGenerationJobs(jobs);

    expect(loadChatGenerationJobs()).toHaveLength(50);
    expect(loadChatGenerationJobs()[0].id).toBe('j79');
  });
});
