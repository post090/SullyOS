/**
 * 任务状态注入器 —— 把某角色正在监督的任务拼成文本段，喂给 LLM。
 *
 * 被这些场景共用：
 *  - 私聊 Chat 的 volatileState（verbose=true，含操作命令说明）
 *  - 主动消息 / Instant Push（verbose=true，配合到点催促）
 *  - 查手机 CheckPhone（verbose=false，只读一句话版）
 *  - 通话 CallApp / 日记 JournalApp（verbose=false，只读一句话版）
 *
 * 关键约束（用户要求）：
 *  - 该角色当前没有监督任何未归档任务时，**整段返回空串**——
 *    连"你可以监督 ta"这种能力描述都不注入，避免角色无任务时主动揽活。
 *  - 操作命令说明只在 verbose=true 时给，且仅当该角色有未归档任务时才给。
 *
 * 输出格式见下方 buildTaskSupervisionContext 的 docstring。
 */

import { TaskV2 } from '../types';
import { DB } from './db';
import {
    computeCurrentStreak,
    computeBestStreak,
    computeThisWeekDoneCount,
    isScheduledDay,
    toLocalDateStr,
    reminderDecision,
} from './taskScheduler';

export interface TaskInjectionOptions {
    /** verbose=true：完整版，含操作命令说明（给私聊/主动消息用）。
     *  verbose=false：精简一句话版（给通话/日记/查手机用）。 */
    verbose?: boolean;
    /** 是否同时输出 LLM 可用的操作命令说明（默认跟 verbose 一致）。
     *  主动消息路径需要状态但不需要每轮都教 LLM 命令语法，可显式 false。 */
    includeCommandGuide?: boolean;
    /** 当前时间，便于测试注入。 */
    now?: Date;
}

/**
 * 拉某角色正在监督的所有未归档任务（+ 最近 5 条已归档，让角色有"我以前监督过什么"的记忆）。
 * 没有任何任务时返回空数组。
 */
export async function loadSupervisedTasks(
    charId: string,
    options?: { includeArchived?: boolean; archivedLimit?: number },
): Promise<{ active: TaskV2[]; archived: TaskV2[] }> {
    const all = await DB.getAllTaskV2();
    const mine = all.filter(t => t.supervisorId === charId);
    const active = mine.filter(t => !t.archived);
    const archived = options?.includeArchived
        ? mine.filter(t => t.archived)
              .sort((a, b) => (b.lastSettledDate || '').localeCompare(a.lastSettledDate || ''))
              .slice(0, options.archivedLimit ?? 5)
        : [];
    return { active, archived };
}

/**
 * 构造「你正在监督的任务」状态段。
 *
 * verbose 版（给私聊/主动消息）：
 * ```
 * ### 你正在监督的任务
 * （以下是 ${userName} 托你监督的事，状态每轮实时刷新。打卡/请假/归档命令见下方规则段。）
 *
 * 1. 「每天跑步」 · 每日 · 提醒 20:00 · 奖 +10 / 漏 -3
 *    今日：未打卡 · 连胜 7 天 · 本周完成 5/7
 * 2. 「读完《XXX》」 · 一次性 · 截止 2026-08-01 · 奖 +50 / 漏 -15
 *    今日：未打卡 · 还剩 12 天
 * ```
 *
 * 精简版（给通话/日记/查手机）：
 * ```
 * 你正在监督 ta：每天跑步（今日未打卡，连胜 7 天）；读完《XXX》（还剩 12 天）。
 * ```
 *
 * @returns 空串表示该角色当前没在监督任何未归档任务（调用方据此跳过整个段）
 */
export async function buildTaskSupervisionContext(
    charId: string,
    userName: string,
    options: TaskInjectionOptions = {},
): Promise<string> {
    const verbose = options.verbose ?? true;
    const includeCommandGuide = options.includeCommandGuide ?? verbose;
    const now = options.now ?? new Date();

    const { active } = await loadSupervisedTasks(charId, { includeArchived: false });
    if (active.length === 0) return '';

    if (verbose) {
        return buildVerboseBlock(active, userName, now, includeCommandGuide);
    }
    return buildCompactBlock(active, now);
}

