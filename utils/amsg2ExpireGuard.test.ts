// utils/amsg2ExpireGuard.test.ts
import { describe, it, expect } from 'vitest';
import {
  ACTIVE_CHAT_WINDOW_MS,
  FIRE_GRACE_MS,
  detectExpiredOccurrences,
  getLastRealUserMessageAt,
  hasDeliveredProactiveNear,
  hasRealUserMessageBetween,
  shouldExpireFire,
} from './amsg2ExpireGuard';

const H = 3600_000;
const user = (timestamp: number, proactiveHint = false) => ({
  role: 'user', timestamp, metadata: proactiveHint ? { proactiveHint: true } : undefined,
});
const assistantPush = (timestamp: number, taskId: string | null = 't1') => ({
  role: 'assistant', timestamp, metadata: { source: 'active_msg_2', activeMsg2: { taskId } },
});

describe('shouldExpireFire', () => {
  const base = { policy: 'expire', recurrenceType: 'none', anchorMs: 1000, nowMs: 10_000, occurrenceMs: 10_000 };

  it('一次性：锚点后有用户消息 → 作废', () => {
    expect(shouldExpireFire({ ...base, lastUserMessageAt: 2000 })).toBe(true);
  });
  it('一次性：锚点后没有用户消息 → 放行', () => {
    expect(shouldExpireFire({ ...base, lastUserMessageAt: 1000 })).toBe(false);
    expect(shouldExpireFire({ ...base, lastUserMessageAt: 500 })).toBe(false);
  });
  it('force / 未知策略 / 旧任务无策略 → 永远放行', () => {
    expect(shouldExpireFire({ ...base, policy: 'force', lastUserMessageAt: 2000 })).toBe(false);
    expect(shouldExpireFire({ ...base, policy: undefined, lastUserMessageAt: 2000 })).toBe(false);
  });
  it('缺锚点 → 放行（判不了就不拦）', () => {
    expect(shouldExpireFire({ ...base, anchorMs: null, lastUserMessageAt: 2000 })).toBe(false);
    expect(shouldExpireFire({ ...base, anchorMs: null, lastUserMessageAt: null })).toBe(false);
  });

  // 用户清空聊天记录之后，云端 fire_pack / 本地历史里都找不到「最后一条用户消息」了。
  // 放行的话，prompted 任务会指着一段不存在的对话照发，用户点开是一句没头没尾的话。
  it('排程时有对话、到点却一条用户消息都没有 → 当作对话被清空，作废', () => {
    expect(shouldExpireFire({ ...base, anchorMs: 1000, lastUserMessageAt: null })).toBe(true);
  });
  it('从没聊过就排的任务（锚点 0）不受影响，照发', () => {
    expect(shouldExpireFire({ ...base, anchorMs: 0, lastUserMessageAt: null })).toBe(false);
  });

  // 老版本 SW 落的收件箱行没有顶层 recurrenceType / occurrenceMs，循环任务会被当成
  // 一次性走锚点规则——用户只要在任务创建后聊过天，之后每天的早安都被兜底闸吞掉。
  // 缺数据 = 判不了 = 放行，跟这个函数别处的哲学一致。
  it('任务身份字段整组缺失 → 放行（老 SW 的收件箱行不该把循环任务当一次性吞掉）', () => {
    const stale = {
      policy: 'expire', anchorMs: 1000, nowMs: 10_000,
      recurrenceType: undefined, occurrenceMs: undefined,
    };
    expect(shouldExpireFire({ ...stale, lastUserMessageAt: 2000 })).toBe(false);
    expect(shouldExpireFire({ ...stale, lastUserMessageAt: null })).toBe(false);
  });
  it('循环：到点前窗口内在聊 → 作废；窗口外聊过 → 放行（昨天聊天不作废今天早安）', () => {
    const rec = { policy: 'expire', recurrenceType: 'daily', anchorMs: 0, nowMs: 24 * H, occurrenceMs: 24 * H };
    expect(shouldExpireFire({ ...rec, lastUserMessageAt: 24 * H - ACTIVE_CHAT_WINDOW_MS + 1 })).toBe(true);
    expect(shouldExpireFire({ ...rec, lastUserMessageAt: 24 * H - ACTIVE_CHAT_WINDOW_MS - 1 })).toBe(false);
  });
  it('循环：热聊窗口锚在到点时刻，判定晚十几分钟也不放行（worker 与客户端送达兜底同一口径）', () => {
    // 到点 24h，客户端送达兜底在 15 分钟后才判：窗口仍是 (到点-10min, now]，
    // 拿 nowMs 当锚点的话这条 9 分钟前的用户消息会落到窗外被误放行。
    const late = {
      policy: 'expire', recurrenceType: 'daily', anchorMs: 0,
      occurrenceMs: 24 * H, nowMs: 24 * H + 15 * 60_000,
    };
    expect(shouldExpireFire({ ...late, lastUserMessageAt: 24 * H - 9 * 60_000 })).toBe(true);
    expect(shouldExpireFire({ ...late, lastUserMessageAt: 24 * H - 11 * 60_000 })).toBe(false);
  });
  it('循环 weekly 与 daily 同规则：只看到点前热聊窗口，不看锚点', () => {
    const rec = { policy: 'expire', recurrenceType: 'weekly', anchorMs: 0, nowMs: 7 * 24 * H, occurrenceMs: 7 * 24 * H };
    expect(shouldExpireFire({ ...rec, lastUserMessageAt: 7 * 24 * H - ACTIVE_CHAT_WINDOW_MS + 1 })).toBe(true);
    expect(shouldExpireFire({ ...rec, lastUserMessageAt: 7 * 24 * H - ACTIVE_CHAT_WINDOW_MS - 1 })).toBe(false);
  });
});

