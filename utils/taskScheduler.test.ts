import { describe, it, expect } from 'vitest';
import {
    toLocalDateStr,
    fromLocalDateStr,
    addDays,
    eachDayBetween,
    isScheduledDay,
    computeCurrentStreak,
    computeBestStreak,
    settleDecision,
    reminderDecision,
    archiveDecision,
    applySettlement,
    markDone,
    markSkipped,
    archiveTask,
    computeSettlementAmount,
    computeThisWeekDoneCount,
} from './taskScheduler';
import { TaskV2 } from '../types';

// 固定"今天"为 2026-07-20（周一），方便测试。所有 now 都基于这个日期构造。
// 时区按测试运行机的本地时区（vitest 默认）—— 但我们用 new Date(y, m-1, d) 显式本地构造，
// 跟生产代码 toLocalDateStr 一致，所以不依赖时区。
const T = (y: number, m: number, d: number, hh = 0, mm = 0): Date => new Date(y, m - 1, d, hh, mm, 0, 0);
const TODAY = T(2026, 7, 20);     // 周一
const YESTERDAY = T(2026, 7, 19); // 周日

// 工厂：daily 任务，已存在 N 天，给定 history / lastSettledDate
const makeDailyTask = (overrides: Partial<TaskV2> = {}): TaskV2 => ({
    id: 't1',
    title: '背单词',
    supervisorId: 'char-1',
    type: 'recurring',
    frequency: 'daily',
    history: [],
    rewardCoins: 10,
    penaltyCoins: 3,
    reminderEnabled: false,
    archived: false,
    createdAt: T(2026, 7, 1).getTime(),
    ...overrides,
});

// 工厂：custom 任务（周一三五做）
const makeCustomTask = (overrides: Partial<TaskV2> = {}): TaskV2 => ({
    id: 't2',
    title: '健身',
    supervisorId: 'char-2',
    type: 'recurring',
    frequency: 'custom',
    customDays: [1, 3, 5], // 周一三五
    history: [],
    rewardCoins: 20,
    penaltyCoins: 10,
    reminderEnabled: false,
    archived: false,
    createdAt: T(2026, 7, 1).getTime(),
    ...overrides,
});

// 工厂：oneshot 任务
const makeOneshotTask = (overrides: Partial<TaskV2> = {}): TaskV2 => ({
    id: 't3',
    title: '交报告',
    supervisorId: 'char-3',
    type: 'oneshot',
    deadline: '2026-07-22T23:59',
    history: [],
    rewardCoins: 50,
    penaltyCoins: 50,
    reminderEnabled: false,
    archived: false,
    createdAt: T(2026, 7, 1).getTime(),
    ...overrides,
});

describe('toLocalDateStr / fromLocalDateStr', () => {
    it('往返一致', () => {
        const d = T(2026, 7, 20, 15, 30);
        expect(fromLocalDateStr(toLocalDateStr(d))).toEqual(T(2026, 7, 20, 0, 0));
    });
    it('两位填充', () => {
        expect(toLocalDateStr(T(2026, 1, 5))).toBe('2026-01-05');
    });
});

describe('addDays / eachDayBetween', () => {
    it('addDays 跨月', () => {
        expect(toLocalDateStr(addDays(T(2026, 1, 31), 1))).toBe('2026-02-01');
    });
    it('eachDayBetween 含 start 不含 end', () => {
        const days = eachDayBetween(T(2026, 7, 18), T(2026, 7, 21));
        expect(days).toEqual(['2026-07-18', '2026-07-19', '2026-07-20']);
    });
});

describe('isScheduledDay', () => {
    it('daily 每天都该做', () => {
        const task = makeDailyTask();
        for (let dow = 0; dow < 7; dow++) {
            const d = new Date(2026, 6, 5 + dow); // 2026-07-05 是周日
            expect(isScheduledDay(task, d)).toBe(true);
        }
    });
    it('custom 仅 customDays 该做', () => {
        const task = makeCustomTask();
        // 2026-07-20 周一（getDay=1）该做
        expect(isScheduledDay(task, T(2026, 7, 20))).toBe(true);
        // 2026-07-21 周二（getDay=2）不该做
        expect(isScheduledDay(task, T(2026, 7, 21))).toBe(false);
        // 2026-07-22 周三（getDay=3）该做
        expect(isScheduledDay(task, T(2026, 7, 22))).toBe(true);
    });
    it('oneshot 不该被调度', () => {
        const task = makeOneshotTask();
        expect(isScheduledDay(task, T(2026, 7, 20))).toBe(false);
    });
});

