/**
 * 时光契约调度器 —— 纯函数模块，负责"什么时候结算 / 催 / 归档"的决策。
 *
 * 设计原则：
 *  - 全部 pure function：输入 (task, now) 输出决策结果（要补结算哪些天 / 是否该催 / 是否该归档），
 *    不读 DB、不调 LLM、不调存钱罐。所有副作用交给上层（taskSchedulerRunner / ScheduleApp）执行。
 *  - 时间基准一律用 now: Date 参数注入，便于测试固定时间点。
 *  - 跨日判定按用户**本地时区**的 YYYY-MM-DD 走（new Date().getFullYear/Month/Date 默认就是本地时区）。
 *  - 单调性：history 里的 entry.date 升序；同一日期只允许一条（重复结算 = 幂等跳过）。
 *
 * 三种核心决策：
 *  - settleDecision(task, now)：该任务自上次结算以来，有哪些天该被判定为 done / missed / skipped。
 *    通常是"昨天之前所有漏结算的天"。
 *  - reminderDecision(task, now)：现在是否到了该提醒用户"今天还没做"的时间点。
 *  - archiveDecision(task, now)：oneshot 任务是否过了 deadline 该归档为失败。
 */

import { TaskV2, TaskHistoryEntry, TaskHistoryStatus } from '../types';

