import React, { useState } from 'react';
import { Message } from '../../types';
import { TaskProposalMeta } from '../../utils/chatParser';

/**
 * 时光契约提议卡片 —— 渲染 chatParser 解析 [[TASK_PROPOSE: 标题 | 频率 | HH:mm]] 落库的
 * task_proposal 消息。用户可在卡片上微调字段（标题 / 频率 / 提醒时间 / 奖惩），
 * 点「建立契约」回调父组件去调 createTask 落库；点「先不要」则 dismiss。
 *
 * 视觉上读 localStorage 'schedule_app_theme' 与 ScheduleApp 保持同款主题
 * （cyber / soft / minimal），让"任务"在聊天里出现时跟在 App 里看到的是同一套皮。
 *
 * 已确认 / 已驳回后卡片转为终态展示，不再可编辑（对齐 LifeRecordCard 的 reviewStatus 行为）。
 */

type ThemeMode = 'cyber' | 'soft' | 'minimal';

interface ThemeTokens {
    container: string;
    headerBar: string;
    headerText: string;
    headerSub: string;
    body: string;
    label: string;
    value: string;
    input: string;
    divider: string;
    pill: string;
    primaryBtn: string;
    ghostBtn: string;
    tag: string;
    footer: string;
    footerText: string;
}

