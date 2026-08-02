// utils/amsg2TaskContext.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db', () => ({
  DB: { getRecentMessagesByCharId: vi.fn() },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    upsertExpiredNotices: vi.fn().mockResolvedValue([]),
    getExpiredNotices: vi.fn().mockResolvedValue([]),
  },
}));

import {
  AMSG2_TASK_LOOKBACK_MS,
  buildAmsg2TaskContextText,
  buildUserCancelledNotices,
  collectAmsg2TaskContext,
} from './amsg2TaskContext';
import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';
import type { ActiveMsg2TaskRecord, Amsg2ExpiredNoticeRecord, CharacterProfile } from '../types';

const H = 3600_000;
const pendingTask: ActiveMsg2TaskRecord = {
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000', clientTaskId: 'cid-aabb', mode: 'prompted',
  firstSendTime: new Date(Date.now() + H).toISOString(), recurrenceType: 'none',
  promptHint: '问问考试结果', expirePolicy: 'expire',
  source: 'character', status: 'scheduled', createdAt: Date.now(),
};
const expired: Amsg2ExpiredNoticeRecord = {
  id: 'aabbccdd-0000-0000-0000-000000000000', charId: 'c1',
  occurrenceMs: Date.now() - H, mode: 'prompted', promptHint: '问问考试结果',
  recurrenceType: 'none', kind: 'expired', createdAt: Date.now(),
};

describe('buildAmsg2TaskContextText', () => {
  it('没任务没作废 → null（零噪音）', () => {
    expect(buildAmsg2TaskContextText([], [], Date.now(), undefined)).toBeNull();
  });
  it('进行中任务列出短 id 与方向', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [], Date.now(), undefined)!;
    expect(text).toContain('[aabbccdd]');
    expect(text).toContain('问问考试结果');
    expect(text).not.toContain('已作废');
  });
  it('作废段包含三选一引导、时机约束、renew 与重建引导、不复述约束', () => {
    const text = buildAmsg2TaskContextText([], [expired], Date.now(), undefined)!;
    expect(text).toContain('已作废');
    expect(text).toContain('renew_active_message');
    expect(text).toContain('cancel_active_message + schedule_active_message');
    expect(text).toContain('强行转移');
    expect(text).toContain('不要向用户复述');
  });

  // 回归守卫：防复述约束以前只挂在作废那一段里，「仅进行中」形态整块裸奔——
  // 短 id、「遇忙作废」这些系统腔会被角色照着念出来。
  it('只有进行中任务时也带防复述约束', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [], Date.now(), undefined)!;
    expect(text).toContain('不要向用户复述');
  });

  it('约束放在块尾，管住整块', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [expired], Date.now(), undefined)!;
    expect(text.trimEnd().endsWith('不要向用户复述或提及这份排程信息本身的存在。')).toBe(true);
  });

  // 回归守卫：手动取消以前没有任何回执，角色下次还照着旧承诺说「放心我叫你」。
  it('手动取消的回执单独成段，并说明不必向用户求证', () => {
    const cancelled: Amsg2ExpiredNoticeRecord = {
      ...expired, id: `${expired.id}:cancelled`, kind: 'user-cancelled',
    };
    const text = buildAmsg2TaskContextText([], [cancelled], Date.now(), undefined)!;
    expect(text).toContain('已被手动取消');
    expect(text).toContain('[aabbccdd]');
    expect(text).toContain('不必向用户求证');
    // 手动取消不该混进「自动作废」那段的三选一引导里（续期对它没有意义）
    expect(text).not.toContain('到点时对话正在进行');
  });

  it('两类回执同时存在 → 各占一段', () => {
    const cancelled: Amsg2ExpiredNoticeRecord = {
      ...expired, id: 'bbbbbbbb-0000-0000-0000-000000000000:cancelled', kind: 'user-cancelled',
    };
    const text = buildAmsg2TaskContextText([], [expired, cancelled], Date.now(), undefined)!;
    expect(text).toContain('已作废（到点时对话正在进行');
    expect(text).toContain('已被手动取消');
  });
});

describe('buildUserCancelledNotices', () => {
  const now = Date.now();

  it('给还会响的任务写回执，id 与作废回执分开且幂等', () => {
    const notices = buildUserCancelledNotices('c1', [pendingTask], now);
    expect(notices).toHaveLength(1);
    expect(notices[0].id).toBe(`${pendingTask.taskUuid}:cancelled`);
    expect(notices[0].kind).toBe('user-cancelled');
    expect(notices[0].charId).toBe('c1');
    // 再取消一次只会命中同一个 id，台账按 id 去重 → 幂等
    expect(buildUserCancelledNotices('c1', [pendingTask], now)[0].id).toBe(notices[0].id);
  });

  it('已经发过的一次性任务不写（没有承诺可撤）', () => {
    const fired: ActiveMsg2TaskRecord = {
      ...pendingTask, firstSendTime: new Date(now - 5 * H).toISOString(),
    };
    expect(buildUserCancelledNotices('c1', [fired], now)).toEqual([]);
  });

  it('循环任务写的是「下一次」的时刻', () => {
    const daily: ActiveMsg2TaskRecord = {
      ...pendingTask, recurrenceType: 'daily',
      firstSendTime: new Date(now - 5 * 24 * H + H).toISOString(),
    };
    const [notice] = buildUserCancelledNotices('c1', [daily], now);
    expect(notice.occurrenceMs).toBeGreaterThan(now);
  });
});

