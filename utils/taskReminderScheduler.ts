/**
 * 任务提醒本地通知调度器 —— Capacitor local-notifications 版。
 *
 * 取代 InstantPush 用于 APK 版本的"到点催打卡"。InstantPush 是 Web Push（VAPID），
 * APK 里不通；APK 走 Capacitor 的本地通知，到点系统状态栏响。
 *
 * 设计：
 *  - 每次进入 ScheduleApp / 创建新任务 / Launcher 启动钩子跑完后调 syncTaskReminders()
 *  - 先 cancel 掉所有 source='task-reminder' 的 pending 通知，再按当前未归档任务重新排
 *  - 只排"今天还没过提醒时间"的通知（最简版，不排未来 7 天 —— 反正每次进 app 都会重排）
 *  - 通知 id 用确定性算法（taskId 哈希），方便 cancel；不依赖 getPending() 也能 cancel
 *
 * 通知文案：标题=监督角色名，body=`该做「${task.title}」了`
 *  - 不调 LLM 生成台词（本地通知要在没网的锁屏上响，LLM 调用不可靠）
 *  - 用户点通知 → opensApp URL → 打开 chat with charId（Capacitor 6 支持 extra）
 */

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { DB } from './db';
import { TaskV2 } from '../types';
import { isScheduledDay, toLocalDateStr } from './taskScheduler';

const NOTIF_SOURCE = 'task-reminder';

/**
 * 把 taskId 折成一个 31-bit 正整数当 notification id。
 * 同一个 taskId 每次都得到同一个 id，cancel 时不用先 getPending()。
 */
function deterministicNotifId(taskId: string): number {
    let h = 0;
    for (let i = 0; i < taskId.length; i++) {
        h = ((h << 5) - h + taskId.charCodeAt(i)) | 0;
    }
    // 取绝对值并 mask 到 0x3FFFFFFF（避免 32-bit 负数 / 边界）
    return Math.abs(h) & 0x3FFFFFFF;
}

/**
 * 把 "HH:mm" + 今天日期 组合成今天的 Date（已过则返回 null）。
 */
function todayAtTime(hhmm: string, now: Date): Date | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    return d.getTime() > now.getTime() ? d : null;
}

/** 该任务今天是否需要提醒（recurring 按周期，oneshot 按截止日）。 */
function shouldRemindToday(task: TaskV2, now: Date): boolean {
    if (!task.reminderEnabled || !task.reminderTime) return false;
    if (task.archived) return false;
    if (task.type === 'recurring') return isScheduledDay(task, now);
    if (task.type === 'oneshot' && task.deadline) {
        // 一次性任务截止当天才提醒（截止前最后冲刺）
        const dl = new Date(task.deadline);
        return toLocalDateStr(dl) === toLocalDateStr(now);
    }
    return false;
}

/** 今天已经打卡 / 请假的任务不需要再提醒。 */
function alreadySettledToday(task: TaskV2, now: Date): boolean {
    const todayStr = toLocalDateStr(now);
    const today = task.history.find(h => h.date === todayStr);
    return today?.status === 'done' || today?.status === 'skipped';
}

/**
 * 重新同步所有任务的提醒通知。
 *
 * 流程：
 *  1. cancel 掉之前用我们的 id 排过的通知（用确定性 id，无需 getPending()）
 *  2. 加载所有未归档任务
 *  3. 对每个"今天该做、未打卡、有提醒时间、提醒时间未过"的任务排一条通知
 *  4. 通知标题=监督角色名（找不到角色则用任务 title 兜底），body=`该做「${title}」了`
 *
 * Web 平台 / 未授权时静默跳过 —— 调用方不用关心环境。
 */
export async function syncTaskReminders(now: Date = new Date()): Promise<{ scheduled: number; cancelled: number }> {
    if (!Capacitor.isNativePlatform()) {
        return { scheduled: 0, cancelled: 0 };
    }
    let permStatus;
    try {
        permStatus = await LocalNotifications.checkPermissions();
    } catch {
        return { scheduled: 0, cancelled: 0 };
    }
    if (permStatus.display !== 'granted') {
        // 没授权就不排，但也不报错（用户可能还没在系统设置里允许）
        return { scheduled: 0, cancelled: 0 };
    }

    // 1. 加载所有未归档任务 + 角色档案
    const [allTasks, chars] = await Promise.all([
        DB.getAllTaskV2(),
        DB.getAllCharacters(),
    ]);
    const charNameById = new Map(chars.map(c => [c.id, c.name]));

    // 2. cancel 之前所有任务的提醒（用确定性 id 列表）
    const allIds = allTasks.map(t => deterministicNotifId(t.id));
    let cancelled = 0;
    if (allIds.length > 0) {
        try {
            await LocalNotifications.cancel({ notifications: allIds.map(id => ({ id })) });
            cancelled = allIds.length;
        } catch (e) {
            console.warn('[TaskReminder] cancel failed:', e);
        }
    }

    // 3. 排今天的提醒
    const candidates = allTasks.filter(t =>
        !t.archived &&
        shouldRemindToday(t, now) &&
        !alreadySettledToday(t, now),
    );

    const notifs = [] as { id: number; title: string; body: string; schedule: { at: Date }; smallIcon: string; extra: Record<string, unknown> }[];
    for (const task of candidates) {
        const at = todayAtTime(task.reminderTime!, now);
        if (!at) continue; // 时间已过
        const supervisorName = charNameById.get(task.supervisorId) || task.title;
        notifs.push({
            id: deterministicNotifId(task.id),
            title: supervisorName,
            body: `该做「${task.title}」了`,
            schedule: { at },
            smallIcon: 'ic_stat_icon_config_sample',
            extra: {
                source: NOTIF_SOURCE,
                taskId: task.id,
                charId: task.supervisorId,
            },
        });
    }

    if (notifs.length > 0) {
        try {
            await LocalNotifications.schedule({ notifications: notifs });
        } catch (e) {
            console.warn('[TaskReminder] schedule failed:', e);
            return { scheduled: 0, cancelled };
        }
    }

    return { scheduled: notifs.length, cancelled };
}

/**
 * 用户点击本地通知后的分发钩子。
 *
 * 在 OSContext / PhoneShell 启动时注册 listener；notification 收到 extra.charId 时
 * 把会话切到该角色。用户已经在 app 里时不响（Capacitor 6 listener 会自动判断）。
 *
 * 这里只暴露 handler，listener 注册由调用方做（PhoneShell 已经在监听 proactive 来源
 * 的通知，复用同一套基础设施更稳）。
 */
export function isTaskReminderNotification(extra: Record<string, unknown> | undefined): boolean {
    return !!extra && extra.source === NOTIF_SOURCE;
}

export function getCharIdFromReminder(extra: Record<string, unknown> | undefined): string | undefined {
    if (!isTaskReminderNotification(extra)) return undefined;
    const v = extra?.charId;
    return typeof v === 'string' ? v : undefined;
}