/** 把 Date 折算成用户本地时区的 YYYY-MM-DD 字符串。 */
export function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** 把 YYYY-MM-DD 字符串解析成本地时区的 Date（当天的 00:00:00）。 */
export function fromLocalDateStr(s: string): Date {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** 把一个 Date 加上 n 天，返回新的 Date（不改原对象）。跨夏令时可能会有几小时偏移，但折回 YYYY-MM-DD 后无影响。 */
export function addDays(d: Date, n: number): Date {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}

/** 列出 [start, end) 区间内每天的 YYYY-MM-DD 字符串（含 start，不含 end）。 */
export function eachDayBetween(start: Date, end: Date): string[] {
    const out: string[] = [];
    const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    for (let d = s; d < e; d = addDays(d, 1)) {
        out.push(toLocalDateStr(d));
    }
    return out;
}

/** history 里是否已有某天的 entry（按日期去重，幂等检查）。 */
export function historyHasEntryFor(history: TaskHistoryEntry[], dateStr: string): boolean {
    return history.some(h => h.date === dateStr);
}

/**
 * 判断 recurring 任务在某天是否"该做"。
 *  - daily：每天都该做
 *  - weekly：customDays 指定周几该做（0=周日…6=周六）；customDays 为空时默认每天
 *  - monthly：monthlyDay 指定每月几号该做（大月没 31 号的月份自动跳过）
 *  - custom：仅 customDays 包含的周几该做（旧数据兼容，UI 不再产生 custom）
 *
 * 注：oneshot 不调用本函数（oneshot 不按日历催，只看 deadline）。
 */
export function isScheduledDay(task: TaskV2, date: Date): boolean {
    if (task.type !== 'recurring') return false;
    const dow = date.getDay(); // 0=Sun ... 6=Sat
    switch (task.frequency) {
        case 'daily':
            return true;
        case 'weekly':
            // weekly 看自定义周几；没配 customDays 默认每天（兼容旧数据）
            if (!Array.isArray(task.customDays) || task.customDays.length === 0) return true;
            return task.customDays.includes(dow);
        case 'monthly':
            return typeof task.monthlyDay === 'number' && date.getDate() === task.monthlyDay;
        case 'custom':
            return Array.isArray(task.customDays) && task.customDays.includes(dow);
        default:
            return false;
    }
}

/**
 * 计算 recurring 任务当前的连胜天数。
 * 连胜定义：从今天往回数，连续的 done（中间允许 skipped，因为请假不算断；
 * 但遇到 missed 立即断）。今天如果还没做，不计入连胜也不打断（今天还没结束）。
 */
export function computeCurrentStreak(task: TaskV2, now: Date): number {
    if (task.type !== 'recurring') return 0;
    const historyByDate = new Map(task.history.map(h => [h.date, h.status]));
    let streak = 0;
    let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // 今天如果还没做，从昨天开始数；今天如果做了，从今天开始数。
    const todayStr = toLocalDateStr(cursor);
    if (historyByDate.get(todayStr) !== 'done') {
        cursor = addDays(cursor, -1);
    }
    // 最多回溯 365 天，防脏数据死循环
    for (let i = 0; i < 365; i++) {
        const ds = toLocalDateStr(cursor);
        const status = historyByDate.get(ds);
        if (status === 'done') {
            streak++;
            cursor = addDays(cursor, -1);
            continue;
        }
        if (status === 'skipped') {
            // 请假跳过：不算连胜也不算断
            cursor = addDays(cursor, -1);
            continue;
        }
        // missed 或没有记录：判定该不该做
        if (isScheduledDay(task, cursor)) {
            // 该做但没做 / 没记 → 断
            break;
        }
        // 不该做（custom 周几模式中今天本就不做）→ 跳过继续往前
        cursor = addDays(cursor, -1);
    }
    return streak;
}

/** 计算历史最长连胜（同样按 done 串、skipped 不算断也不算进）。 */
export function computeBestStreak(task: TaskV2): number {
    if (task.type !== 'recurring' || !task.history.length) return 0;
    const sorted = [...task.history].sort((a, b) => a.date.localeCompare(b.date));
    let best = 0;
    let cur = 0;
    let prevDate: Date | null = null;
    for (const h of sorted) {
        if (h.status === 'done') {
            if (prevDate && isConsecutive(prevDate, fromLocalDateStr(h.date))) {
                cur++;
            } else {
                cur = 1;
            }
            best = Math.max(best, cur);
            prevDate = fromLocalDateStr(h.date);
        } else if (h.status === 'skipped') {
            // skipped 不重置 cur 也不计入 cur，但更新 prevDate 以保持连续性
            prevDate = fromLocalDateStr(h.date);
        } else {
            // missed：重置
            cur = 0;
            prevDate = null;
        }
    }
    return best;
}

/** 两个日期是否相邻（b 比 a 晚 1 天，且都是本地日期）。 */
function isConsecutive(a: Date, b: Date): boolean {
    const diff = addDays(a, 1);
    return toLocalDateStr(diff) === toLocalDateStr(b);
}

/**
 * 结算决策：列出该任务自上次结算以来、截至 now 之前所有"该做但没结算"的天，
 * 每天给出该判什么 status（missed 居多，done 不会自动判，skipped 也不自动）。
 *
 * 规则：
 *  - 不包括"今天"（今天还没结束，不判漏）
 *  - recurring：从 lastSettledDate 后一天开始，到昨天为止，每个 scheduledDay 没记录的判 missed
 *  - oneshot：不在这里漏判，由 archiveDecision 处理
 *
 * 返回 daysToSettle: { date: string, status: 'missed' }[] —— 上层执行时再补 reaction / 写存钱罐。
 */
export function settleDecision(task: TaskV2, now: Date): { date: string; status: TaskHistoryStatus }[] {
    if (task.archived) return [];
    if (task.type === 'oneshot') return [];

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const out: { date: string; status: TaskHistoryStatus }[] = [];

    // 起点：lastSettledDate 后一天；没设过就从 createdAt 那天开始（也后一天避免重判创建当天）
    let start: Date;
    if (task.lastSettledDate) {
        start = addDays(fromLocalDateStr(task.lastSettledDate), 1);
    } else {
        const created = new Date(task.createdAt);
        start = new Date(created.getFullYear(), created.getMonth(), created.getDate());
        // 创建当天不判漏（用户当天才建的任务）
        start = addDays(start, 1);
    }
    if (start >= today) return [];

    const historyByDate = new Set(task.history.map(h => h.date));
    for (const ds of eachDayBetween(start, today)) {
        if (historyByDate.has(ds)) continue;
        const d = fromLocalDateStr(ds);
        if (isScheduledDay(task, d)) {
            out.push({ date: ds, status: 'missed' });
        }
    }
    return out;
}

/**
 * 提醒决策：现在是否到了该提醒用户"今天还没做"的时间点。
 *
 * 规则：
 *  - 必须开了 reminderEnabled 且设了 reminderTime
 *  - 任务未归档、未结算今天
 *  - 今天是 scheduledDay（recurring）
 *  - 现在时间 ≥ reminderTime（小时:分钟）
 *  - 今天还没 done（avoid 重复催）
 *
 * 返回 { shouldRemind: boolean, reason: string }。
 */
export function reminderDecision(task: TaskV2, now: Date): { shouldRemind: boolean; reason: string } {
    if (!task.reminderEnabled || !task.reminderTime) {
        return { shouldRemind: false, reason: 'reminder-disabled' };
    }
    if (task.archived) return { shouldRemind: false, reason: 'archived' };

    const todayStr = toLocalDateStr(now);
    const todayDone = task.history.some(h => h.date === todayStr && h.status === 'done');
    if (todayDone) return { shouldRemind: false, reason: 'already-done' };

    if (task.type === 'recurring') {
        if (!isScheduledDay(task, now)) {
            return { shouldRemind: false, reason: 'not-scheduled-day' };
        }
    } else if (task.type === 'oneshot') {
        // 一次性任务：过了 deadline 就该归档而不是催，未过 deadline 也能催
        if (task.deadline) {
            const dl = new Date(task.deadline);
            if (now > dl) return { shouldRemind: false, reason: 'past-deadline' };
        }
    }

    // 解析 reminderTime 'HH:mm'
    const [hh, mm] = task.reminderTime.split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
        return { shouldRemind: false, reason: 'invalid-time' };
    }
    const reminderMinutes = hh * 60 + mm;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes < reminderMinutes) {
        return { shouldRemind: false, reason: 'before-time' };
    }

    // 防重复催：今天已经在 history 里有 missed 记录说明已被结算判过漏，
    // 不再催（结算和催促是两个互斥的出口）
    const todayMissed = task.history.some(h => h.date === todayStr && h.status === 'missed');
    if (todayMissed) return { shouldRemind: false, reason: 'already-missed-today' };

    return { shouldRemind: true, reason: 'due' };
}