// 回归守卫：送达证据以前只在「最近 200 条」里找。重度用户 48h 聊过 200 条之后，
// 已经发出去的那条主动消息被挤出窗口 → 检出侧把它当成作废 → 角色把发过的事再来一遍。
describe('collectAmsg2TaskContext 的送达证据窗口', () => {
  const NOW = Date.UTC(2026, 7, 2, 12, 0);
  const CLIENT_TASK_ID = 'cid-morning';
  const TASK_UUID = 'aabbccdd-1111-4111-8111-111111111111';

  /** 触发时刻（2h 前）+ 排程锚点（3h 前）。 */
  const occurrenceMs = NOW - 2 * H;
  const anchorMs = NOW - 3 * H;

  /** 送达证据（这一次确实发出去了）在最老的位置，后面压着一大堆用户消息。 */
  const buildHistory = (chatterCount: number) => {
    const delivered = {
      id: 1, role: 'assistant', timestamp: occurrenceMs + 60_000,
      metadata: { activeMsg2: { taskId: 'remote-1' }, amsgClientTaskId: CLIENT_TASK_ID },
    };
    const chatter = Array.from({ length: chatterCount }, (_, i) => ({
      id: i + 2, role: 'user',
      timestamp: NOW - H + i * 1_000,
      metadata: {},
    }));
    return [delivered, ...chatter];
  };

  const charWithTask = (): CharacterProfile => ({
    id: 'char-heavy', name: '重度聊天',
    activeMsg2Config: {
      enabled: true,
      tasks: [{
        taskUuid: TASK_UUID, clientTaskId: CLIENT_TASK_ID, mode: 'auto',
        firstSendTime: new Date(occurrenceMs).toISOString(), recurrenceType: 'none',
        expirePolicy: 'expire', anchorLastUserMsgAt: anchorMs,
        source: 'character', status: 'scheduled', createdAt: anchorMs,
      }],
    },
  } as unknown as CharacterProfile);

  beforeEach(() => {
    vi.setSystemTime(NOW);
    (ActiveMsgStore.upsertExpiredNotices as any).mockClear();
    (ActiveMsgStore.getExpiredNotices as any).mockResolvedValue([]);
  });

  it('近史超过 200 条、送达证据在 200 条之外 → 不再误判成作废', async () => {
    const history = buildHistory(260);
    (DB.getRecentMessagesByCharId as any).mockImplementation(
      async (_id: string, limit: number) => history.slice(-limit));

    const result = await collectAmsg2TaskContext(charWithTask());

    // 修复前：固定取 200 条 → 证据被挤出窗口 → 这里会攒下一条作废回执
    expect(ActiveMsgStore.upsertExpiredNotices).not.toHaveBeenCalled();
    expect(result.expiredIds).toEqual([]);
  });

  it('真的没送达（证据不存在）照旧检出作废', async () => {
    const history = buildHistory(260).filter((m) => m.role !== 'assistant');
    (DB.getRecentMessagesByCharId as any).mockImplementation(
      async (_id: string, limit: number) => history.slice(-limit));

    await collectAmsg2TaskContext(charWithTask());

    expect(ActiveMsgStore.upsertExpiredNotices).toHaveBeenCalledTimes(1);
    const [, records] = (ActiveMsgStore.upsertExpiredNotices as any).mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('expired');
  });

  it('历史不足一页时不空转多要一次', async () => {
    (DB.getRecentMessagesByCharId as any).mockClear();
    (DB.getRecentMessagesByCharId as any).mockResolvedValue(buildHistory(10));

    await collectAmsg2TaskContext(charWithTask());

    expect(DB.getRecentMessagesByCharId).toHaveBeenCalledTimes(1);
  });
});

// 回看期必须明确短于作废台账的 TTL（48h）：一样长的话，边界那天的触发会在台账
// 刚清掉它的下一轮被重新检出，同一件事给角色说第二遍。
describe('回看期与台账 TTL 的关系', () => {
  it('回看期 < 48h', () => {
    expect(AMSG2_TASK_LOOKBACK_MS).toBeLessThan(48 * H);
  });
});
