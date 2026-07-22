/**
 * 时光契约 —— 让某个角色监督用户完成任意日常任务。
 *
 * 数据流：
 *  - tasks: TaskV2[]（重复 / 一次性 / 连胜 / 奖惩 / 提醒）
 *  - anniversaries: Anniversary[]（保留，跟任务 tab 平级）
 *  - 启动时 migrateLegacyTasksToV2（老 Task → TaskV2）；跨日自动结算由 Launcher 启动钩子统一跑
 *
 * 主题：保留 cyber / soft / minimal 三套，但按全局水准优化（不简陋）。
 *  - 去掉 twemoji 装饰图标（用户反馈"丑丑的"），全部用 Phosphor / SVG
 *  - 信息密度增加：进度条 + 连胜 + 奖惩 + 状态行
 *  - minimal 主题修了 tab 选中态反转 bug（选中应该是凸阴影，原版是凹的）
 *  - soft 主题圆点背景透明度从 30% → 20%（不抢戏）
 *  - cyber 主题网格透明度从 20% → 8%
 *
 * 监督角色台词：调 taskSettlement.markTaskDone（用户打卡），
 * 不在 UI 里直接拼 prompt / 调 LLM —— prompt 走 taskPrompts.ts，LLM 调用走 taskSettlement.ts。
 * Launcher 启动钩子统一调 runDailyCheck，避免本 App 与 Launcher 并发触发导致存钱罐流水 / 聊天 system 消息重复写。
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { Anniversary, CharacterProfile, TaskV2 } from '../types';
import Modal from '../components/os/Modal';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { markTaskDone, skipToday, archiveTaskManual } from '../utils/taskSettlement';
import { syncTaskReminders } from '../utils/taskReminderScheduler';
import {
    computeCurrentStreak,
    computeBestStreak,
    computeThisWeekDoneCount,
    toLocalDateStr,
    fromLocalDateStr,
    addDays,
    reminderDecision,
} from '../utils/taskScheduler';
import {
    ArrowLeft, Plus, Timer as TimerIcon, Calendar as CalendarIcon,
    DotsThree, CheckCircle, XCircle, SkipForward, Archive as ArchiveIcon,
    Bell, Coins, Fire, Trophy, Warning, Clock,
} from '@phosphor-icons/react';
import { getCalendarDayDifference, getLocalDateKey } from '../utils/localDate';
import { useLocalDateKey } from '../hooks/useLocalDateKey';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

type ThemeMode = 'cyber' | 'soft' | 'minimal';

// --- 三套主题配置（优化版）---
// 优化点：
//  - 卡片样式更克制（不堆叠廉价边框）
//  - 按钮统一圆角逻辑（不再 skew）
//  - 加 progress / status / streak 配色字段，让任务卡能展示信息层级
//  - tab 选中态在 minimal 主题下用凸阴影（修了原版反过来的 bug）
const THEMES: Record<ThemeMode, {
    id: ThemeMode;
    bg: string;
    bgPattern?: { kind: 'grid' | 'dots'; opacity: number };
    text: string;
    textSub: string;
    textMuted: string;
    accent: string;
    accentBg: string;
    border: string;
    card: string;
    cardActive: string;
    buttonPrimary: string;
    buttonGhost: string;
    buttonDanger: string;
    font: string;
    iconDone: string;
    iconMissed: string;
    iconSkipped: string;
    progressTrack: string;
    progressFill: string;
    streakColor: string;
    coinColor: string;
    tabContainer: string;
    tabActive: string;
    tabInactive: string;
    label: string;
    eventLabel: string;
    headerBorder: string;
}> = {
    cyber: {
        id: 'cyber',
        bg: 'bg-[#0f172a]',
        bgPattern: { kind: 'grid', opacity: 0.08 },
        text: 'text-slate-100',
        textSub: 'text-slate-400',
        textMuted: 'text-slate-600',
        accent: 'text-cyan-400',
        accentBg: 'bg-cyan-500/10 border-cyan-500/30',
        border: 'border-slate-800',
        card: 'bg-slate-900/60 backdrop-blur-md border border-slate-700/40 rounded-2xl',
        cardActive: 'bg-slate-900/80 border-cyan-500/40 ring-1 ring-cyan-500/20',
        buttonPrimary: 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-xl font-bold tracking-wide',
        buttonGhost: 'bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 rounded-xl border border-slate-700/50',
        buttonDanger: 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-xl border border-rose-500/30',
        font: 'font-mono',
        iconDone: 'text-emerald-400',
        iconMissed: 'text-rose-400',
        iconSkipped: 'text-slate-500',
        progressTrack: 'bg-slate-800',
        progressFill: 'bg-gradient-to-r from-cyan-500 to-cyan-400',
        streakColor: 'text-amber-400',
        coinColor: 'text-amber-300',
        tabContainer: 'bg-black/40 border border-slate-700/50 rounded-lg',
        tabActive: 'text-cyan-400 bg-cyan-900/40 shadow-sm',
        tabInactive: 'text-slate-500',
        label: 'QUEST LOG',
        eventLabel: 'EVENTS',
        headerBorder: 'border-slate-800',
    },
    soft: {
        id: 'soft',
        bg: 'bg-[#fff5f8]',
        bgPattern: { kind: 'dots', opacity: 0.20 },
        text: 'text-slate-700',
        textSub: 'text-slate-500',
        textMuted: 'text-slate-400',
        accent: 'text-pink-500',
        accentBg: 'bg-pink-100/60 border-pink-200',
        border: 'border-pink-100',
        card: 'bg-white/80 backdrop-blur-xl rounded-[1.5rem] shadow-sm border border-white',
        cardActive: 'bg-white/95 border-pink-200 ring-2 ring-pink-100',
        buttonPrimary: 'bg-pink-400 hover:bg-pink-500 text-white rounded-2xl shadow-md shadow-pink-200/50 font-bold',
        buttonGhost: 'bg-white/60 hover:bg-white text-slate-600 rounded-2xl border border-pink-100',
        buttonDanger: 'bg-rose-50 hover:bg-rose-100 text-rose-500 rounded-2xl border border-rose-100',
        font: 'font-sans',
        iconDone: 'text-emerald-500',
        iconMissed: 'text-rose-500',
        iconSkipped: 'text-slate-400',
        progressTrack: 'bg-pink-100/60',
        progressFill: 'bg-gradient-to-r from-pink-400 to-rose-400',
        streakColor: 'text-amber-500',
        coinColor: 'text-amber-600',
        tabContainer: 'bg-white/50 rounded-full p-1',
        tabActive: 'text-pink-600 bg-white shadow-sm rounded-full',
        tabInactive: 'text-slate-400',
        label: '任务日志',
        eventLabel: '纪念日',
        headerBorder: 'border-pink-100',
    },
    minimal: {
        id: 'minimal',
        bg: 'bg-[#eef2f6]',
        text: 'text-slate-700',
        textSub: 'text-slate-500',
        textMuted: 'text-slate-400',
        accent: 'text-indigo-500',
        accentBg: 'bg-[#eef2f6] shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff] border-indigo-200/50',
        border: 'border-transparent',
        card: 'bg-[#eef2f6] rounded-2xl shadow-[6px_6px_12px_#d1d9e6,-6px_-6px_12px_#ffffff]',
        cardActive: 'bg-[#eef2f6] rounded-2xl shadow-[inset_3px_3px_8px_#d1d9e6,inset_-3px_-3px_8px_#ffffff] ring-2 ring-indigo-200/50',
        buttonPrimary: 'bg-[#eef2f6] text-indigo-600 font-bold rounded-xl shadow-[4px_4px_10px_#d1d9e6,-4px_-4px_10px_#ffffff] active:shadow-[inset_3px_3px_8px_#d1d9e6,inset_-3px_-3px_8px_#ffffff]',
        buttonGhost: 'bg-[#eef2f6] text-slate-500 font-medium rounded-xl shadow-[3px_3px_8px_#d1d9e6,-3px_-3px_8px_#ffffff] active:shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]',
        buttonDanger: 'bg-[#eef2f6] text-rose-500 font-medium rounded-xl shadow-[3px_3px_8px_#d1d9e6,-3px_-3px_8px_#ffffff] active:shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]',
        font: 'font-sans',
        iconDone: 'text-emerald-500',
        iconMissed: 'text-rose-400',
        iconSkipped: 'text-slate-400',
        progressTrack: 'bg-slate-200/60',
        progressFill: 'bg-gradient-to-r from-indigo-400 to-indigo-500',
        streakColor: 'text-amber-500',
        coinColor: 'text-amber-600',
        tabContainer: 'bg-[#eef2f6] rounded-xl shadow-[inset_3px_3px_8px_#d1d9e6,inset_-3px_-3px_8px_#ffffff] p-1',
        // 修复点：minimal 主题选中应该是凸阴影（原版反过来了，选中反而凹了）
        tabActive: 'text-indigo-600 bg-[#eef2f6] shadow-[3px_3px_8px_#d1d9e6,-3px_-3px_8px_#ffffff] rounded-lg',
        tabInactive: 'text-slate-400',
        label: 'Focus',
        eventLabel: 'Memories',
        headerBorder: 'border-slate-200/60',
    },
};

const ScheduleApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, apiConfig, addToast, userProfile, characterGroups } = useOS();
    const localDateKey = useLocalDateKey();
    const [tasks, setTasks] = useState<TaskV2[]>([]);
    const [anniversaries, setAnniversaries] = useState<Anniversary[]>([]);
    const [activeTab, setActiveTab] = useState<'quest' | 'events'>('quest');
    const [processingTaskIds, setProcessingTaskIds] = useState<Set<string>>(new Set());
    const [currentThemeMode, setCurrentThemeMode] = useState<ThemeMode>('cyber');
    const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
    const [editTask, setEditTask] = useState<TaskV2 | null>(null); // 编辑模式时填入

    // 新建任务表单状态
    const [showTaskModal, setShowTaskModal] = useState(false);
    const [showAnniModal, setShowAnniModal] = useState(false);
    const [form, setForm] = useState<{
        title: string;
        type: 'recurring' | 'oneshot';
        frequency: 'daily' | 'weekly' | 'monthly' | 'custom';
        customDays: number[];
        monthlyDay: number;
        targetCount: number;
        deadline: string;
        supervisorId: string;
        reminderEnabled: boolean;
        reminderTime: string;
        rewardCoins: number;
        penaltyCoins: number;
    }>({
        title: '',
        type: 'recurring',
        frequency: 'daily',
        customDays: [1, 3, 5],
        monthlyDay: 1,
        targetCount: 7,
        deadline: '',
        supervisorId: '',
        reminderEnabled: true,
        reminderTime: '20:00',
        rewardCoins: 10,
        penaltyCoins: 3,
    });
    const [supervisorGroupId, setSupervisorGroupId] = useState<string>(GROUP_FILTER_ALL);

    const [newAnniTitle, setNewAnniTitle] = useState('');
    const [newAnniDate, setNewAnniDate] = useState('');
    const [newAnniChar, setNewAnniChar] = useState<string>(activeCharacterId || '');
    const [anniCharGroupId, setAnniCharGroupId] = useState<string>(GROUP_FILTER_ALL);

    const theme = THEMES[currentThemeMode];
    const now = useMemo(() => new Date(), [tasks, anniversaries]); // tasks 变化时刷新 now 让 streak 显示最新

    useEffect(() => {
        init();
        const saved = localStorage.getItem('schedule_app_theme');
        if (saved && THEMES[saved as ThemeMode]) {
            setCurrentThemeMode(saved as ThemeMode);
        }
    }, []);

    const init = async () => {
        // 1. 老 Task → TaskV2 迁移（启动时跑一次，幂等）
        try {
            await DB.migrateLegacyTasksToV2();
        } catch (err) {
            console.warn('[ScheduleApp] migrate legacy tasks failed:', err);
        }

        // 2. 加载数据
        //    跨日自动结算（runDailyCheck）已挪到 Launcher 启动钩子统一跑，
        //    避免同进程并发触发导致存钱罐流水 / 聊天 system 消息重复写。
        //    Launcher 跑完结算后用 addToast 通知，进 App 时这里 loadData 拿到的就是最新数据。
        await loadData();
    };

    const loadData = async () => {
        const [t, a] = await Promise.all([DB.getAllTaskV2(), DB.getAllAnniversaries()]);
        setTasks(t.sort((a, b) => b.createdAt - a.createdAt));
        setAnniversaries(a.sort((a, b) => a.date.localeCompare(b.date)));
        // 进入 App 时重排本地通知（任务状态可能已经变，比如跨日打卡）；
        // Web 平台 / 未授权 syncTaskReminders 内部静默跳过。
        syncTaskReminders().catch(err => console.warn('[ScheduleApp] syncTaskReminders failed:', err));
    };

    const toggleTheme = () => {
        const modes: ThemeMode[] = ['cyber', 'soft', 'minimal'];
        const nextIndex = (modes.indexOf(currentThemeMode) + 1) % modes.length;
        const nextMode = modes[nextIndex];
        setCurrentThemeMode(nextMode);
        localStorage.setItem('schedule_app_theme', nextMode);
    };

    // --- 纪念日 LLM 想法（保留原逻辑，按场景描述 prompt）---
    const generateAnniversaryThought = async (anni: Anniversary) => {
        const char = characters.find(c => c.id === anni.charId);
        if (!char || !apiConfig.apiKey) return;
        // 24h 缓存
        if (anni.aiThought && anni.lastThoughtGeneratedAt && (Date.now() - anni.lastThoughtGeneratedAt < 24 * 60 * 60 * 1000)) {
            return;
        }
        // 跑 LLM 的 prompt 由 taskPrompts.ts 风格写法（只描述场景，不预设语气）
        // —— 但纪念日不在 taskPrompts 模板里（只有契约打卡相关），这里直接写
        // FEEDBACK: 显式调用时弹 loading toast
        if (Date.now() - (anni.lastThoughtGeneratedAt || 0) > 10000) {
            addToast(`${char.name} 正在查阅日历...`, 'info');
        }
        try {
            const { ContextBuilder } = await import('../utils/context');
            const { injectMemoryPalace } = await import('../utils/memoryPalace/pipeline');
            const { safeResponseJson } = await import('../utils/safeApi');
            const daysDiff = getCalendarDayDifference(localDateKey, anni.date) ?? Math.ceil((new Date(anni.date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
            const dayText = daysDiff > 0 ? `还有 ${daysDiff} 天` : (daysDiff === 0 ? '就是今天' : `已经过去 ${Math.abs(daysDiff)} 天`);
            await injectMemoryPalace(char, undefined, anni.title);
            const baseContext = ContextBuilder.buildCoreContext(char, userProfile);
            const userPrompt = `### 场景：纪念日
事件: "${anni.title}"
时间状态: ${dayText}

### 任务
基于你的人设和你们的关系，对这件事做出反应。

**输出要求**:
- 仅输出一句话（不超过 30 字）。
- 必须使用用户常用语言。
- 不要有引号、不要有括号说明。`;
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'system', content: baseContext }, { role: 'user', content: userPrompt }],
                    temperature: 0.8, max_tokens: 200,
                }),
            });
            if (!response.ok) return;
            const data = await safeResponseJson(response);
            const text = (data?.choices?.[0]?.message?.content || '').trim().replace(/^["'"「『]+|["'"」』]+$/g, '');
            if (text) {
                const updated = { ...anni, aiThought: text, lastThoughtGeneratedAt: Date.now() };
                await DB.saveAnniversary(updated);
                setAnniversaries(prev => prev.map(a => a.id === anni.id ? updated : a));
            }
        } catch (err) {
            console.warn('[ScheduleApp] anniversary thought failed:', err);
        }
    };

    // --- 任务操作 ---
    const handleAddTask = async () => {
        if (!form.title.trim()) {
            addToast('请填写任务标题', 'error');
            return;
        }
        if (form.type === 'oneshot' && !form.deadline) {
            addToast('一次性任务需要截止时间', 'error');
            return;
        }
        const newTask: TaskV2 = {
            id: `task-${Date.now()}`,
            title: form.title.trim(),
            supervisorId: form.supervisorId || characters[0]?.id || '',
            type: form.type,
            frequency: form.type === 'recurring' ? form.frequency : undefined,
            targetCount: form.frequency === 'weekly' ? form.targetCount : undefined,
            customDays: form.type === 'recurring' && (form.frequency === 'weekly' || form.frequency === 'custom') ? form.customDays : undefined,
            monthlyDay: form.type === 'recurring' && form.frequency === 'monthly' ? form.monthlyDay : undefined,
            deadline: form.type === 'oneshot' ? form.deadline : undefined,
            history: [],
            rewardCoins: Math.max(0, form.rewardCoins),
            penaltyCoins: Math.max(0, form.penaltyCoins),
            reminderEnabled: form.reminderEnabled,
            reminderTime: form.reminderEnabled ? form.reminderTime : undefined,
            archived: false,
            createdAt: Date.now(),
        };
        await DB.saveTaskV2(newTask);
        setTasks(prev => [newTask, ...prev]);
        setShowTaskModal(false);
        resetForm();
        addToast('已创建契约', 'success');
        syncTaskReminders().catch(err => console.warn('[ScheduleApp] syncTaskReminders after create failed:', err));
    };

    const resetForm = () => {
        setForm({
            title: '', type: 'recurring', frequency: 'daily',
            customDays: [1, 3, 5], monthlyDay: 1, targetCount: 7, deadline: '',
            supervisorId: '', reminderEnabled: true, reminderTime: '20:00',
            rewardCoins: 10, penaltyCoins: 3,
        });
    };

    const handleCheckin = async (task: TaskV2) => {
        if (processingTaskIds.has(task.id)) return;
        setProcessingTaskIds(prev => new Set(prev).add(task.id));
        try {
            const result = await markTaskDone(task, characters, userProfile, apiConfig);
            setTasks(prev => prev.map(t => t.id === task.id ? result.updatedTask : t));
            const supervisor = characters.find(c => c.id === task.supervisorId);
            const newStreak = computeCurrentStreak(result.updatedTask, new Date());
            if (result.newEntries[0]?.reaction) {
                addToast(`${supervisor?.name || '监督人'}：${result.newEntries[0].reaction}`, 'success');
            } else {
                addToast(`已完成 · 连胜 ${newStreak} 天`, 'success');
            }
            if (result.coinDelta) addToast(`流通币 ${result.coinDelta > 0 ? '+' : ''}${result.coinDelta}`, 'success');
        } catch (err: any) {
            addToast(`打卡失败: ${err?.message || '未知错误'}`, 'error');
        } finally {
            setProcessingTaskIds(prev => { const n = new Set(prev); n.delete(task.id); return n; });
            syncTaskReminders().catch(err => console.warn('[ScheduleApp] syncTaskReminders after checkin failed:', err));
        }
    };

    const handleSkip = async (task: TaskV2) => {
        const updated = await skipToday(task);
        setTasks(prev => prev.map(t => t.id === task.id ? updated : t));
        addToast('已请假跳过今天', 'info');
        syncTaskReminders().catch(err => console.warn('[ScheduleApp] syncTaskReminders after skip failed:', err));
    };

    const handleArchive = async (task: TaskV2) => {
        const updated = await archiveTaskManual(task);
        setTasks(prev => prev.map(t => t.id === task.id ? updated : t));
        addToast('已归档', 'info');
        syncTaskReminders().catch(err => console.warn('[ScheduleApp] syncTaskReminders after archive failed:', err));
    };

    /** 更新已有契约的字段（截止时间、提醒时间等）。保留 history 不动。 */
    const handleUpdateTask = async (taskId: string, patch: Partial<TaskV2>) => {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        const updated: TaskV2 = { ...task, ...patch };
        await DB.saveTaskV2(updated);
        setTasks(prev => prev.map(t => t.id === taskId ? updated : t));
        setDetailTask(updated);
        addToast('契约已更新', 'success');
        syncTaskReminders().catch(err => console.warn('[ScheduleApp] syncTaskReminders after update failed:', err));
    };

    const handleDelete = async (id: string) => {
        await DB.deleteTaskV2(id);
        setTasks(prev => prev.filter(t => t.id !== id));
        syncTaskReminders().catch(err => console.warn('[ScheduleApp] syncTaskReminders after delete failed:', err));
    };

    // --- 纪念日操作 ---
    const handleAddAnni = async () => {
        if (!newAnniTitle.trim() || !newAnniDate) {
            addToast('请填写名称和日期', 'error');
            return;
        }
        const anni: Anniversary = {
            id: `anni-${Date.now()}`,
            title: newAnniTitle.trim(),
            date: newAnniDate,
            charId: newAnniChar || characters[0]?.id || '',
        };
        await DB.saveAnniversary(anni);
        setAnniversaries(prev => [...prev, anni].sort((a, b) => a.date.localeCompare(b.date)));
        setShowAnniModal(false);
        setNewAnniTitle('');
        setNewAnniDate('');
    };

    const handleDeleteAnni = async (id: string) => {
        await DB.deleteAnniversary(id);
        setAnniversaries(prev => prev.filter(a => a.id !== id));
    };

    // --- 派生数据 ---
    const getDaysUntil = (dateStr: string) => {
        return getCalendarDayDifference(localDateKey, dateStr) ?? Number.POSITIVE_INFINITY;
    };

    const upcomingAnni = useMemo(() => {
        return anniversaries.filter(a => getDaysUntil(a.date) >= 0).sort((a, b) => a.date.localeCompare(b.date))[0];
    }, [anniversaries, localDateKey]);

    useEffect(() => {
        if (upcomingAnni) generateAnniversaryThought(upcomingAnni);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [upcomingAnni?.id]);

    // 顶部统计：今日完成 / 总数
    const todayStats = useMemo(() => {
        const todayStr = toLocalDateStr(new Date());
        const active = tasks.filter(t => !t.archived);
        const doneToday = active.filter(t => t.history.some(h => h.date === todayStr && h.status === 'done')).length;
        return { doneToday, total: active.length };
    }, [tasks]);

    // 本周流通币结算
    const weekCoins = useMemo(() => {
        const today = new Date();
        const dow = today.getDay() === 0 ? 6 : today.getDay() - 1;
        const monday = addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -dow);
        let sum = 0;
        for (const t of tasks) {
            for (const h of t.history) {
                const d = fromLocalDateStr(h.date);
                if (d < monday) continue;
                if (h.status === 'done') sum += t.rewardCoins;
                else if (h.status === 'missed') {
                    // 简化：用 penaltyCoins 不算倍数（精确倍数在结算时已扣过）
                    sum -= t.penaltyCoins;
                }
            }
        }
        return sum;
    }, [tasks]);

    // 最长连胜
    const bestStreak = useMemo(() => {
        return tasks.reduce((max, t) => Math.max(max, computeBestStreak(t)), 0);
    }, [tasks]);

    const detailTask = useMemo(() => tasks.find(t => t.id === detailTaskId) || null, [tasks, detailTaskId]);

    // --- 渲染 ---
    return (
        <div className={`h-full w-full flex flex-col ${theme.font} ${theme.bg} ${theme.text} relative overflow-hidden transition-colors duration-500`}>
            {/* 主题背景纹理 */}
            {theme.bgPattern?.kind === 'grid' && (
                <div className="absolute inset-0 pointer-events-none" style={{ opacity: theme.bgPattern.opacity, backgroundImage: 'linear-gradient(rgba(56,189,248,1) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,1) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
            )}
            {theme.bgPattern?.kind === 'dots' && (
                <div className="absolute inset-0 pointer-events-none" style={{ opacity: theme.bgPattern.opacity, backgroundImage: 'radial-gradient(#fbcfe8 2px, transparent 2px)', backgroundSize: '20px 20px' }} />
            )}

            {/* Header */}
            <div className={`border-b ${theme.headerBorder} backdrop-blur-sm sticky top-0 z-20 shrink-0 relative transition-colors duration-300`} style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="pt-12 pb-4 px-6 flex items-center justify-between h-24 box-border">
                    <button onClick={closeApp} className={`p-2 -ml-2 rounded-full active:scale-90 transition-transform ${currentThemeMode === 'minimal' ? 'shadow-[4px_4px_8px_#d1d9e6,-4px_-4px_8px_#ffffff]' : 'hover:bg-black/5'}`} aria-label="返回">
                        <ArrowLeft size={22} className={theme.accent} weight="bold" />
                    </button>
                    <div className="flex items-center gap-2">
                        <TimerIcon size={18} className={theme.accent} weight="fill" />
                        <span className={`text-sm font-bold tracking-wide ${currentThemeMode === 'cyber' ? 'uppercase' : ''}`}>时光契约</span>
                    </div>
                    <div className="flex gap-2">
                        <button onClick={toggleTheme} className={`p-2 rounded-full active:scale-90 transition-transform ${currentThemeMode === 'minimal' ? 'shadow-[4px_4px_8px_#d1d9e6,-4px_-4px_8px_#ffffff]' : 'hover:bg-black/5'}`} aria-label="切换主题">
                            <span className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>{currentThemeMode}</span>
                        </button>
                        <button onClick={() => activeTab === 'quest' ? (resetForm(), setEditTask(null), setShowTaskModal(true)) : setShowAnniModal(true)} className={`p-2 rounded-full active:scale-90 transition-transform ${currentThemeMode === 'minimal' ? 'shadow-[4px_4px_8px_#d1d9e6,-4px_-4px_8px_#ffffff]' : 'hover:bg-black/5'}`} aria-label="新建">
                            <Plus size={22} className={theme.accent} weight="bold" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Tab 切换 */}
            <div className={`px-6 pt-4 pb-2 z-10 shrink-0`}>
                <div className={`flex gap-1 p-1 ${theme.tabContainer}`}>
                    <button onClick={() => setActiveTab('quest')} className={`flex-1 px-4 py-2 rounded text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'quest' ? theme.tabActive : theme.tabInactive}`}>
                        <TimerIcon size={14} weight="fill" />
                        {theme.label}
                    </button>
                    <button onClick={() => setActiveTab('events')} className={`flex-1 px-4 py-2 rounded text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'events' ? theme.tabActive : theme.tabInactive}`}>
                        <CalendarIcon size={14} weight="fill" />
                        {theme.eventLabel}
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar p-6 space-y-4 z-10">
                {/* 任务 tab */}
                {activeTab === 'quest' && (
                    <>
                        {/* 顶部统计卡 */}
                        <div className={`${theme.card} p-5`}>
                            <div className="flex items-center justify-between mb-3">
                                <div>
                                    <div className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>今日进度</div>
                                    <div className={`text-2xl font-bold ${theme.text} mt-0.5`}>
                                        {todayStats.doneToday} <span className={theme.textSub}>/ {todayStats.total}</span>
                                    </div>
                                </div>
                                <div className="flex gap-4">
                                    <div className="text-right">
                                        <div className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>最长连胜</div>
                                        <div className={`text-xl font-bold flex items-center gap-1 ${theme.streakColor}`}>
                                            <Trophy size={16} weight="fill" />
                                            {bestStreak}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>本周结算</div>
                                        <div className={`text-xl font-bold flex items-center gap-1 ${weekCoins >= 0 ? theme.coinColor : theme.iconMissed}`}>
                                            <Coins size={16} weight="fill" />
                                            {weekCoins >= 0 ? '+' : ''}{weekCoins}
                                        </div>
                                    </div>
                                </div>
                            </div>
                            {todayStats.total > 0 && (
                                <div className={`h-1.5 ${theme.progressTrack} rounded-full overflow-hidden`}>
                                    <div className={`h-full ${theme.progressFill} transition-all duration-500`} style={{ width: `${(todayStats.doneToday / todayStats.total) * 100}%` }} />
                                </div>
                            )}
                        </div>

                        {/* 进行中 */}
                        <div>
                            <div className={`text-[10px] font-bold uppercase tracking-[0.2em] ${theme.textSub} px-1 mb-2`}>进行中</div>
                            {tasks.filter(t => !t.archived).length === 0 && (
                                <div className={`${theme.card} text-center py-10`}>
                                    <div className={theme.textSub + ' text-sm'}>还没有进行中的契约</div>
                                    <button onClick={() => { resetForm(); setEditTask(null); setShowTaskModal(true); }} className={`mt-3 text-xs font-bold ${theme.accent}`}>+ 新建契约</button>
                                </div>
                            )}
                            <div className="space-y-3">
                                {tasks.filter(t => !t.archived).map(task => (
                                    <TaskCard
                                        key={task.id}
                                        task={task}
                                        theme={theme}
                                        themeMode={currentThemeMode}
                                        supervisor={characters.find(c => c.id === task.supervisorId)}
                                        isProcessing={processingTaskIds.has(task.id)}
                                        now={now}
                                        onCheckin={() => handleCheckin(task)}
                                        onSkip={() => handleSkip(task)}
                                        onArchive={() => handleArchive(task)}
                                        onDetail={() => setDetailTaskId(task.id)}
                                    />
                                ))}
                            </div>
                        </div>

                        {/* 已归档 */}
                        {tasks.filter(t => t.archived).length > 0 && (
                            <div>
                                <div className={`text-[10px] font-bold uppercase tracking-[0.2em] ${theme.textSub} px-1 mb-2`}>已归档</div>
                                <div className="space-y-2">
                                    {tasks.filter(t => t.archived).map(task => (
                                        <ArchivedTaskRow
                                            key={task.id}
                                            task={task}
                                            theme={theme}
                                            themeMode={currentThemeMode}
                                            supervisor={characters.find(c => c.id === task.supervisorId)}
                                            onDetail={() => setDetailTaskId(task.id)}
                                            onDelete={() => handleDelete(task.id)}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* 提示 */}
                        <div className={`text-[10px] ${theme.textMuted} px-1 leading-relaxed`}>
                            打开本应用时自动结算昨日漏的契约；到提醒时间监督角色会主动找你。
                        </div>
                    </>
                )}

                {/* 纪念日 tab */}
                {activeTab === 'events' && (
                    <div className="space-y-4">
                        {upcomingAnni && (
                            <div className={`w-full rounded-2xl p-5 relative overflow-hidden transition-all ${
                                currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_5px_5px_10px_#d1d9e6,inset_-5px_-5px_10px_#ffffff]'
                                : currentThemeMode === 'soft' ? 'bg-gradient-to-r from-pink-300 to-purple-300 text-white shadow-lg shadow-pink-200'
                                : 'bg-gradient-to-r from-slate-900 to-slate-800 border border-purple-500/30'
                            }`}>
                                <div className="relative z-10">
                                    <div className="flex justify-between items-start mb-2">
                                        <div className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${currentThemeMode === 'minimal' ? 'text-slate-500 bg-white/60' : 'text-white/80 bg-white/20'}`}>即将到来</div>
                                        <div className="text-3xl font-bold tracking-tighter">{getDaysUntil(upcomingAnni.date)} <span className="text-xs opacity-60 font-normal">天后</span></div>
                                    </div>
                                    <div className="text-xl font-bold mb-4">{upcomingAnni.title}</div>
                                    <div className={`flex items-start gap-3 p-3 rounded-xl ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[5px_5px_10px_#d1d9e6,-5px_-5px_10px_#ffffff]' : 'bg-white/20 backdrop-blur-md'}`}>
                                        <img src={characters.find(c => c.id === upcomingAnni.charId)?.avatar} className="w-8 h-8 rounded-full object-cover" alt="" />
                                        <div className={`text-xs font-medium leading-relaxed italic ${currentThemeMode === 'minimal' ? 'text-slate-600' : 'text-white/90'}`}>
                                            "{upcomingAnni.aiThought || "加载中..."}"
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div>
                            <div className={`text-[10px] font-bold uppercase tracking-[0.2em] ${theme.textSub} px-1 mb-2`}>全部纪念日</div>
                            {anniversaries.length === 0 && (
                                <div className={`${theme.card} text-center py-10`}>
                                    <div className={theme.textSub + ' text-sm'}>还没有纪念日</div>
                                </div>
                            )}
                            <div className="space-y-2">
                                {anniversaries.map(a => {
                                    const char = characters.find(c => c.id === a.charId);
                                    const days = getDaysUntil(a.date);
                                    return (
                                        <div key={a.id} className={`${theme.card} p-4 flex justify-between items-center group`}>
                                            <div className="flex items-center gap-3">
                                                {char && <img src={char.avatar} className="w-9 h-9 rounded-full object-cover" alt="" />}
                                                <div>
                                                    <div className={`text-sm font-bold ${theme.text}`}>{a.title}</div>
                                                    <div className={`text-[10px] ${theme.textSub} mt-0.5`}>{a.date} · {char?.name || '—'} · {days >= 0 ? `${days} 天后` : `${Math.abs(days)} 天前`}</div>
                                                </div>
                                            </div>
                                            <button onClick={() => handleDeleteAnni(a.id)} className={`p-2 opacity-0 group-hover:opacity-100 transition-opacity ${theme.textSub} hover:text-rose-500`} aria-label="删除">
                                                <XCircle size={16} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* 新建任务 Modal */}
            <Modal
                isOpen={showTaskModal}
                title={currentThemeMode === 'cyber' ? "INITIALIZE QUEST" : "新建契约"}
                onClose={() => setShowTaskModal(false)}
                footerClassName="pt-2"
                footer={<button onClick={handleAddTask} className={`w-full py-3 transition-all ${theme.buttonPrimary}`}>保存契约</button>}
            >
                <div className="space-y-5">
                    {/* 标题 */}
                    <div>
                        <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>契约标题</label>
                        <input autoFocus value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="例如：每天背 30 个单词" className={`w-full px-4 py-3 text-sm focus:outline-none ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] text-slate-700 rounded-xl shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-pink-50 text-slate-700 border border-pink-100 rounded-xl' : 'bg-slate-800 text-white rounded-xl border-none'}`} />
                    </div>

                    {/* 类型 */}
                    <div>
                        <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>类型</label>
                        <div className="flex gap-2">
                            <button onClick={() => setForm({ ...form, type: 'recurring' })} className={`flex-1 py-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${form.type === 'recurring' ? (currentThemeMode === 'minimal' ? 'shadow-[inset_3px_3px_8px_#d1d9e6,inset_-3px_-3px_8px_#ffffff] text-indigo-600' : currentThemeMode === 'soft' ? 'bg-pink-400 text-white shadow-md' : 'bg-cyan-500 text-slate-950') : theme.buttonGhost}`}>
                                <TimerIcon size={14} weight="fill" /> 重复契约
                            </button>
                            <button onClick={() => setForm({ ...form, type: 'oneshot' })} className={`flex-1 py-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${form.type === 'oneshot' ? (currentThemeMode === 'minimal' ? 'shadow-[inset_3px_3px_8px_#d1d9e6,inset_-3px_-3px_8px_#ffffff] text-indigo-600' : currentThemeMode === 'soft' ? 'bg-pink-400 text-white shadow-md' : 'bg-cyan-500 text-slate-950') : theme.buttonGhost}`}>
                                <TargetIcon /> 一次性
                            </button>
                        </div>
                    </div>

                    {/* 重复任务配置 */}
                    {form.type === 'recurring' && (
                        <div className="space-y-3">
                            <div>
                                <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>频率</label>
                                <div className="flex gap-2">
                                    {(['daily', 'weekly', 'monthly'] as const).map(f => (
                                        <button key={f} onClick={() => setForm({ ...form, frequency: f })} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${form.frequency === f ? (currentThemeMode === 'minimal' ? 'shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff] text-indigo-600' : currentThemeMode === 'soft' ? 'bg-pink-100 text-pink-600' : 'bg-cyan-900/40 text-cyan-400') : theme.textSub}`}>
                                            {f === 'daily' ? '每天' : f === 'weekly' ? '每周' : '每月'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {form.frequency === 'weekly' && (
                                <div>
                                    <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>每周哪几天</label>
                                    <div className="flex gap-1.5 mb-2">
                                        <button onClick={() => setForm({ ...form, customDays: [1, 2, 3, 4, 5] })} className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${theme.buttonGhost}`}>工作日</button>
                                        <button onClick={() => setForm({ ...form, customDays: [0, 6] })} className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${theme.buttonGhost}`}>周末</button>
                                        <button onClick={() => setForm({ ...form, customDays: [0, 1, 2, 3, 4, 5, 6] })} className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${theme.buttonGhost}`}>全选</button>
                                    </div>
                                    <div className="flex gap-1.5">
                                        {[['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 0]].map(([label, dow]) => {
                                            const active = form.customDays.includes(dow as number);
                                            return (
                                                <button key={dow} onClick={() => setForm({ ...form, customDays: active ? form.customDays.filter(d => d !== dow) : [...form.customDays, dow as number].sort() })} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${active ? (currentThemeMode === 'minimal' ? 'shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff] text-indigo-600' : currentThemeMode === 'soft' ? 'bg-pink-400 text-white' : 'bg-cyan-500 text-slate-950') : theme.buttonGhost}`}>
                                                    {label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {form.frequency === 'monthly' && (
                                <div>
                                    <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>每月几号</label>
                                    <div className={`flex items-center gap-2 px-3 py-2.5 rounded-xl ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-pink-50 border border-pink-100' : 'bg-slate-800'}`}>
                                        <span className={`text-xs ${theme.textSub}`}>每月</span>
                                        <input type="number" min="1" max="31" value={form.monthlyDay} onChange={e => setForm({ ...form, monthlyDay: Math.max(1, Math.min(31, parseInt(e.target.value) || 1)) })} className={`flex-1 bg-transparent text-sm focus:outline-none ${theme.text} w-full`} />
                                        <span className={`text-xs ${theme.textSub}`}>号（1-31，大月没 31 号的月份自动跳过）</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* 一次性任务配置 */}
                    {form.type === 'oneshot' && (
                        <div>
                            <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>截止时间</label>
                            <input type="datetime-local" value={form.deadline} onChange={e => setForm({ ...form, deadline: e.target.value })} className={`w-full px-4 py-3 text-sm focus:outline-none ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] text-slate-700 rounded-xl shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-pink-50 text-slate-700 border border-pink-100 rounded-xl' : 'bg-slate-800 text-white rounded-xl border-none'}`} />
                        </div>
                    )}

                    {/* 监督人 */}
                    <div>
                        <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>监督人</label>
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups} value={supervisorGroupId} onChange={setSupervisorGroupId} className="mb-2" />
                        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
                            {filterCharactersByGroup(characters, characterGroups, supervisorGroupId).map(c => (
                                <button key={c.id} onClick={() => setForm({ ...form, supervisorId: c.id })} className={`flex flex-col items-center gap-2 p-2 rounded-lg border transition-all min-w-[60px] ${(form.supervisorId || activeCharacterId) === c.id ? (currentThemeMode === 'minimal' ? 'shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff] border-indigo-200' : currentThemeMode === 'cyber' ? 'border-cyan-500 bg-cyan-50' : 'border-current') : (currentThemeMode === 'cyber' ? 'border-slate-200 bg-white' : 'border-transparent opacity-50')}`}>
                                    <img src={c.avatar} className="w-10 h-10 rounded-md object-cover" alt="" />
                                    <span className={`text-[10px] font-bold whitespace-nowrap ${currentThemeMode === 'cyber' ? 'text-slate-700' : theme.text}`}>{c.name}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 提醒 */}
                    <div className={`p-3 rounded-xl ${currentThemeMode === 'minimal' ? 'shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-pink-50/60' : 'bg-slate-800/60'}`}>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Bell size={16} className={theme.accent} weight="fill" />
                                <span className={`text-sm font-bold ${theme.text}`}>到点提醒</span>
                            </div>
                            <button onClick={() => setForm({ ...form, reminderEnabled: !form.reminderEnabled })} className={`relative w-10 h-6 rounded-full transition-colors ${form.reminderEnabled ? (currentThemeMode === 'soft' ? 'bg-pink-400' : currentThemeMode === 'minimal' ? 'bg-indigo-400' : 'bg-cyan-500') : 'bg-slate-400/40'}`}>
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${form.reminderEnabled ? 'translate-x-4' : ''}`} />
                            </button>
                        </div>
                        {form.reminderEnabled && (
                            <div className="mt-3 flex items-center gap-2">
                                <Clock size={14} className={theme.textSub} />
                                <input type="time" value={form.reminderTime} onChange={e => setForm({ ...form, reminderTime: e.target.value })} className={`px-3 py-1.5 text-sm rounded-lg focus:outline-none ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-white border border-pink-100' : 'bg-slate-900 border border-slate-700'}`} />
                                <span className={`text-[10px] ${theme.textSub}`}>到点监督角色会主动找你</span>
                            </div>
                        )}
                    </div>

                    {/* 奖惩 */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>完成奖励</label>
                            <div className={`flex items-center gap-2 px-3 py-2.5 rounded-xl ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-pink-50 border border-pink-100' : 'bg-slate-800'}`}>
                                <Coins size={16} className={theme.coinColor} weight="fill" />
                                <span className={theme.textSub}>+</span>
                                <input type="number" min="0" value={form.rewardCoins} onChange={e => setForm({ ...form, rewardCoins: parseInt(e.target.value) || 0 })} className={`flex-1 bg-transparent text-sm focus:outline-none ${theme.text} w-full`} />
                            </div>
                        </div>
                        <div>
                            <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>漏做惩罚</label>
                            <div className={`flex items-center gap-2 px-3 py-2.5 rounded-xl ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-pink-50 border border-pink-100' : 'bg-slate-800'}`}>
                                <Coins size={16} className={theme.iconMissed} weight="fill" />
                                <span className={theme.textSub}>-</span>
                                <input type="number" min="0" value={form.penaltyCoins} onChange={e => setForm({ ...form, penaltyCoins: parseInt(e.target.value) || 0 })} className={`flex-1 bg-transparent text-sm focus:outline-none ${theme.text} w-full`} />
                            </div>
                        </div>
                    </div>
                    <div className={`text-[10px] ${theme.textMuted} leading-relaxed`}>连续漏做惩罚会翻倍（最多 3 倍）。流通币走存钱罐自动加减。</div>
                </div>
            </Modal>

            {/* 任务详情 Modal */}
            <Modal
                isOpen={!!detailTask}
                title="契约详情"
                onClose={() => setDetailTaskId(null)}
            >
                {detailTask && (
                    <TaskDetail
                        task={detailTask}
                        theme={theme}
                        themeMode={currentThemeMode}
                        supervisor={characters.find(c => c.id === detailTask.supervisorId)}
                        now={now}
                        onSkip={() => { handleSkip(detailTask); setDetailTaskId(null); }}
                        onArchive={() => { handleArchive(detailTask); setDetailTaskId(null); }}
                        onUpdate={(patch) => handleUpdateTask(detailTask.id, patch)}
                    />
                )}
            </Modal>

            {/* 纪念日 Modal */}
            <Modal
                isOpen={showAnniModal}
                title={currentThemeMode === 'cyber' ? "REGISTER EVENT" : "添加纪念日"}
                onClose={() => setShowAnniModal(false)}
                footer={<button onClick={handleAddAnni} className={`w-full py-3 transition-all ${theme.buttonPrimary}`}>保存</button>}
            >
                <div className="space-y-4">
                    <input value={newAnniTitle} onChange={e => setNewAnniTitle(e.target.value)} placeholder="事件名称 (例如: 第一次见面)" className={`w-full px-4 py-3 text-sm focus:outline-none ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] text-slate-700 rounded-xl shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-pink-50 text-slate-700 border border-pink-100 rounded-xl' : 'bg-slate-800 text-white rounded-xl border-none'}`} />
                    <input type="date" value={newAnniDate} onChange={e => setNewAnniDate(e.target.value)} className={`w-full px-4 py-3 text-sm focus:outline-none ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] text-slate-700 rounded-xl shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : currentThemeMode === 'soft' ? 'bg-pink-50 text-slate-700 border border-pink-100 rounded-xl' : 'bg-slate-800 text-white rounded-xl border-none'}`} />
                    <div>
                        <label className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} block mb-2`}>关联对象</label>
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups} value={anniCharGroupId} onChange={setAnniCharGroupId} className="mb-2" />
                        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
                            {filterCharactersByGroup(characters, characterGroups, anniCharGroupId).map(c => (
                                <button key={c.id} onClick={() => setNewAnniChar(c.id)} className={`flex flex-col items-center gap-2 p-2 rounded-lg border transition-all min-w-[60px] ${(newAnniChar || activeCharacterId) === c.id ? (currentThemeMode === 'minimal' ? 'shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff] border-indigo-200' : currentThemeMode === 'cyber' ? 'border-cyan-500 bg-cyan-50' : 'border-current') : (currentThemeMode === 'cyber' ? 'border-slate-200 bg-white' : 'border-transparent opacity-50')}`}>
                                    <img src={c.avatar} className="w-10 h-10 rounded-md object-cover" alt="" />
                                    <span className={`text-[10px] font-bold whitespace-nowrap ${currentThemeMode === 'cyber' ? 'text-slate-700' : theme.text}`}>{c.name}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </Modal>
        </div>
    );
};

// --- 内联图标：Target（Phosphor 没有合适的，自己画一个） ---
const TargetIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
);

// --- 任务卡 ---
const TaskCard: React.FC<{
    task: TaskV2;
    theme: typeof THEMES[ThemeMode];
    themeMode: ThemeMode;
    supervisor?: CharacterProfile;
    isProcessing: boolean;
    now: Date;
    onCheckin: () => void;
    onSkip: () => void;
    onArchive: () => void;
    onDetail: () => void;
}> = ({ task, theme, themeMode, supervisor, isProcessing, now, onCheckin, onSkip, onArchive, onDetail }) => {
    const todayStr = toLocalDateStr(now);
    const todayEntry = task.history.find(h => h.date === todayStr);
    const isDoneToday = todayEntry?.status === 'done';
    const isSkippedToday = todayEntry?.status === 'skipped';

    const streak = task.type === 'recurring' ? computeCurrentStreak(task, now) : 0;
    const weekDone = task.type === 'recurring' ? computeThisWeekDoneCount(task, now) : 0;
    const weekTarget = task.type === 'recurring'
        ? (task.frequency === 'weekly' ? (task.customDays?.length || 7)
            : task.frequency === 'custom' ? (task.customDays?.length || 0)
            : task.frequency === 'monthly' ? 1
            : (task.targetCount || 7))
        : 0;

    // 进度条：recurring 显示本周进度；oneshot 显示距离 deadline 还剩几天
    const progress = task.type === 'recurring' && weekTarget > 0
        ? Math.min(100, (weekDone / weekTarget) * 100)
        : task.type === 'oneshot' && task.deadline
            ? 50  // 一次性任务进度条用占位（实际显示倒计时天数）
            : 0;

    // 元信息行
    let metaLine = '';
    if (task.type === 'recurring') {
        if (task.frequency === 'daily') metaLine = '每天';
        else if (task.frequency === 'weekly') {
            const names = ['日', '一', '二', '三', '四', '五', '六'];
            metaLine = task.customDays?.length
                ? '周' + task.customDays.map(d => names[d]).join('·')
                : `每周目标 ${task.targetCount || 7} 次`;
        }
        else if (task.frequency === 'monthly') metaLine = `每月 ${task.monthlyDay || 1} 号`;
        else if (task.frequency === 'custom') {
            const names = ['日', '一', '二', '三', '四', '五', '六'];
            metaLine = '周' + (task.customDays || []).map(d => names[d]).join('·');
        }
        if (task.reminderEnabled && task.reminderTime) metaLine += ` · 提醒 ${task.reminderTime}`;
    } else {
        if (task.deadline) {
            const dl = new Date(task.deadline);
            const diffMs = dl.getTime() - now.getTime();
            const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            metaLine = diffDays > 0 ? `还剩 ${diffDays} 天` : diffDays === 0 ? '今天截止' : `已超期 ${Math.abs(diffDays)} 天`;
        }
    }

    const statusText = isDoneToday ? '今日已完成' : isSkippedToday ? '今日请假' : (task.type === 'recurring' ? '今日未打卡' : '未开始');

    return (
        <div className={`${theme.card} p-4 transition-all`}>
            <div className="flex items-start gap-3">
                {/* 头像 */}
                <div className="relative shrink-0">
                    {supervisor ? <img src={supervisor.avatar} className="w-12 h-12 rounded-xl object-cover" alt="" /> : <div className="w-12 h-12 rounded-xl bg-slate-300" />}
                </div>

                {/* 主体 */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className={`text-sm font-bold ${theme.text} truncate`}>{task.title}</div>
                            <div className={`text-[10px] ${theme.textSub} mt-0.5`}>
                                {supervisor?.name || '未指定'} 监督 · {metaLine}
                            </div>
                        </div>
                        <button onClick={onDetail} className={`p-1.5 rounded-lg ${theme.textSub} hover:bg-black/5`} aria-label="详情">
                            <DotsThree size={18} weight="bold" />
                        </button>
                    </div>

                    {/* 进度条 + 状态 */}
                    {task.type === 'recurring' && (
                        <div className="mt-2.5">
                            <div className="flex items-center justify-between mb-1">
                                <span className={`text-[10px] ${theme.textSub}`}>{weekDone} / {weekTarget} 本周</span>
                                <span className={`text-[10px] font-bold ${isDoneToday ? theme.iconDone : isSkippedToday ? theme.iconSkipped : theme.textSub}`}>{statusText}</span>
                            </div>
                            <div className={`h-1.5 ${theme.progressTrack} rounded-full overflow-hidden`}>
                                <div className={`h-full ${theme.progressFill} transition-all duration-500`} style={{ width: `${progress}%` }} />
                            </div>
                        </div>
                    )}
                    {task.type === 'oneshot' && (
                        <div className="mt-2.5 flex items-center gap-2">
                            {task.deadline && new Date(task.deadline) < now ? (
                                <Warning size={14} className={theme.iconMissed} weight="fill" />
                            ) : (
                                <Clock size={14} className={theme.textSub} />
                            )}
                            <span className={`text-[10px] ${task.deadline && new Date(task.deadline) < now ? theme.iconMissed : theme.textSub} font-bold`}>{statusText} · {metaLine}</span>
                        </div>
                    )}

                    {/* 信息行 */}
                    <div className="flex items-center gap-3 mt-2 text-[10px]">
                        {task.type === 'recurring' && (
                            <div className={`flex items-center gap-1 ${theme.streakColor}`}>
                                <Fire size={12} weight="fill" />
                                <span className="font-bold">{streak}</span>
                                <span className={theme.textSub}>连胜</span>
                            </div>
                        )}
                        <div className={`flex items-center gap-1 ${theme.coinColor}`}>
                            <Coins size={12} weight="fill" />
                            <span className="font-bold">+{task.rewardCoins}</span>
                        </div>
                        <div className={`flex items-center gap-1 ${theme.iconMissed}`}>
                            <Coins size={12} weight="fill" />
                            <span className="font-bold">-{task.penaltyCoins}</span>
                        </div>
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex gap-2 mt-3">
                        <button
                            onClick={onCheckin}
                            disabled={isDoneToday || isProcessing}
                            className={`flex-1 py-2.5 text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${isDoneToday ? theme.buttonGhost + ' opacity-50' : theme.buttonPrimary}`}
                        >
                            {isProcessing ? (
                                <span className="animate-pulse">处理中…</span>
                            ) : isDoneToday ? (
                                <><CheckCircle size={14} weight="fill" /> 已完成</>
                            ) : (
                                <><CheckCircle size={14} weight="bold" /> {task.type === 'recurring' ? '打卡' : '完成'}</>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- 已归档任务行 ---
const ArchivedTaskRow: React.FC<{
    task: TaskV2;
    theme: typeof THEMES[ThemeMode];
    themeMode: ThemeMode;
    supervisor?: CharacterProfile;
    onDetail: () => void;
    onDelete: () => void;
}> = ({ task, theme, themeMode, supervisor, onDetail, onDelete }) => {
    const bestStreak = computeBestStreak(task);
    return (
        <div className={`${theme.card} p-3 flex items-center gap-3`}>
            <button onClick={onDetail} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                {task.archiveReason === 'completed' ? (
                    <CheckCircle size={16} className={theme.iconDone} weight="fill" />
                ) : task.archiveReason === 'expired' ? (
                    <XCircle size={16} className={theme.iconMissed} weight="fill" />
                ) : (
                    <ArchiveIcon size={16} className={theme.textSub} />
                )}
                <div className="min-w-0">
                    <div className={`text-xs font-bold truncate ${theme.text}`}>{task.title}</div>
                    <div className={`text-[10px] ${theme.textSub}`}>
                        {supervisor?.name || '—'}
                        {task.type === 'recurring' && bestStreak > 0 && ` · 最佳连胜 ${bestStreak} 天`}
                        {task.archiveReason === 'completed' && ' · 已完成'}
                        {task.archiveReason === 'expired' && ' · 超期失效'}
                        {task.archiveReason === 'manual' && ' · 手动归档'}
                    </div>
                </div>
            </button>
            <button onClick={onDelete} className={`p-1.5 ${theme.textSub} hover:text-rose-500`} aria-label="删除">
                <XCircle size={14} />
            </button>
        </div>
    );
};

// --- 任务详情 ---
const TaskDetail: React.FC<{
    task: TaskV2;
    theme: typeof THEMES[ThemeMode];
    themeMode: ThemeMode;
    supervisor?: CharacterProfile;
    now: Date;
    onSkip: () => void;
    onArchive: () => void;
    onUpdate: (patch: Partial<TaskV2>) => void;
}> = ({ task, theme, themeMode, supervisor, now, onSkip, onArchive, onUpdate }) => {
    const streak = computeCurrentStreak(task, now);
    const best = computeBestStreak(task);
    const recent30 = useMemo(() => {
        // 显示最近 30 天的日历热力图
        const days: { date: string; status?: string }[] = [];
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        for (let i = 29; i >= 0; i--) {
            const d = addDays(today, -i);
            const ds = toLocalDateStr(d);
            const entry = task.history.find(h => h.date === ds);
            days.push({ date: ds, status: entry?.status });
        }
        return days;
    }, [task, now]);

    const recentSettlements = useMemo(() => {
        return [...task.history].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    }, [task]);

    // 行内编辑截止时间 / 提醒开关 + 提醒时间
    const [editingDeadline, setEditingDeadline] = useState(false);
    const [draftDeadline, setDraftDeadline] = useState(task.deadline || '');
    const [editingReminder, setEditingReminder] = useState(false);
    const [draftReminderEnabled, setDraftReminderEnabled] = useState(task.reminderEnabled);
    const [draftReminderTime, setDraftReminderTime] = useState(task.reminderTime || '20:00');

    // 频率展示行
    const freqLine = task.type === 'recurring'
        ? (task.frequency === 'daily' ? '每天'
            : task.frequency === 'weekly' ? (task.customDays?.length ? '周' + task.customDays.map(d => '日一二三四五六'[d]).join('·') : `每周目标 ${task.targetCount || 7} 次`)
            : task.frequency === 'monthly' ? `每月 ${task.monthlyDay || 1} 号`
            : task.customDays?.length ? '周' + task.customDays.map(d => '日一二三四五六'[d]).join('·') : '自定义')
        : '';

    return (
        <div className="space-y-5">
            {/* 头部 */}
            <div>
                <div className={`text-base font-bold ${theme.text}`}>{task.title}</div>
                <div className={`text-[10px] ${theme.textSub} mt-1`}>
                    {supervisor?.name || '—'} 监督 · 创建于 {new Date(task.createdAt).toLocaleDateString()}
                </div>
            </div>

            {/* 频率 + 截止时间 + 提醒时间（行内可编辑） */}
            <div className={`space-y-3 p-3 rounded-xl ${themeMode === 'minimal' ? 'shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : themeMode === 'soft' ? 'bg-pink-50/60' : 'bg-slate-800/60'}`}>
                {/* 频率 */}
                {task.type === 'recurring' && (
                    <div className="flex items-center justify-between">
                        <span className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>频率</span>
                        <span className={`text-xs ${theme.text}`}>{freqLine}</span>
                    </div>
                )}

                {/* 截止时间（oneshot 可编辑） */}
                {task.type === 'oneshot' && (
                    <div>
                        <div className="flex items-center justify-between">
                            <span className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>截止时间</span>
                            {!editingDeadline ? (
                                <button onClick={() => { setDraftDeadline(task.deadline || ''); setEditingDeadline(true); }} className={`text-xs ${theme.text} underline`}>
                                    {task.deadline ? new Date(task.deadline).toLocaleString() : '未设置 · 点此修改'}
                                </button>
                            ) : (
                                <div className="flex items-center gap-2">
                                    <input type="datetime-local" value={draftDeadline} onChange={e => setDraftDeadline(e.target.value)} className={`px-2 py-1 text-xs rounded-lg focus:outline-none ${themeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : themeMode === 'soft' ? 'bg-white border border-pink-100' : 'bg-slate-900 border border-slate-700'}`} />
                                    <button onClick={() => { onUpdate({ deadline: draftDeadline || undefined }); setEditingDeadline(false); }} className={`px-2 py-1 text-[10px] font-bold rounded-md ${theme.buttonPrimary}`}>保存</button>
                                    <button onClick={() => setEditingDeadline(false)} className={`px-2 py-1 text-[10px] font-bold rounded-md ${theme.buttonGhost}`}>取消</button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* 提醒（可编辑） */}
                <div>
                    {!editingReminder ? (
                        <div className="flex items-center justify-between">
                            <span className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>到点提醒</span>
                            <button onClick={() => { setDraftReminderEnabled(task.reminderEnabled); setDraftReminderTime(task.reminderTime || '20:00'); setEditingReminder(true); }} className={`text-xs ${theme.text} underline`}>
                                {task.reminderEnabled ? `每天 ${task.reminderTime}` : '关闭 · 点此修改'}
                            </button>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <span className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>到点提醒</span>
                                <button onClick={() => setDraftReminderEnabled(!draftReminderEnabled)} className={`relative w-10 h-6 rounded-full transition-colors ${draftReminderEnabled ? (themeMode === 'soft' ? 'bg-pink-400' : themeMode === 'minimal' ? 'bg-indigo-400' : 'bg-cyan-500') : 'bg-slate-400/40'}`}>
                                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${draftReminderEnabled ? 'translate-x-4' : ''}`} />
                                </button>
                            </div>
                            {draftReminderEnabled && (
                                <div className="flex items-center gap-2">
                                    <input type="time" value={draftReminderTime} onChange={e => setDraftReminderTime(e.target.value)} className={`px-2 py-1 text-xs rounded-lg focus:outline-none ${themeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : themeMode === 'soft' ? 'bg-white border border-pink-100' : 'bg-slate-900 border border-slate-700'}`} />
                                    <button onClick={() => { onUpdate({ reminderEnabled: draftReminderEnabled, reminderTime: draftReminderEnabled ? draftReminderTime : undefined }); setEditingReminder(false); }} className={`px-2 py-1 text-[10px] font-bold rounded-md ${theme.buttonPrimary}`}>保存</button>
                                    <button onClick={() => setEditingReminder(false)} className={`px-2 py-1 text-[10px] font-bold rounded-md ${theme.buttonGhost}`}>取消</button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* 奖惩（只读展示） */}
                <div className="flex items-center justify-between">
                    <span className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub}`}>奖惩</span>
                    <span className={`text-xs ${theme.text}`}>完成 +{task.rewardCoins} · 漏做 -{task.penaltyCoins}</span>
                </div>
            </div>

            {/* 连胜 */}
            {task.type === 'recurring' && (
                <div className={`flex items-center justify-around p-4 rounded-xl ${themeMode === 'minimal' ? 'shadow-[inset_3px_3px_8px_#d1d9e6,inset_-3px_-3px_8px_#ffffff]' : themeMode === 'soft' ? 'bg-pink-50/60' : 'bg-slate-800/60'}`}>
                    <div className="text-center">
                        <div className={`flex items-center gap-1 justify-center ${theme.streakColor}`}>
                            <Fire size={18} weight="fill" />
                            <span className="text-2xl font-bold">{streak}</span>
                        </div>
                        <div className={`text-[10px] ${theme.textSub} mt-1`}>当前连胜</div>
                    </div>
                    <div className={`w-px h-10 ${themeMode === 'minimal' ? 'bg-slate-200' : 'bg-slate-700'}`} />
                    <div className="text-center">
                        <div className={`flex items-center gap-1 justify-center ${theme.streakColor}`}>
                            <Trophy size={18} weight="fill" />
                            <span className="text-2xl font-bold">{best}</span>
                        </div>
                        <div className={`text-[10px] ${theme.textSub} mt-1`}>最佳连胜</div>
                    </div>
                </div>
            )}

            {/* 30 天热力图 */}
            <div>
                <div className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} mb-2`}>最近 30 天</div>
                <div className="grid grid-cols-10 gap-1">
                    {recent30.map(d => {
                        const isDone = d.status === 'done';
                        const isMissed = d.status === 'missed';
                        const isSkipped = d.status === 'skipped';
                        return (
                            <div
                                key={d.date}
                                title={`${d.date} · ${isDone ? '完成' : isMissed ? '漏做' : isSkipped ? '请假' : '未记录'}`}
                                className={`aspect-square rounded-sm ${isDone ? (themeMode === 'cyber' ? 'bg-cyan-500' : themeMode === 'soft' ? 'bg-pink-400' : 'bg-indigo-500') : isMissed ? (themeMode === 'cyber' ? 'bg-rose-500/60' : themeMode === 'soft' ? 'bg-rose-300' : 'bg-rose-300') : isSkipped ? (themeMode === 'cyber' ? 'bg-slate-600' : themeMode === 'soft' ? 'bg-slate-200' : 'bg-slate-300') : (themeMode === 'cyber' ? 'bg-slate-800' : themeMode === 'soft' ? 'bg-pink-50' : 'bg-[#e2e8f0]')}`}
                            />
                        );
                    })}
                </div>
                <div className={`flex gap-3 mt-2 text-[10px] ${theme.textSub}`}>
                    <span className="flex items-center gap-1"><span className={`w-2 h-2 rounded-sm ${themeMode === 'cyber' ? 'bg-cyan-500' : themeMode === 'soft' ? 'bg-pink-400' : 'bg-indigo-500'}`} /> 完成</span>
                    <span className="flex items-center gap-1"><span className={`w-2 h-2 rounded-sm ${themeMode === 'cyber' ? 'bg-rose-500/60' : 'bg-rose-300'}`} /> 漏做</span>
                    <span className="flex items-center gap-1"><span className={`w-2 h-2 rounded-sm ${themeMode === 'cyber' ? 'bg-slate-600' : 'bg-slate-300'}`} /> 请假</span>
                </div>
            </div>

            {/* 结算记录 */}
            <div>
                <div className={`text-[10px] font-bold uppercase tracking-widest ${theme.textSub} mb-2`}>结算记录</div>
                <div className="space-y-2 max-h-48 overflow-y-auto no-scrollbar">
                    {recentSettlements.length === 0 && <div className={`text-xs ${theme.textSub} py-2`}>还没有记录</div>}
                    {recentSettlements.map(h => (
                        <div key={h.date} className={`flex items-center gap-2 py-1.5 px-2 rounded-lg ${themeMode === 'minimal' ? '' : 'bg-black/5'}`}>
                            {h.status === 'done' ? <CheckCircle size={14} className={theme.iconDone} weight="fill" /> :
                             h.status === 'missed' ? <XCircle size={14} className={theme.iconMissed} weight="fill" /> :
                             <SkipForward size={14} className={theme.iconSkipped} weight="fill" />}
                            <span className={`text-[10px] ${theme.textSub} font-mono`}>{h.date}</span>
                            <span className={`text-[10px] font-bold ${h.status === 'done' ? theme.coinColor : h.status === 'missed' ? theme.iconMissed : theme.textSub}`}>
                                {h.status === 'done' ? `+${task.rewardCoins}` : h.status === 'missed' ? `-${task.penaltyCoins}` : '0'}
                            </span>
                            {h.reaction && (
                                <span className={`text-[10px] ${theme.text} truncate flex-1`}>"{h.reaction}"</span>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* 操作 */}
            {!task.archived && (
                <div className="flex gap-2 pt-2">
                    <button onClick={onSkip} className={`flex-1 py-2.5 text-xs font-bold ${theme.buttonGhost} flex items-center justify-center gap-1.5`}>
                        <SkipForward size={14} weight="bold" /> 请假今天
                    </button>
                    <button onClick={onArchive} className={`flex-1 py-2.5 text-xs font-bold ${theme.buttonDanger} flex items-center justify-center gap-1.5`}>
                        <ArchiveIcon size={14} weight="bold" /> 归档契约
                    </button>
                </div>
            )}
        </div>
    );
};

export default ScheduleApp;
