/**
 * 时光契约副作用编排器 —— 把 taskScheduler 的纯决策、taskPrompts 的场景模板、
 * LLM 调用、存钱罐写入、DB 持久化串成一个完整流程。
 *
 * 跟 ScheduleApp UI 解耦：UI 只调 runDailyCheck / markTaskDone / skipToday，
 * 不用关心"先调 LLM 还是先扣币 / 错误回滚 / 哪些任务该批量处理"等细节。
 *
 * 设计要点：
 *  - 单任务单函数：runSettlementForTask 处理一个任务的所有漏结算/归档，
 *    内部串：决策 → 批量生成台词 → 应用 → 存钱罐 → DB.saveTaskV2 → 聊天 system 消息。
 *  - 错误隔离：单个任务失败不影响其它；LLM 失败不阻塞结算（reaction 留空）。
 *  - 不接 Push：Push 调度由 instantPushClient 单独管，本模块只做"现在打开了 app，要不要补结算"。
 *    提醒决策（reminderDecision）由 UI 层在用户进入 app 时主动调一次，触发主动发聊天消息。
 */

import { APIConfig, BankFullState, BankTransaction, CharacterProfile, TaskV2, TaskHistoryEntry, UserProfile } from '../types';
import { DB } from './db';
import { ContextBuilder } from './context';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { safeResponseJson } from './safeApi';
import {
    settleDecision,
    archiveDecision,
    applySettlement,
    markDone as markDonePure,
    markSkipped as markSkippedPure,
    archiveTask,
    computeCurrentStreak,
    computeSettlementAmount,
} from './taskScheduler';
import {
    buildTaskPrompt,
    pickSceneForMissedEntry,
    pickSceneForComplete,
    TaskPromptContext,
} from './taskPrompts';

/** 结算结果 —— 上层用于 toast / UI 更新。 */
export interface SettlementResult {
    taskId: string;
    /** 应用后的最新任务（已 saveTaskV2 落库） */
    updatedTask: TaskV2;
    /** 这次结算 / 归档产生的新 history 条目（含 LLM 台词） */
    newEntries: TaskHistoryEntry[];
    /** 这次产生的虚拟币流水（正为奖、负为扣），上层可选地累加 toast */
    coinDelta: number;
    /** 这次有没有归档 */
    archived: boolean;
    archiveReason?: 'completed' | 'expired' | 'manual';
}

/** 单次调 LLM 生成一句话台词。失败返回空串不阻塞流程。 */
async function generateSupervisorReaction(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
    ctx: TaskPromptContext,
): Promise<string> {
    if (!apiConfig.apiKey) return '';
    try {
        await injectMemoryPalace(char, undefined, ctx.task.title);
        const baseContext = ContextBuilder.buildCoreContext(char, user);
        const userPrompt = buildTaskPrompt(ctx);
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [
                    { role: 'system', content: baseContext },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.9,
                max_tokens: 200,
            }),
        });
        if (!response.ok) return '';
        const data = await safeResponseJson(response);
        let text = (data?.choices?.[0]?.message?.content || '').trim();
        if (!text) return '';
        // 去掉首尾引号 + 括号说明 + 舞台指示
        text = text.replace(/^["'"「『]+|["'"」』]+$/g, '');
        text = text.replace(/[（(][^）)]{0,40}[）)]/g, '').trim();
        // 过滤 prompt 指令泄漏：弱模型会把约束文本本身当输出回吐
        // （如"≤30字""一句话（≤30字）""不超过30字""30 characters"），塞进聊天会显示成乱码
        if (/(?:不超过|≤\s*\d|\d+\s*(?:字|characters?|chars?)|一句话|常用语言|不要有引号|舞台指示|输出要求|must use|one sentence|no quotes)/i.test(text)) {
            return '';
        }
        // 截断到 60 字（prompt 要求 30 字，留点宽容度）
        if (text.length > 60) text = text.slice(0, 60);
        return text;
    } catch (err) {
        console.warn('[TaskSettlement] LLM reaction failed:', err);
        return '';
    }
}