describe('computeCurrentStreak', () => {
    it('今天没做从昨天开始数', () => {
        const task = makeDailyTask({
            history: [
                { date: '2026-07-19', status: 'done', settledAt: 0 },
                { date: '2026-07-18', status: 'done', settledAt: 0 },
            ],
        });
        expect(computeCurrentStreak(task, TODAY)).toBe(2);
    });
    it('今天做了从今天开始数', () => {
        const task = makeDailyTask({
            history: [
                { date: '2026-07-20', status: 'done', settledAt: 0 },
                { date: '2026-07-19', status: 'done', settledAt: 0 },
                { date: '2026-07-18', status: 'done', settledAt: 0 },
            ],
        });
        expect(computeCurrentStreak(task, TODAY)).toBe(3);
    });
    it('skipped 不算也不断', () => {
        const task = makeDailyTask({
            history: [
                { date: '2026-07-19', status: 'skipped', settledAt: 0 },
                { date: '2026-07-18', status: 'done', settledAt: 0 },
                { date: '2026-07-17', status: 'done', settledAt: 0 },
            ],
        });
        expect(computeCurrentStreak(task, TODAY)).toBe(2);
    });
    it('missed 立即断', () => {
        const task = makeDailyTask({
            history: [
                { date: '2026-07-19', status: 'missed', settledAt: 0 },
                { date: '2026-07-18', status: 'done', settledAt: 0 },
                { date: '2026-07-17', status: 'done', settledAt: 0 },
            ],
        });
        expect(computeCurrentStreak(task, TODAY)).toBe(0);
    });
    it('custom 不该做的日子跨过去', () => {
        // 周一三五任务；2026-07-19 周日、2026-07-18 周六不该做
        const task = makeCustomTask({
            history: [
                { date: '2026-07-17', status: 'done', settledAt: 0 }, // 周五
            ],
        });
        // 2026-07-20 周一今天还没做，从周日开始数
        // 周日（不该做）→ 周六（不该做）→ 周五 done → streak = 1
        expect(computeCurrentStreak(task, TODAY)).toBe(1);
    });
    it('oneshot 返回 0', () => {
        const task = makeOneshotTask({
            history: [{ date: '2026-07-19', status: 'done', settledAt: 0 }],
        });
        expect(computeCurrentStreak(task, TODAY)).toBe(0);
    });
});

describe('computeBestStreak', () => {
    it('单调上升取最大', () => {
        const task = makeDailyTask({
            history: [
                { date: '2026-07-15', status: 'done', settledAt: 0 },
                { date: '2026-07-16', status: 'done', settledAt: 0 },
                { date: '2026-07-17', status: 'missed', settledAt: 0 },
                { date: '2026-07-18', status: 'done', settledAt: 0 },
                { date: '2026-07-19', status: 'done', settledAt: 0 },
                { date: '2026-07-20', status: 'done', settledAt: 0 },
            ],
        });
        expect(computeBestStreak(task)).toBe(3);
    });
    it('skipped 跨过去仍连续', () => {
        const task = makeDailyTask({
            history: [
                { date: '2026-07-15', status: 'done', settledAt: 0 },
                { date: '2026-07-16', status: 'skipped', settledAt: 0 },
                { date: '2026-07-17', status: 'done', settledAt: 0 },
            ],
        });
        expect(computeBestStreak(task)).toBe(2);
    });
});

describe('settleDecision', () => {
    it('daily 漏 3 天全部判 missed', () => {
        // lastSettled = 2026-07-16；今天是 7-20；该判 7-17、7-18、7-19 三天 missed（今天不算）
        const task = makeDailyTask({ lastSettledDate: '2026-07-16' });
        const out = settleDecision(task, TODAY);
        expect(out).toEqual([
            { date: '2026-07-17', status: 'missed' },
            { date: '2026-07-18', status: 'missed' },
            { date: '2026-07-19', status: 'missed' },
        ]);
    });
    it('已有 history 的天不重复判', () => {
        const task = makeDailyTask({
            lastSettledDate: '2026-07-16',
            history: [
                { date: '2026-07-17', status: 'done', settledAt: 0 },
                { date: '2026-07-18', status: 'skipped', settledAt: 0 },
            ],
        });
        const out = settleDecision(task, TODAY);
        expect(out).toEqual([{ date: '2026-07-19', status: 'missed' }]);
    });
    it('start >= today 返回空', () => {
        const task = makeDailyTask({ lastSettledDate: '2026-07-19' });
        expect(settleDecision(task, TODAY)).toEqual([]);
    });
    it('archived 任务不结算', () => {
        const task = makeDailyTask({ lastSettledDate: '2026-07-16', archived: true });
        expect(settleDecision(task, TODAY)).toEqual([]);
    });
    it('oneshot 任务不结算', () => {
        const task = makeOneshotTask();
        expect(settleDecision(task, TODAY)).toEqual([]);
    });
    it('custom 跳过非 scheduledDay', () => {
        // 周一三五任务；lastSettled = 7-15（周三）
        // 7-16 周四（不做）、7-17 周五（做，漏）、7-18 周六（不做）、7-19 周日（不做）
        // 期望只判 7-17 missed
        const task = makeCustomTask({ lastSettledDate: '2026-07-15' });
        const out = settleDecision(task, TODAY);
        expect(out).toEqual([{ date: '2026-07-17', status: 'missed' }]);
    });
});