// --- 内部 ---

function buildVerboseBlock(
    tasks: TaskV2[],
    userName: string,
    now: Date,
    includeCommandGuide: boolean,
): string {
    const lines: string[] = [];
    lines.push(`### 你正在监督的任务`);
    lines.push(`（以下是 ${userName} 托你监督的事，状态每轮实时刷新。${includeCommandGuide ? '打卡 / 请假 / 归档命令见下方「任务监督工具」段。' : ''}）`);
    lines.push('');

    tasks.forEach((task, idx) => {
        lines.push(`${idx + 1}. ${formatTaskLine(task, now)}`);
    });

    return lines.join('\n') + '\n';
}

function buildCompactBlock(tasks: TaskV2[], now: Date): string {
    const todayStr = toLocalDateStr(now);
    const parts = tasks.map(task => {
        const title = `「${task.title}」`;
        const todayEntry = task.history.find(h => h.date === todayStr);
        const streak = computeCurrentStreak(task, now);

        let status: string;
        if (todayEntry?.status === 'done') {
            status = '今日已打卡';
        } else if (todayEntry?.status === 'skipped') {
            status = '今日请假';
        } else if (todayEntry?.status === 'missed') {
            status = '今日漏做';
        } else if (task.type === 'recurring' && !isScheduledDay(task, now)) {
            status = '今日无需做';
        } else {
            status = '今日未打卡';
        }

        // 一次性任务附带剩余天数
        if (task.type === 'oneshot' && task.deadline) {
            const dl = new Date(task.deadline);
            const remainDays = Math.ceil((dl.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            if (remainDays > 0) {
                status += `，还剩 ${remainDays} 天`;
            } else if (remainDays === 0) {
                status += '，今天截止';
            }
        }

        // recurring 附带连胜
        if (task.type === 'recurring' && streak > 0) {
            status += `，连胜 ${streak} 天`;
        }

        return `${title}（${status}）`;
    });

    return `你正在监督 ta：${parts.join('；')}。\n`;
}

/** 单条任务的多行详细格式（verbose 版用）。 */
function formatTaskLine(task: TaskV2, now: Date): string {
    const todayStr = toLocalDateStr(now);
    const head = `「${task.title}」`;

    // 元信息行
    let meta: string;
    if (task.type === 'recurring') {
        const freqText = formatFrequency(task);
        meta = `${freqText}`;
        if (task.reminderEnabled && task.reminderTime) {
            meta += ` · 提醒 ${task.reminderTime}`;
        }
    } else {
        meta = `一次性`;
        if (task.deadline) {
            const dl = new Date(task.deadline);
            meta += ` · 截止 ${dl.getFullYear()}-${(dl.getMonth()+1).toString().padStart(2,'0')}-${dl.getDate().toString().padStart(2,'0')} ${dl.getHours().toString().padStart(2,'0')}:${dl.getMinutes().toString().padStart(2,'0')}`;
        }
    }
    meta += ` · 奖 +${task.rewardCoins} / 漏 -${task.penaltyCoins}`;

    // 今日状态行
    const todayEntry = task.history.find(h => h.date === todayStr);
    let todayStatus: string;
    if (todayEntry?.status === 'done') {
        todayStatus = '今日已打卡';
    } else if (todayEntry?.status === 'skipped') {
        todayStatus = '今日请假';
    } else if (todayEntry?.status === 'missed') {
        todayStatus = '今日漏做';
    } else if (task.type === 'recurring' && !isScheduledDay(task, now)) {
        todayStatus = '今日无需做';
    } else {
        // 检查是否到提醒时间还没做
        const reminder = reminderDecision(task, now);
        if (reminder.shouldRemind) {
            todayStatus = `今日未打卡（已过提醒时间 ${task.reminderTime}，可以催了）`;
        } else {
            todayStatus = '今日未打卡';
        }
    }

    // 补充统计
    const extras: string[] = [todayStatus];
    if (task.type === 'recurring') {
        const streak = computeCurrentStreak(task, now);
        if (streak > 0) extras.push(`连胜 ${streak} 天`);
        const best = computeBestStreak(task);
        if (best > streak) extras.push(`最长 ${best} 天`);
        const weekDone = computeThisWeekDoneCount(task, now);
        extras.push(`本周完成 ${weekDone}`);
    } else if (task.type === 'oneshot' && task.deadline) {
        const dl = new Date(task.deadline);
        const remainDays = Math.ceil((dl.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        if (remainDays > 0) extras.push(`还剩 ${remainDays} 天`);
        else if (remainDays === 0) extras.push('今天截止');
        else extras.push(`已超期 ${Math.abs(remainDays)} 天`);
    }

    return `${head} · ${meta}\n   ${extras.join(' · ')}`;
}

function formatFrequency(task: TaskV2): string {
    switch (task.frequency) {
        case 'daily': return '每日';
        case 'weekly': return '每周';
        case 'custom': {
            if (!task.customDays || task.customDays.length === 0) return '每周';
            const names = ['日', '一', '二', '三', '四', '五', '六'];
            const sorted = [...task.customDays].sort((a, b) => a - b);
            return `每周${sorted.map(d => names[d]).join('、')}`;
        }
        default: return '每日';
    }
}

/**
 * 构造操作命令说明段（仅 verbose 模式且该角色有未归档任务时调用方才注入）。
 *
 * 跟现有 [[ACTION:POKE]] / [[RECALL]] 一个套路，4 个新指令：
 *  - [[TASK_PROPOSE: 标题 | 频率 | HH:mm]]  → 角色提议建任务，用户回填表单确认
 *  - [[TASK_DONE: 标题关键词]]              → 打卡今天
 *  - [[TASK_SKIP: 标题关键词]]              → 请假今天
 *  - [[TASK_ARCHIVE: 标题关键词]]           → 手动归档
 */
export function buildTaskCommandGuide(userName: string): string {
    return `### 任务监督工具
你可以监督 ${userName} 完成日常任务。${userName} 跟你说"监督我做 X" / "帮我养成 X 习惯" / "我打算每天 X" 时，你可以提议建立契约；${userName} 确认后才正式生效。

**提议新契约**（仅在 ${userName} 主动表达想被监督时用，不要主动揽活）：
\`\`\`
[[TASK_PROPOSE: 任务标题 | 频率 | HH:mm 提醒时间]]
\`\`\`
- 频率可选：\`daily\`（每日）/ \`weekly\`（每周）/ \`custom:1,3,5\`（每周指定周几，0=周日…6=周六）/ \`oneshot:2026-08-01T20:00\`（一次性 + 截止时间）
- 提醒时间可省（例：\`[[TASK_PROPOSE: 每天跑步 | daily | 20:00]]\` 或 \`[[TASK_PROPOSE: 读完《XXX》 | oneshot:2026-08-01T20:00]]\`）
- 奖励 / 惩罚金额固定 +10 / -3，${userName} 可以事后在「时光契约」App 里改
- 监督人就是你，不用指定
- 输出后系统会渲染一张任务卡片，${userName} 改完字段确认才落库；没确认前任务不存在

**对已有任务的操作**（${userName} 明确表达意图后才用）：
- 打卡今天：\`[[TASK_DONE: 任务标题关键词]]\`（${userName} 说"我做了"/"完成了" → 你确认打卡）
- 请假今天：\`[[TASK_SKIP: 任务标题关键词]]\`（${userName} 说"今天请假"/"今天算了" → 你帮 ta 请假）
- 归档任务：\`[[TASK_ARCHIVE: 任务标题关键词]]\`（${userName} 说"这个不做了"/"算了吧" → 你归档）

**关键原则**：
- 只在 ${userName} 明确表达意图后才操作；不要自作主张打卡 / 请假 / 归档
- 标题关键词模糊匹配，多条匹配时反问 ta "是 X 还是 Y？"，零匹配时告诉 ta "我没监督你这个"
- 打卡 / 请假 / 归档后系统会通知你结果，你自然地接一句话就好（不用每条都复读"已打卡"）
`;
}