/** 把一条流水写入存钱罐（saveTransaction + 更新 todaySpent + saveBankState）。 */
async function applyCoinDelta(
    amount: number,
    note: string,
    now: Date,
): Promise<void> {
    if (amount === 0) return;
    const today = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')}`;
    const tx: BankTransaction = {
        id: `task-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
        amount,
        category: 'general',
        note,
        timestamp: now.getTime(),
        dateStr: today,
    };
    await DB.saveTransaction(tx);
    // 同步更新 todaySpent（存钱罐 app 用这个显示"今日支出"）
    try {
        const state = await DB.getBankState();
        if (state) {
            // amount 正为奖、负为扣；todaySpent 是"今天花掉的总额"（绝对值累加），
            // 奖励不应减 todaySpent，惩罚应加。但既有 BankApp.handleAddTransaction 是
            // todaySpent + amount（不管正负）—— 我们沿用同一个语义：amount 是带符号的，
            // todaySpent 直接 += amount。负数会减少 todaySpent（即扣币等于"今天又花了一笔"，
            // 不算负支出）。为了贴合用户直觉（漏做扣币 = 花掉），把惩罚走 +|amount|、奖励走 0。
            const deltaForSpent = amount < 0 ? Math.abs(amount) : 0;
            const newState: BankFullState = { ...state, todaySpent: state.todaySpent + deltaForSpent };
            await DB.saveBankState(newState);
        }
    } catch (err) {
        console.warn('[TaskSettlement] update bank state failed:', err);
    }
}

/**
 * 把契约事件塞进监督人聊天记录（role=system，带结构化 metadata 供 UI 渲染卡片）。
 * content 保留可读文本兜底；metadata.source='task-event' 触发卡片渲染。
 * role=system + type=text → 开启「隐藏系统日志」时自动隐藏。
 */
async function injectTaskEventIntoChat(msg: {
    charId: string;
    content: string;
    metadata: Record<string, any>;
}): Promise<void> {
    try {
        await DB.saveMessage({
            charId: msg.charId,
            role: 'system',
            type: 'text',
            content: msg.content,
            metadata: msg.metadata,
        });
    } catch (err) {
        console.warn('[TaskSettlement] inject chat failed:', err);
    }
}

/**
 * 对单个任务跑完整结算 + 归档检查。
 * 适用于：用户打开 app / Launcher 启动钩子 / 定时器后台唤起。
 *
 * 流程：
 *  1. settleDecision → 漏结算的天数（recurring）
 *  2. archiveDecision → oneshot 超期归档
 *  3. 对每个漏做 / 超期归档 entry 调一次 LLM 生成台词（独立失败）
 *  4. applySettlement → 合并 history
 *  5. 每条 entry 对应一笔存钱罐流水
 *  6. 把台词塞进对应角色聊天 system 消息
 *  7. saveTaskV2 落库
 *
 * LLM 调用是按条串行（避免并发把监督人 LLM 限流），但单条失败不阻塞。
 */
export async function runSettlementForTask(
    task: TaskV2,
    characters: CharacterProfile[],
    user: UserProfile,
    apiConfig: APIConfig,
    now: Date = new Date(),
): Promise<SettlementResult> {
    let working = { ...task };
    const newEntries: TaskHistoryEntry[] = [];
    let coinDelta = 0;
    let archived = false;
    let archiveReason: 'completed' | 'expired' | 'manual' | undefined;
    const sceneLabels: { charId: string; reaction: string; sceneLabel: string; coinDelta: number; taskKind: string }[] = [];

    const supervisor = characters.find(c => c.id === task.supervisorId);

    // 1. 漏做结算（recurring）
    const missedEntries = settleDecision(working, now);
    if (missedEntries.length && supervisor) {
        // 倒序生成台词（最近一天先），让 missed_streak 升级反应能正确算"连续到今天第 N 天"
        // 但应用顺序无所谓（applySettlement 内部会按日期排序）
        const reactionByDate: Record<string, string> = {};
        for (const entry of missedEntries) {
            // 算该 entry 当时的"连续漏做天数"：用 task 当前 history + 之前已生成的 entries 模拟
            const tempTask = applySettlement(working, [entry]);
            const tempHistoryMap = new Map(tempTask.history.map(h => [h.date, h.status]));
            // 数 entry 之前（含 entry）的连续 missed
            let consecutive = 0;
            const entryDate = new Date(entry.date);
            for (let i = 0; i < 30; i++) {
                const ds = `${entryDate.getFullYear()}-${(entryDate.getMonth()+1).toString().padStart(2,'0')}-${entryDate.getDate().toString().padStart(2,'0')}`;
                const s = tempHistoryMap.get(ds);
                if (s === 'missed') {
                    consecutive++;
                    entryDate.setDate(entryDate.getDate() - 1);
                    continue;
                }
                if (s === 'skipped') { entryDate.setDate(entryDate.getDate() - 1); continue; }
                if (s === 'done') break;
                if (task.type === 'recurring' && !isScheduledDayForTask(task, ds)) {
                    entryDate.setDate(entryDate.getDate() - 1);
                    continue;
                }
                break;
            }
            const scene = pickSceneForMissedEntry(task, entry as any, consecutive, now);
            const streakBefore = computeCurrentStreak(working, now);
            const ctx: TaskPromptContext = {
                userName: user.name,
                task,
                supervisorName: supervisor.name,
                scene,
                streak: streakBefore,
                consecutiveMissed: consecutive,
            };
            const reaction = await generateSupervisorReaction(supervisor, user, apiConfig, ctx);
            reactionByDate[entry.date] = reaction;

            // 算金额 + 写存钱罐（每条独立流水，便于存钱罐 app 展示）
            const amount = computeSettlementAmount(task, entry);
            coinDelta += amount;
            await applyCoinDelta(amount, `契约"${task.title}" - 漏做 ${entry.date}`, now);

            // 准备塞聊天 system 消息
            const sceneLabel = sceneLabelByScene(scene);
            sceneLabels.push({ charId: supervisor.id, reaction, sceneLabel, coinDelta: amount, taskKind: scene });
        }
        working = applySettlement(working, missedEntries, reactionByDate);
        // 收集新条目（已生成 reaction 的）
        for (const entry of missedEntries) {
            const e = working.history.find(h => h.date === entry.date);
            if (e) newEntries.push(e);
        }
    }

    // 2. 超期归档（oneshot）
    const archive = archiveDecision(working, now);
    if (archive.shouldArchive && archive.reason === 'expired') {
        if (archive.missedEntry && supervisor) {
            // 单独为超期归档调一次 LLM
            const ctx: TaskPromptContext = {
                userName: user.name,
                task,
                supervisorName: supervisor.name,
                scene: 'oneshot_expired',
                streak: 0,
                consecutiveMissed: 1,
            };
            const reaction = await generateSupervisorReaction(supervisor, user, apiConfig, ctx);
            const entries = [archive.missedEntry];
            working = applySettlement(working, entries, reaction ? { [archive.missedEntry.date]: reaction } : undefined);
            const amount = -task.penaltyCoins;
            coinDelta += amount;
            await applyCoinDelta(amount, `契约"${task.title}" - 超期失效`, now);
            const e = working.history.find(h => h.date === archive.missedEntry!.date);
            if (e) newEntries.push(e);
            sceneLabels.push({ charId: supervisor.id, reaction, sceneLabel: '一次性契约超期失效', coinDelta: -task.penaltyCoins, taskKind: 'oneshot_expired' });
        }
        working = archiveTask(working, 'expired');
        archived = true;
        archiveReason = 'expired';
    }

    // 3. 落库 + 塞聊天 system 消息（结构化 metadata，UI 渲染卡片）
    if (newEntries.length || archived) {
        await DB.saveTaskV2(working);
        for (const sl of sceneLabels) {
            await injectTaskEventIntoChat({
                charId: sl.charId,
                content: `[系统: ${sl.sceneLabel} | 契约"${task.title}" | 监督人 ${supervisor?.name || ''}: ${sl.reaction}]`,
                metadata: {
                    source: 'task-event',
                    taskKind: sl.taskKind,
                    taskTitle: task.title,
                    supervisorName: supervisor?.name || '',
                    supervisorAvatar: supervisor?.avatar,
                    userName: user.name,
                    sceneLabel: sl.sceneLabel,
                    reaction: sl.reaction,
                    coinDelta: sl.coinDelta,
                },
            });
        }
    }

    return { taskId: task.id, updatedTask: working, newEntries, coinDelta, archived, archiveReason };
}

/** 用户主动打卡完成（recurring 当天 / oneshot 整单）。 */
export async function markTaskDone(
    task: TaskV2,
    characters: CharacterProfile[],
    user: UserProfile,
    apiConfig: APIConfig,
    now: Date = new Date(),
): Promise<SettlementResult> {
    const supervisor = characters.find(c => c.id === task.supervisorId);
    const wasOneshot = task.type === 'oneshot';

    // 1. 应用 markDone（pure）
    let working = markDonePure(task, now);

    // 2. 算连胜 + 选场景 + 调 LLM
    let reaction = '';
    let scene: TaskPromptContext['scene'];
    if (supervisor) {
        if (wasOneshot) {
            scene = 'oneshot_complete';
        } else {
            const newStreak = computeCurrentStreak(working, now);
            scene = pickSceneForComplete(newStreak);
        }
        const ctx: TaskPromptContext = {
            userName: user.name,
            task,
            supervisorName: supervisor.name,
            scene,
            streak: wasOneshot ? 0 : computeCurrentStreak(working, now),
        };
        reaction = await generateSupervisorReaction(supervisor, user, apiConfig, ctx);
    }

    // 3. 写存钱罐（奖励）
    const amount = task.rewardCoins;
    await applyCoinDelta(amount, `契约"${task.title}" - 完成`, now);

    // 4. 一次性任务完成 → 自动归档
    let archived = false;
    let archiveReason: 'completed' | undefined;
    if (wasOneshot) {
        working = archiveTask(working, 'completed');
        archived = true;
        archiveReason = 'completed';
    }

    // 5. 把 reaction 写回当天 history entry
    if (reaction) {
        const todayStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')}`;
        working = {
            ...working,
            history: working.history.map(h => h.date === todayStr ? { ...h, reaction } : h),
        };
    }

    // 6. 落库 + 聊天 system 消息（结构化 metadata，UI 渲染卡片）
    await DB.saveTaskV2(working);
    if (supervisor) {
        const sl = sceneLabelByScene(scene!);
        await injectTaskEventIntoChat({
            charId: supervisor.id,
            content: `[系统: ${sl} | 契约"${task.title}" | 监督人 ${supervisor.name}: ${reaction}]`,
            metadata: {
                source: 'task-event',
                taskKind: scene,
                taskTitle: task.title,
                supervisorName: supervisor.name,
                supervisorAvatar: supervisor.avatar,
                userName: user.name,
                sceneLabel: sl,
                reaction,
                coinDelta: amount,
            },
        });
    }

    const todayStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')}`;
    const newEntry = working.history.find(h => h.date === todayStr);
    return {
        taskId: task.id,
        updatedTask: working,
        newEntries: newEntry ? [newEntry] : [],
        coinDelta: amount,
        archived,
        archiveReason,
    };
}