/**
 * 归档决策：oneshot 任务过了 deadline 还没完成 → 归档为 expired，
 * 并在 history 补一条 missed（按 deadline 那天）。
 *
 * recurring 任务不归档（除非用户手动归档）。
 */
export function archiveDecision(task: TaskV2, now: Date): { shouldArchive: boolean; reason: 'expired' | null; missedEntry?: { date: string; status: TaskHistoryStatus } } {
    if (task.archived) return { shouldArchive: false, reason: null };
    if (task.type !== 'oneshot' || !task.deadline) {
        return { shouldArchive: false, reason: null };
    }
    const dl = new Date(task.deadline);
    if (now <= dl) return { shouldArchive: false, reason: null };

    // 过了 deadline：是否已经 done 过？
    const hasDone = task.history.some(h => h.status === 'done');
    if (hasDone) {
        // 已完成但还没归档（可能用户点完成时没自动归档）→ 不在这里强行归档，让上层走 completed 流程
        return { shouldArchive: false, reason: null };
    }
    const dlDateStr = toLocalDateStr(dl);
    // 如果 history 里已经有这条 missed，不重复加
    const hasMissedEntry = task.history.some(h => h.date === dlDateStr);
    return {
        shouldArchive: true,
        reason: 'expired',
        missedEntry: hasMissedEntry ? undefined : { date: dlDateStr, status: 'missed' },
    };
}

/**
 * 应用结算结果到任务上，返回更新后的 task（pure，不改原对象）。
 *
 * 输入：
 *  - task：原任务
 *  - entries：要补的 history 条目（来自 settleDecision 或 archiveDecision.missedEntry）
 *  - reactionByDate：可选，每条 entry 对应的监督角色台词（来自 LLM 调用）
 *
 * 输出：新的 TaskV2，history 已合并、lastSettledDate 已更新到 entries 最后一天。
 */
export function applySettlement(
    task: TaskV2,
    entries: { date: string; status: TaskHistoryStatus }[],
    reactionByDate?: Record<string, string>,
): TaskV2 {
    if (!entries.length) return task;
    const existingDates = new Set(task.history.map(h => h.date));
    const newEntries: TaskHistoryEntry[] = entries
        .filter(e => !existingDates.has(e.date))
        .map(e => ({
            date: e.date,
            status: e.status,
            settledAt: Date.now(),
            reaction: reactionByDate?.[e.date],
        }));
    if (!newEntries.length) return task;

    const mergedHistory = [...task.history, ...newEntries].sort((a, b) => a.date.localeCompare(b.date));
    const lastDate = newEntries[newEntries.length - 1].date;
    return {
        ...task,
        history: mergedHistory,
        lastSettledDate: task.lastSettledDate && task.lastSettledDate > lastDate
            ? task.lastSettledDate
            : lastDate,
    };
}