describe('reminderDecision', () => {
    const baseTask = makeDailyTask({
        reminderEnabled: true,
        reminderTime: '20:00',
    });
    it('未到提醒时间不催', () => {
        const out = reminderDecision(baseTask, T(2026, 7, 20, 10, 0));
        expect(out.shouldRemind).toBe(false);
        expect(out.reason).toBe('before-time');
    });
    it('过了提醒时间且今天未做 → 催', () => {
        const out = reminderDecision(baseTask, T(2026, 7, 20, 20, 30));
        expect(out.shouldRemind).toBe(true);
        expect(out.reason).toBe('due');
    });
    it('今天已做不催', () => {
        const task = makeDailyTask({
            reminderEnabled: true,
            reminderTime: '20:00',
            history: [{ date: '2026-07-20', status: 'done', settledAt: 0 }],
        });
        const out = reminderDecision(task, T(2026, 7, 20, 20, 30));
        expect(out.shouldRemind).toBe(false);
        expect(out.reason).toBe('already-done');
    });
    it('未开提醒不催', () => {
        const task = makeDailyTask({ reminderEnabled: false, reminderTime: '20:00' });
        expect(reminderDecision(task, T(2026, 7, 20, 20, 30)).shouldRemind).toBe(false);
    });
    it('archived 不催', () => {
        const task = makeDailyTask({ reminderEnabled: true, reminderTime: '20:00', archived: true });
        expect(reminderDecision(task, T(2026, 7, 20, 20, 30)).shouldRemind).toBe(false);
    });
    it('custom 非该做日不催', () => {
        const task = makeCustomTask({ reminderEnabled: true, reminderTime: '20:00' });
        // 7-21 周二不该做
        expect(reminderDecision(task, T(2026, 7, 21, 20, 30)).shouldRemind).toBe(false);
    });
    it('oneshot 过 deadline 不催（归 archive 处理）', () => {
        const task = makeOneshotTask({
            reminderEnabled: true,
            reminderTime: '20:00',
            deadline: '2026-07-18T23:59',
        });
        expect(reminderDecision(task, T(2026, 7, 20, 20, 30)).shouldRemind).toBe(false);
        expect(reminderDecision(task, T(2026, 7, 20, 20, 30)).reason).toBe('past-deadline');
    });
    it('oneshot 未过 deadline 该催', () => {
        const task = makeOneshotTask({
            reminderEnabled: true,
            reminderTime: '20:00',
            deadline: '2026-07-22T23:59',
        });
        expect(reminderDecision(task, T(2026, 7, 20, 20, 30)).shouldRemind).toBe(true);
    });
});

describe('archiveDecision', () => {
    it('oneshot 过 deadline 未做 → 归档 + missedEntry', () => {
        const task = makeOneshotTask({ deadline: '2026-07-18T23:59' });
        const out = archiveDecision(task, TODAY);
        expect(out.shouldArchive).toBe(true);
        expect(out.reason).toBe('expired');
        expect(out.missedEntry).toEqual({ date: '2026-07-18', status: 'missed' });
    });
    it('oneshot 已 done 不强行归档', () => {
        const task = makeOneshotTask({
            deadline: '2026-07-18T23:59',
            history: [{ date: '2026-07-17', status: 'done', settledAt: 0 }],
        });
        expect(archiveDecision(task, TODAY).shouldArchive).toBe(false);
    });
    it('未过 deadline 不归档', () => {
        const task = makeOneshotTask({ deadline: '2026-07-22T23:59' });
        expect(archiveDecision(task, TODAY).shouldArchive).toBe(false);
    });
    it('recurring 不自动归档', () => {
        const task = makeDailyTask();
        expect(archiveDecision(task, TODAY).shouldArchive).toBe(false);
    });
    it('已有该日期 missed 不重复加 entry', () => {
        const task = makeOneshotTask({
            deadline: '2026-07-18T23:59',
            history: [{ date: '2026-07-18', status: 'missed', settledAt: 0 }],
        });
        const out = archiveDecision(task, TODAY);
        expect(out.shouldArchive).toBe(true);
        expect(out.missedEntry).toBeUndefined();
    });
});

