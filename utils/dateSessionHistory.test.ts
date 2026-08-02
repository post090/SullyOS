// utils/dateSessionHistory.test.ts
// 见面（DateApp）会话历史的两处窗口逻辑。
import { describe, it, expect } from 'vitest';

import { trimHistoryThrough, planNovelLoadMore } from './dateSessionHistory';

const msg = (id: number, source: string) => ({ id, metadata: { source } } as any);

// ── 重掷时的历史裁剪 ──
// 见面里重掷最后一条 AI 回复时，传给提示词的历史是「全来源」的最近窗口，而被重掷的那轮
// user 消息是从 date 子集里挑的。要是这中间用户还在普通聊天里发过消息，全来源历史的尾巴
// 就不是那条 date user 了：buildDateHistory 固定砍掉最后一条（本该砍掉待重发的 user），
// 结果砍掉了那条聊天消息，而 date user 又被 buildSessionPayload 追加了一次——聊天消息丢了，
// date 回合重复了。裁到目标那条为止，两个毛病一起没。
describe('trimHistoryThrough', () => {
  it('目标之后还有别处来源的新消息 → 裁掉（回归：丢聊天消息 + 重复 date 回合）', () => {
    const msgs = [msg(1, 'date'), msg(2, 'date'), msg(3, 'chat'), msg(4, 'chat')];
    expect(trimHistoryThrough(msgs, 2).map((m) => m.id)).toEqual([1, 2]);
  });

  it('目标就是最后一条 → 原样返回', () => {
    const msgs = [msg(1, 'date'), msg(2, 'date')];
    expect(trimHistoryThrough(msgs, 2).map((m) => m.id)).toEqual([1, 2]);
  });

  it('目标不在列表里 → 原样返回，不把历史裁没', () => {
    const msgs = [msg(1, 'date'), msg(2, 'date')];
    expect(trimHistoryThrough(msgs, 99).map((m) => m.id)).toEqual([1, 2]);
  });

  it('空历史不炸', () => {
    expect(trimHistoryThrough([], 1)).toEqual([]);
  });
});

// ── 阅读模式「加载更早」──
// 会话初始化只从库里取最近 220 条见面消息，阅读模式的按钮原本只是在这批已加载的数组上
// 放大显示窗口，从不回库里取更早的行。于是这 220 条全放出来后按钮就消失，更早的见面记录
// 在阅读模式里永远够不着。要区分「只需开窗」和「得回库里再取」两种情况。
describe('planNovelLoadMore', () => {
  const base = { loadedCount: 220, visibleCount: 80, windowStep: 80, loadLimit: 220, loadStep: 220, reachedDbEnd: false };

  it('本地还有没显示的 → 只开窗，不查库', () => {
    const plan = planNovelLoadMore(base);
    expect(plan.nextVisibleCount).toBe(160);
    expect(plan.nextLoadLimit).toBeNull();
  });

  it('开窗不会超过已加载条数', () => {
    const plan = planNovelLoadMore({ ...base, visibleCount: 200 });
    expect(plan.nextVisibleCount).toBe(220);
    expect(plan.nextLoadLimit).toBeNull();
  });

  it('已加载的全显示完、库里还有 → 回库里取下一批（回归：按钮消失、旧记录够不着）', () => {
    const plan = planNovelLoadMore({ ...base, visibleCount: 220 });
    expect(plan.nextLoadLimit).toBe(440);
    expect(plan.nextVisibleCount).toBeGreaterThan(220);
  });

  it('已到库底且窗口铺满 → 既不查库也不再开窗', () => {
    const plan = planNovelLoadMore({ ...base, visibleCount: 220, reachedDbEnd: true });
    expect(plan.nextLoadLimit).toBeNull();
    expect(plan.nextVisibleCount).toBe(220);
  });

  it('到库底但本地窗口还没铺满 → 仍可继续开窗', () => {
    const plan = planNovelLoadMore({ ...base, visibleCount: 100, reachedDbEnd: true });
    expect(plan.nextLoadLimit).toBeNull();
    expect(plan.nextVisibleCount).toBe(180);
  });
});
