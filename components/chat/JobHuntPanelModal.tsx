/**
 * JobHuntPanelModal — 单聊里的「上岸计划」快捷面板（加号菜单第 2 页入口）。
 *
 * 四块内容：
 *  1. 求职模式开关：写 char.jobHuntEnabled。开了才会往该角色的单聊 prompt 注入
 *     岗位/笔记状态 + JOB 指令教学（chatPrompts 里判的就是这个字段），关了零注入。
 *  2. 岗位卡列表：阶段可快速切换（select 直接落库，同工作台 advanceStage 逻辑）。
 *  3. 最近笔记：点开看全文（面板内展开，不跳走）。
 *  4. 简历库：选一份把脱敏文本发进聊天（复用 rawText，隐私闸门在导入时已过）。
 *
 * 数据自读 DB（getJobPositions/getJobNotes/getJobResumes），不经 Chat.tsx 中转，
 * 与 CharApiHubModal 一样保持 Chat.tsx 零状态增量。
 */
import React, { useState, useEffect, useCallback } from 'react';
import Modal from '../os/Modal';
import { DB } from '../../utils/db';
import { CharacterProfile, JobPosition, JobNote, JobResume, JobStage } from '../../types';
import { JobHuntSettings, loadJhSettings, saveJhSettings } from '../../utils/jobHuntSettings';

const STAGE_LABEL: Record<JobStage, string> = {
    watching: '观望中', applied: '已投递', written: '笔试中', interview: '面试中', offer_talk: '沟通Offer', offer: '已接受Offer', rejected: '已结束',
};
const STAGE_STYLE: Record<JobStage, string> = {
    watching: 'bg-violet-100 text-violet-600',
    applied: 'bg-slate-100 text-slate-600',
    written: 'bg-amber-100 text-amber-700',
    interview: 'bg-sky-100 text-sky-700',
    offer_talk: 'bg-teal-100 text-teal-700',
    offer: 'bg-emerald-100 text-emerald-700',
    rejected: 'bg-slate-100 text-slate-400',
};
const NOTE_KIND_LABEL: Record<string, string> = {
    eval: '面试评价', resume_advice: '简历建议', analysis: '岗位分析', note: '随手记',
};

interface JobHuntPanelModalProps {
    isOpen: boolean;
    onClose: () => void;
    char: CharacterProfile;
    /** 写 char.jobHuntEnabled（Chat.tsx 用 updateCharacter 落库） */
    onToggleJobHunt: (enabled: boolean) => void;
    /** 把一份脱敏简历文本发进聊天 */
    onSendResume: (resume: JobResume) => void;
    /** 跳转上岸计划工作台 */
    onOpenApp: () => void;
}