describe('消息扫描 helpers', () => {
  it('getLastRealUserMessageAt 跳过 proactiveHint 和 assistant', () => {
    expect(getLastRealUserMessageAt([user(1), assistantPush(2), user(3, true)])).toBe(1);
    expect(getLastRealUserMessageAt([assistantPush(2)])).toBe(null);
  });
  it('hasRealUserMessageBetween 是 (after, before] 半开区间', () => {
    const msgs = [user(100), user(200)];
    expect(hasRealUserMessageBetween(msgs, 100, 200)).toBe(true);
    expect(hasRealUserMessageBetween(msgs, 200, 300)).toBe(false);
  });
  it('hasDeliveredProactiveNear 只认 taskId 非空的 active_msg_2 消息', () => {
    const withCid = (taskId: string | null) => ({
      role: 'assistant', timestamp: 1000,
      metadata: { source: 'active_msg_2', activeMsg2: { taskId }, amsgClientTaskId: 'cid-A' },
    });
    expect(hasDeliveredProactiveNear([withCid('t1')], 1000, 'cid-A')).toBe(true);
    expect(hasDeliveredProactiveNear([withCid(null)], 1000, 'cid-A')).toBe(false); // instant 回复不算
  });
  it('hasDeliveredProactiveNear 按精确 id 归属：id 不同或缺 id 都不算本任务的送达', () => {
    const withCid = { role: 'assistant', timestamp: 1000, metadata: { source: 'active_msg_2', activeMsg2: { taskId: 't1' }, amsgClientTaskId: 'cid-A' } };
    expect(hasDeliveredProactiveNear([withCid], 1000, 'cid-A')).toBe(true);
    expect(hasDeliveredProactiveNear([withCid], 1000, 'cid-B')).toBe(false); // A 的送达不能抹掉 B 的回执
    expect(hasDeliveredProactiveNear([assistantPush(1000)], 1000, 'cid-A')).toBe(false); // 缺 amsgClientTaskId 的消息不是本任务的送达
  });
});

describe('detectExpiredOccurrences（排程现状块的作废检出）', () => {
  const NOW = 100 * H;

  it('一次性：锚点之后有用户消息 → 检出（窗口放宽到 now，Cron 迟到 fire 也不漏）', () => {
    const fireAt = NOW - 2 * H;
    const base = {
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'none',
      firstSendTime: new Date(fireAt).toISOString(), anchorMs: fireAt - 5 * H, nowMs: NOW,
    };
    expect(detectExpiredOccurrences({ ...base, messages: [user(fireAt - H)] }))
      .toEqual([{ id: 'u1', occurrenceMs: fireAt }]);
    // 到点之后才聊的也检出——worker 的 skip 规则与 Cron 何时消费无关；
    // 「其实已正常送达」的排除由调用方用 hasDeliveredProactiveNear 按任务归属做。
    expect(detectExpiredOccurrences({ ...base, messages: [user(fireAt + FIRE_GRACE_MS + 1000)] }))
      .toEqual([{ id: 'u1', occurrenceMs: fireAt }]);
  });
  it('循环：只检出「到点前窗口内在聊」的那几次，id 带 occurrence 时间戳', () => {
    const first = NOW - 30 * H;
    const o2 = first + 24 * H;
    const out = detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'daily',
      firstSendTime: new Date(first).toISOString(), anchorMs: 0,
      messages: [user(o2 - 60_000)], nowMs: NOW,
    });
    expect(out).toEqual([{ id: `u1:${o2}`, occurrenceMs: o2 }]);
  });
  it('循环 weekly：周期 7 天，快进到回看期后只检出到点前窗口内在聊的那次', () => {
    const first = NOW - 8 * 24 * H;
    const o2 = first + 7 * 24 * H;
    const out = detectExpiredOccurrences({
      taskUuid: 'w1', policy: 'expire', recurrenceType: 'weekly',
      firstSendTime: new Date(first).toISOString(), anchorMs: 0,
      messages: [user(o2 - 60_000)], nowMs: NOW,
    });
    expect(out).toEqual([{ id: `w1:${o2}`, occurrenceMs: o2 }]);
  });
  it('未来的任务 / force 策略 → 空', () => {
    expect(detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'none',
      firstSendTime: new Date(NOW + H).toISOString(), anchorMs: 0,
      messages: [user(NOW - 1)], nowMs: NOW,
    })).toEqual([]);
    expect(detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'force', recurrenceType: 'none',
      firstSendTime: new Date(NOW - H).toISOString(), anchorMs: 0,
      messages: [user(NOW - 1)], nowMs: NOW,
    })).toEqual([]);
  });
});