const THEMES: Record<ThemeMode, ThemeTokens> = {
    cyber: {
        container: 'w-[280px] rounded-2xl overflow-hidden border border-slate-700/60 shadow-lg shadow-cyan-500/5 bg-slate-900/80 backdrop-blur-md',
        headerBar: 'bg-gradient-to-r from-cyan-600/30 to-cyan-500/10 border-b border-cyan-500/20',
        headerText: 'text-cyan-300 font-mono font-bold tracking-wider text-[11px] uppercase',
        headerSub: 'text-slate-500 font-mono text-[9px]',
        body: 'p-3 space-y-2.5',
        label: 'text-slate-400 font-mono text-[9px] uppercase tracking-wider',
        value: 'text-slate-100 font-mono text-[12px]',
        input: 'bg-slate-800/60 border border-slate-700/60 rounded-lg px-2 py-1.5 text-[12px] text-slate-100 font-mono focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30 transition',
        divider: 'border-slate-800',
        pill: 'bg-slate-800/70 border border-slate-700/60 rounded-lg',
        primaryBtn: 'flex-1 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono font-bold text-[11px] tracking-wider transition active:scale-95',
        ghostBtn: 'flex-1 py-2 rounded-lg bg-slate-800/60 hover:bg-slate-700/60 text-slate-400 font-mono font-medium text-[11px] border border-slate-700/50 transition active:scale-95',
        tag: 'text-[9px] px-1.5 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono',
        footer: 'bg-slate-950/60 border-t border-slate-800 px-3 py-1.5',
        footerText: 'text-slate-600 font-mono text-[9px] tracking-wider',
    },
    soft: {
        container: 'w-[280px] rounded-[1.5rem] overflow-hidden border border-white shadow-md shadow-pink-100/40 bg-white/90 backdrop-blur-xl',
        headerBar: 'bg-gradient-to-r from-pink-100 to-rose-50 border-b border-pink-100',
        headerText: 'text-pink-500 font-bold text-[12px]',
        headerSub: 'text-slate-400 text-[10px]',
        body: 'p-3.5 space-y-3',
        label: 'text-slate-400 text-[10px] font-medium',
        value: 'text-slate-700 text-[12px] font-medium',
        input: 'bg-pink-50/40 border border-pink-100 rounded-xl px-2.5 py-1.5 text-[12px] text-slate-700 focus:outline-none focus:border-pink-300 focus:ring-2 focus:ring-pink-100 transition',
        divider: 'border-pink-100',
        pill: 'bg-pink-50/60 border border-pink-100 rounded-xl',
        primaryBtn: 'flex-1 py-2 rounded-2xl bg-pink-400 hover:bg-pink-500 text-white font-bold text-[12px] shadow-sm shadow-pink-200/50 transition active:scale-95',
        ghostBtn: 'flex-1 py-2 rounded-2xl bg-white/70 hover:bg-white text-slate-500 font-medium text-[12px] border border-pink-100 transition active:scale-95',
        tag: 'text-[9px] px-1.5 py-0.5 rounded-full bg-pink-100 text-pink-600 font-medium',
        footer: 'bg-pink-50/40 border-t border-pink-100 px-3.5 py-1.5',
        footerText: 'text-slate-400 text-[9px]',
    },
    minimal: {
        container: 'w-[280px] rounded-2xl overflow-hidden border border-transparent bg-[#eef2f6] shadow-[6px_6px_12px_#d1d9e6,-6px_-6px_12px_#ffffff]',
        headerBar: 'border-b border-slate-200/60',
        headerText: 'text-indigo-500 font-bold text-[12px]',
        headerSub: 'text-slate-400 text-[10px]',
        body: 'p-3.5 space-y-3',
        label: 'text-slate-400 text-[10px] font-medium',
        value: 'text-slate-700 text-[12px] font-medium',
        input: 'bg-[#eef2f6] border border-slate-200/60 rounded-xl px-2.5 py-1.5 text-[12px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200/60 transition shadow-[inset_2px_2px_4px_#d1d9e6,inset_-2px_-2px_4px_#ffffff]',
        divider: 'border-slate-200/60',
        pill: 'bg-[#eef2f6] border border-slate-200/40 rounded-xl shadow-[inset_2px_2px_4px_#d1d9e6,inset_-2px_-2px_4px_#ffffff]',
        primaryBtn: 'flex-1 py-2 rounded-xl bg-[#eef2f6] text-indigo-600 font-bold text-[12px] shadow-[4px_4px_10px_#d1d9e6,-4px_-4px_10px_#ffffff] active:shadow-[inset_3px_3px_8px_#d1d9e6,inset_-3px_-3px_8px_#ffffff] transition',
        ghostBtn: 'flex-1 py-2 rounded-xl bg-[#eef2f6] text-slate-500 font-medium text-[12px] shadow-[3px_3px_8px_#d1d9e6,-3px_-3px_8px_#ffffff] active:shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff] transition',
        tag: 'text-[9px] px-1.5 py-0.5 rounded-lg bg-indigo-100/60 text-indigo-600 font-medium',
        footer: 'bg-[#e7ebf0] border-t border-slate-200/60 px-3.5 py-1.5',
        footerText: 'text-slate-400 text-[9px]',
    },
};

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function readThemeMode(): ThemeMode {
    try {
        const saved = localStorage.getItem('schedule_app_theme');
        if (saved === 'cyber' || saved === 'soft' || saved === 'minimal') return saved;
    } catch { /* SSR / 测试环境没 localStorage */ }
    return 'cyber';
}

function describeFrequency(meta: TaskProposalMeta): string {
    if (meta.type === 'oneshot') {
        return meta.deadline ? `一次性 · 截止 ${meta.deadline.replace('T', ' ')}` : '一次性契约';
    }
    if (meta.frequency === 'daily') return '每天';
    if (meta.frequency === 'weekly') return '每周';
    if (meta.frequency === 'custom') {
        const days = (meta.customDays || []).slice().sort();
        if (days.length === 0) return '自定义周期';
        return `每周${days.map(d => WEEKDAY_LABELS[d] || String(d)).join('·')}`;
    }
    return '重复任务';
}

export interface TaskProposalCardProps {
    m: Message;
    charName: string;
    /** 用户点「建立契约」：父组件负责调 createTask + 更新消息 metadata.status=confirmed + reload */
    onConfirm?: (m: Message, editedMeta: TaskProposalMeta) => Promise<void> | void;
    /** 用户点「先不要」：父组件负责更新消息 metadata.status=dismissed */
    onDismiss?: (m: Message) => Promise<void> | void;
    commonLayout: (content: React.ReactNode) => JSX.Element;
    selectionMode: boolean;
}