describe('applySettlement / markDone / markSkipped / archiveTask', () => {
    it('applySettlement 合并 + 幂等', () => {
        const task = makeDailyTask({ lastSettledDate: '2026-07-16' });
        const entries = settleDecision(task, TODAY);
        const updated = applySettlement(task, entries, { '2026-07-17': '诶今天没做？' });
        expect(updated.history).toHaveLength(3);
        expect(updated.lastSettledDate).toBe('2026-07-19');
        expect(updated.history.find(h => h.date === '2026-07-17')?.reaction).toBe('诶今天没做？');
        // 再来一次幂等
        const updated2 = applySettlement(updated, entries);
        expect(updated2.history).toHaveLength(3);
    });
    it('markDone 覆盖当天', () => {
        const task = makeDailyTask({
            history: [{ date: '2026-07-20', status: 'missed', settledAt: 0 }],
        });
        const updated = markDone(task, TODAY);
        expect(updated.history.find(h => h.date === '2026-07-20')?.status).toBe('done');
        expect(updated.history).toHaveLength(1);
    });
    it('markSkipped 当天', () => {
        const task = makeDailyTask();
        const updated = markSkipped(task, TODAY);
        expect(updated.history.find(h => h.date === '2026-07-20')?.status).toBe('skipped');
    });
    it('archiveTask 标记归档原因', () => {
        const task = makeDailyTask();
        const updated = archiveTask(task, 'manual');
        expect(updated.archived).toBe(true);
        expect(updated.archiveReason).toBe('manual');
    });
});

describe('computeSettlementAmount', () => {
    it('done → +rewardCoins', () => {
        const task = makeDailyTask({ rewardCoins: 10 });
        expect(computeSettlementAmount(task, { date: '2026-07-19', status: 'done' })).toBe(10);
    });
    it('skipped → 0', () => {
        const task = makeDailyTask();
        expect(computeSettlementAmount(task, { date: '2026-07-19', status: 'skipped' })).toBe(0);
    });
    it('单天 missed → -penaltyCoins', () => {
        const task = makeDailyTask({ penaltyCoins: 3 });
        expect(computeSettlementAmount(task, { date: '2026-07-19', status: 'missed' })).toBe(-3);
    });
    it('连续 3 天 missed → -3 * 3 = -9', () => {
        const task = makeDailyTask({
            penaltyCoins: 3,
            history: [
                { date: '2026-07-17', status: 'missed', settledAt: 0 },
                { date: '2026-07-18', status: 'missed', settledAt: 0 },
            ],
        });
        // 加 7-19 missed，连续 3 天，倍数 3
        expect(computeSettlementAmount(task, { date: '2026-07-19', status: 'missed' })).toBe(-9);
    });
    it('连续 5 天 missed 倍数封顶 3', () => {
        const task = makeDailyTask({
            penaltyCoins: 3,
            history: [
                { date: '2026-07-15', status: 'missed', settledAt: 0 },
                { date: '2026-07-16', status: 'missed', settledAt: 0 },
                { date: '2026-07-17', status: 'missed', settledAt: 0 },
                { date: '2026-07-18', status: 'missed', settledAt: 0 },
            ],
        });
        // 加 7-19 missed，连续 5 天，倍数仍 3
        expect(computeSettlementAmount(task, { date: '2026-07-19', status: 'missed' })).toBe(-9);
    });
    it('中间 skipped 不算连续', () => {
        const task = makeDailyTask({
            penaltyCoins: 3,
            history: [
                { date: '2026-07-17', status: 'missed', settledAt: 0 },
                { date: '2026-07-18', status: 'skipped', settledAt: 0 },
            ],
        });
        // 加 7-19 missed；7-18 skipped 不算连续；连续 missed 只 2 天（17 + 19）
        expect(computeSettlementAmount(task, { date: '2026-07-19', status: 'missed' })).toBe(-6);
    });
});

describe('computeThisWeekDoneCount', () => {
    it('本周周一到周日的 done 数', () => {
        // 2026-07-20 周一，本周 = 7-20 ~ 7-26
        const task = makeDailyTask({
            history: [
                { date: '2026-07-18', status: 'done', settledAt: 0 }, // 上周六
                { date: '2026-07-19', status: 'done', settledAt: 0 }, // 上周日
                { date: '2026-07-20', status: 'done', settledAt: 0 }, // 本周一
                { date: '2026-07-21', status: 'done', settledAt: 0 }, // 本周二
                { date: '2026-07-22', status: 'missed', settledAt: 0 }, // 本周三（不算）
            ],
        });
        expect(computeThisWeekDoneCount(task, TODAY)).toBe(2);
    });
    it('recurring 才算', () => {
        const task = makeOneshotTask({
            history: [{ date: '2026-07-20', status: 'done', settledAt: 0 }],
        });
        expect(computeThisWeekDoneCount(task, TODAY)).toBe(0);
    });
});