/** 用户主动请假跳过今天。 */
export async function skipToday(
    task: TaskV2,
    now: Date = new Date(),
): Promise<TaskV2> {
    const updated = markSkippedPure(task, now);
    await DB.saveTaskV2(updated);
    return updated;
}

/** 手动归档任务。 */
export async function archiveTaskManual(task: TaskV2): Promise<TaskV2> {
    const updated = archiveTask(task, 'manual');
    await DB.saveTaskV2(updated);
    return updated;
}

/**
 * 创建新任务（落库 + 通知监督人角色的聊天 system 消息）。
 *
 * 由 chatParser 在用户确认 TaskProposalCard 后调用；也由 ScheduleApp 表单直接调用。
 * 不调 LLM ——「建好」是用户的事实，监督人之后在反应性场景里再演绎。
 *
 * @returns 创建好的 TaskV2（已 saveTaskV2 落库）
 */
export async function createTask(
    task: TaskV2,
    userName: string,
    supervisorName?: string,
    supervisorAvatar?: string,
): Promise<TaskV2> {
    await DB.saveTaskV2(task);
    // 塞一条 system 消息进监督人聊天，让 ta 之后开口时知道这个新契约存在
    try {
        const typeText = task.type === 'oneshot'
            ? `一次性契约，截止 ${task.deadline || '未指定'}`
            : `频率 ${task.frequency || 'daily'}${task.reminderEnabled && task.reminderTime ? `，提醒 ${task.reminderTime}` : ''}`;
        await DB.saveMessage({
            charId: task.supervisorId,
            role: 'system',
            type: 'text',
            content: `[系统: 新契约已建立 | "${task.title}" | 监督人 ${supervisorName || '？'} 监督 ${userName} | ${typeText} | 奖励 +${task.rewardCoins} / 漏做 -${task.penaltyCoins}]`,
            metadata: {
                source: 'task-event',
                taskKind: 'created',
                taskTitle: task.title,
                supervisorName: supervisorName || '',
                supervisorAvatar,
                userName,
                sceneLabel: '新契约已建立',
                reaction: '',
                coinDelta: 0,
                typeText,
                rewardCoins: task.rewardCoins,
                penaltyCoins: task.penaltyCoins,
            },
        });
    } catch (err) {
        console.warn('[TaskSettlement] createTask inject chat failed:', err);
    }
    return task;
}