const TaskProposalCard: React.FC<TaskProposalCardProps> = ({
    m, charName, onConfirm, onDismiss, commonLayout, selectionMode,
}) => {
    const initialMeta = (m.metadata as TaskProposalMeta) || null;
    const theme = THEMES[readThemeMode()];

    // 终态：confirmed / dismissed 直接渲染结果，不可编辑。
    const finalStatus: 'pending' | 'confirmed' | 'dismissed' = initialMeta?.status || 'pending';
    const isFinal = finalStatus !== 'pending';
    const canInteract = !selectionMode && !isFinal && (!!onConfirm || !!onDismiss);

    // 表单字段（仅 pending 时编辑）。一旦终态，只读展示 initialMeta。
    const [draft, setDraft] = useState<TaskProposalMeta>(() => ({
        title: initialMeta?.title || '未命名契约',
        type: initialMeta?.type || 'recurring',
        frequency: initialMeta?.frequency || 'daily',
        customDays: initialMeta?.customDays || [1, 3, 5],
        deadline: initialMeta?.deadline || '',
        reminderEnabled: initialMeta?.reminderEnabled ?? true,
        reminderTime: initialMeta?.reminderTime || '20:00',
        rewardCoins: initialMeta?.rewardCoins ?? 10,
        penaltyCoins: initialMeta?.penaltyCoins ?? 3,
        supervisorId: initialMeta?.supervisorId || '',
        status: 'pending',
    }));
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const update = <K extends keyof TaskProposalMeta>(k: K, v: TaskProposalMeta[K]) => {
        setDraft(d => ({ ...d, [k]: v }));
    };

    const toggleCustomDay = (dow: number) => {
        setDraft(d => {
            const set = new Set(d.customDays || []);
            if (set.has(dow)) set.delete(dow); else set.add(dow);
            return { ...d, customDays: Array.from(set).sort() };
        });
    };

    const handleConfirm = async () => {
        if (!onConfirm || submitting) return;
        // 基本校验
        if (!draft.title.trim()) { setError('标题不能为空'); return; }
        if (draft.type === 'recurring' && draft.frequency === 'custom' && (draft.customDays || []).length === 0) {
            setError('自定义周期至少选一天'); return;
        }
        if (draft.type === 'oneshot' && !draft.deadline) {
            setError('一次性契约需要截止时间'); return;
        }
        if (draft.rewardCoins < 0 || draft.penaltyCoins < 0) {
            setError('奖惩币数不能为负'); return;
        }
        setError(null);
        setSubmitting(true);
        try {
            await onConfirm(m, { ...draft, title: draft.title.trim() });
        } catch (e: any) {
            console.warn('[TaskProposalCard] onConfirm failed:', e);
            setError(e?.message || '建立失败，请重试');
            setSubmitting(false);
        }
        // 成功路径不重置 submitting —— 卡片会被父组件 reload 切到 confirmed 终态。
    };

    const handleDismiss = async () => {
        if (!onDismiss || submitting) return;
        setError(null);
        setSubmitting(true);
        try {
            await onDismiss(m);
        } catch (e: any) {
            console.warn('[TaskProposalCard] onDismiss failed:', e);
            setError(e?.message || '操作失败');
            setSubmitting(false);
        }
    };

    // ── 终态展示 ─────────────────────────────────────────────────────────
    if (isFinal) {
        const isConfirmed = finalStatus === 'confirmed';
        return commonLayout(
            <div className={theme.container}>
                <div className={`${theme.headerBar} px-3.5 pt-3 pb-2.5`}>
                    <div className="flex items-center gap-2">
                        <div className={`shrink-0 w-2 h-2 rounded-full ${isConfirmed ? 'bg-emerald-400' : 'bg-slate-400'}`} />
                        <div className="flex-1 min-w-0">
                            <div className={theme.headerText}>{isConfirmed ? '契约已建立' : '契约已拒绝'}</div>
                            <div className={theme.headerSub}>{charName} 提议</div>
                        </div>
                    </div>
                </div>
                <div className={theme.body}>
                    <div className={`${theme.value} font-bold truncate`}>{initialMeta?.title}</div>
                    <div className="flex flex-wrap gap-1.5">
                        <span className={theme.tag}>{describeFrequency(initialMeta!)}</span>
                        {initialMeta?.reminderEnabled && initialMeta?.reminderTime && (
                            <span className={theme.tag}>提醒 {initialMeta.reminderTime}</span>
                        )}
                        <span className={theme.tag}>+{initialMeta?.rewardCoins ?? 0} / -{initialMeta?.penaltyCoins ?? 0}</span>
                    </div>
                    {!isConfirmed && (
                        <div className={`${theme.label} italic`}>已通知 {charName} 这次先不建立</div>
                    )}
                    {isConfirmed && initialMeta?.taskId && (
                        <div className={`${theme.label} font-mono`}>#{initialMeta.taskId.slice(-6)}</div>
                    )}
                </div>
                <div className={theme.footer}>
                    <div className={theme.footerText}>时光契约</div>
                </div>
            </div>
        );
    }

    // ── pending 编辑态 ────────────────────────────────────────────────────
    return commonLayout(
        <div className={theme.container}>
            <div className={`${theme.headerBar} px-3.5 pt-3 pb-2.5`}>
                <div className="flex items-center gap-2">
                    <div className="shrink-0 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                    <div className="flex-1 min-w-0">
                        <div className={theme.headerText}>新契约提议</div>
                        <div className={theme.headerSub}>{charName} 想监督你完成一件事</div>
                    </div>
                </div>
            </div>

            <div className={theme.body}>
                {/* 标题 */}
                <div className="space-y-1">
                    <label className={theme.label}>标题</label>
                    <input
                        type="text"
                        value={draft.title}
                        onChange={e => update('title', e.target.value)}
                        disabled={!canInteract}
                        className={`${theme.input} w-full disabled:opacity-60`}
                        placeholder="给这件事起个名字"
                        maxLength={40}
                    />
                </div>

                {/* 频率 */}
                <div className="space-y-1.5">
                    <label className={theme.label}>频率</label>
                    {draft.type === 'oneshot' ? (
                        <div className="space-y-1">
                            <div className={`${theme.pill} px-2.5 py-1.5`}>
                                <input
                                    type="datetime-local"
                                    value={draft.deadline || ''}
                                    onChange={e => update('deadline', e.target.value)}
                                    disabled={!canInteract}
                                    className={`${theme.input} w-full border-0 bg-transparent p-0 disabled:opacity-60`}
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => update('type', 'recurring')}
                                disabled={!canInteract}
                                className={`${theme.label} underline-offset-2 hover:underline disabled:opacity-50`}
                            >改为重复任务</button>
                        </div>
                    ) : (
                        <div className="space-y-1.5">
                            <div className="flex gap-1">
                                {(['daily', 'weekly', 'custom'] as const).map(f => (
                                    <button
                                        key={f}
                                        type="button"
                                        onClick={() => update('frequency', f)}
                                        disabled={!canInteract}
                                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition disabled:opacity-60 ${
                                            draft.frequency === f
                                                ? 'bg-slate-700/80 text-white shadow-sm'
                                                : 'bg-slate-100/60 text-slate-500 hover:bg-slate-200/60'
                                        }`}
                                    >
                                        {f === 'daily' ? '每天' : f === 'weekly' ? '每周' : '自定义'}
                                    </button>
                                ))}
                            </div>
                            {draft.frequency === 'custom' && (
                                <div className="flex gap-1 flex-wrap">
                                    {WEEKDAY_LABELS.map((lbl, dow) => {
                                        const active = (draft.customDays || []).includes(dow);
                                        return (
                                            <button
                                                key={dow}
                                                type="button"
                                                onClick={() => toggleCustomDay(dow)}
                                                disabled={!canInteract}
                                                className={`w-7 h-7 rounded-full text-[11px] font-medium transition disabled:opacity-60 ${
                                                    active
                                                        ? 'bg-indigo-500 text-white shadow-sm'
                                                        : 'bg-slate-100/60 text-slate-400 hover:bg-slate-200/60'
                                                }`}
                                            >{lbl}</button>
                                        );
                                    })}
                                </div>
                            )}
                            <button
                                type="button"
                                onClick={() => update('type', 'oneshot')}
                                disabled={!canInteract}
                                className={`${theme.label} underline-offset-2 hover:underline disabled:opacity-50`}
                            >改为一次性任务</button>
                        </div>
                    )}
                </div>

                {/* 提醒时间 */}
                <div className={`flex items-center justify-between pt-1 ${canInteract ? '' : 'opacity-60'}`}>
                    <label className={theme.label}>到点提醒</label>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => update('reminderEnabled', !draft.reminderEnabled)}
                            disabled={!canInteract}
                            className={`relative w-9 h-5 rounded-full transition ${draft.reminderEnabled ? 'bg-emerald-400' : 'bg-slate-300'}`}
                        >
                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.reminderEnabled ? 'translate-x-4' : ''}`} />
                        </button>
                        {draft.reminderEnabled && (
                            <input
                                type="time"
                                value={draft.reminderTime || '20:00'}
                                onChange={e => update('reminderTime', e.target.value)}
                                disabled={!canInteract}
                                className={`${theme.input} w-[88px] py-1`}
                            />
                        )}
                    </div>
                </div>

                <div className={`border-t ${theme.divider}`} />

                {/* 奖惩 */}
                <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                        <label className={theme.label}>完成奖励</label>
                        <div className={`${theme.pill} flex items-center gap-1 px-2 py-1`}>
                            <span className="text-amber-400 text-[12px]">+</span>
                            <input
                                type="number"
                                min={0}
                                max={999}
                                value={draft.rewardCoins}
                                onChange={e => update('rewardCoins', Math.max(0, parseInt(e.target.value || '0', 10)))}
                                disabled={!canInteract}
                                className={`${theme.input} flex-1 w-full border-0 bg-transparent p-0 py-0.5 disabled:opacity-60`}
                            />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <label className={theme.label}>漏做扣</label>
                        <div className={`${theme.pill} flex items-center gap-1 px-2 py-1`}>
                            <span className="text-rose-400 text-[12px]">−</span>
                            <input
                                type="number"
                                min={0}
                                max={999}
                                value={draft.penaltyCoins}
                                onChange={e => update('penaltyCoins', Math.max(0, parseInt(e.target.value || '0', 10)))}
                                disabled={!canInteract}
                                className={`${theme.input} flex-1 w-full border-0 bg-transparent p-0 py-0.5 disabled:opacity-60`}
                            />
                        </div>
                    </div>
                </div>

                {error && (
                    <div className="text-[10px] text-rose-500 leading-snug">{error}</div>
                )}

                {/* 监督人 */}
                <div className={`flex items-center justify-between pt-1`}>
                    <span className={theme.label}>监督人</span>
                    <span className={theme.value}>{charName}</span>
                </div>

                {/* 操作按钮 */}
                {canInteract && (
                    <div className="flex gap-2 pt-1">
                        <button
                            type="button"
                            onClick={handleDismiss}
                            disabled={submitting}
                            className={`${theme.ghostBtn} disabled:opacity-50`}
                        >先不要</button>
                        <button
                            type="button"
                            onClick={handleConfirm}
                            disabled={submitting}
                            className={`${theme.primaryBtn} disabled:opacity-50`}
                        >{submitting ? '建立中…' : '建立契约'}</button>
                    </div>
                )}
            </div>

            <div className={theme.footer}>
                <div className={theme.footerText}>时光契约</div>
            </div>
        </div>
    );
};

export default TaskProposalCard;
