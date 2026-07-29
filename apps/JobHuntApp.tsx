// 上岸计划 — 角色辅助求职工作台
// 定位：聊天是过程，沉淀下来的岗位进展/面试评价/简历建议才是资产。视觉像备忘录。
// 对话流是文档流而非气泡（参照 StudyApp 骨架）：角色发言=完整 markdown 块，用户发言=浅色引用条。
// 隐私两道闸：公司代号制（companyNameLocal 永不进 prompt）+ 简历/入记忆文本本地脱敏。
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { useBackGuard } from '../hooks/useBackGuard';
import { DB } from '../utils/db';
import {
    CharacterProfile, JobSession, JobPosition, JobNote, JobResume,
    JobChatMessage, JobStage, JobNoteKind, AppID,
} from '../types';
import { ContextBuilder } from '../utils/context';
import { resilientFetch } from '../utils/resilientFetch';
import { parseJobHuntCommands, JOB_COMMAND_GUIDE, normalizeJobStage } from '../utils/jobHuntParser';
import { redactPrivacy, codifyCompanies, RedactResult } from '../utils/privacyRedact';
import { synthesizeSpeech, characterHasVoice } from '../utils/ttsRouter';
import { hashTtsParams, getCachedTts, saveCachedTts } from '../utils/ttsCache';
import { startStt, isSttSupported, SttSession, SttProviderConfig } from '../utils/speechToText';
import {
    ReadCvLogo, PaperPlaneTilt, Microphone, Plus, CaretLeft, Notebook, Briefcase,
    ChatsCircle, FileText, Trash, SpeakerHigh, StopCircle, X, CircleNotch, UploadSimple,
    GearSix, Plugs,
} from '@phosphor-icons/react';
import { RealtimeContextManager, defaultRealtimeConfig } from '../utils/realtimeContext';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { resolveCharTimeZone, nowInTimeZone } from '../utils/timezone';
import CharApiHubModal from '../components/chat/CharApiHubModal';

// ─── CDN 动态加载（照 StudyApp 先例，不进 bundle）─────────────────

type PdfJsLike = {
    getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<any> };
    GlobalWorkerOptions?: { workerSrc?: string };
};
type MammothLike = {
    extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
};

let pdfjsPromise: Promise<PdfJsLike> | null = null;
let mammothPromise: Promise<MammothLike> | null = null;

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
        if ((existing as any).dataset.loaded === 'true') { resolve(); return; }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`load failed: ${src}`)), { once: true });
        return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
    script.onerror = () => reject(new Error(`load failed: ${src}`));
    document.head.appendChild(script);
});

const loadPdfJs = async (): Promise<PdfJsLike> => {
    if (!pdfjsPromise) {
        pdfjsPromise = loadScript('https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js').then(() => {
            const pdfjs = (window as any).pdfjsLib as PdfJsLike | undefined;
            if (!pdfjs) throw new Error('pdfjs 加载失败');
            if (pdfjs?.GlobalWorkerOptions) {
                pdfjs.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
            }
            return pdfjs;
        });
    }
    return pdfjsPromise;
};

const loadMammoth = async (): Promise<MammothLike> => {
    if (!mammothPromise) {
        mammothPromise = loadScript('https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js').then(() => {
            const mammoth = (window as any).mammoth as MammothLike | undefined;
            if (!mammoth) throw new Error('mammoth 加载失败');
            return mammoth;
        });
    }
    return mammothPromise;
};

// ─── 轻量 Markdown 渲染（文档流用；无公式需求，不拉 KaTeX）───────

