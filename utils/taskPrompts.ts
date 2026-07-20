/**
 * 时光契约监督角色台词 prompt 模板。
 *
 * 设计原则（与 ScheduleApp.tsx 旧版 generateTaskReward 对齐）：
 *  - system 段由 ContextBuilder.buildCoreContext 注入（人设 / 世界观 / 印象 / 记忆宫殿 / 情绪 buff）。
 *  - user 段只描述客观场景 + 输出要求，**不预设人设语气、不预设反应强度**。
 *    由 LLM 根据已注入的人设自由演绎。
 *  - 旧版 prompt 写了"严厉的勉强认可 / 温柔的夸奖 / 傲娇的别扭" 这种硬塞语气，
 *    跟 tone 字段一起废弃 —— 那等于"指挥 LLM 演什么"，跟"让 LLM 按自己人设演"是两回事。
 *  - 输出统一为"一句话（≤30 字）+ 用户常用语言 + 无引号"，方便塞 toast / 聊天 system 消息。
 */

import { TaskV2 } from '../types';

export interface TaskPromptContext {
    userName: string;
    task: TaskV2;
    supervisorName: string;
    /** 当前场景，决定 prompt 模板分支 */
    scene:
        | 'complete'        // 用户主动打卡完成（recurring 当天 done / oneshot 整单 done）
        | 'milestone'       // recurring 连胜达到里程碑（3 / 7 / 14 / 30 / 60 / 100 天）
        | 'missed'          // 漏做扣币（单日 missed）
        | 'missed_streak'   // 连续漏做（N 天 missed，N≥2）
        | 'reminder'        // 到点提醒（push 通知）
        | 'oneshot_expired' // 一次性任务超期归档
        | 'oneshot_complete'; // 一次性任务完成归档
    /** 当前连胜（done 场景给 LLM 看，让它的反应有上下文） */
    streak?: number;
    /** 连续漏做天数（missed_streak 给 LLM 看让反应升级） */
    consecutiveMissed?: number;
}

/** 里程碑列表：达到这些天数时升级反应（用更大场面）。 */
export const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 200, 365];

/** 判断一个连胜数是不是里程碑。 */
export function isStreakMilestone(streak: number): boolean {
    return STREAK_MILESTONES.includes(streak);
}

/**
 * 根据 scene 选 prompt 模板。返回 user 段内容。
 * 不导出每个模板的字符串本身（避免上层改坏）—— 上层只调 buildTaskPrompt(ctx)。
 */
export function buildTaskPrompt(ctx: TaskPromptContext): string {
    const { scene, userName, task, supervisorName } = ctx;
    const streak = ctx.streak ?? 0;
    const consecutive = ctx.consecutiveMissed ?? 0;

    const baseHeader = `### 场景：${sceneTitle(scene)}
用户 (${userName}) 与你 (${supervisorName}) 之间有一份监督契约：
"${task.title}"`;

    const baseOutput = `
### 任务
基于你的人设和你们的关系，对当前场景做出反应。

**输出要求**:
- 仅输出一句话（不超过 30 字）。
- 必须使用用户常用语言。
- 不要有引号、不要有括号说明、不要有舞台指示。
- 不要重复任务标题。`;

    switch (scene) {
        case 'complete':
            return `${baseHeader}
用户刚刚完成了今天的打卡。

### 当前状态
- 今天完成情况：已打卡
- 当前连胜：${streak} 天

${baseOutput}`;

        case 'milestone':
            return `${baseHeader}
用户刚刚完成了今天的打卡，并且达成了 ${streak} 天连胜的里程碑。

### 当前状态
- 今天完成情况：已打卡（第 ${streak} 天）
- 当前连胜：${streak} 天（里程碑达成）

${baseOutput}`;

        case 'missed':
            return `${baseHeader}
今天是该做这件事的日子，但用户没完成，已被判定为漏做。
漏做一天会扣 ${task.penaltyCoins} 流通币。

### 当前状态
- 今天完成情况：漏做
- 之前连胜：${streak} 天（因今天漏做已断）

${baseOutput}`;

        case 'missed_streak':
            return `${baseHeader}
用户已经连续 ${consecutive} 天没做这件事了，今天又一次漏做。
连续漏做惩罚会翻倍，今天扣 ${task.penaltyCoins * Math.min(consecutive, 3)} 流通币。

### 当前状态
- 连续漏做：${consecutive} 天
- 之前连胜：${streak} 天（已断）

${baseOutput}`;

        case 'reminder':
            return `${baseHeader}
现在到了用户该做这件事的时间，但用户还没打卡。这是一条到点提醒。

### 当前状态
- 今天完成情况：未打卡
- 当前连胜：${streak} 天

${baseOutput}`;

        case 'oneshot_expired':
            return `${baseHeader}
这是一份一次性契约，截止时间是 ${task.deadline || '已过'}。
截止时间已过，用户没完成，契约自动归档为失败。
失败扣 ${task.penaltyCoins} 流通币。

### 当前状态
- 截止时间：${task.deadline || '已过'}
- 完成情况：未完成
- 状态：契约失效归档

${baseOutput}`;

        case 'oneshot_complete':
            return `${baseHeader}
这是一份一次性契约，截止时间是 ${task.deadline || '—'}。
用户刚刚完成了这份契约。

### 当前状态
- 完成情况：已完成
- 奖励：${task.rewardCoins} 流通币

${baseOutput}`;

        default:
            return `${baseHeader}
${baseOutput}`;
    }
}

function sceneTitle(scene: TaskPromptContext['scene']): string {
    switch (scene) {
        case 'complete': return '契约打卡 - 完成';
        case 'milestone': return '契约打卡 - 里程碑';
        case 'missed': return '契约漏做 - 单日';
        case 'missed_streak': return '契约漏做 - 连续';
        case 'reminder': return '契约提醒';
        case 'oneshot_expired': return '一次性契约 - 超期失效';
        case 'oneshot_complete': return '一次性契约 - 完成';
        default: return '契约';
    }
}

/**
 * 根据任务当前状态自动选 scene —— 上层在调 LLM 时不用自己判断。
 * 用于"自动结算"流（漏做扣币 / 超期归档）的批量调用。
 * 主动打卡完成的场景由 UI 层直接传 scene='complete' / 'milestone'。
 */
export function pickSceneForMissedEntry(
    task: TaskV2,
    entry: { date: string; status: 'missed' },
    consecutiveMissed: number,
    now: Date,
): TaskPromptContext['scene'] {
    if (task.type === 'oneshot') return 'oneshot_expired';
    if (consecutiveMissed >= 2) return 'missed_streak';
    return 'missed';
}

/**
 * 主动打卡时选 scene：连胜达到里程碑走 milestone，否则走 complete。
 * 上层应在 markDone 之后调 computeCurrentStreak 拿到新连胜，再传进来。
 */
export function pickSceneForComplete(
    newStreak: number,
): TaskPromptContext['scene'] {
    return isStreakMilestone(newStreak) ? 'milestone' : 'complete';
}