const JobHuntPanelModal: React.FC<JobHuntPanelModalProps> = ({
    isOpen, onClose, char, onToggleJobHunt, onSendResume, onOpenApp,
}) => {
    const [positions, setPositions] = useState<JobPosition[]>([]);
    const [notes, setNotes] = useState<JobNote[]>([]);
    const [resumes, setResumes] = useState<JobResume[]>([]);
    const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
    // 单聊注入三项（存全局 jhSettings.inject，所有角色共用）
    const [inject, setInject] = useState<JobHuntSettings['inject']>(() => loadJhSettings().inject);
    const patchInject = useCallback((p: Partial<JobHuntSettings['inject']>) => {
        setInject(prev => {
            const next = { ...prev, ...p };
            const full = loadJhSettings();
            saveJhSettings({ ...full, inject: next });
            return next;
        });
    }, []);

    const reload = useCallback(async () => {
        try { setPositions(await DB.getJobPositions()); } catch { setPositions([]); }
        try { setNotes(await DB.getJobNotes()); } catch { setNotes([]); }
        try { setResumes(await DB.getJobResumes()); } catch { setResumes([]); }
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        setExpandedNoteId(null);
        setInject(loadJhSettings().inject);
        reload();
    }, [isOpen, reload]);

    // 阶段快速切换：同工作台 advanceStage——落库 + timeline 追一条
    const advanceStage = useCallback(async (pos: JobPosition, stage: JobStage) => {
        const now = Date.now();
        await DB.saveJobPosition({
            ...pos, stage, timeline: [...pos.timeline, { ts: now, stage }], updatedAt: now,
        });
        reload();
    }, [reload]);

    if (!isOpen) return null;

    const enabled = !!char.jobHuntEnabled;
    const activePositions = positions.filter(p => p.stage !== 'rejected');
    const recentNotes = notes.slice(0, 8);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="上岸计划">
            <div className="space-y-4">
                {/* 求职模式开关 */}
                <div className={`rounded-2xl border p-4 transition-colors ${enabled ? 'bg-sky-50/80 border-sky-200' : 'bg-slate-50 border-slate-200'}`}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-sm font-black text-slate-700">求职模式</p>
                            <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                                开启后 {char.name} 在单聊里能看到你的岗位进展和笔记，
                                还能帮你建卡 / 记笔记 / 更新阶段。关闭则完全不注入。
                            </p>
                        </div>
                        <button
                            onClick={() => onToggleJobHunt(!enabled)}
                            className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-sky-500' : 'bg-slate-300'}`}
                        >
                            <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                        </button>
                    </div>
                    {/* 注入内容三项：开关下方展开，全局生效（所有开了求职模式的角色共用） */}
                    {enabled && (
                        <div className="mt-3 pt-3 border-t border-sky-200/60 space-y-2.5">
                            <div>
                                <p className="text-[11px] font-bold text-slate-600 mb-1.5">简历注入</p>
                                <div className="flex gap-1.5">
                                    {([['none', '不注入'], ['digest', '摘要'], ['raw', '全文']] as const).map(([v, label]) => (
                                        <button key={v} onClick={() => patchInject({ resume: v })}
                                            className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border transition-all active:scale-95 ${inject.resume === v ? 'bg-sky-100 text-sky-600 border-sky-300' : 'bg-white text-slate-400 border-slate-200'}`}>
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {([
                                ['profile', '竞争力档案', inject.profile] as const,
                                ['positions', '岗位摘要', inject.positions] as const,
                                ['notes', '笔记本条目', inject.notes] as const,
                            ]).map(([key, label, on]) => (
                                <button key={key} onClick={() => patchInject({ [key]: !on } as Partial<JobHuntSettings['inject']>)}
                                    className="w-full flex items-center justify-between px-1 active:scale-[0.99] transition-transform">
                                    <span className="text-[11px] font-bold text-slate-600">{label}</span>
                                    <span className={`w-9 h-5 rounded-full p-0.5 transition-colors ${on ? 'bg-sky-500' : 'bg-slate-300'}`}>
                                        <span className={`block w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
                                    </span>
                                </button>
                            ))}
                            <p className="text-[10px] text-slate-400 leading-relaxed">注入选项全局生效，所有开了求职模式的角色共用同一份。</p>
                        </div>
                    )}
                </div>

                {/* 岗位卡列表 */}
                <div>
                    <p className="text-xs font-black text-slate-700 mb-2">在推进的岗位</p>
                    {activePositions.length === 0 ? (
                        <p className="text-[11px] text-slate-400 px-1">还没有岗位卡——开着求职模式直接和 {char.name} 聊投递，TA 会帮你建。</p>
                    ) : (
                        <div className="space-y-2">
                            {activePositions.map(p => (
                                <div key={p.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[13px] font-bold text-slate-700">{p.code}</span>
                                        <span className="text-[11px] text-slate-400 truncate flex-1">{p.title}</span>
                                        <select
                                            value={p.stage}
                                            onChange={e => advanceStage(p, e.target.value as JobStage)}
                                            className={`text-[10px] font-semibold rounded-full px-2 py-1 outline-none border-0 ${STAGE_STYLE[p.stage]}`}
                                        >
                                            {(Object.keys(STAGE_LABEL) as JobStage[]).map(st => (
                                                <option key={st} value={st}>{STAGE_LABEL[st]}</option>
                                            ))}
                                        </select>
                                    </div>
                                    {p.nextStep && <p className="text-[11px] text-sky-600 mt-1">下一步：{p.nextStep}</p>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* 最近笔记 */}
                <div>
                    <p className="text-xs font-black text-slate-700 mb-2">最近笔记</p>
                    {recentNotes.length === 0 ? (
                        <p className="text-[11px] text-slate-400 px-1">笔记本还是空的。</p>
                    ) : (
                        <div className="space-y-1.5">
                            {recentNotes.map(n => {
                                const open = expandedNoteId === n.id;
                                return (
                                    <button
                                        key={n.id}
                                        onClick={() => setExpandedNoteId(open ? null : n.id)}
                                        className="w-full text-left rounded-xl border border-slate-200 bg-white px-3 py-2.5 active:scale-[0.99] transition-transform"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-500">{NOTE_KIND_LABEL[n.kind] || n.kind}</span>
                                            <span className="text-[12px] font-semibold text-slate-700 truncate flex-1">{n.title}</span>
                                            <span className="text-[9px] text-slate-300">{open ? '收起' : '全文'}</span>
                                        </div>
                                        {open && (
                                            <p className="text-[11px] leading-5 text-slate-500 mt-2 whitespace-pre-wrap max-h-52 overflow-y-auto no-scrollbar">{n.content}</p>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* 简历库 */}
                <div>
                    <p className="text-xs font-black text-slate-700 mb-2">简历库</p>
                    {resumes.length === 0 ? (
                        <p className="text-[11px] text-slate-400 px-1">还没导入过简历——去上岸计划里导入（本地自动脱敏）。</p>
                    ) : (
                        <div className="space-y-1.5">
                            {resumes.map(r => (
                                <div key={r.id} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                                    <span className="text-[12px] font-semibold text-slate-700 truncate flex-1">{r.name}</span>
                                    <span className="text-[9px] text-slate-300 shrink-0">{new Date(r.createdAt).toLocaleDateString('zh-CN')}</span>
                                    <button
                                        onClick={() => { onSendResume(r); onClose(); }}
                                        className="shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-lg bg-sky-500 text-white active:scale-95 transition-transform"
                                    >发进聊天</button>
                                </div>
                            ))}
                            <p className="text-[9px] text-slate-300 px-1">发出的是脱敏后的文本，真实姓名/电话/公司名在导入时已打码。</p>
                        </div>
                    )}
                </div>

                {/* 跳工作台 */}
                <button
                    onClick={() => { onClose(); onOpenApp(); }}
                    className="w-full py-3 rounded-2xl bg-gradient-to-r from-sky-500 to-cyan-500 text-white text-sm font-bold active:scale-[0.98] transition-transform"
                >打开上岸计划工作台</button>
            </div>
        </Modal>
    );
};

export default JobHuntPanelModal;