const parseInline = (line: string): React.ReactNode[] => {
    const tokenRegex = /(\*\*[^*]+?\*\*|\*[^*]+?\*|`[^`]+?`)/g;
    return line.split(tokenRegex).map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
            return <strong key={i} className="text-slate-900 font-semibold">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
            return <em key={i} className="text-slate-600 italic">{part.slice(1, -1)}</em>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
            return <code key={i} className="bg-slate-100 text-sky-700 px-1.5 py-0.5 rounded font-mono text-xs mx-0.5">{part.slice(1, -1)}</code>;
        }
        return <span key={i}>{part}</span>;
    });
};

const MarkdownBlock: React.FC<{ text: string }> = ({ text }) => {
    // 代码块先摘出来保护，避免被按行切割
    const storedCode: string[] = [];
    const processed = text.replace(/```[\s\S]*?```/g, (match) => {
        storedCode.push(match.replace(/^```\w*\r?\n?/, '').replace(/```$/, ''));
        return `\u000a__JH_CODE_${storedCode.length - 1}__\u000a`;
    });
    const lines = processed.split(/\r?\n/);
    return (
        <div className="text-[15px] leading-relaxed text-slate-700">
            {lines.map((line, index) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={index} className="h-2" />;
                const codeMatch = trimmed.match(/^__JH_CODE_(\d+)__$/);
                if (codeMatch) {
                    return (
                        <pre key={index} className="bg-slate-900 text-slate-100 p-3 rounded-xl font-mono text-xs my-2 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                            {storedCode[parseInt(codeMatch[1])]}
                        </pre>
                    );
                }
                if (trimmed.startsWith('### ')) return <h4 key={index} className="text-[15px] font-bold text-slate-900 mt-3 mb-1">{parseInline(trimmed.slice(4))}</h4>;
                if (trimmed.startsWith('## ')) return <h3 key={index} className="text-base font-bold text-slate-900 mt-4 mb-1.5">{parseInline(trimmed.slice(3))}</h3>;
                if (trimmed.startsWith('# ')) return <h2 key={index} className="text-lg font-bold text-slate-900 mt-4 mb-2">{parseInline(trimmed.slice(2))}</h2>;
                if (trimmed.startsWith('> ')) {
                    return <div key={index} className="border-l-[3px] border-sky-300 bg-sky-50/60 px-3 py-1.5 my-1.5 rounded-r-lg text-slate-600">{parseInline(trimmed.slice(2))}</div>;
                }
                if (/^[-•]\s/.test(trimmed)) {
                    return (
                        <div key={index} className="flex gap-2 my-1 pl-1">
                            <span className="text-sky-500 mt-0.5 shrink-0">•</span>
                            <span>{parseInline(trimmed.slice(2))}</span>
                        </div>
                    );
                }
                const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
                if (numMatch) {
                    return (
                        <div key={index} className="flex gap-2 my-1 pl-1">
                            <span className="text-sky-600 font-semibold shrink-0">{numMatch[1]}.</span>
                            <span>{parseInline(numMatch[2])}</span>
                        </div>
                    );
                }
                return <p key={index} className="my-1">{parseInline(line)}</p>;
            })}
        </div>
    );
};

// ─── 展示常量 ───────────────────────────────────────────

const STAGE_LABEL: Record<JobStage, string> = {
    watching: '观望中', applied: '已投递', written: '笔试中', interview: '面试中', offer: 'Offer', rejected: '已结束',
};
const STAGE_STYLE: Record<JobStage, string> = {
    watching: 'bg-violet-100 text-violet-600',
    applied: 'bg-slate-100 text-slate-600',
    written: 'bg-amber-100 text-amber-700',
    interview: 'bg-sky-100 text-sky-700',
    offer: 'bg-emerald-100 text-emerald-700',
    rejected: 'bg-rose-100 text-rose-500',
};
const NOTE_KIND_LABEL: Record<JobNoteKind, string> = {
    eval: '面试评价', resume_advice: '简历建议', analysis: '岗位分析', note: '随手记',
};
const NOTE_KIND_STYLE: Record<JobNoteKind, string> = {
    eval: 'bg-sky-100 text-sky-700',
    resume_advice: 'bg-violet-100 text-violet-700',
    analysis: 'bg-amber-100 text-amber-700',
    note: 'bg-slate-100 text-slate-600',
};
const INTERVIEW_QUESTION_COUNT = 5;

// ─── 工作台本地设置（localStorage，全局生效不分角色）───
interface JobHuntSettings {
    zoom: number;                              // 文档流缩放挡位（0.9/1/1.1/1.2）
    typewriter: boolean;                       // 打字机效果
    autoSpeak: 'off' | 'interview' | 'all';    // 回复自动朗读范围
    autoMemorySync: boolean;                   // 离开会话自动沉淀记忆
    syncThreshold: number;                     // 自动沉淀的新消息条数阈值
}
const JH_SETTINGS_KEY = 'os_jobhunt_settings';
const DEFAULT_JH_SETTINGS: JobHuntSettings = { zoom: 1, typewriter: true, autoSpeak: 'interview', autoMemorySync: true, syncThreshold: 6 };
const loadJhSettings = (): JobHuntSettings => {
    try { return { ...DEFAULT_JH_SETTINGS, ...JSON.parse(localStorage.getItem(JH_SETTINGS_KEY) || '{}') }; }
    catch { return { ...DEFAULT_JH_SETTINGS }; }
};

const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

type SttPhase = 'idle' | 'starting' | 'listening' | 'recognizing';

// ─── 主组件 ─────────────────────────────────────────────

// 2.0 旧会话迁移的模块级同步闸：StrictMode 双跑 effect 时第二次能同步看到，
// 不像 localStorage 标记要等异步迁移跑完才写入
let jobMigrationRunning = false;

const JobHuntApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, setActiveCharacterId, openApp, apiConfig, addToast, userProfile, memoryPalaceConfig, realtimeConfig, updateCharacter } = useOS();

    // 数据
    const [sessions, setSessions] = useState<JobSession[]>([]);
    const [positions, setPositions] = useState<JobPosition[]>([]);
    const [notes, setNotes] = useState<JobNote[]>([]);
    const [resumes, setResumes] = useState<JobResume[]>([]);

    // 视图
    const [view, setView] = useState<'home' | 'chat'>('home');
    const [homeTab, setHomeTab] = useState<'sessions' | 'positions' | 'notebook'>('sessions');
    const [activeSession, setActiveSession] = useState<JobSession | null>(null);
    const [selectedCharId, setSelectedCharId] = useState<string>(activeCharacterId);

    // 聊天
    const [input, setInput] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [typingText, setTypingText] = useState('');   // 打字机的当前展示文本
    const [showPlusMenu, setShowPlusMenu] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const typingTimerRef = useRef<any>(null);
    const chatInputRef = useRef<HTMLTextAreaElement>(null);

    // 弹窗
    const [showNewSession, setShowNewSession] = useState(false);
    const [showNewPosition, setShowNewPosition] = useState(false);
    const [editingPosition, setEditingPosition] = useState<JobPosition | null>(null);
    const [viewingNote, setViewingNote] = useState<JobNote | null>(null);
    const [showResumePicker, setShowResumePicker] = useState(false);
    const [resumePreview, setResumePreview] = useState<{ name: string; format: JobResume['sourceFormat']; result: RedactResult } | null>(null);
    const [showPasteImport, setShowPasteImport] = useState(false);
    const [pasteText, setPasteText] = useState('');
    const [importBusy, setImportBusy] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 新建岗位表单
    const [posCode, setPosCode] = useState('');
    const [posTitle, setPosTitle] = useState('');
    const [posCompanyLocal, setPosCompanyLocal] = useState('');
    const [posNextStep, setPosNextStep] = useState('');

    // 语音输入（状态机全外显）
    const [sttPhase, setSttPhase] = useState<SttPhase>('idle');
    const [sttHint, setSttHint] = useState('');
    const [sttLevel, setSttLevel] = useState(0);
    const sttSessionRef = useRef<SttSession | null>(null);
    const sttBaseTextRef = useRef('');

    // TTS 播放
    const [playingIdx, setPlayingIdx] = useState<number | null>(null);
    const [ttsBusyIdx, setTtsBusyIdx] = useState<number | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // 记忆沉淀
    const [memorySyncBusy, setMemorySyncBusy] = useState(false);

    // 工作台设置 / 角色级 API 配置
    const [jhSettings, setJhSettings] = useState<JobHuntSettings>(loadJhSettings);
    const [showJhSettings, setShowJhSettings] = useState(false);
    const [showApiHub, setShowApiHub] = useState(false);
    const patchJhSettings = useCallback((p: Partial<JobHuntSettings>) => {
        setJhSettings(prev => {
            const next = { ...prev, ...p };
            try { localStorage.setItem(JH_SETTINGS_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    }, []);
    // latest-ref：sendMessage/bootstrapInterview 定义在 playMessageVoice 之前，
    // 自动朗读经 ref 调用，避开 const TDZ 与陈旧闭包
    const playVoiceRef = useRef<((msg: JobChatMessage, idx: number, opts?: { session?: JobSession; char?: CharacterProfile }) => void) | null>(null);

    const selectedChar = useMemo<CharacterProfile | null>(
        () => characters.find(c => c.id === selectedCharId) || characters[0] || null,
        [characters, selectedCharId],
    );
    const sessionChar = useMemo<CharacterProfile | null>(
        () => activeSession ? (characters.find(c => c.id === activeSession.charId) || null) : null,
        [characters, activeSession],
    );

    const sttCfg = useMemo<SttProviderConfig>(() => ({
        provider: apiConfig?.sttProvider === 'cloud' && apiConfig?.sttApiKey ? 'cloud' : 'system',
        baseUrl: apiConfig?.sttBaseUrl,
        apiKey: apiConfig?.sttApiKey,
        model: apiConfig?.sttModel,
    }), [apiConfig?.sttProvider, apiConfig?.sttBaseUrl, apiConfig?.sttApiKey, apiConfig?.sttModel]);
    const sttSupported = useMemo(() => isSttSupported(sttCfg), [sttCfg]);

    // 返回键：弹窗 → 聊天视图 → 关 App
    useBackGuard([
        [showJhSettings, () => setShowJhSettings(false)],
        [showApiHub, () => setShowApiHub(false)],
        [!!resumePreview, () => setResumePreview(null)],
        [showPasteImport, () => setShowPasteImport(false)],
        [!!viewingNote, () => setViewingNote(null)],
        [showNewPosition || !!editingPosition, () => { setShowNewPosition(false); setEditingPosition(null); }],
        [showNewSession, () => setShowNewSession(false)],
        [showResumePicker, () => setShowResumePicker(false)],
        [view === 'chat', () => handleLeaveChat()],
    ]);

    const reloadAll = useCallback(async () => {
        try {
            const [s, p, n, r] = await Promise.all([
                DB.getJobSessions(), DB.getJobPositions(), DB.getJobNotes(), DB.getJobResumes(),
            ]);
            setSessions(s); setPositions(p); setNotes(n); setResumes(r);
        } catch (e) {
            console.warn('[JobHunt] 数据加载失败', e);
        }
    }, []);
    useEffect(() => { reloadAll(); }, [reloadAll]);

    // ── 2.0 一次性迁移：日常求职会话（自由聊/聊岗位）合入对应角色的单聊消息流。
    // 求职能力已并入单聊（jobHuntEnabled + JOB 指令），工作台只留模拟面试。
    // 单聊消息流按主键 id 排序而非 timestamp，所以走 insertMessagesByTimestamp：
    // 按原时间戳定位到历史中的正确位置插入（小数 id），信息流/时间线严丝合缝，
    // 且不会被记忆宫殿水位线当成新消息灌进 AI 上下文。
    // 幂等三道闸：模块级同步锁挡 StrictMode 双跑 effect；逐个角色「插完即删会话」
    // 保证中途失败不重复插（下次只重试剩余会话）；全部完成才写 localStorage 标记。
    useEffect(() => {
        (async () => {
            try {
                if (localStorage.getItem('os_jobhunt_migrated_v2')) return;
                if (jobMigrationRunning) return; // StrictMode 双跑 / 重复挂载护栏
                jobMigrationRunning = true;
                const all = await DB.getJobSessions();
                const daily = all.filter(s => s.topic !== 'interview');
                if (daily.length === 0) {
                    localStorage.setItem('os_jobhunt_migrated_v2', '1');
                    jobMigrationRunning = false;
                    return;
                }
                let moved = 0;
                // 按角色分组：同角色的所有旧会话一次性插入（同一事务，区间定位也更准）
                const byChar = new Map<string, { sessions: JobSession[]; msgs: { role: 'user' | 'assistant'; content: string; ts: number }[] }>();
                for (const s of daily) {
                    const g = byChar.get(s.charId) || { sessions: [], msgs: [] };
                    g.sessions.push(s);
                    for (const m of s.messages) {
                        if (!m.content?.trim()) continue;
                        g.msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content, ts: m.ts });
                    }
                    byChar.set(s.charId, g);
                }
                for (const [charId, g] of byChar) {
                    // 插入与删会话按角色成对提交：插成功立刻删掉该角色的旧会话，
                    // 后续角色失败只影响未迁移部分，重试不会重复插已成功的
                    if (g.msgs.length > 0) {
                        moved += await DB.insertMessagesByTimestamp(charId, g.msgs.map(m => ({
                            charId,
                            role: m.role,
                            type: 'text' as const,
                            content: m.content,
                            timestamp: m.ts,
                        })) as any);
                    }
                    for (const s of g.sessions) await DB.deleteJobSession(s.id);
                }
                localStorage.setItem('os_jobhunt_migrated_v2', '1');
                if (moved > 0) addToast(`已把 ${daily.length} 场求职对话按原时间线合入单聊记录（${moved} 条）`, 'success');
                reloadAll();
            } catch (e) { console.warn('[JobHunt] 旧会话迁移失败（下次进入继续重试剩余部分）', e); }
            finally { jobMigrationRunning = false; }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => {
        // 卸载兜底：停音频/识别器/打字机
        if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
        sttSessionRef.current?.stop();
        if (typingTimerRef.current) clearInterval(typingTimerRef.current);
    }, []);

    const scrollToBottom = useCallback(() => {
        requestAnimationFrame(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
    }, []);
    useEffect(() => { scrollToBottom(); }, [activeSession?.messages.length, typingText, scrollToBottom]);

    // ─── 会话持久化 ───
    const persistSession = useCallback(async (session: JobSession) => {
        setActiveSession(session);
        setSessions(prev => {
            const rest = prev.filter(s => s.id !== session.id);
            return [session, ...rest];
        });
        try { await DB.saveJobSession(session); } catch (e) { console.warn('[JobHunt] 会话落库失败', e); }
    }, []);

    // ─── 指令落库：JOB_UPDATE / JOB_NOTE ───
    const applyCommands = useCallback(async (
        parsed: ReturnType<typeof parseJobHuntCommands>,
        session: JobSession,
    ) => {
        let touched = false;
        const now = Date.now();
        for (const u of parsed.updates) {
            const existing = (await DB.getJobPositions()).find(p => p.code === u.code);
            if (existing) {
                const updated: JobPosition = {
                    ...existing,
                    stage: u.stage,
                    nextStep: u.nextStep || existing.nextStep,
                    timeline: [...existing.timeline, { ts: now, stage: u.stage, note: u.nextStep || undefined }],
                    updatedAt: now,
                };
                await DB.saveJobPosition(updated);
            } else {
                // prompt 教「已建档才记」，但 LLM 偶尔会自作主张——照单收下比丢数据强
                const created: JobPosition = {
                    id: genId('jpos'), code: u.code, title: u.code, stage: u.stage,
                    nextStep: u.nextStep || undefined, timeline: [{ ts: now, stage: u.stage }],
                    charId: session.charId, createdAt: now, updatedAt: now,
                };
                await DB.saveJobPosition(created);
            }
            touched = true;
        }
        for (const n of parsed.notes) {
            const note: JobNote = {
                id: genId('jnote'), kind: n.kind, title: n.title, content: n.content,
                positionId: session.positionId, sessionId: session.id,
                charId: session.charId, createdAt: now,
            };
            await DB.saveJobNote(note);
            touched = true;
        }
        if (touched) {
            await reloadAll();
            if (parsed.updates.length) addToast(`岗位进展已更新（${parsed.updates.length} 条）`, 'success');
            if (parsed.notes.length) addToast(`已记入笔记本（${parsed.notes.length} 条）`, 'success');
        }
    }, [reloadAll, addToast]);

    // ─── system prompt 组装（认知层对齐单聊：宫殿召回/世界书激活/日程/实时世界/钢印）───
    const buildSystemPrompt = useCallback(async (char: CharacterProfile, session: JobSession): Promise<string> => {
        // 伪 Message：给宫殿召回和世界书关键词扫描用（结构上满足 id/role/content/timestamp）
        const pseudoMsgs: any[] = session.messages.slice(-60).map((m, i) => ({
            id: i + 1, charId: char.id, role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content, type: 'text', timestamp: m.ts,
        }));
        // 记忆宫殿：与单聊同款，发送前现场召回（结果挂 char.memoryPalaceInjection，buildCoreContext 自动读）
        try {
            const { injectMemoryPalace } = await import('../utils/memoryPalace/pipeline');
            await injectMemoryPalace(char, pseudoMsgs, undefined, userProfile?.name);
        } catch (e) { console.warn('[JobHunt] 宫殿召回失败（非致命）', e); }

        const lastMsg = session.messages[session.messages.length - 1];
        let ctx = ContextBuilder.buildCoreContext(char, userProfile, true, undefined, undefined, {
            lastInteractionTs: lastMsg?.ts,
            userTimezone: userProfile?.timezone,
            worldbookMessages: pseudoMsgs,
        });

        // 实时世界（天气/新闻/特殊日期）：与单聊同一份 realtimeConfig，开关跟随全局设置
        const charTz = resolveCharTimeZone(char);
        const rtCfg = realtimeConfig || defaultRealtimeConfig;
        if (rtCfg.weatherEnabled || rtCfg.newsEnabled) {
            try { ctx += `\n${await RealtimeContextManager.buildFullContext(rtCfg, charTz, char.regionConfig)}\n`; }
            catch (e) { console.warn('[JobHunt] 实时上下文注入失败', e); }
        }
        // 日程 + 意识流：只读现成日程，不在求职 App 里触发生成
        if (isScheduleFeatureOn(char)) {
            try {
                const schedule = await getDailyScheduleForChar(char);
                const block = ContextBuilder.buildScheduleInjection(schedule, undefined, nowInTimeZone(charTz));
                if (block) ctx += `\n### 你此刻的生活状态\n${block}`;
            } catch (e) { console.warn('[JobHunt] 日程注入失败', e); }
        }
        const posLines = positions
            .filter(p => p.stage !== 'rejected' || p.id === session.positionId)
            .map(p => `- ${p.code} · ${p.title} · ${STAGE_LABEL[p.stage]}${p.nextStep ? ` · 下一步：${p.nextStep}` : ''}`);
        ctx += [
            '',
            '### [System: 求职工作台模式]',
            `你正在「上岸计划」App 里帮 ${userProfile.name} 处理求职相关的事：聊岗位、盘进展、模拟面试、改简历。`,
            '- 保持你的人设和说话方式，不要变成客服机器人。',
            '- 回复用 markdown 排版（标题/列表/加粗），长内容放得下，不用刻意压缩。',
            posLines.length ? `当前在推进的岗位（公司都是代号）：\u000a${posLines.join('\u000a')}` : '工作台暂时还没有建档的岗位。',
            '',
            JOB_COMMAND_GUIDE,
        ].join('\u000a');
        if (session.topic === 'interview' && session.interview) {
            const pos = positions.find(p => p.id === session.positionId);
            ctx += [
                '',
                '### [System: 模拟面试模式]',
                `你现在是「${pos ? `${pos.code} 的 ${pos.title}` : '目标岗位'}」的面试官，一次只问一道题。`,
                `题目清单（共 ${session.interview.questions.length} 题，按序进行）：`,
                ...session.interview.questions.map((q, i) => `${i + 1}. ${q}`),
                `当前进行到第 ${Math.min(session.interview.currentIndex + 1, session.interview.questions.length)} 题。`,
                '- 用户回答后：先给一两句简短的追问或反馈（保持面试官口吻），然后自然过渡到下一题。',
                '- 全部题目问完后告知面试环节结束，等待用户点击「生成评价」。',
                '- 不要一次抛出多道题。',
            ].join('\u000a');
        }
        // recency 钢印（单聊同源的简版）：防止聊久了褪成没有名字的职业顾问
        ctx += [
            '',
            '### 关于对方的表达（重要）',
            `当 ${userProfile.name} 说话，先听，别急着分析或把 ta 的感受纠正成你觉得更合理的版本。求职期的焦虑和动摇都是真实的，ta 的反馈不是约束而是信任——让它真的改变你接下来怎么回。但听进去不等于磨平自己：你依然可以不同意、可以用你本来的方式回应。`,
            '',
            '### 最后，回到你自己',
            `你就是 ${char.name}。建议要专业，但每一句话都该像从 ${char.name} 心里自然冒出来的——带着你的语气、你的节奏、你们的过去。不要变成一个没有名字的职业顾问。`,
        ].join('\n');
        return ctx;
    }, [userProfile, positions, realtimeConfig]);

    // ─── LLM 调用（resilientFetch：120s + 瞬断补枪；角色级 chatApiOverride 优先）───
    const callLLM = useCallback(async (systemPrompt: string, history: JobChatMessage[], extraUser?: string, char?: CharacterProfile): Promise<string> => {
        // 与单聊同款：角色配了专属主 API 就走角色的，否则跟随全局
        const eff = char?.chatApiOverride?.baseUrl ? char.chatApiOverride : apiConfig;
        const messages: { role: string; content: string }[] = [{ role: 'system', content: systemPrompt }];
        for (const m of history.slice(-40)) {
            messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
        }
        if (extraUser) messages.push({ role: 'user', content: extraUser });
        const res = await resilientFetch(`${eff.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${eff.apiKey}` },
            body: JSON.stringify({ model: eff.model, messages, temperature: 0.7 }),
        }, { timeoutMs: 120_000, retries: 1 });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.reasoning_content || '';
        if (!text) throw new Error('模型返回内容为空');
        return text;
    }, [apiConfig]);

    // ─── 打字机（设置里可关：关了就直接上全文）───
    const typeOut = useCallback((full: string, onDone: () => void) => {
        if (typingTimerRef.current) clearInterval(typingTimerRef.current);
        if (!jhSettings.typewriter) { setTypingText(''); onDone(); return; }
        let i = 0;
        const step = Math.max(2, Math.round(full.length / 120)); // 全长约 2.4s 播完
        typingTimerRef.current = setInterval(() => {
            i = Math.min(full.length, i + step);
            setTypingText(full.slice(0, i));
            if (i >= full.length) {
                clearInterval(typingTimerRef.current);
                typingTimerRef.current = null;
                setTypingText('');
                onDone();
            }
        }, 20);
    }, [jhSettings.typewriter]);

    // ─── 发送消息（自由/岗位/面试共用管线）───
    const sendMessage = useCallback(async (rawContent?: string) => {
        const content = (rawContent ?? input).trim();
        if (!content || isSending || !activeSession || !sessionChar) return;
        setInput('');
        // 发送后把被撑大的输入框缩回一行（onInput 只在用户输入时触发，程序清空不会）
        if (chatInputRef.current) chatInputRef.current.style.height = '42px';
        setShowPlusMenu(false);
        setIsSending(true);
        const userMsg: JobChatMessage = { role: 'user', content, ts: Date.now() };
        let session: JobSession = {
            ...activeSession,
            messages: [...activeSession.messages, userMsg],
            updatedAt: Date.now(),
        };
        await persistSession(session);
        try {
            const raw = await callLLM(await buildSystemPrompt(sessionChar, session), session.messages, undefined, sessionChar);
            const parsed = parseJobHuntCommands(raw);
            const charMsg: JobChatMessage = { role: 'char', content: parsed.cleanText || raw, ts: Date.now() };
            // 面试模式：角色每回一轮 = 推进一题
            const nextInterview = session.topic === 'interview' && session.interview && !session.interview.finished
                ? {
                    ...session.interview,
                    currentIndex: Math.min(session.interview.currentIndex + 1, session.interview.questions.length),
                    finished: session.interview.currentIndex + 1 >= session.interview.questions.length,
                }
                : session.interview;
            session = {
                ...session,
                messages: [...session.messages, charMsg],
                interview: nextInterview,
                updatedAt: Date.now(),
            };
            typeOut(charMsg.content, () => { /* 打完字后由下方 persist 的渲染接管 */ });
            await persistSession(session);
            // 自动朗读（按设置：仅面试 / 全部）
            if (jhSettings.autoSpeak === 'all' || (jhSettings.autoSpeak === 'interview' && session.topic === 'interview')) {
                playVoiceRef.current?.(charMsg, session.messages.length - 1, { session, char: sessionChar });
            }
            await applyCommands(parsed, session);
        } catch (e: any) {
            addToast(`回复失败：${e?.message || '网络异常'}`, 'error');
        } finally {
            setIsSending(false);
        }
    }, [input, isSending, activeSession, sessionChar, persistSession, callLLM, buildSystemPrompt, typeOut, applyCommands, addToast, jhSettings.autoSpeak]);

    // ─── 新建会话 ───
    const createSession = useCallback(async (topic: JobSession['topic'], positionId?: string) => {
        if (!selectedChar) { addToast('先去神经链接里建一个角色吧', 'info'); return; }
        const pos = positionId ? positions.find(p => p.id === positionId) : undefined;
        const now = Date.now();
        const session: JobSession = {
            id: genId('jses'), charId: selectedChar.id, topic, positionId,
            title: topic === 'interview'
                ? `模拟面试 · ${pos ? `${pos.code} ${pos.title}` : '未指定岗位'}`
                : pos ? `聊聊 ${pos.code} · ${pos.title}` : `和${selectedChar.name}聊求职`,
            messages: [], memorySyncedCount: 0, createdAt: now, updatedAt: now,
        };
        await persistSession(session);
        setShowNewSession(false);
        setView('chat');
        if (topic === 'interview') {
            await bootstrapInterview(session, selectedChar, pos);
        }
    }, [selectedChar, positions, persistSession, addToast]);

    // ─── 模拟面试：先生成题目清单，再由面试官抛第一题 ───
    const bootstrapInterview = useCallback(async (session: JobSession, char: CharacterProfile, pos?: JobPosition) => {
        setIsSending(true);
        try {
            const genPrompt = [
                `你是「${pos ? `${pos.code} 的 ${pos.title}` : '目标岗位'}」的面试官，为候选人 ${userProfile.name} 准备 ${INTERVIEW_QUESTION_COUNT} 道面试题。`,
                '要求：由浅入深，覆盖自我介绍/岗位匹配/项目深挖/软素质；公司只用代号；',
                `严格输出 JSON 字符串数组（长度 ${INTERVIEW_QUESTION_COUNT}），不要输出其它任何内容。`,
            ].join('\u000a');
            const raw = await callLLM(genPrompt, [], '请给出题目清单。', char);
            let questions: string[] = [];
            try {
                const jsonMatch = raw.match(/\[[\s\S]*\]/);
                questions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
            } catch { questions = []; }
            questions = (Array.isArray(questions) ? questions : []).filter(q => typeof q === 'string' && q.trim()).slice(0, INTERVIEW_QUESTION_COUNT);
            if (!questions.length) throw new Error('题目生成失败，请重试');
            let s: JobSession = {
                ...session,
                interview: { questions, currentIndex: 0, finished: false },
                updatedAt: Date.now(),
            };
            await persistSession(s);
            // 面试官开场 + 第一题
            const raw2 = await callLLM(await buildSystemPrompt(char, s), [],
                '（系统：面试开始。请你以面试官身份简短开场，然后提出第 1 题。）', char);
            const parsed = parseJobHuntCommands(raw2);
            const charMsg: JobChatMessage = { role: 'char', content: parsed.cleanText || raw2, ts: Date.now() };
            s = { ...s, messages: [charMsg], updatedAt: Date.now() };
            typeOut(charMsg.content, () => {});
            await persistSession(s);
            // 自动读题：面试模式下开场+第一题直接念出来
            if (jhSettings.autoSpeak !== 'off') {
                playVoiceRef.current?.(charMsg, 0, { session: s, char });
            }
        } catch (e: any) {
            addToast(`面试启动失败：${e?.message || '网络异常'}`, 'error');
        } finally {
            setIsSending(false);
        }
    }, [userProfile, callLLM, persistSession, buildSystemPrompt, typeOut, addToast, jhSettings.autoSpeak]);

    // ─── 面试结束 → 结构化评价报告 → 自动归档笔记本 ───
    const generateInterviewEval = useCallback(async () => {
        if (!activeSession || !sessionChar || isSending) return;
        setIsSending(true);
        try {
            const raw = await callLLM(await buildSystemPrompt(sessionChar, activeSession), activeSession.messages, [
                '（系统：面试结束。请以面试官身份生成结构化评价报告，markdown 排版，包含：',
                '1. 维度打分（表达/岗位匹配/深度/临场，各 10 分制）；2. 逐题点评；3. 三条最优先的改进建议。',
                '并把报告全文用 [[JOB_NOTE:eval|标题|正文]] 指令归档，标题带上岗位代号。）',
            ].join('\u000a'), sessionChar);
            const parsed = parseJobHuntCommands(raw);
            // 兜底：LLM 忘了打指令标记时，把正文直接落成 eval 笔记，评价不能丢
            if (!parsed.notes.length && parsed.cleanText) {
                parsed.notes.push({ kind: 'eval', title: activeSession.title, content: parsed.cleanText });
            }
            const charMsg: JobChatMessage = { role: 'char', content: parsed.cleanText || raw, ts: Date.now() };
            const s: JobSession = {
                ...activeSession,
                messages: [...activeSession.messages, charMsg],
                interview: activeSession.interview ? { ...activeSession.interview, finished: true } : undefined,
                updatedAt: Date.now(),
            };
            typeOut(charMsg.content, () => {});
            await persistSession(s);
            await applyCommands(parsed, s);
        } catch (e: any) {
            addToast(`评价生成失败：${e?.message || '网络异常'}`, 'error');
        } finally {
            setIsSending(false);
        }
    }, [activeSession, sessionChar, isSending, callLLM, buildSystemPrompt, typeOut, persistSession, applyCommands, addToast]);

    // ─── TTS：读题/回放（走 ttsCache 全局持久缓存；opts 供自动朗读在 state 未刷新时直接传现场会话）───
    const playMessageVoice = useCallback(async (msg: JobChatMessage, idx: number, opts?: { session?: JobSession; char?: CharacterProfile }) => {
        const char = opts?.char || sessionChar;
        const sess = opts?.session || activeSession;
        if (!char || ttsBusyIdx !== null) return;
        if (playingIdx === idx) {
            audioRef.current?.pause();
            setPlayingIdx(null);
            return;
        }
        if (!characterHasVoice(char, apiConfig)) {
            // 自动朗读路径静默跳过，手动点才提示
            if (!opts) addToast('这个角色还没配音色，去神经链接里配一个', 'info');
            return;
        }
        setTtsBusyIdx(idx);
        try {
            const ttsText = msg.content.replace(/[#*`>\-]/g, '').slice(0, 600);
            const key = msg.voiceKey || hashTtsParams({ app: 'jobhunt', charId: char.id, text: ttsText, vp: char.voiceProfile });
            let blob = await getCachedTts(key);
            if (!blob) {
                const url = await synthesizeSpeech(ttsText, char, apiConfig, { groupId: apiConfig.minimaxGroupId || undefined });
                blob = await (await fetch(url)).blob();
                await saveCachedTts(key, blob);
            }
            if (!msg.voiceKey && sess) {
                // 回写 voiceKey：笔记本/回放场景可复取
                const s: JobSession = {
                    ...sess,
                    messages: sess.messages.map((m, i) => i === idx ? { ...m, voiceKey: key } : m),
                };
                await persistSession(s);
            }
            if (audioRef.current) audioRef.current.pause();
            const audio = new Audio(URL.createObjectURL(blob));
            audioRef.current = audio;
            audio.onended = () => setPlayingIdx(null);
            setPlayingIdx(idx);
            await audio.play();
        } catch (e: any) {
            console.error('[JobHunt TTS] failed:', e);
            addToast(`语音合成失败：${e?.message || '未知错误'}`, 'error');
            setPlayingIdx(null);
        } finally {
            setTtsBusyIdx(null);
        }
    }, [sessionChar, apiConfig, playingIdx, ttsBusyIdx, activeSession, persistSession, addToast]);
    useEffect(() => { playVoiceRef.current = playMessageVoice; }, [playMessageVoice]);

    // ─── 语音输入（云端优先 + 状态全外显，吸取通话 STT 教训）───
    const toggleStt = useCallback(async () => {
        if (sttPhase !== 'idle') {
            await sttSessionRef.current?.stop();
            return;
        }
        if (!sttSupported) {
            addToast('当前环境不支持语音输入，可在设置里配置云端 STT', 'info');
            return;
        }
        if (sttCfg.provider !== 'cloud') {
            addToast('系统识别在部分机型不稳，建议到设置里配云端 STT（如硅基流动，免费）', 'info');
        }
        setSttPhase('starting');
        setSttHint('正在请求麦克风权限…');
        sttBaseTextRef.current = input;
        try {
            const session = await startStt('zh-CN', {
                onPartial: (text) => {
                    setSttPhase('listening');
                    setSttHint('在听，说完点停止');
                    setInput((sttBaseTextRef.current ? sttBaseTextRef.current + ' ' : '') + text);
                },
                onFinal: (text) => {
                    if (text) setInput((sttBaseTextRef.current ? sttBaseTextRef.current + ' ' : '') + text);
                },
                onLevel: (level) => { setSttPhase('listening'); setSttLevel(level); setSttHint('在听，说完点停止'); },
                onRecognizing: () => { setSttPhase('recognizing'); setSttHint('识别中…'); },
                onError: (message) => { if (message) { addToast(`语音输入失败：${message}`, 'error'); setSttHint(message); } },
                onEnd: () => { setSttPhase('idle'); setSttLevel(0); setSttHint(''); sttSessionRef.current = null; },
            }, sttCfg);
            sttSessionRef.current = session;
            setSttPhase(prev => prev === 'starting' ? 'listening' : prev);
            setSttHint('在听，说完点停止');
        } catch (e: any) {
            setSttPhase('idle');
            setSttHint('');
            addToast(`识别器启动失败：${e?.message || '未知错误'}`, 'error');
        }
    }, [sttPhase, sttSupported, sttCfg, input, addToast]);

    // ─── 全量互通：会话（脱敏+代号化后）喂记忆宫殿 ───
    const syncSessionToMemory = useCallback(async (session: JobSession, silent: boolean) => {
        const char = characters.find(c => c.id === session.charId);
        if (!char) return;
        const emb = memoryPalaceConfig?.embedding;
        const llm = memoryPalaceConfig?.lightLLM;
        if (!char.memoryPalaceEnabled || !emb?.baseUrl || !emb?.apiKey || !emb?.model || !llm?.baseUrl || !llm?.apiKey || !llm?.model) {
            if (!silent) addToast('要先给角色开记忆宫殿并配好 Embedding/副 API 才能沉淀', 'info');
            return;
        }
        const synced = session.memorySyncedCount || 0;
        const fresh = session.messages.slice(synced);
        if (fresh.length < 2) {
            if (!silent) addToast('没有新内容需要沉淀', 'info');
            return;
        }
        if (memorySyncBusy) return;
        setMemorySyncBusy(true);
        try {
            const rawLines = fresh.map(m => `${m.role === 'user' ? userProfile.name : char.name}：${m.content}`).join('\u000a');
            // 两道闸：先代号化真实公司名，再本地脱敏个人信息
            const codified = codifyCompanies(rawLines, positions);
            const redacted = redactPrivacy(codified).text;
            const header = `【求职工作台 · ${session.title} · ${new Date(session.updatedAt).toLocaleDateString('zh-CN')}】`;
            const { importExternalMemoryText } = await import('../utils/memoryPalace/pipeline');
            const result = await importExternalMemoryText(
                `${header}\u000a${redacted}`, char.id, char.name, emb, llm, userProfile?.name || '',
            );
            if (result.error === 'lock') {
                if (!silent) addToast('角色有其它记忆任务在跑，稍后再试', 'info');
                return;
            }
            if (result.error) throw new Error(result.error);
            const s: JobSession = { ...session, memorySyncedCount: session.messages.length };
            await persistSession(s);
            if (!silent) addToast(`已沉淀进${char.name}的记忆宫殿（${result.stored} 条）`, 'success');
        } catch (e: any) {
            if (!silent) addToast(`记忆沉淀失败：${e?.message || '未知错误'}`, 'error');
            else console.warn('[JobHunt] 静默记忆沉淀失败', e);
        } finally {
            setMemorySyncBusy(false);
        }
    }, [characters, memoryPalaceConfig, memorySyncBusy, positions, userProfile, persistSession, addToast]);

    // 离开聊天：按设置自动沉淀（开关+阈值都在工作台设置里；前置校验不满足会自动跳过）
    const handleLeaveChat = useCallback(() => {
        if (audioRef.current) { audioRef.current.pause(); setPlayingIdx(null); }
        sttSessionRef.current?.stop();
        if (jhSettings.autoMemorySync && activeSession
            && activeSession.messages.length - (activeSession.memorySyncedCount || 0) >= jhSettings.syncThreshold) {
            syncSessionToMemory(activeSession, true);
        }
        setActiveSession(null);
        setView('home');
    }, [activeSession, syncSessionToMemory, jhSettings.autoMemorySync, jhSettings.syncThreshold]);

    // ─── 简历导入：PDF / DOCX / TXT / 粘贴 → 本地脱敏 → 预览确认 ───
    const handleResumeFile = useCallback(async (file: File) => {
        setImportBusy(true);
        try {
            const name = file.name.replace(/\.[^.]+$/, '');
            const ext = (file.name.split('.').pop() || '').toLowerCase();
            let text = '';
            let format: JobResume['sourceFormat'] = 'txt';
            if (ext === 'pdf') {
                format = 'pdf';
                const pdfjs = await loadPdfJs();
                const buf = await file.arrayBuffer();
                const pdf = await pdfjs.getDocument({ data: buf }).promise;
                const pageCount = Math.min(pdf.numPages, 50);
                const parts: string[] = [];
                for (let i = 1; i <= pageCount; i++) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent();
                    parts.push(content.items.map((it: any) => it.str).join(' '));
                }
                text = parts.join('\u000a');
                if (text.replace(/\s/g, '').length < 50) throw new Error('这份 PDF 像是扫描件，提取不到文字，换个文本版试试');
            } else if (ext === 'docx') {
                format = 'docx';
                const mammoth = await loadMammoth();
                const buf = await file.arrayBuffer();
                const result = await mammoth.extractRawText({ arrayBuffer: buf });
                text = result.value || '';
            } else {
                format = 'txt';
                text = await file.text();
            }
            if (!text.trim()) throw new Error('没提取到内容');
            const result = redactPrivacy(text, { realNames: [userProfile.name] });
            setResumePreview({ name, format, result });
        } catch (e: any) {
            addToast(`简历导入失败：${e?.message || '未知错误'}`, 'error');
        } finally {
            setImportBusy(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }, [userProfile, addToast]);

    const confirmResumeImport = useCallback(async () => {
        if (!resumePreview) return;
        const resume: JobResume = {
            id: genId('jres'), name: resumePreview.name,
            rawText: resumePreview.result.text, sourceFormat: resumePreview.format,
            createdAt: Date.now(),
        };
        await DB.saveJobResume(resume);
        setResumePreview(null);
        await reloadAll();
        addToast('简历已导入（存的是脱敏版）', 'success');
    }, [resumePreview, reloadAll, addToast]);

    // 粘贴导入：同样过脱敏预览闸
    const handlePasteImport = useCallback(() => {
        const text = pasteText.trim();
        if (!text) { addToast('先粘贴简历文本', 'info'); return; }
        const result = redactPrivacy(text, { realNames: [userProfile.name] });
        setShowPasteImport(false);
        setPasteText('');
        setResumePreview({ name: `粘贴的简历 ${new Date().toLocaleDateString('zh-CN')}`, format: 'paste', result });
    }, [pasteText, userProfile, addToast]);

    // 对话里引用简历 → 让角色改
    const sendResumeToChat = useCallback((resume: JobResume) => {
        setShowResumePicker(false);
        sendMessage(`这是我的简历（已脱敏），帮我看看怎么改：\u000a\u000a${resume.rawText.slice(0, 6000)}`);
    }, [sendMessage]);

    // ─── 岗位卡增删改 ───
    const savePosition = useCallback(async () => {
        const code = posCode.trim();
        const title = posTitle.trim();
        if (!code || !title) { addToast('代号和岗位名都要填', 'info'); return; }
        const now = Date.now();
        if (editingPosition) {
            await DB.saveJobPosition({
                ...editingPosition, code, title,
                companyNameLocal: posCompanyLocal.trim() || undefined,
                nextStep: posNextStep.trim() || undefined, updatedAt: now,
            });
        } else {
            await DB.saveJobPosition({
                id: genId('jpos'), code, title, stage: 'applied',
                nextStep: posNextStep.trim() || undefined,
                timeline: [{ ts: now, stage: 'applied' }],
                companyNameLocal: posCompanyLocal.trim() || undefined,
                charId: selectedChar?.id || '', createdAt: now, updatedAt: now,
            });
        }
        setShowNewPosition(false); setEditingPosition(null);
        setPosCode(''); setPosTitle(''); setPosCompanyLocal(''); setPosNextStep('');
        await reloadAll();
    }, [posCode, posTitle, posCompanyLocal, posNextStep, editingPosition, selectedChar, reloadAll, addToast]);

    const advanceStage = useCallback(async (pos: JobPosition, stage: JobStage) => {
        const now = Date.now();
        await DB.saveJobPosition({
            ...pos, stage, timeline: [...pos.timeline, { ts: now, stage }], updatedAt: now,
        });
        await reloadAll();
    }, [reloadAll]);

    const deletePosition = useCallback(async (pos: JobPosition) => {
        if (!window.confirm(`删除岗位卡「${pos.code} · ${pos.title}」？关联笔记会保留。`)) return;
        await DB.deleteJobPosition(pos.id);
        await reloadAll();
    }, [reloadAll]);

    const deleteSession = useCallback(async (session: JobSession) => {
        if (!window.confirm(`删除会话「${session.title}」？`)) return;
        await DB.deleteJobSession(session.id);
        await reloadAll();
    }, [reloadAll]);

    const deleteNote = useCallback(async (note: JobNote) => {
        if (!window.confirm(`删除笔记「${note.title}」？`)) return;
        await DB.deleteJobNote(note.id);
        setViewingNote(null);
        await reloadAll();
    }, [reloadAll]);

    const deleteResume = useCallback(async (resume: JobResume) => {
        if (!window.confirm(`删除简历「${resume.name}」？`)) return;
        await DB.deleteJobResume(resume.id);
        await reloadAll();
    }, [reloadAll]);

    const openEditPosition = useCallback((pos: JobPosition) => {
        setEditingPosition(pos);
        setPosCode(pos.code); setPosTitle(pos.title);
        setPosCompanyLocal(pos.companyNameLocal || ''); setPosNextStep(pos.nextStep || '');
        setShowNewPosition(true);
    }, []);

    // ─── 渲染：脱敏预览（导入确认前的最后一道闸）───

    const renderRedactPreview = () => {
        if (!resumePreview) return null;
        const { result } = resumePreview;
        return (
            <div className="absolute inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
                <div className="w-full max-w-md bg-white rounded-3xl p-5 max-h-[85%] flex flex-col">
                    <div className="font-bold text-slate-800 mb-1">脱敏预览 · {resumePreview.name}</div>
                    <div className="text-xs text-slate-500 mb-3">
                        {result.changed
                            ? `本地已打码 ${result.hits.reduce((a, h) => a + h.count, 0)} 处：${result.hits.map(h => `${h.label}×${h.count}`).join('、')}`
                            : '未发现敏感信息（也请自己扫一眼）'}
                        。确认后仅保存脱敏版，原文不落库、不发送。
                    </div>
                    <div className="flex-1 overflow-y-auto bg-slate-50 rounded-xl p-3 text-xs text-slate-600 whitespace-pre-wrap leading-relaxed border border-slate-200">
                        {result.text.slice(0, 8000)}{result.text.length > 8000 ? '…（预览截断，完整内容会保存）' : ''}
                    </div>
                    <div className="flex gap-2 mt-4">
                        <button onClick={() => setResumePreview(null)} className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-600 text-sm font-semibold active:scale-95 transition-transform">取消</button>
                        <button onClick={confirmResumeImport} className="flex-1 py-2.5 rounded-xl bg-sky-500 text-white text-sm font-semibold active:scale-95 transition-transform">确认导入</button>
                    </div>
                </div>
            </div>
        );
    };

    // ─── 渲染：工作台设置（阅读体验/自动朗读/记忆沉淀）───

    const renderSettingsModal = () => (
        <div className="absolute inset-0 z-50 bg-black/30 flex items-end" onClick={() => setShowJhSettings(false)}>
            <div className="w-full bg-white rounded-t-3xl p-5 max-h-[80%] overflow-y-auto" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))' }}>
                <div className="font-bold text-slate-800 mb-4">工作台设置</div>
                <div className="space-y-5">
                    <div>
                        <div className="text-xs font-bold text-slate-500 mb-2">文档流字号</div>
                        <div className="flex gap-2">
                            {([[0.9, '小'], [1, '标准'], [1.1, '大'], [1.2, '特大']] as const).map(([v, label]) => (
                                <button key={v} onClick={() => patchJhSettings({ zoom: v })}
                                    className={`px-3.5 py-2 text-xs font-bold rounded-xl border transition-all active:scale-95 ${jhSettings.zoom === v ? 'bg-sky-50 text-sky-600 border-sky-200 ring-1 ring-sky-100' : 'bg-white text-slate-500 border-slate-200'}`}>
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <button onClick={() => patchJhSettings({ typewriter: !jhSettings.typewriter })}
                        className="w-full flex items-center justify-between bg-slate-50 rounded-2xl px-4 py-3 active:scale-[0.98] transition-transform">
                        <div className="text-left">
                            <div className="text-xs font-bold text-slate-700">打字机效果</div>
                            <div className="text-[10px] text-slate-400 mt-0.5">关掉后长回复直接整段呈现</div>
                        </div>
                        <div className={`w-11 h-6 rounded-full p-0.5 transition-colors shrink-0 ${jhSettings.typewriter ? 'bg-sky-500' : 'bg-slate-300'}`}>
                            <div className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${jhSettings.typewriter ? 'translate-x-5' : ''}`} />
                        </div>
                    </button>
                    <div>
                        <div className="text-xs font-bold text-slate-500 mb-1">回复自动朗读</div>
                        <div className="text-[10px] text-slate-400 mb-2">需要角色已配音色；没配音色会静默跳过</div>
                        <div className="flex gap-2">
                            {([['off', '关闭'], ['interview', '仅面试读题'], ['all', '所有回复']] as const).map(([v, label]) => (
                                <button key={v} onClick={() => patchJhSettings({ autoSpeak: v })}
                                    className={`px-3.5 py-2 text-xs font-bold rounded-xl border transition-all active:scale-95 ${jhSettings.autoSpeak === v ? 'bg-sky-50 text-sky-600 border-sky-200 ring-1 ring-sky-100' : 'bg-white text-slate-500 border-slate-200'}`}>
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <button onClick={() => patchJhSettings({ autoMemorySync: !jhSettings.autoMemorySync })}
                            className="w-full flex items-center justify-between bg-slate-50 rounded-2xl px-4 py-3 active:scale-[0.98] transition-transform">
                            <div className="text-left">
                                <div className="text-xs font-bold text-slate-700">离开会话自动沉淀记忆</div>
                                <div className="text-[10px] text-slate-400 mt-0.5">退出聊天时静默把新内容喂进记忆宫殿（先代号化+脱敏）</div>
                            </div>
                            <div className={`w-11 h-6 rounded-full p-0.5 transition-colors shrink-0 ${jhSettings.autoMemorySync ? 'bg-violet-500' : 'bg-slate-300'}`}>
                                <div className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${jhSettings.autoMemorySync ? 'translate-x-5' : ''}`} />
                            </div>
                        </button>
                        {jhSettings.autoMemorySync && (
                            <div className="flex items-center gap-2 mt-2 px-1">
                                <span className="text-[11px] text-slate-500 shrink-0">新消息满</span>
                                {[4, 6, 10, 16].map(v => (
                                    <button key={v} onClick={() => patchJhSettings({ syncThreshold: v })}
                                        className={`px-2.5 py-1 text-[11px] font-bold rounded-lg border transition-all active:scale-95 ${jhSettings.syncThreshold === v ? 'bg-violet-50 text-violet-600 border-violet-200' : 'bg-white text-slate-400 border-slate-200'}`}>
                                        {v} 条
                                    </button>
                                ))}
                                <span className="text-[11px] text-slate-500">才沉淀</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );

    // ─── 渲染：聊天视图（文档流）───────────────────────────

    if (view === 'chat' && activeSession) {
        const interview = activeSession.interview;
        const msgs = activeSession.messages;
        // 打字机进行中：最后一条角色消息用 typingText 替换展示
        let lastCharIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'char') { lastCharIdx = i; break; } }
        return (
            <div className="h-full w-full bg-[#f6f8fa] flex flex-col font-sans relative">
                {/* 顶栏 */}
                <div className="bg-white/85 backdrop-blur-md border-b border-slate-200/80 shrink-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-3 py-2.5 gap-2">
                        <button onClick={handleLeaveChat} className="p-2 rounded-full hover:bg-slate-100 active:scale-90 transition-transform">
                            <CaretLeft className="w-5 h-5 text-slate-600" />
                        </button>
                        <div className="flex-1 min-w-0">
                            <div className="text-slate-800 font-bold text-sm truncate">{activeSession.title}</div>
                            <div className="text-[11px] text-slate-400 truncate">
                                {sessionChar?.name || '角色已删除'}{activeSession.topic === 'interview' ? ' · 面试官模式' : ' · 求职工作台'}
                            </div>
                        </div>
                        {/* 记忆沉淀仅面试会话保留：日常对话已进单聊，由现有记忆体系覆盖 */}
                        {activeSession.topic === 'interview' && (
                        <button
                            onClick={() => syncSessionToMemory(activeSession, false)}
                            disabled={memorySyncBusy}
                            className="text-[11px] px-2.5 py-1.5 rounded-full bg-violet-50 text-violet-600 border border-violet-100 active:scale-95 transition-transform disabled:opacity-50"
                        >
                            {memorySyncBusy ? '沉淀中…' : '沉淀记忆'}
                        </button>
                        )}
                    </div>
                    {/* 面试进度条 */}
                    {interview && (
                        <div className="px-4 pb-2.5">
                            <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                                <span>{interview.finished ? '面试环节已结束' : `第 ${Math.min(interview.currentIndex + 1, interview.questions.length)} / ${interview.questions.length} 题`}</span>
                                <button onClick={generateInterviewEval} disabled={isSending} className="text-sky-600 font-semibold disabled:opacity-50">
                                    {interview.finished ? '生成评价报告' : '提前结束并生成评价'}
                                </button>
                            </div>
                            <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                <div className="h-full bg-sky-500 rounded-full transition-all duration-500"
                                    style={{ width: `${Math.round(((interview.finished ? interview.questions.length : interview.currentIndex) / Math.max(1, interview.questions.length)) * 100)}%` }} />
                            </div>
                        </div>
                    )}
                </div>

                {/* 文档流消息区 */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 space-y-4"
                    style={{ fontSize: `${jhSettings.zoom}em` }}>
                    {msgs.length === 0 && !isSending && (
                        <div className="text-center text-slate-400 text-sm mt-16 px-8 leading-relaxed">
                            {activeSession.topic === 'interview'
                                ? '面试准备中…'
                                : `跟${sessionChar?.name || '角色'}聊聊你的求职情况吧。已建档的岗位有进展、或聊出值得记的结论时，${sessionChar?.name || 'ta'}会自己记到工作台里。`}
                        </div>
                    )}
                    {msgs.map((msg, idx) => {
                        const isTypingThis = idx === lastCharIdx && !!typingText;
                        if (msg.role === 'user') {
                            return (
                                <div key={idx} className="pl-3 border-l-[3px] border-slate-300/70">
                                    <div className="text-[13px] text-slate-500 whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                                </div>
                            );
                        }
                        return (
                            <div key={idx} className="bg-white rounded-2xl border border-slate-200/70 shadow-sm p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    {sessionChar?.avatar
                                        ? <img src={sessionChar.avatar} className="w-6 h-6 rounded-full object-cover border border-slate-200" alt="" />
                                        : <div className="w-6 h-6 rounded-full bg-sky-100 flex items-center justify-center text-[10px] text-sky-600 font-bold">{(sessionChar?.name || '?').slice(0, 1)}</div>}
                                    <span className="text-xs font-semibold text-slate-500">{sessionChar?.name || '角色'}</span>
                                    <span className="text-[10px] text-slate-300 ml-auto">{new Date(msg.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                                    {sessionChar && characterHasVoice(sessionChar, apiConfig) && (
                                        <button onClick={() => playMessageVoice(msg, idx)} className="p-1 rounded-full hover:bg-slate-100 active:scale-90 transition-transform">
                                            {ttsBusyIdx === idx
                                                ? <CircleNotch className="w-4 h-4 text-sky-500 animate-spin" />
                                                : playingIdx === idx
                                                    ? <StopCircle className="w-4 h-4 text-sky-600" weight="fill" />
                                                    : <SpeakerHigh className="w-4 h-4 text-slate-400" />}
                                        </button>
                                    )}
                                </div>
                                <MarkdownBlock text={isTypingThis ? typingText : msg.content} />
                            </div>
                        );
                    })}
                    {isSending && !typingText && (
                        <div className="flex items-center gap-2 text-slate-400 text-sm px-1">
                            <CircleNotch className="w-4 h-4 animate-spin" />
                            {sessionChar?.name || '角色'}正在思考…
                        </div>
                    )}
                    <div className="h-2" />
                </div>

                {/* 语音输入状态条（状态机全外显：启动/在听波形/识别中/失败原因逐态有字） */}
                {sttPhase !== 'idle' && (
                    <div className="mx-4 mb-2 px-3 py-2 rounded-xl bg-sky-50 border border-sky-100 flex items-center gap-2 text-xs text-sky-700">
                        {sttPhase === 'listening' ? (
                            <div className="flex items-end gap-0.5 h-4">
                                {[0.4, 0.8, 0.6, 1, 0.5].map((f, i) => (
                                    <div key={i} className="w-1 bg-sky-500 rounded-full transition-all duration-100"
                                        style={{ height: `${Math.max(3, Math.min(16, 4 + sttLevel * 14 * f))}px` }} />
                                ))}
                            </div>
                        ) : <CircleNotch className="w-3.5 h-3.5 animate-spin" />}
                        <span className="flex-1">{sttHint || (sttPhase === 'starting' ? '正在启动识别器…' : sttPhase === 'recognizing' ? '识别中…' : '在听…')}</span>
                        <button onClick={toggleStt} className="font-semibold text-sky-600">停止</button>
                    </div>
                )}

                {/* 输入区 */}
                <div className="bg-white/95 backdrop-blur-xl border-t border-slate-200/80 px-3 py-2.5" style={{ paddingBottom: 'max(0.625rem, var(--safe-bottom))' }}>
                    {showPlusMenu && (
                        <div className="flex gap-2 pb-2.5 flex-wrap">
                            <button onClick={() => { setShowPlusMenu(false); setShowResumePicker(true); }}
                                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 active:scale-95 transition-transform">
                                <FileText className="w-4 h-4" /> 引用简历
                            </button>
                            <button onClick={() => { setShowPlusMenu(false); fileInputRef.current?.click(); }}
                                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 active:scale-95 transition-transform">
                                <UploadSimple className="w-4 h-4" /> 导入新简历
                            </button>
                            <button onClick={() => { setShowPlusMenu(false); setShowApiHub(true); }}
                                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 active:scale-95 transition-transform">
                                <Plugs className="w-4 h-4" /> API 配置
                            </button>
                            <button onClick={() => { setShowPlusMenu(false); setShowJhSettings(true); }}
                                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 active:scale-95 transition-transform">
                                <GearSix className="w-4 h-4" /> 设置
                            </button>
                        </div>
                    )}
                    <div className="flex items-end gap-2">
                        <button onClick={() => setShowPlusMenu(v => !v)} className="p-2.5 rounded-full bg-slate-100 text-slate-500 active:scale-90 transition-transform shrink-0">
                            <Plus className={`w-5 h-5 transition-transform ${showPlusMenu ? 'rotate-45' : ''}`} />
                        </button>
                        <textarea
                            ref={chatInputRef}
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            placeholder={activeSession.topic === 'interview' ? '回答面试官的问题…' : '说说你的求职情况…'}
                            rows={1}
                            className="flex-1 resize-none bg-slate-100 rounded-2xl px-4 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-sky-200 max-h-28"
                            style={{ minHeight: '42px' }}
                            onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = `${Math.min(112, t.scrollHeight)}px`; }}
                        />
                        {sttSupported && (
                            <button onClick={toggleStt} className={`p-2.5 rounded-full shrink-0 active:scale-90 transition-transform ${sttPhase !== 'idle' ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                <Microphone className="w-5 h-5" />
                            </button>
                        )}
                        <button onClick={() => sendMessage()} disabled={!input.trim() || isSending}
                            className="p-2.5 rounded-full bg-sky-500 text-white shrink-0 active:scale-90 transition-transform disabled:opacity-40">
                            <PaperPlaneTilt className="w-5 h-5" weight="fill" />
                        </button>
                    </div>
                </div>

                {/* 简历选择弹窗 */}
                {showResumePicker && (
                    <div className="absolute inset-0 z-40 bg-black/30 flex items-end" onClick={() => setShowResumePicker(false)}>
                        <div className="w-full bg-white rounded-t-3xl p-5 max-h-[60%] overflow-y-auto" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))' }}>
                            <div className="font-bold text-slate-800 mb-3">选一份简历发给{sessionChar?.name || '角色'}</div>
                            {resumes.length === 0 && <div className="text-sm text-slate-400 py-6 text-center">还没导入过简历，先点「导入新简历」</div>}
                            <div className="space-y-2">
                                {resumes.map(r => (
                                    <button key={r.id} onClick={() => sendResumeToChat(r)}
                                        className="w-full text-left px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 active:scale-[0.98] transition-transform">
                                        <div className="text-sm font-semibold text-slate-700">{r.name}</div>
                                        <div className="text-[11px] text-slate-400 mt-0.5">{r.sourceFormat.toUpperCase()} · {new Date(r.createdAt).toLocaleDateString('zh-CN')} · 已脱敏</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* 隐藏文件输入（聊天里也能导）+ 脱敏预览 */}
                <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleResumeFile(f); }} />
                {resumePreview && renderRedactPreview()}
                {sessionChar && (
                    <CharApiHubModal isOpen={showApiHub} onClose={() => setShowApiHub(false)} char={sessionChar}
                        apiConfig={apiConfig}
                        onSave={(patch) => { updateCharacter(sessionChar.id, patch); addToast('API 配置已保存', 'success'); }} />
                )}
                {showJhSettings && renderSettingsModal()}
            </div>
        );
    }

    // ─── 渲染：主页（工作台/岗位/笔记本 三 tab，备忘录质感）───

    const sessionCharName = (s: JobSession) => characters.find(c => c.id === s.charId)?.name || '角色已删除';

    return (
        <div className="h-full w-full bg-[#f6f8fa] flex flex-col font-sans relative">
            {/* 顶栏 */}
            <div className="bg-white/85 backdrop-blur-md border-b border-slate-200/80 shrink-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center px-3 py-2.5">
                    <button onClick={closeApp} className="p-2 rounded-full hover:bg-slate-100 active:scale-90 transition-transform">
                        <CaretLeft className="w-5 h-5 text-slate-600" />
                    </button>
                    <div className="flex items-center gap-1.5 ml-1">
                        <ReadCvLogo className="w-5 h-5 text-sky-500" weight="fill" />
                        <span className="font-bold text-slate-800">上岸计划</span>
                    </div>
                    <button onClick={() => setShowJhSettings(true)} className="p-2 ml-1 rounded-full hover:bg-slate-100 active:scale-90 transition-transform">
                        <GearSix className="w-[18px] h-[18px] text-slate-400" />
                    </button>
                    <div className="ml-auto flex items-center gap-1 overflow-x-auto no-scrollbar max-w-[55%]">
                        {characters.slice(0, 8).map(c => (
                            <button key={c.id} onClick={() => setSelectedCharId(c.id)}
                                className={`shrink-0 rounded-full border-2 transition-all ${selectedCharId === c.id ? 'border-sky-400 scale-105' : 'border-transparent opacity-60'}`}>
                                {c.avatar
                                    ? <img src={c.avatar} className="w-8 h-8 rounded-full object-cover" alt={c.name} />
                                    : <div className="w-8 h-8 rounded-full bg-sky-100 flex items-center justify-center text-xs text-sky-600 font-bold">{c.name.slice(0, 1)}</div>}
                            </button>
                        ))}
                    </div>
                </div>
                {/* Tab 栏 */}
                <div className="flex px-4 gap-5">
                    {([['sessions', '工作台', ChatsCircle], ['positions', '岗位', Briefcase], ['notebook', '笔记本', Notebook]] as const).map(([key, label, Icon]) => (
                        <button key={key} onClick={() => setHomeTab(key)}
                            className={`flex items-center gap-1 pb-2 text-sm font-semibold border-b-2 transition-colors ${homeTab === key ? 'text-sky-600 border-sky-500' : 'text-slate-400 border-transparent'}`}>
                            <Icon className="w-4 h-4" /> {label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 pb-28">
                {/* Tab 1：工作台 = 模拟面试记录（日常求职对话已并入单聊） */}
                {homeTab === 'sessions' && (
                    <div className="space-y-2.5">
                        {/* 和角色聊求职 → 跳单聊（求职能力已并入，在加号菜单第 2 页开求职模式） */}
                        <button
                            onClick={() => { if (selectedCharId) setActiveCharacterId(selectedCharId); openApp(AppID.Chat); }}
                            className="w-full text-left px-4 py-3.5 rounded-2xl bg-gradient-to-r from-sky-500 to-cyan-500 text-white shadow-sm active:scale-[0.98] transition-transform"
                        >
                            <div className="text-sm font-bold">和{selectedChar?.name || '角色'}聊求职 → 去单聊</div>
                            <div className="text-[11px] text-white/80 mt-0.5">日常求职对话已并入单聊：开启求职模式后，TA 能看到岗位/笔记还能帮你记录</div>
                        </button>
                        {sessions.filter(s => s.topic === 'interview').length === 0 && (
                            <div className="text-center text-slate-400 text-sm mt-12 px-8 leading-relaxed">
                                这里只存模拟面试记录。<br />到「岗位」tab 的岗位卡上发起模拟面试；日常聊求职直接去单聊。
                            </div>
                        )}
                        {sessions.filter(s => s.topic === 'interview').map(s => (
                            <div key={s.id} onClick={() => { setActiveSession(s); setView('chat'); }}
                                className="bg-white rounded-2xl border border-slate-200/70 shadow-sm p-4 active:scale-[0.99] transition-transform cursor-pointer">
                                <div className="flex items-center gap-2">
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${s.topic === 'interview' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-500'}`}>
                                        {s.topic === 'interview' ? '模拟面试' : s.topic === 'position' ? '岗位' : '闲聊'}
                                    </span>
                                    <span className="text-sm font-semibold text-slate-800 truncate flex-1">{s.title}</span>
                                    <button onClick={e => { e.stopPropagation(); deleteSession(s); }} className="p-1 text-slate-300 hover:text-rose-400">
                                        <Trash className="w-4 h-4" />
                                    </button>
                                </div>
                                <div className="text-xs text-slate-400 mt-1.5 truncate">
                                    {s.messages.length ? s.messages[s.messages.length - 1].content.slice(0, 60) : '还没开始聊'}
                                </div>
                                <div className="text-[10px] text-slate-300 mt-1">{sessionCharName(s)} · {new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {s.messages.length} 条</div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Tab 2：岗位看板 */}
                {homeTab === 'positions' && (
                    <div className="space-y-2.5">
                        {positions.length === 0 && (
                            <div className="text-center text-slate-400 text-sm mt-16 px-8 leading-relaxed">
                                还没有在推进的岗位。<br />建卡时公司用代号（A厂/B司），真实公司名只存在本机、永远不会发给 AI。
                            </div>
                        )}
                        {positions.map(p => (
                            <div key={p.id} className="bg-white rounded-2xl border border-slate-200/70 shadow-sm p-4">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-bold text-slate-800">{p.code}</span>
                                    <span className="text-sm text-slate-500 truncate flex-1">{p.title}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${STAGE_STYLE[p.stage]}`}>{STAGE_LABEL[p.stage]}</span>
                                </div>
                                {p.companyNameLocal && (
                                    <div className="text-[11px] text-slate-400 mt-1">备注（仅本机可见）：{p.companyNameLocal}</div>
                                )}
                                {p.nextStep && (
                                    <div className="text-xs text-sky-600 bg-sky-50 rounded-lg px-2.5 py-1.5 mt-2">下一步：{p.nextStep}</div>
                                )}
                                <div className="flex items-center gap-2 mt-3 flex-wrap">
                                    <button onClick={() => { setSelectedCharId(p.charId || selectedCharId); createSession('interview', p.id); }}
                                        className="text-xs px-3 py-1.5 rounded-lg bg-sky-500 text-white font-semibold active:scale-95 transition-transform">模拟面试</button>
                                    <button onClick={() => { if (p.charId || selectedCharId) setActiveCharacterId(p.charId || selectedCharId); openApp(AppID.Chat); }}
                                        className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-semibold active:scale-95 transition-transform">聊这个岗位 → 单聊</button>
                                    <select value={p.stage} onChange={e => advanceStage(p, e.target.value as JobStage)}
                                        className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-slate-500 outline-none ml-auto">
                                        {(Object.keys(STAGE_LABEL) as JobStage[]).map(st => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
                                    </select>
                                    <button onClick={() => openEditPosition(p)} className="text-xs text-slate-400 px-1">编辑</button>
                                    <button onClick={() => deletePosition(p)} className="p-1 text-slate-300 hover:text-rose-400"><Trash className="w-4 h-4" /></button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Tab 3：笔记本 = 角色帮你记的东西 + 简历库 */}
                {homeTab === 'notebook' && (
                    <div>
                        {notes.length === 0 && (
                            <div className="text-center text-slate-400 text-sm mt-10 mb-6 px-8 leading-relaxed">
                                角色帮你记的面试评价、简历建议、岗位分析都会集中在这里，方便回看。
                            </div>
                        )}
                        <div className="space-y-2.5">
                            {notes.map(n => (
                                <div key={n.id} onClick={() => setViewingNote(n)}
                                    className="bg-white rounded-2xl border border-slate-200/70 shadow-sm p-4 active:scale-[0.99] transition-transform cursor-pointer">
                                    <div className="flex items-center gap-2">
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${NOTE_KIND_STYLE[n.kind]}`}>{NOTE_KIND_LABEL[n.kind]}</span>
                                        <span className="text-sm font-semibold text-slate-800 truncate flex-1">{n.title}</span>
                                    </div>
                                    <div className="text-xs text-slate-400 mt-1.5">{n.content.replace(/[#*`>]/g, '').slice(0, 80)}</div>
                                    <div className="text-[10px] text-slate-300 mt-1">{characters.find(c => c.id === n.charId)?.name || ''} · {new Date(n.createdAt).toLocaleDateString('zh-CN')}</div>
                                </div>
                            ))}
                        </div>
                        {/* 简历库 */}
                        <div className="mt-6">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">简历库（已脱敏）</span>
                            <div className="flex items-center gap-3">
                                <button onClick={() => setShowPasteImport(true)}
                                    className="text-xs text-slate-500 font-semibold">粘贴导入</button>
                                <button onClick={() => fileInputRef.current?.click()} disabled={importBusy}
                                    className="flex items-center gap-1 text-xs text-sky-600 font-semibold disabled:opacity-50">
                                    {importBusy ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <UploadSimple className="w-3.5 h-3.5" />}
                                    导入 PDF/DOCX/TXT
                                </button>
                            </div>
                            </div>
                            {resumes.length === 0 && <div className="text-xs text-slate-400 bg-white rounded-2xl border border-dashed border-slate-200 p-4 text-center">还没导入简历。导入时会本地打码手机号/邮箱/身份证等，确认后才保存。</div>}
                            <div className="space-y-2">
                                {resumes.map(r => (
                                    <div key={r.id} className="bg-white rounded-2xl border border-slate-200/70 shadow-sm px-4 py-3 flex items-center gap-2">
                                        <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-semibold text-slate-700 truncate">{r.name}</div>
                                            <div className="text-[10px] text-slate-400">{r.sourceFormat.toUpperCase()} · {new Date(r.createdAt).toLocaleDateString('zh-CN')} · {r.rawText.length} 字</div>
                                        </div>
                                        <button onClick={() => deleteResume(r)} className="p-1 text-slate-300 hover:text-rose-400"><Trash className="w-4 h-4" /></button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* 悬浮新建按钮 */}
            <div className="absolute right-5 z-30" style={{ bottom: 'max(1.5rem, calc(var(--safe-bottom) + 1rem))' }}>
                <button
                    onClick={() => { if (homeTab === 'positions') { setEditingPosition(null); setPosCode(''); setPosTitle(''); setPosCompanyLocal(''); setPosNextStep(''); setShowNewPosition(true); } else setShowNewSession(true); }}
                    className="p-4 rounded-2xl bg-sky-500 text-white shadow-lg shadow-sky-200 active:scale-90 transition-transform">
                    <Plus className="w-6 h-6" weight="bold" />
                </button>
            </div>

            {/* 新建会话弹窗：日常求职对话已并入单聊，这里只留去单聊 + 面试指引 */}
            {showNewSession && (
                <div className="absolute inset-0 z-40 bg-black/30 flex items-end" onClick={() => setShowNewSession(false)}>
                    <div className="w-full bg-white rounded-t-3xl p-5" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))' }}>
                        <div className="font-bold text-slate-800 mb-1">和{selectedChar?.name || '角色'}聊求职</div>
                        <div className="text-xs text-slate-400 mb-4">日常求职对话已并入单聊；模拟面试请到「岗位」tab 从岗位卡发起</div>
                        <div className="space-y-2">
                            <button onClick={() => { setShowNewSession(false); if (selectedCharId) setActiveCharacterId(selectedCharId); openApp(AppID.Chat); }}
                                className="w-full text-left px-4 py-3.5 rounded-2xl bg-sky-50 border border-sky-200 active:scale-[0.98] transition-transform">
                                <div className="text-sm font-semibold text-sky-700">去单聊聊求职 →</div>
                                <div className="text-[11px] text-slate-400 mt-0.5">焦虑/选 offer/盘进展都在单聊里聊，开启求职模式后 TA 还能帮你建卡记笔记</div>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 新建/编辑岗位弹窗 */}
            {showNewPosition && (
                <div className="absolute inset-0 z-40 bg-black/30 flex items-end" onClick={() => { setShowNewPosition(false); setEditingPosition(null); }}>
                    <div className="w-full bg-white rounded-t-3xl p-5" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))' }}>
                        <div className="font-bold text-slate-800 mb-4">{editingPosition ? '编辑岗位卡' : '新建岗位卡'}</div>
                        <div className="space-y-3">
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">公司代号 *（发给 AI 的只有代号）</label>
                                <input value={posCode} onChange={e => setPosCode(e.target.value)} placeholder="如：A厂、B司"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">岗位名 *</label>
                                <input value={posTitle} onChange={e => setPosTitle(e.target.value)} placeholder="如：前端开发工程师"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">真实公司名（选填，仅本机，永不发给 AI）</label>
                                <input value={posCompanyLocal} onChange={e => setPosCompanyLocal(e.target.value)} placeholder="只是给你自己看的备注"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">下一步（选填）</label>
                                <input value={posNextStep} onChange={e => setPosNextStep(e.target.value)} placeholder="如：周四二面"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                        </div>
                        <button onClick={savePosition} className="w-full mt-4 py-3 rounded-xl bg-sky-500 text-white text-sm font-bold active:scale-[0.98] transition-transform">保存</button>
                    </div>
                </div>
            )}

            {/* 笔记详情弹窗 */}
            {viewingNote && (
                <div className="absolute inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => setViewingNote(null)}>
                    <div className="w-full max-w-md bg-white rounded-3xl p-5 max-h-[85%] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2 mb-3">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${NOTE_KIND_STYLE[viewingNote.kind]}`}>{NOTE_KIND_LABEL[viewingNote.kind]}</span>
                            <span className="font-bold text-slate-800 truncate flex-1">{viewingNote.title}</span>
                            <button onClick={() => deleteNote(viewingNote)} className="p-1 text-slate-300 hover:text-rose-400"><Trash className="w-4 h-4" /></button>
                            <button onClick={() => setViewingNote(null)} className="p-1 text-slate-400"><X className="w-4 h-4" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            <MarkdownBlock text={viewingNote.content} />
                        </div>
                        <div className="text-[10px] text-slate-300 mt-3">
                            {characters.find(c => c.id === viewingNote.charId)?.name || ''} · {new Date(viewingNote.createdAt).toLocaleString('zh-CN')}
                            {viewingNote.sessionId && sessions.some(s => s.id === viewingNote.sessionId) && (
                                <button className="text-sky-500 font-semibold ml-2"
                                    onClick={() => { const src = sessions.find(x => x.id === viewingNote.sessionId); if (src) { setViewingNote(null); setActiveSession(src); setView('chat'); } }}>
                                    回到来源会话 →
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* 粘贴导入弹窗 */}
            {showPasteImport && (
                <div className="absolute inset-0 z-40 bg-black/30 flex items-end" onClick={() => setShowPasteImport(false)}>
                    <div className="w-full bg-white rounded-t-3xl p-5" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))' }}>
                        <div className="font-bold text-slate-800 mb-1">粘贴简历文本</div>
                        <div className="text-xs text-slate-400 mb-3">确认前会先本地打码手机号/邮箱/身份证等敏感信息</div>
                        <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={8}
                            placeholder="把简历文本粘到这里…"
                            className="w-full bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200 resize-none" />
                        <button onClick={handlePasteImport} className="w-full mt-3 py-3 rounded-xl bg-sky-500 text-white text-sm font-bold active:scale-[0.98] transition-transform">脱敏预览</button>
                    </div>
                </div>
            )}

            {/* 隐藏文件输入 + 脱敏预览 + 工作台设置 */}
            <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleResumeFile(f); }} />
            {resumePreview && renderRedactPreview()}
            {showJhSettings && renderSettingsModal()}
        </div>
    );
};

export default JobHuntApp;