/**
 * 按标题关键词模糊查找某角色监督的未归档任务。
 * - 完全相等优先
 * - 否则按 includes 子串匹配
 * - 多条匹配返回 null（调用方应让角色反问"是 X 还是 Y？"）
 * - 零匹配返回 null
 */
export async function findTaskByTitle(
    supervisorId: string,
    keyword: string,
): Promise<TaskV2 | null> {
    const all = await DB.getAllTaskV2();
    const candidates = all.filter(t => !t.archived && t.supervisorId === supervisorId);
    const k = keyword.trim();
    if (!k) return null;
    // 1. 完全相等
    const exact = candidates.find(t => t.title === k);
    if (exact) return exact;
    // 2. 子串包含
    const substring = candidates.filter(t => t.title.includes(k) || k.includes(t.title));
    if (substring.length === 1) return substring[0];
    return null;
}

/**
 * 跑全量任务的日检查（漏结算 + 超期归档）。
 * 由 Launcher 启动钩子 / ScheduleApp 进入时调。
 *
 * @returns 所有产生了变化的任务结果（无变化的任务不进数组）
 */
export async function runDailyCheck(
    characters: CharacterProfile[],
    user: UserProfile,
    apiConfig: APIConfig,
    now: Date = new Date(),
): Promise<SettlementResult[]> {
    let tasks: TaskV2[] = [];
    try {
        tasks = await DB.getAllTaskV2();
    } catch (err) {
        console.warn('[TaskSettlement] load tasks failed:', err);
        return [];
    }
    const results: SettlementResult[] = [];
    for (const task of tasks) {
        if (task.archived) continue;
        try {
            const r = await runSettlementForTask(task, characters, user, apiConfig, now);
            if (r.newEntries.length || r.archived) {
                results.push(r);
            }
        } catch (err) {
            console.warn(`[TaskSettlement] task ${task.id} settle failed:`, err);
        }
    }
    return results;
}

// --- 内部工具 ---

function sceneLabelByScene(scene: TaskPromptContext['scene']): string {
    switch (scene) {
        case 'complete': return '契约打卡完成';
        case 'milestone': return '契约连胜里程碑';
        case 'missed': return '契约漏做';
        case 'missed_streak': return '契约连续漏做';
        case 'reminder': return '契约到点提醒';
        case 'oneshot_expired': return '一次性契约超期失效';
        case 'oneshot_complete': return '一次性契约完成';
        default: return '契约';
    }
}

/** 临时副本：判断 recurring 任务某天该不该做（taskScheduler.isScheduledDay 是导出的，
 * 但本文件为了在算 consecutiveMissed 时直接用 ds（字符串），需要内联一个按 ds 的版本）。 */
function isScheduledDayForTask(task: TaskV2, dateStr: string): boolean {
    if (task.type !== 'recurring') return false;
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const dow = date.getDay();
    switch (task.frequency) {
        case 'daily': return true;
        case 'weekly': return true;
        case 'custom': return Array.isArray(task.customDays) && task.customDays.includes(dow);
        default: return false;
    }
}