/**
 * 标记某天为 done（用户点完成 / 打卡）。
 * 如果当天已有 entry，覆盖其 status（保证幂等：一天只一条）。
 * 不在这里调 LLM 生成 reaction —— 由上层在调用前后另行处理。
 */
export function markDone(task: TaskV2, date: Date): TaskV2 {
    const dateStr = toLocalDateStr(date);
    const filtered = task.history.filter(h => h.date !== dateStr);
    const newEntry: TaskHistoryEntry = {
        date: dateStr,
        status: 'done',
        settledAt: Date.now(),
    };
    const mergedHistory = [...filtered, newEntry].sort((a, b) => a.date.localeCompare(b.date));
    return {
        ...task,
        history: mergedHistory,
        lastSettledDate: task.lastSettledDate && task.lastSettledDate > dateStr
            ? task.lastSettledDate
            : dateStr,
    };
}

/** 用户主动请假跳过某天。 */
export function markSkipped(task: TaskV2, date: Date): TaskV2 {
    const dateStr = toLocalDateStr(date);
    const filtered = task.history.filter(h => h.date !== dateStr);
    const newEntry: TaskHistoryEntry = {
        date: dateStr,
        status: 'skipped',
        settledAt: Date.now(),
    };
    const mergedHistory = [...filtered, newEntry].sort((a, b) => a.date.localeCompare(b.date));
    return {
        ...task,
        history: mergedHistory,
        lastSettledDate: task.lastSettledDate && task.lastSettledDate > dateStr
            ? task.lastSettledDate
            : dateStr,
    };
}

/** 归档任务（手动 / 自动）。 */
export function archiveTask(task: TaskV2, reason: 'completed' | 'expired' | 'manual'): TaskV2 {
    return { ...task, archived: true, archiveReason: reason };
}

/**
 * 计算任务在某天的结算金额（正为奖、负为扣）。
 *  - done：+rewardCoins
 *  - missed：-penaltyCoins
 *  - skipped：0
 *  - 连续漏做惩罚翻倍：连续 N 天 missed 时第 N 天扣 penaltyCoins * N（上限 3 倍）
 */
export function computeSettlementAmount(
    task: TaskV2,
    entry: { date: string; status: TaskHistoryStatus },
): number {
    if (entry.status === 'done') return task.rewardCoins;
    if (entry.status === 'skipped') return 0;
    // missed：算连续漏做几天
    const entryDate = fromLocalDateStr(entry.date);
    let consecutiveMissed = 0;
    let cursor = entryDate;
    const historyByDate = new Map(task.history.map(h => [h.date, h.status]));
    // 把当前这条 entry 也算进去（临时加进 map 模拟结算后状态）
    if (entry.status === 'missed') {
        historyByDate.set(entry.date, 'missed');
    }
    for (let i = 0; i < 30; i++) {
        const ds = toLocalDateStr(cursor);
        const s = historyByDate.get(ds);
        if (s === 'missed') {
            consecutiveMissed++;
            cursor = addDays(cursor, -1);
            continue;
        }
        if (s === 'skipped') {
            // skipped 不算漏也不算断
            cursor = addDays(cursor, -1);
            continue;
        }
        if (s === 'done') break;
        // 没记录：看该不该做
        if (isScheduledDay(task, cursor)) break;
        cursor = addDays(cursor, -1);
    }
    const multiplier = Math.min(consecutiveMissed, 3);
    return -task.penaltyCoins * multiplier;
}

/** 本周（周一到周日）已完成次数，用于 weekly 任务进度展示。 */
export function computeThisWeekDoneCount(task: TaskV2, now: Date): number {
    if (task.type !== 'recurring') return 0;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = today.getDay() === 0 ? 6 : today.getDay() - 1; // 周一=0 ... 周日=6
    const monday = addDays(today, -dow);
    const sunday = addDays(monday, 7);
    return task.history.filter(h => {
        if (h.status !== 'done') return false;
        const d = fromLocalDateStr(h.date);
        return d >= monday && d < sunday;
    }).length;
}
