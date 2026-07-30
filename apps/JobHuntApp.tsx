// 上岸计划 — 角色辅助求职工作台
// 定位：聊天是过程，沉淀下来的岗位进展/面试评价/简历建议才是资产。视觉像备忘录。
// 对话流是文档流而非气泡（参照 StudyApp 骨架）：角色发言=完整 markdown 块，用户发言=浅色引用条。
// 隐私两道闸：公司代号制（companyNameLocal 永不进 prompt）+ 简历/入记忆文本本地脱敏。
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { useBackGuard } from '../hooks/useBackGuard';
import { DB } from '../utils/db';
import {
    CharacterProfile, JobSession, JobPosition, JobNote, JobResume, JobProfile,
    JobChatMessage, JobStage, JobNoteKind, AppID,
} from '../types';
import { ContextBuilder } from '../utils/context';
import { resilientFetch } from '../utils/resilientFetch';
import { parseJobHuntCommands, JOB_COMMAND_GUIDE, normalizeJobStage } from '../utils/jobHuntParser';
import { buildPositionPromptLine, fmtJobTime, nextInterviewTs, waitingDays, ROUND_KIND_LABEL, ROUND_STATUS_LABEL, relTimeLabel } from '../utils/jobDirectives';
import { parseResumeIntoProfile } from '../utils/jobProfileGen';
import { JobHuntSettings, JH_SETTINGS_KEY, loadJhSettings, JobApiRef } from '../utils/jobHuntSettings';
import { redactPrivacy, codifyCompanies, genCompanyCode, RedactResult, NameRedactMode } from '../utils/privacyRedact';
import { synthesizeSpeech, characterHasVoice } from '../utils/ttsRouter';
import { hashTtsParams, getCachedTts, saveCachedTts } from '../utils/ttsCache';
import { startStt, isSttSupported, SttSession, SttProviderConfig } from '../utils/speechToText';
import {
    ReadCvLogo, PaperPlaneTilt, Microphone, Plus, CaretLeft, Notebook, Briefcase,
    ChatsCircle, FileText, Trash, SpeakerHigh, StopCircle, X, CircleNotch, UploadSimple,
    GearSix, Plugs, Question, ShieldCheck, PencilSimple,
} from '@phosphor-icons/react';
import { RealtimeContextManager, defaultRealtimeConfig } from '../utils/realtimeContext';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { resolveCharTimeZone, nowInTimeZone } from '../utils/timezone';
import CharApiHubModal from '../components/chat/CharApiHubModal';
import ApiConnectionPicker from '../components/os/ApiConnectionPicker';

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
    watching: '观望中', applied: '已投递', written: '笔试中', interview: '面试中', offer_talk: '沟通Offer', offer: '已接受Offer', rejected: '已结束',
};
const STAGE_STYLE: Record<JobStage, string> = {
    watching: 'bg-violet-100 text-violet-600',
    applied: 'bg-slate-100 text-slate-600',
    written: 'bg-amber-100 text-amber-700',
    interview: 'bg-sky-100 text-sky-700',
    offer_talk: 'bg-teal-100 text-teal-700',
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

// 阶段进度权重（排序用）：观望→投递→笔试→面试→沟通Offer→上岸；已结束排最后
const STAGE_ORDER: Record<JobStage, number> = {
    watching: 0, applied: 1, written: 2, interview: 3, offer_talk: 4, offer: 5, rejected: 6,
};

// 环节状态胶囊配色（与聊天聚合卡同色系）
const ROUND_STATUS_STYLE: Record<string, string> = {
    pending: 'bg-slate-100 text-slate-500',
    scheduled: 'bg-cyan-100 text-cyan-700',
    awaiting: 'bg-amber-100 text-amber-700',
    passed: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-rose-100 text-rose-500',
};

// datetime-local 输入值 ⇄ 时间戳
const tsToLocalInput = (ts?: number): string => {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const localInputToTs = (v: string): number | undefined => {
    if (!v.trim()) return undefined;
    const ts = new Date(v).getTime();
    return Number.isFinite(ts) ? ts : undefined;
};
// 面试倒计时文案（按自然日算）
const ivCountdownLabel = (ts: number): string => {
    const now = new Date();
    const d = new Date(ts);
    const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
    return dayDiff <= 0 ? '就在今天' : dayDiff === 1 ? '就在明天' : `还有 ${dayDiff} 天`;
};

// ─── 工作台本地设置（提取至 utils/jobHuntSettings.ts，单聊注入/通话多方共读）───

const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

type SttPhase = 'idle' | 'starting' | 'listening' | 'recognizing';

// ─── 主组件 ─────────────────────────────────────────────

// 2.0 旧会话迁移的模块级同步闸：StrictMode 双跑 effect 时第二次能同步看到，
// 不像 localStorage 标记要等异步迁移跑完才写入
let jobMigrationRunning = false;

const JobHuntApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, setActiveCharacterId, openApp, apiConfig, addToast, userProfile, memoryPalaceConfig, realtimeConfig, updateCharacter, openCallWithChar } = useOS();

    // 数据
    const [sessions, setSessions] = useState<JobSession[]>([]);
    const [positions, setPositions] = useState<JobPosition[]>([]);
    const [notes, setNotes] = useState<JobNote[]>([]);
    const [resumes, setResumes] = useState<JobResume[]>([]);
    const [jobProfile, setJobProfile] = useState<JobProfile | null>(null);
    const [parsingResumeId, setParsingResumeId] = useState<string | null>(null);

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
    // 简历导入 · 生成脱敏预览前先弹打码选项（默认勾选基础敏感信息+姓名，公司/学校/项目名靠手填词）
    const [pendingImport, setPendingImport] = useState<{ name: string; format: JobResume['sourceFormat']; rawText: string } | null>(null);
    const [impPii, setImpPii] = useState(true);
    const [impName, setImpName] = useState(true);
    const [impNameMode, setImpNameMode] = useState<NameRedactMode>('fixed');
    const [impCustomTerms, setImpCustomTerms] = useState('');
    const [impCustomMode, setImpCustomMode] = useState<'hide' | 'initial'>('hide');
    // 脱敏预览 · 可编辑正文 + Markdown 渲染/编辑态切换
    const [previewEditText, setPreviewEditText] = useState('');
    const [previewMdMode, setPreviewMdMode] = useState(false);

    // 新建岗位表单
    const [posCode, setPosCode] = useState('');
    const [posTitle, setPosTitle] = useState('');
    const [posCompanyLocal, setPosCompanyLocal] = useState('');
    const [posNextStep, setPosNextStep] = useState('');
    const [posJd, setPosJd] = useState('');
    const [posHrName, setPosHrName] = useState('');
    const [posProjectName, setPosProjectName] = useState('');
    const [posLocation, setPosLocation] = useState('');
    const [posNotes, setPosNotes] = useState(''); // 岗位笔记（多行，注入时同 JD 脱敏+截断）
    const [posInterviewAt, setPosInterviewAt] = useState(''); // datetime-local 值，空=未定/清除
    const [posWaiting, setPosWaiting] = useState(false);
    // 代号是否被用户手改过：手改即锁（codeLocked），自动生成与 AI 都不再覆盖
    const [posCodeDirty, setPosCodeDirty] = useState(false);
    // 岗位卡上展开查看 JD 的卡片 id（同时只展开一张）
    const [jdOpenId, setJdOpenId] = useState<string | null>(null);
    // 岗位卡上展开查看笔记的卡片 id（与 JD 展开互不影响）
    const [notesOpenId, setNotesOpenId] = useState<string | null>(null);
    // 岗位浏览工具条（纯前端过滤排序）
    const [posSearch, setPosSearch] = useState('');
    const [posStageFilter, setPosStageFilter] = useState<Set<JobStage>>(new Set());
    const [posSort, setPosSort] = useState<'updated' | 'stage' | 'company'>('updated');
    const [posGroupBy, setPosGroupBy] = useState<'none' | 'stage' | 'title'>('none');
    // 多选批量操作
    const [posSelectMode, setPosSelectMode] = useState(false);
    const [selectedPosIds, setSelectedPosIds] = useState<Set<string>>(new Set());
    // 顶栏角色切换下拉
    const [showCharPicker, setShowCharPicker] = useState(false);
    // C3 驾驶舱：竞争力档案编辑 + 模拟练习入口
    const [showProfileEdit, setShowProfileEdit] = useState(false);
    const [showPracticeSetup, setShowPracticeSetup] = useState(false);
    const [profDirection, setProfDirection] = useState('');
    const [profNewEdge, setProfNewEdge] = useState('');
    const [profNewGap, setProfNewGap] = useState('');
    const [profNewGapKind, setProfNewGapKind] = useState<'strategy' | 'resume'>('strategy');
    const [practiceTargetId, setPracticeTargetId] = useState<string>(''); // '' = 综合面试
    const [practiceForm, setPracticeForm] = useState<'text' | 'voice' | 'video'>('text');
    const [practiceMode, setPracticeMode] = useState<'strict' | 'coach'>('strict');
    const [practiceExtra, setPracticeExtra] = useState('');
    const [practiceTplName, setPracticeTplName] = useState('');
    // C5 笔记人工编辑态
    const [noteEditing, setNoteEditing] = useState(false);
    const [noteEditTitle, setNoteEditTitle] = useState('');
    const [noteEditContent, setNoteEditContent] = useState('');

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
    const [showPrivacyInfo, setShowPrivacyInfo] = useState(false); // 隐私说明弹层（顶栏问号）
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

    const sttCfg = useMemo<SttProviderConfig>(() => {
        // 面试会话且配了面试独立 STT：用它（provider 固定 cloud）；否则跟随全局
        const ov = jhSettings.api.stt;
        if (activeSession?.topic === 'interview' && ov?.apiKey) {
            return { provider: 'cloud', baseUrl: ov.baseUrl, apiKey: ov.apiKey, model: ov.model };
        }
        return {
            provider: apiConfig?.sttProvider === 'cloud' && apiConfig?.sttApiKey ? 'cloud' : 'system',
            baseUrl: apiConfig?.sttBaseUrl,
            apiKey: apiConfig?.sttApiKey,
            model: apiConfig?.sttModel,
        };
    }, [activeSession?.topic, jhSettings.api.stt, apiConfig?.sttProvider, apiConfig?.sttBaseUrl, apiConfig?.sttApiKey, apiConfig?.sttModel]);
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
            try { setJobProfile(await DB.getJobProfile()); } catch { /* 档案缺失不阻塞 */ }
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
            .map(p => buildPositionPromptLine(p, positions));
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
            const pt = session.practiceTarget;
            const posDesc = pos ? `「${pos.code} 的 ${pos.title}」` : '综合面试（不限定具体岗位）';
            const toneLine = pt?.mode === 'coach' ? '- 你是轻松陪练：语气鼓励、可以适当给提示和引导。' : '- 你是严肃面试官：正式、简洁、有压力感。';
            ctx += [
                '',
                '### [System: 模拟面试模式]',
                `你现在是${posDesc}的面试官，一次只问一道题。`,
                toneLine,
                pt?.extraPrompt ? `- 额外要求：${pt.extraPrompt}` : '',
                `题目清单（共 ${session.interview.questions.length} 题，按序进行）：`,
                ...session.interview.questions.map((q, i) => `${i + 1}. ${q}`),
                `当前进行到第 ${Math.min(session.interview.currentIndex + 1, session.interview.questions.length)} 题。`,
                '- 用户回答后：先给一两句简短的追问或反馈（保持面试官口吻），然后自然过渡到下一题。',
                '- 全部题目问完后告知面试环节结束，等待用户点击「生成评价」。',
                '- 不要一次抛出多道题。',
            ].filter(Boolean).join('\u000a');
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

    // ─── LLM 调用（resilientFetch：120s + 瞬断补枪）───
    // API 优先级（§13）：面试会话 = interviewApi(jhSettings.api.chat) > jobHuntApiOverride > chatApiOverride > 全局；
    //                    普通岗位会话（不传 interviewApi）= jobHuntApiOverride > chatApiOverride > 全局。
    const callLLM = useCallback(async (systemPrompt: string, history: JobChatMessage[], extraUser?: string, char?: CharacterProfile, interviewApi?: JobApiRef | null): Promise<string> => {
        const eff = interviewApi?.baseUrl ? interviewApi
            : char?.jobHuntApiOverride?.baseUrl ? char.jobHuntApiOverride
            : char?.chatApiOverride?.baseUrl ? char.chatApiOverride
            : apiConfig;
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

    // ─── 发起模拟练习（C4：面试与岗位解耦，综合/岗位 + 两档 + 附加提示词）───
    const startPractice = useCallback(async () => {
        if (!selectedChar) { addToast('先去神经链接里建一个角色吧', 'info'); return; }
        const kind: 'comprehensive' | 'position' = practiceTargetId ? 'position' : 'comprehensive';
        const pos = practiceTargetId ? positions.find(p => p.id === practiceTargetId) : undefined;
        const now = Date.now();
        const extra = practiceExtra.trim();
        // 语音形态：走 CallApp 语音面试（openCallWithChar 携带面试官场景），不建文字会话
        if (practiceForm === 'voice') {
            const posLine = pos ? buildPositionPromptLine(pos, positions) : '';
            const targetDesc = pos ? `「${pos.code} 的 ${pos.title}」` : '综合面试（不限定具体岗位，围绕候选人方向和通用能力）';
            const toneLine = practiceMode === 'coach' ? '风格：轻松陪练，语气鼓励、可适当给提示。' : '风格：严肃面试官，正式、有压力感。';
            const sceneContext = [
                `【模拟面试场景】你现在是${targetDesc}的面试官，正在对候选人 ${userProfile.name} 进行一场电话面试。`,
                toneLine,
                posLine ? `目标岗位信息：${posLine}` : '',
                extra ? `额外要求：${extra}` : '',
                '要求：一次只问一个问题，由浅入深覆盖自我介绍/岗位匹配/项目深挖/软素质；候选人答完再追问或进入下一题；公司一律用代号，不要念真实公司名或任何个人隐私。',
            ].filter(Boolean).join('\u000a');
            setShowPracticeSetup(false);
            openCallWithChar({
                charId: selectedChar.id,
                sceneContext,
                sceneLabel: `模拟面试 · ${pos ? `${pos.code} ${pos.title}` : '综合'} · ${practiceMode === 'coach' ? '轻松陪练' : '严肃面试官'}`,
                // 面试独立 API 三路（§13）：对话 LLM = jhSettings.api.chat > jobHuntApiOverride > chatApiOverride > 全局
                apiOverride: jhSettings.api.chat?.baseUrl ? jhSettings.api.chat
                    : selectedChar.jobHuntApiOverride?.baseUrl ? selectedChar.jobHuntApiOverride
                    : selectedChar.chatApiOverride?.baseUrl ? selectedChar.chatApiOverride
                    : undefined,
                sttOverride: jhSettings.api.stt?.baseUrl
                    ? { baseUrl: jhSettings.api.stt.baseUrl, apiKey: jhSettings.api.stt.apiKey, model: jhSettings.api.stt.model }
                    : undefined,
                ttsProviderOverride: jhSettings.api.ttsProvider !== 'follow' ? jhSettings.api.ttsProvider : undefined,
                audioAnalysis: (jhSettings.api.audioAnalysis && jhSettings.api.audio?.baseUrl)
                    ? { enabled: true, api: { baseUrl: jhSettings.api.audio.baseUrl, apiKey: jhSettings.api.audio.apiKey, model: jhSettings.api.audio.model }, transcribeMode: jhSettings.api.transcribeMode }
                    : undefined,
            });
            return;
        }
        const session: JobSession = {
            id: genId('jses'), charId: selectedChar.id, topic: 'interview', positionId: pos?.id,
            practiceTarget: { kind, positionId: pos?.id, mode: practiceMode, extraPrompt: extra || undefined },
            title: `模拟面试 · ${pos ? `${pos.code} ${pos.title}` : '综合模式'}`,
            messages: [], memorySyncedCount: 0, createdAt: now, updatedAt: now,
        };
        setShowPracticeSetup(false);
        await persistSession(session);
        setActiveSession(session);
        setView('chat');
        await bootstrapInterview(session, selectedChar, pos);
    }, [selectedChar, practiceTargetId, practiceForm, practiceMode, practiceExtra, positions, userProfile, jhSettings, openCallWithChar, persistSession, addToast]);

    // ─── 模拟面试：先生成题目清单，再由面试官抛第一题 ───
    const bootstrapInterview = useCallback(async (session: JobSession, char: CharacterProfile, pos?: JobPosition) => {
        setIsSending(true);
        try {
            const pt = session.practiceTarget;
            const targetDesc = pos ? `「${pos.code} 的 ${pos.title}」` : '综合面试（不限定具体岗位，围绕候选人方向和通用能力）';
            const toneLine = pt?.mode === 'coach' ? '风格：轻松陪练，语气鼓励、可适当给提示。' : '风格：严肃面试官，正式、有压力感。';
            const genPrompt = [
                `你是${targetDesc}的面试官，为候选人 ${userProfile.name} 准备 ${INTERVIEW_QUESTION_COUNT} 道面试题。`,
                toneLine,
                pt?.extraPrompt ? `额外要求：${pt.extraPrompt}` : '',
                '要求：由浅入深，覆盖自我介绍/岗位匹配/项目深挖/软素质；公司只用代号；',
                `严格输出 JSON 字符串数组（长度 ${INTERVIEW_QUESTION_COUNT}），不要输出其它任何内容。`,
            ].filter(Boolean).join('\u000a');
            const raw = await callLLM(genPrompt, [], '请给出题目清单。', char, jhSettings.api.chat);
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
                '（系统：面试开始。请你以面试官身份简短开场，然后提出第 1 题。）', char, jhSettings.api.chat);
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
    }, [userProfile, callLLM, persistSession, buildSystemPrompt, typeOut, addToast, jhSettings.autoSpeak, jhSettings.api.chat]);

    // ─── 面试结束 → 结构化评价报告 → 自动归档笔记本 ───
    const generateInterviewEval = useCallback(async () => {
        if (!activeSession || !sessionChar || isSending) return;
        setIsSending(true);
        try {
            const raw = await callLLM(await buildSystemPrompt(sessionChar, activeSession), activeSession.messages, [
                '（系统：面试结束。请以面试官身份生成结构化评价报告，markdown 排版，包含：',
                '1. 维度打分（表达/岗位匹配/深度/临场，各 10 分制）；2. 逐题点评；3. 三条最优先的改进建议。',
                '并把报告全文用 [[JOB_NOTE:eval|标题|正文]] 指令归档，标题带上岗位代号。）',
            ].join('\u000a'), sessionChar, jhSettings.api.chat);
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
    }, [activeSession, sessionChar, isSending, callLLM, buildSystemPrompt, typeOut, persistSession, applyCommands, addToast, jhSettings.api.chat]);

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
            // 面试会话可单独指定 TTS 服务商（密钥沿用全局）；其它会话跟随全局
            const ttsOv = sess?.topic === 'interview' && jhSettings.api.ttsProvider !== 'follow' ? jhSettings.api.ttsProvider : null;
            const effApi = ttsOv ? { ...apiConfig, ttsProvider: ttsOv } : apiConfig;
            const ttsText = msg.content.replace(/[#*`>\-]/g, '').slice(0, 600);
            const key = msg.voiceKey || hashTtsParams({ app: 'jobhunt', charId: char.id, text: ttsText, vp: char.voiceProfile, ...(ttsOv ? { provider: ttsOv } : {}) });
            let blob = await getCachedTts(key);
            if (!blob) {
                const url = await synthesizeSpeech(ttsText, char, effApi, { groupId: apiConfig.minimaxGroupId || undefined });
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
    }, [sessionChar, apiConfig, playingIdx, ttsBusyIdx, activeSession, persistSession, addToast, jhSettings.api.ttsProvider]);
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

    // ─── 简历导入：PDF / DOCX / TXT / 粘贴 → 打码选项 → 本地脱敏 → 可编辑预览 → 确认 ───
    // 打开打码选项弹窗：重置为默认（基础敏感信息+姓名勾选，姓名档位跟随全局设置）
    const openImportOptions = useCallback((pending: { name: string; format: JobResume['sourceFormat']; rawText: string }) => {
        setImpPii(true);
        setImpName(true);
        setImpNameMode(jhSettings.redactMode.name);
        setImpCustomTerms('');
        setImpCustomMode('hide');
        setPendingImport(pending);
    }, [jhSettings.redactMode.name]);

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
            openImportOptions({ name, format, rawText: text });
        } catch (e: any) {
            addToast(`简历导入失败：${e?.message || '未知错误'}`, 'error');
        } finally {
            setImportBusy(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }, [openImportOptions, addToast]);

    const confirmResumeImport = useCallback(async () => {
        if (!resumePreview) return;
        const resume: JobResume = {
            id: genId('jres'), name: resumePreview.name,
            rawText: (previewEditText.trim() || resumePreview.result.text), sourceFormat: resumePreview.format,
            createdAt: Date.now(),
        };
        await DB.saveJobResume(resume);
        setResumePreview(null);
        await reloadAll();
        addToast('简历已导入（存的是脱敏版）', 'success');
    }, [resumePreview, previewEditText, reloadAll, addToast]);

    // 生成脱敏预览：按打码选项跑 redactPrivacy，进入可编辑预览
    const runRedactPreview = useCallback(() => {
        if (!pendingImport) return;
        const terms = impCustomTerms.split(/[\s,，、]+/).map(t => t.trim()).filter(Boolean);
        const result = redactPrivacy(pendingImport.rawText, {
            realNames: impName ? [userProfile.name] : [],
            nameMode: impName ? impNameMode : 'off',
            redactPii: impPii,
            customTerms: terms,
            customTermMode: impCustomMode,
        });
        setResumePreview({ name: pendingImport.name, format: pendingImport.format, result });
        setPreviewEditText(result.text);
        setPreviewMdMode(false);
        setPendingImport(null);
    }, [pendingImport, impCustomTerms, impName, impNameMode, impPii, impCustomMode, userProfile]);

    // 粘贴导入：同样过脱敏预览闸
    const handlePasteImport = useCallback(() => {
        const text = pasteText.trim();
        if (!text) { addToast('先粘贴简历文本', 'info'); return; }
        setShowPasteImport(false);
        openImportOptions({ name: `粘贴的简历 ${new Date().toLocaleDateString('zh-CN')}`, format: 'paste', rawText: text });
        setPasteText('');
    }, [pasteText, openImportOptions, addToast]);

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
                nextStep: posNextStep.trim() || undefined,
                jd: posJd.trim() || undefined,
                hrName: posHrName.trim() || undefined,
                projectName: posProjectName.trim() || undefined,
                location: posLocation.trim() || undefined,
                notes: posNotes.trim() || undefined,
                interviewAt: localInputToTs(posInterviewAt),
                // 已在等保留原起点不重置；关掉开关才清空
                waitingSince: posWaiting ? (editingPosition.waitingSince || now) : undefined,
                // 手改过代号即锁（已锁的不回退）
                codeLocked: editingPosition.codeLocked || (posCodeDirty && code !== editingPosition.code) || undefined,
                updatedAt: now,
            });
        } else {
            await DB.saveJobPosition({
                id: genId('jpos'), code, title, stage: 'applied',
                nextStep: posNextStep.trim() || undefined,
                timeline: [{ ts: now, stage: 'applied' }],
                companyNameLocal: posCompanyLocal.trim() || undefined,
                jd: posJd.trim() || undefined,
                hrName: posHrName.trim() || undefined,
                projectName: posProjectName.trim() || undefined,
                location: posLocation.trim() || undefined,
                notes: posNotes.trim() || undefined,
                interviewAt: localInputToTs(posInterviewAt),
                waitingSince: posWaiting ? now : undefined,
                codeLocked: posCodeDirty || undefined,
                charId: selectedChar?.id || '', createdAt: now, updatedAt: now,
            });
        }
        setShowNewPosition(false); setEditingPosition(null);
        setPosCode(''); setPosTitle(''); setPosCompanyLocal(''); setPosNextStep('');
        setPosJd(''); setPosHrName(''); setPosProjectName(''); setPosLocation(''); setPosNotes('');
        setPosInterviewAt(''); setPosWaiting(false); setPosCodeDirty(false);
        await reloadAll();
    }, [posCode, posTitle, posCompanyLocal, posNextStep, posJd, posHrName, posProjectName, posLocation, posNotes, posInterviewAt, posWaiting, posCodeDirty, editingPosition, selectedChar, reloadAll, addToast]);

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

    // ── 多选批量操作（删除二次确认） ──
    const togglePosSelect = useCallback((id: string) => {
        setSelectedPosIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }, []);
    const exitSelectMode = useCallback(() => { setPosSelectMode(false); setSelectedPosIds(new Set()); }, []);
    const bulkDeletePositions = useCallback(async () => {
        if (selectedPosIds.size === 0) return;
        if (!window.confirm(`删除选中的 ${selectedPosIds.size} 个岗位卡？关联笔记会保留，此操作不可撤销。`)) return;
        for (const id of selectedPosIds) { try { await DB.deleteJobPosition(id); } catch { /* 单个失败跳过 */ } }
        exitSelectMode();
        await reloadAll();
    }, [selectedPosIds, exitSelectMode, reloadAll]);
    const bulkSetStage = useCallback(async (stage: JobStage) => {
        if (selectedPosIds.size === 0) return;
        const now = Date.now();
        const all = await DB.getJobPositions();
        for (const id of selectedPosIds) {
            const p = all.find(x => x.id === id);
            if (!p) continue;
            try { await DB.saveJobPosition({ ...p, stage, timeline: [...p.timeline, { ts: now, stage }], updatedAt: now }); } catch { /* 跳过 */ }
        }
        exitSelectMode();
        await reloadAll();
    }, [selectedPosIds, exitSelectMode, reloadAll]);

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

    // C5：笔记人工编辑落库（刷新 updatedAt）
    const saveNoteEdit = useCallback(async () => {
        if (!viewingNote) return;
        const title = noteEditTitle.trim();
        const content = noteEditContent.trim();
        if (!title || !content) { addToast('标题和正文都要填', 'info'); return; }
        const next: JobNote = { ...viewingNote, title, content, updatedAt: Date.now() };
        await DB.saveJobNote(next);
        setViewingNote(next);
        setNoteEditing(false);
        await reloadAll();
        addToast('笔记已保存', 'success');
    }, [viewingNote, noteEditTitle, noteEditContent, addToast, reloadAll]);

    const deleteResume = useCallback(async (resume: JobResume) => {
        if (!window.confirm(`删除简历「${resume.name}」？`)) return;
        await DB.deleteJobResume(resume.id);
        await reloadAll();
    }, [reloadAll]);

    // 把一份简历解析进竞争力档案（端上提取的脱敏文本过 codify 后交 LLM）
    const parseResume = useCallback(async (resume: JobResume) => {
        setParsingResumeId(resume.id);
        try {
            const merged = await parseResumeIntoProfile(resume, apiConfig);
            setJobProfile(merged);
            addToast('已解析进竞争力档案', 'success');
        } catch (e: any) {
            addToast(`解析失败：${e?.message || '未知错误'}`, 'error');
        } finally {
            setParsingResumeId(null);
        }
    }, [apiConfig, addToast]);

    const openEditPosition = useCallback((pos: JobPosition) => {
        setEditingPosition(pos);
        setPosCode(pos.code); setPosTitle(pos.title);
        setPosCompanyLocal(pos.companyNameLocal || ''); setPosNextStep(pos.nextStep || '');
        setPosJd(pos.jd || ''); setPosHrName(pos.hrName || ''); setPosProjectName(pos.projectName || ''); setPosLocation(pos.location || '');
        setPosNotes(pos.notes || '');
        setPosInterviewAt(tsToLocalInput(pos.interviewAt)); setPosWaiting(!!pos.waitingSince);
        setPosCodeDirty(!!pos.codeLocked);
        setShowNewPosition(true);
    }, []);

    // ─── 渲染：脱敏预览（导入确认前的最后一道闸）───

    const renderImportOptions = () => {
        if (!pendingImport) return null;
        const nameModes: { v: NameRedactMode; label: string }[] = [
            { v: 'fixed', label: '换成「候选人」' },
            { v: 'pinyin', label: '拼音缩写' },
            { v: 'off', label: '不打码' },
        ];
        return (
            <div className="absolute inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
                <div className="w-full max-w-md bg-white rounded-3xl p-5 max-h-[88%] overflow-y-auto">
                    <div className="font-bold text-slate-800 mb-1">导入前 · 选择要打码的内容</div>
                    <div className="text-xs text-slate-500 mb-4">全程本地处理，原文不出设备。默认项已勾选，按需调整。</div>
                    <label className="flex items-start gap-3 py-2 cursor-pointer">
                        <input type="checkbox" checked={impPii} onChange={e => setImpPii(e.target.checked)} className="mt-0.5 w-4 h-4 accent-sky-500" />
                        <div>
                            <div className="text-sm font-semibold text-slate-700">基础敏感信息</div>
                            <div className="text-[11px] text-slate-400">手机号 / 邮箱 / 身份证 / 银行卡 / 详细住址（建议保持勾选）</div>
                        </div>
                    </label>
                    <label className="flex items-start gap-3 py-2 cursor-pointer">
                        <input type="checkbox" checked={impName} onChange={e => setImpName(e.target.checked)} className="mt-0.5 w-4 h-4 accent-sky-500" />
                        <div className="flex-1">
                            <div className="text-sm font-semibold text-slate-700">姓名</div>
                            <div className="text-[11px] text-slate-400">你的真实姓名</div>
                        </div>
                    </label>
                    {impName && (
                        <div className="flex gap-2 pl-7 mb-1">
                            {nameModes.map(m => (
                                <button key={m.v} onClick={() => setImpNameMode(m.v)}
                                    className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border transition-all active:scale-95 ${impNameMode === m.v ? 'bg-sky-50 text-sky-600 border-sky-200' : 'bg-white text-slate-500 border-slate-200'}`}>{m.label}</button>
                            ))}
                        </div>
                    )}
                    <div className="mt-3 pt-3 border-t border-slate-100">
                        <div className="text-sm font-semibold text-slate-700">公司名 / 学校名 / 项目名等</div>
                        <div className="text-[11px] text-slate-400 mb-2">这些没法自动认出来，填上要隐去的词（逗号、顿号或换行分隔），预览里还能手动补改。</div>
                        <textarea value={impCustomTerms} onChange={e => setImpCustomTerms(e.target.value)} rows={2}
                            placeholder="如：字节跳动，清华大学，商家增长项目"
                            className="w-full bg-slate-100 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                        <div className="flex gap-2 mt-2">
                            {([['hide', '完全隐去'], ['initial', '保留首字（如 字**）']] as const).map(([v, label]) => (
                                <button key={v} onClick={() => setImpCustomMode(v)}
                                    className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border transition-all active:scale-95 ${impCustomMode === v ? 'bg-sky-50 text-sky-600 border-sky-200' : 'bg-white text-slate-500 border-slate-200'}`}>{label}</button>
                            ))}
                        </div>
                    </div>
                    <div className="mt-3 text-[11px] text-amber-600 bg-amber-50 rounded-xl px-3 py-2 leading-relaxed">
                        打码越多越稳妥，但公司 / 学校 / 项目被隐去后，AI 做竞争力分析时会不了解你背景的含金量，结论可能更笼统。
                    </div>
                    <div className="flex gap-2 mt-4">
                        <button onClick={() => setPendingImport(null)} className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-600 text-sm font-semibold active:scale-95 transition-transform">取消</button>
                        <button onClick={runRedactPreview} className="flex-1 py-2.5 rounded-xl bg-sky-500 text-white text-sm font-semibold active:scale-95 transition-transform">生成预览</button>
                    </div>
                </div>
            </div>
        );
    };

    const renderRedactPreview = () => {
        if (!resumePreview) return null;
        const { result } = resumePreview;
        return (
            <div className="absolute inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
                <div className="w-full max-w-md bg-white rounded-3xl p-5 max-h-[88%] flex flex-col">
                    <div className="flex items-center justify-between mb-1">
                        <div className="font-bold text-slate-800">脱敏预览 · {resumePreview.name}</div>
                        <button onClick={() => setPreviewMdMode(m => !m)}
                            className="text-[11px] font-bold px-2.5 py-1 rounded-lg bg-slate-100 text-slate-500 active:scale-95 transition-transform">
                            {previewMdMode ? '切到编辑' : '预览排版'}
                        </button>
                    </div>
                    <div className="text-xs text-slate-500 mb-3">
                        {result.changed
                            ? `本地已打码 ${result.hits.reduce((a, h) => a + h.count, 0)} 处：${result.hits.map(h => `${h.label}×${h.count}`).join('、')}`
                            : '未发现敏感信息（也请自己扫一眼）'}
                        。可直接编辑（用 Markdown 排版更清晰）；确认后仅保存这份脱敏版。
                    </div>
                    {previewMdMode ? (
                        <div className="flex-1 overflow-y-auto bg-slate-50 rounded-xl p-3 border border-slate-200">
                            <MarkdownBlock text={previewEditText || '（空）'} />
                        </div>
                    ) : (
                        <textarea value={previewEditText} onChange={e => setPreviewEditText(e.target.value)}
                            className="flex-1 min-h-[220px] overflow-y-auto bg-slate-50 rounded-xl p-3 text-xs text-slate-700 leading-relaxed border border-slate-200 outline-none focus:ring-2 focus:ring-sky-200 resize-none font-mono" />
                    )}
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
                    <div>
                        <div className="text-xs font-bold text-slate-500 mb-1">模拟面试出题素材</div>
                        <div className="text-[10px] text-slate-400 mb-2">出题时给面试官看什么额外材料（都会先脱敏/代号化）</div>
                        <div className="space-y-1.5">
                            {([
                                ['profile', '竞争力档案', jhSettings.interviewInject.profile] as const,
                                ['resumeDigest', '简历摘要', jhSettings.interviewInject.resumeDigest] as const,
                            ]).map(([key, label, on]) => (
                                <button key={key} onClick={() => patchJhSettings({ interviewInject: { ...jhSettings.interviewInject, [key]: !on } })}
                                    className="w-full flex items-center justify-between bg-slate-50 rounded-xl px-3.5 py-2.5 active:scale-[0.98] transition-transform">
                                    <span className="text-xs font-bold text-slate-600">{label}</span>
                                    <span className={`w-9 h-5 rounded-full p-0.5 transition-colors shrink-0 ${on ? 'bg-sky-500' : 'bg-slate-300'}`}>
                                        <span className={`block w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <div className="text-xs font-bold text-slate-500 mb-1">练习提示词模板</div>
                        <div className="text-[10px] text-slate-400 mb-2">练习设置里「存为模板」存下的附加提示词，这里统一删</div>
                        {jhSettings.practiceTemplates.length === 0 ? (
                            <div className="text-[11px] text-slate-300 px-1">还没有模板</div>
                        ) : (
                            <div className="space-y-1.5">
                                {jhSettings.practiceTemplates.map(t => (
                                    <div key={t.id} className="flex items-center gap-2 bg-slate-50 rounded-xl px-3 py-2">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-bold text-slate-600 truncate">{t.name}</div>
                                            <div className="text-[10px] text-slate-400 truncate">{t.text}</div>
                                        </div>
                                        <button onClick={() => patchJhSettings({ practiceTemplates: jhSettings.practiceTemplates.filter(x => x.id !== t.id) })}
                                            className="text-slate-300 hover:text-rose-400 shrink-0 active:scale-90 transition-transform"><Trash size={16} /></button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <div>
                        <div className="text-xs font-bold text-slate-500 mb-1">面试独立 API</div>
                        <div className="text-[10px] text-slate-400 mb-2">只影响面试会话（文字+语音）；不设就跟随角色/全局配置</div>
                        <div className="space-y-3">
                            <div>
                                <div className="text-[11px] font-bold text-slate-600 mb-1">对话 LLM</div>
                                <ApiConnectionPicker value={jhSettings.api.chat} onChange={v => patchJhSettings({ api: { ...jhSettings.api, chat: v ? { ...v } : null } })}
                                    followLabel="跟随角色 / 全局配置" compact hint={null} />
                            </div>
                            <div>
                                <div className="text-[11px] font-bold text-slate-600 mb-1">云端语音识别（STT）</div>
                                <ApiConnectionPicker value={jhSettings.api.stt} onChange={v => patchJhSettings({ api: { ...jhSettings.api, stt: v ? { ...v } : null } })}
                                    followLabel="跟随全局 STT" compact hint={null} />
                                <div className="text-[10px] text-slate-400 mt-1 px-1">语音面试里把你说的话转文字；选的站要支持 /audio/transcriptions</div>
                            </div>
                            <div>
                                <div className="text-[11px] font-bold text-slate-600 mb-1">语音合成（TTS）服务商</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {([['follow', '跟随全局'], ['minimax', 'MiniMax'], ['fishaudio', '鱼声'], ['elevenlabs', 'ElevenLabs']] as const).map(([v, label]) => (
                                        <button key={v} onClick={() => patchJhSettings({ api: { ...jhSettings.api, ttsProvider: v } })}
                                            className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border transition-all active:scale-95 ${jhSettings.api.ttsProvider === v ? 'bg-sky-50 text-sky-600 border-sky-200 ring-1 ring-sky-100' : 'bg-white text-slate-400 border-slate-200'}`}>
                                            {label}
                                        </button>
                                    ))}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-1 px-1">只切服务商，密钥沿用全局配置里填的</div>
                            </div>
                            <div>
                                <button onClick={() => patchJhSettings({ api: { ...jhSettings.api, audioAnalysis: !jhSettings.api.audioAnalysis } })}
                                    className="w-full flex items-center justify-between bg-slate-50 rounded-2xl px-4 py-3 active:scale-[0.98] transition-transform">
                                    <div className="text-left">
                                        <div className="text-xs font-bold text-slate-700">说话状态分析（语音面试）</div>
                                        <div className="text-[10px] text-slate-400 mt-0.5">音频理解模型听你的回答，给清晰度/语速/自信度反馈，挂断后出表达复盘</div>
                                    </div>
                                    <div className={`w-11 h-6 rounded-full p-0.5 transition-colors shrink-0 ${jhSettings.api.audioAnalysis ? 'bg-sky-500' : 'bg-slate-300'}`}>
                                        <div className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${jhSettings.api.audioAnalysis ? 'translate-x-5' : ''}`} />
                                    </div>
                                </button>
                                {jhSettings.api.audioAnalysis && (
                                    <div className="mt-2 space-y-2.5">
                                        <div>
                                            <div className="text-[11px] font-bold text-slate-600 mb-1">音频理解模型</div>
                                            <ApiConnectionPicker value={jhSettings.api.audio} onChange={v => patchJhSettings({ api: { ...jhSettings.api, audio: v ? { ...v } : null } })} compact hint={null} />
                                            <div className="text-[10px] text-slate-400 mt-1 px-1">要选支持音频输入的多模态模型；不选则分析不生效</div>
                                        </div>
                                        <div>
                                            <div className="text-[11px] font-bold text-slate-600 mb-1">转写方式</div>
                                            <div className="space-y-1.5">
                                                {([
                                                    ['stt', '双轨（推荐）', 'STT 先出字不等人，音频模型后台慢慢分析状态'] as const,
                                                    ['audioModel', '一体', '录音直接交给音频模型，转写+分析一次完成（出字较慢）'] as const,
                                                ]).map(([v, label, desc]) => (
                                                    <button key={v} onClick={() => patchJhSettings({ api: { ...jhSettings.api, transcribeMode: v } })}
                                                        className={`w-full text-left px-3 py-2 rounded-xl border transition-all active:scale-[0.99] ${jhSettings.api.transcribeMode === v ? 'bg-sky-50 border-sky-200 ring-1 ring-sky-100' : 'bg-white border-slate-200'}`}>
                                                        <div className={`text-xs font-bold ${jhSettings.api.transcribeMode === v ? 'text-sky-600' : 'text-slate-600'}`}>{label}</div>
                                                        <div className="text-[10px] text-slate-400 mt-0.5">{desc}</div>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                    <div>
                        <div className="text-xs font-bold text-slate-500 mb-1">公司名模糊化（全程离线拼音库，不联网）</div>
                        <div className="text-[10px] text-slate-400 mb-2">决定填真实公司名时自动生成什么样的代号；只有代号会发给 AI</div>
                        <div className="space-y-1.5">
                            {([
                                ['initial', '拼音首字母 + 去重', '字节→Z、招商→Z2；辨识度优先，隐私中等（推荐）'],
                                ['pinyin', '完整拼音缩写', '字节跳动→ZJTD；好认，但云端可能反推真名'],
                                ['custom', '我自己定', '不自动生成；你填的代号自动钉住，AI 也不会改'],
                                ['off', '不脱敏', '直接用真名当代号（不建议，真名会进提示词）'],
                            ] as const).map(([v, label, desc]) => (
                                <button key={v} onClick={() => patchJhSettings({ redactMode: { ...jhSettings.redactMode, company: v } })}
                                    className={`w-full text-left px-3 py-2 rounded-xl border transition-all active:scale-[0.99] ${jhSettings.redactMode.company === v ? 'bg-sky-50 border-sky-200 ring-1 ring-sky-100' : 'bg-white border-slate-200'}`}>
                                    <div className={`text-xs font-bold ${jhSettings.redactMode.company === v ? 'text-sky-600' : 'text-slate-600'}`}>{label}</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5">{desc}</div>
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <div className="text-xs font-bold text-slate-500 mb-1">姓名模糊化（简历导入时生效）</div>
                        <div className="flex gap-2">
                            {([['fixed', '固定「候选人」'], ['pinyin', '拼音缩写'], ['off', '真名不替换']] as const).map(([v, label]) => (
                                <button key={v} onClick={() => patchJhSettings({ redactMode: { ...jhSettings.redactMode, name: v } })}
                                    className={`px-3.5 py-2 text-xs font-bold rounded-xl border transition-all active:scale-95 ${jhSettings.redactMode.name === v ? 'bg-sky-50 text-sky-600 border-sky-200 ring-1 ring-sky-100' : 'bg-white text-slate-500 border-slate-200'}`}>
                                    {label}
                                </button>
                            ))}
                        </div>
                        {jhSettings.redactMode.name === 'off' && <div className="text-[10px] text-rose-400 mt-1.5">真名会随简历进入提示词，确定吗？</div>}
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
                {pendingImport && renderImportOptions()}
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

    // 岗位浏览：搜索（code/title/公司/项目名/jd/notes）+ 阶段多选筛选 + 排序（纯前端）
    const filteredPositions = useMemo(() => {
        const q = posSearch.trim().toLowerCase();
        let list = positions.filter(p => {
            if (posStageFilter.size > 0 && !posStageFilter.has(p.stage)) return false;
            if (!q) return true;
            return [p.code, p.title, p.companyNameLocal, p.projectName, p.location, p.jd, p.notes]
                .some(f => (f || '').toLowerCase().includes(q));
        });
        list = [...list].sort((a, b) => {
            if (posSort === 'stage') return (STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]) || (b.updatedAt - a.updatedAt);
            if (posSort === 'company') return (a.companyNameLocal || a.code).localeCompare(b.companyNameLocal || b.code, 'zh');
            return b.updatedAt - a.updatedAt; // updated
        });
        return list;
    }, [positions, posSearch, posStageFilter, posSort]);

    // 分组：不分组 / 按阶段 / 按岗位名（带计数）
    const positionGroups = useMemo<{ key: string; label: string; stage: JobStage | null; items: JobPosition[] }[]>(() => {
        if (posGroupBy === 'stage') {
            const order = (Object.keys(STAGE_ORDER) as JobStage[]).sort((a, b) => STAGE_ORDER[a] - STAGE_ORDER[b]);
            return order
                .map(st => ({ key: st, label: STAGE_LABEL[st], stage: st, items: filteredPositions.filter(p => p.stage === st) }))
                .filter(g => g.items.length > 0);
        }
        if (posGroupBy === 'title') {
            const map = new Map<string, JobPosition[]>();
            filteredPositions.forEach(p => { const k = (p.title || '未命名').trim(); if (!map.has(k)) map.set(k, []); map.get(k)!.push(p); });
            return [...map.entries()].map(([k, items]) => ({ key: `t_${k}`, label: k, stage: null, items }));
        }
        return [{ key: 'all', label: '', stage: null, items: filteredPositions }];
    }, [filteredPositions, posGroupBy]);

    // C3 驾驶舱统计：在投/面试中/已上岸 + 阶段漏斗 + 下一步拉平
    const cockpit = useMemo(() => {
        const activeCount = positions.filter(p => ['applied', 'written', 'interview', 'offer_talk'].includes(p.stage)).length;
        const interviewing = positions.filter(p => p.stage === 'interview').length;
        const offers = positions.filter(p => p.stage === 'offer').length;
        const funnel = (['watching', 'applied', 'written', 'interview', 'offer_talk', 'offer'] as JobStage[])
            .map(st => ({ st, label: STAGE_LABEL[st], count: positions.filter(p => p.stage === st).length }));
        const nextSteps = positions.filter(p => p.stage !== 'rejected' && (p.nextStep || '').trim())
            .map(p => ({ id: p.id, code: p.code, nextStep: (p.nextStep || '').trim() }));
        return { activeCount, interviewing, offers, funnel, nextSteps };
    }, [positions]);

    // C3：竞争力档案落库 + 刷新（用户手改条目 source:'user'）
    const saveProfile = useCallback(async (next: JobProfile) => {
        await DB.saveJobProfile(next);
        setJobProfile(next);
    }, []);

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
                    <button onClick={() => setShowJhSettings(true)} className="p-2 ml-auto rounded-full hover:bg-slate-100 active:scale-90 transition-transform">
                        <GearSix className="w-[18px] h-[18px] text-slate-400" />
                    </button>
                    <button onClick={() => setShowPrivacyInfo(true)} className="p-2 rounded-full hover:bg-slate-100 active:scale-90 transition-transform" aria-label="隐私说明">
                        <Question className="w-[18px] h-[18px] text-slate-400" />
                    </button>
                    <div className="relative ml-1 shrink-0">
                        <button onClick={() => setShowCharPicker(v => !v)}
                            className="block rounded-full border-2 border-sky-400 overflow-hidden active:scale-90 transition-transform" aria-label="切换角色">
                            {selectedChar?.avatar
                                ? <img src={selectedChar.avatar} className="w-8 h-8 rounded-full object-cover block" alt={selectedChar?.name || ''} />
                                : <div className="w-8 h-8 rounded-full bg-sky-100 flex items-center justify-center text-xs text-sky-600 font-bold">{(selectedChar?.name || '?').slice(0, 1)}</div>}
                        </button>
                        {showCharPicker && (
                            <>
                                <div className="fixed inset-0 z-30" onClick={() => setShowCharPicker(false)} />
                                <div className="absolute right-0 mt-1.5 z-40 w-44 max-h-72 overflow-y-auto bg-white rounded-2xl shadow-xl border border-slate-200 p-1.5">
                                    {characters.map(c => (
                                        <button key={c.id} onClick={() => { setSelectedCharId(c.id); setShowCharPicker(false); }}
                                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-left active:scale-[0.98] transition-transform ${selectedCharId === c.id ? 'bg-sky-50' : 'hover:bg-slate-50'}`}>
                                            {c.avatar
                                                ? <img src={c.avatar} className="w-7 h-7 rounded-full object-cover shrink-0" alt={c.name} />
                                                : <div className="w-7 h-7 rounded-full bg-sky-100 flex items-center justify-center text-[11px] text-sky-600 font-bold shrink-0">{c.name.slice(0, 1)}</div>}
                                            <span className={`text-sm truncate ${selectedCharId === c.id ? 'text-sky-600 font-semibold' : 'text-slate-600'}`}>{c.name}</span>
                                            {selectedCharId === c.id && <span className="ml-auto text-sky-500 text-xs">✓</span>}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
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
                    <div className="space-y-3">
                        {/* Hero 海岸区：总览 + 阶段漏斗 */}
                        <div className="rounded-3xl p-4 bg-gradient-to-br from-sky-600 via-sky-400 to-amber-50 shadow-sm">
                            <div className="text-white/90 text-xs font-semibold tracking-wide">上岸进度</div>
                            <div className="flex items-end gap-5 mt-1.5">
                                <div><div className="text-3xl font-black text-white leading-none">{cockpit.activeCount}</div><div className="text-[11px] text-white/80 mt-1">在投</div></div>
                                <div><div className="text-3xl font-black text-white leading-none">{cockpit.interviewing}</div><div className="text-[11px] text-white/80 mt-1">面试中</div></div>
                                <div><div className="text-3xl font-black text-white leading-none">{cockpit.offers}</div><div className="text-[11px] text-white/80 mt-1">已上岸</div></div>
                            </div>
                            <div className="mt-3 flex items-stretch gap-1 rounded-xl bg-white/25 backdrop-blur-sm p-1">
                                {cockpit.funnel.map(f => (
                                    <div key={f.st} className="flex-1 text-center py-0.5">
                                        <div className="text-[13px] font-bold text-white leading-none">{f.count}</div>
                                        <div className="text-[9px] text-white/85 mt-0.5 truncate">{f.label}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* 竞争力档案卡 */}
                        <div className="bg-white rounded-2xl border border-slate-200/70 shadow-sm p-4">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-slate-800">竞争力档案</span>
                                <button onClick={() => { setProfDirection(jobProfile?.direction || ''); setShowProfileEdit(true); }} className="ml-auto text-xs text-sky-500 font-semibold flex items-center gap-1 active:scale-95 transition-transform"><PencilSimple className="w-3.5 h-3.5" />编辑</button>
                            </div>
                            {jobProfile?.direction && <div className="text-xs text-slate-600 mt-1.5">方向：{jobProfile.direction}</div>}
                            {(jobProfile?.strengths.length || 0) > 0 && (
                                <div className="mt-2">
                                    <div className="text-[11px] text-slate-400 mb-1">竞争点</div>
                                    <div className="flex flex-wrap gap-1.5">{jobProfile!.strengths.map(s => <span key={s.id} className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">{s.text}</span>)}</div>
                                </div>
                            )}
                            {(jobProfile?.gaps.length || 0) > 0 && (
                                <div className="mt-2">
                                    <div className="text-[11px] text-slate-400 mb-1">改进点</div>
                                    <div className="flex flex-wrap gap-1.5">{jobProfile!.gaps.map(g => <span key={g.id} className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">{g.kind === 'resume' ? '简历·' : '策略·'}{g.text}</span>)}</div>
                                </div>
                            )}
                            {!jobProfile?.direction && !(jobProfile?.strengths.length) && !(jobProfile?.gaps.length) && (
                                <div className="text-xs text-slate-400 mt-1.5 leading-relaxed">还没建立档案。到「笔记本」导入简历点「解析进档案」，或在单聊里让角色帮你沉淀；也可以点右上「编辑」手动填。</div>
                            )}
                        </div>

                        {/* 下一步清单 */}
                        {cockpit.nextSteps.length > 0 && (
                            <div className="bg-white rounded-2xl border border-slate-200/70 shadow-sm p-4">
                                <div className="text-sm font-bold text-slate-800 mb-2">下一步</div>
                                <div className="space-y-2">
                                    {cockpit.nextSteps.map(ns => (
                                        <button key={ns.id} onClick={() => setHomeTab('positions')} className="w-full flex items-start gap-2 text-left active:scale-[0.99] transition-transform">
                                            <span className="text-[10px] font-bold text-slate-500 bg-slate-100 rounded px-1.5 py-0.5 shrink-0 mt-0.5">{ns.code}</span>
                                            <span className="text-xs text-slate-600 flex-1">{ns.nextStep}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* 模拟练习入口卡 */}
                        <button onClick={() => { setPracticeTargetId(''); setPracticeForm('text'); setPracticeMode('strict'); setPracticeExtra(''); setPracticeTplName(''); setShowPracticeSetup(true); }}
                            className="w-full text-left px-4 py-3.5 rounded-2xl bg-gradient-to-r from-violet-500 to-sky-500 text-white shadow-sm active:scale-[0.98] transition-transform">
                            <div className="text-sm font-bold flex items-center gap-1.5"><Microphone className="w-4 h-4" />开始模拟练习</div>
                            <div className="text-[11px] text-white/80 mt-0.5">选角色和目标岗位，严肃面试官 / 轻松陪练两档</div>
                        </button>

                        {/* 练习记录列表 */}
                        <div>
                            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">练习记录</div>
                            {sessions.filter(s => s.topic === 'interview').length === 0 && (
                                <div className="text-center text-slate-400 text-sm py-6 px-8 leading-relaxed">还没有练习记录。点上面「开始模拟练习」发起一场。</div>
                            )}
                            <div className="space-y-2.5">
                                {sessions.filter(s => s.topic === 'interview').map(s => (
                                    <div key={s.id} onClick={() => { setActiveSession(s); setView('chat'); }}
                                        className="bg-white rounded-2xl border border-slate-200/70 shadow-sm p-4 active:scale-[0.99] transition-transform cursor-pointer">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] px-1.5 py-0.5 rounded-md font-semibold bg-sky-100 text-sky-700">模拟面试</span>
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
                        </div>

                        {/* 页底单聊模式备注卡 */}
                        <div className="rounded-2xl bg-slate-100/70 border border-slate-200/60 px-4 py-3">
                            <div className="text-[11px] text-slate-500 leading-relaxed">日常想和角色聊求职？在单聊里开启「上岸计划模式」，TA 就能看到你的岗位/档案/笔记，边聊边帮你记录。</div>
                        </div>
                    </div>
                )}

                {/* Tab 2：岗位看板 */}
                {homeTab === 'positions' && (
                    <div className="space-y-3">
                        {/* 头部：新建岗位（原右下角 FAB 补位到这里） */}
                        <div className="flex items-center">
                            <span className="text-sm font-bold text-slate-700">岗位库</span>
                            <button onClick={() => { setEditingPosition(null); setPosCode(''); setPosTitle(''); setPosCompanyLocal(''); setPosNextStep(''); setPosJd(''); setPosHrName(''); setPosProjectName(''); setPosNotes(''); setPosInterviewAt(''); setPosWaiting(false); setPosCodeDirty(false); setShowNewPosition(true); }}
                                className="ml-auto flex items-center gap-1 text-xs font-semibold text-white bg-sky-500 rounded-xl px-3 py-1.5 active:scale-95 transition-transform">
                                <Plus className="w-4 h-4" weight="bold" />新建岗位
                            </button>
                        </div>
                        {/* 浏览工具条：搜索 + 阶段多选 chips + 排序 + 分组开关（纯前端） */}
                        {positions.length > 0 && (
                            <div className="space-y-2">
                                <input value={posSearch} onChange={e => setPosSearch(e.target.value)}
                                    placeholder="搜索代号 / 岗位 / 公司 / 项目 / JD / 笔记"
                                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                                <div className="flex flex-wrap gap-1.5">
                                    {(Object.keys(STAGE_ORDER) as JobStage[]).map(st => {
                                        const on = posStageFilter.has(st);
                                        return (
                                            <button key={st} onClick={() => setPosStageFilter(prev => { const n = new Set(prev); n.has(st) ? n.delete(st) : n.add(st); return n; })}
                                                className={`text-[11px] px-2 py-0.5 rounded-full font-semibold border transition-all active:scale-95 ${on ? STAGE_STYLE[st] + ' border-transparent ring-1 ring-sky-200' : 'bg-white text-slate-400 border-slate-200'}`}>
                                                {STAGE_LABEL[st]}
                                            </button>
                                        );
                                    })}
                                    {posStageFilter.size > 0 && (
                                        <button onClick={() => setPosStageFilter(new Set())} className="text-[11px] px-2 py-0.5 text-slate-400 underline">清除</button>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <select value={posSort} onChange={e => setPosSort(e.target.value as typeof posSort)}
                                        className="text-xs bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-slate-500 outline-none">
                                        <option value="updated">最近更新</option>
                                        <option value="stage">阶段进度</option>
                                        <option value="company">公司名</option>
                                    </select>
                                    <select value={posGroupBy} onChange={e => setPosGroupBy(e.target.value as typeof posGroupBy)}
                                        className="text-xs bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-slate-500 outline-none">
                                        <option value="none">不分组</option>
                                        <option value="stage">按阶段</option>
                                        <option value="title">按岗位</option>
                                    </select>
                                    <button onClick={() => { if (posSelectMode) exitSelectMode(); else setPosSelectMode(true); }}
                                        className={`text-xs px-2.5 py-1.5 rounded-lg font-semibold border transition-all active:scale-95 ${posSelectMode ? 'bg-sky-500 text-white border-sky-500' : 'bg-white text-slate-400 border-slate-200'}`}>
                                        {posSelectMode ? '完成' : '多选'}
                                    </button>
                                    <span className="text-[11px] text-slate-400 ml-auto">{filteredPositions.length} 个</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <span className="text-[11px] text-slate-400">视图</span>
                                    {([['compact', '简略'], ['detailed', '详细'], ['masonry', '双列']] as const).map(([v, label]) => (
                                        <button key={v} onClick={() => patchJhSettings({ positionView: v })}
                                            className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold border transition-all active:scale-95 ${jhSettings.positionView === v ? 'bg-sky-50 text-sky-600 border-sky-200' : 'bg-white text-slate-400 border-slate-200'}`}>
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {posSelectMode && positions.length > 0 && (
                            <div className="sticky top-0 z-10 flex items-center gap-2 bg-white border border-sky-200 rounded-xl px-3 py-2 shadow-sm">
                                <span className="text-xs font-bold text-sky-600">已选 {selectedPosIds.size}</span>
                                <select value="" onChange={e => { if (e.target.value) bulkSetStage(e.target.value as JobStage); }}
                                    disabled={selectedPosIds.size === 0}
                                    className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-slate-500 outline-none disabled:opacity-50">
                                    <option value="">批量改阶段…</option>
                                    {(Object.keys(STAGE_LABEL) as JobStage[]).map(st => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
                                </select>
                                <button onClick={bulkDeletePositions} disabled={selectedPosIds.size === 0}
                                    className="text-xs px-2.5 py-1.5 rounded-lg font-semibold bg-rose-50 text-rose-500 border border-rose-200 active:scale-95 disabled:opacity-50">批量删除</button>
                                <button onClick={exitSelectMode} className="text-xs text-slate-400 ml-auto">取消</button>
                            </div>
                        )}
                        {positions.length === 0 && (
                            <div className="text-center text-slate-400 text-sm mt-16 px-8 leading-relaxed">
                                还没有在推进的岗位。<br />建卡时公司用代号（A厂/B司），真实公司名只存在本机、永远不会发给 AI。
                            </div>
                        )}
                        {positions.length > 0 && filteredPositions.length === 0 && (
                            <div className="text-center text-slate-400 text-sm mt-12 px-8">没找到匹配的岗位，换个关键词或清除筛选试试。</div>
                        )}
                        {positionGroups.map(group => (
                            <div key={group.key} className="space-y-2.5">
                                {group.label && (
                                    <div className="flex items-center gap-2 pt-1">
                                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${group.stage ? STAGE_STYLE[group.stage] : 'bg-slate-100 text-slate-500'}`}>{group.label}</span>
                                        <span className="text-[10px] text-slate-400">{group.items.length}</span>
                                    </div>
                                )}
                                <div className={jhSettings.positionView === 'masonry' ? 'columns-2 gap-2.5' : 'space-y-2.5'}>
                                {group.items.map(p => {
                            const sel = selectedPosIds.has(p.id);
                            const cardClick = () => posSelectMode ? togglePosSelect(p.id) : openEditPosition(p);
                            return jhSettings.positionView === 'compact' ? (
                                <button key={p.id} onClick={cardClick}
                                    className={`w-full text-left bg-white rounded-xl shadow-sm px-3 py-2.5 flex items-center gap-2 active:scale-[0.99] transition-transform ${sel ? 'ring-2 ring-sky-400' : 'ring-1 ring-slate-200/60'}`}>
                                    {posSelectMode && <span className={`w-4 h-4 rounded-full border-2 shrink-0 ${sel ? 'bg-sky-500 border-sky-500' : 'border-slate-300'}`} />}
                                    <span className="text-sm font-bold text-slate-800 shrink-0">{p.code}</span>
                                    <span className="text-xs text-slate-500 truncate flex-1">{p.title}</span>
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 ${STAGE_STYLE[p.stage]}`}>{STAGE_LABEL[p.stage]}</span>
                                </button>
                            ) : (
                            <div key={p.id} onClick={cardClick}
                                className={`bg-white rounded-2xl shadow-sm p-4 cursor-pointer ${jhSettings.positionView === 'masonry' ? 'break-inside-avoid mb-2.5' : ''} ${sel ? 'ring-2 ring-sky-400' : 'ring-1 ring-slate-200/60'}`}>
                                {/* 头部：代号+阶段一行，岗位名独立一行（双列不挤） */}
                                <div className="flex items-center gap-2">
                                    {posSelectMode && <span className={`w-4 h-4 rounded-full border-2 shrink-0 ${sel ? 'bg-sky-500 border-sky-500' : 'border-slate-300'}`} />}
                                    <span className="text-[15px] font-bold text-slate-800 flex-1 truncate">{p.code}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${STAGE_STYLE[p.stage]}`}>{STAGE_LABEL[p.stage]}</span>
                                </div>
                                <div className="text-[13px] font-semibold text-slate-600 mt-0.5 break-words">{p.title}</div>
                                {p.companyNameLocal && (
                                    <div className="text-[11px] text-slate-400 mt-1">备注：{p.companyNameLocal}</div>
                                )}
                                {(p.projectName || p.location || p.hrName) && (
                                    <div className="text-[11px] text-slate-400 mt-1">
                                        {p.projectName && <span>项目：{p.projectName}</span>}
                                        {p.projectName && (p.location || p.hrName) && <span> · </span>}
                                        {p.location && <span>地点：{p.location}</span>}
                                        {p.location && p.hrName && <span> · </span>}
                                        {p.hrName && <span>HR：{p.hrName}</span>}
                                    </div>
                                )}
                                {p.nextStep && (
                                    <div className="text-xs text-sky-700 bg-sky-50 rounded-lg px-2.5 py-1.5 mt-2 font-medium">下一步：{p.nextStep}</div>
                                )}
                                {(p.rounds || []).length > 0 && (
                                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                                        {(p.rounds || []).map(r => (
                                            <span key={r.id} className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${ROUND_STATUS_STYLE[r.status] || ROUND_STATUS_STYLE.pending}`}>
                                                {ROUND_KIND_LABEL[r.kind]}{r.index}·{ROUND_STATUS_LABEL[r.status] || r.status}{r.at && (r.status === 'scheduled' || r.status === 'pending') ? ` ${fmtJobTime(r.at)}` : ''}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {(() => {
                                    const ivTs = nextInterviewTs(p);
                                    if (ivTs) {
                                        const today = ivCountdownLabel(ivTs) === '就在今天';
                                        return (
                                            <div className={`text-xs rounded-lg px-2.5 py-1.5 mt-2 font-semibold ${today ? 'text-rose-600 bg-rose-50' : 'text-cyan-700 bg-cyan-50'}`}>
                                                下一场面试：{fmtJobTime(ivTs)} · {ivCountdownLabel(ivTs)}
                                            </div>
                                        );
                                    }
                                    if (p.interviewAt && p.interviewAt <= Date.now() - 3600 * 1000) {
                                        return <div className="text-[11px] text-slate-300 mt-2">面试已过：{fmtJobTime(p.interviewAt)}</div>;
                                    }
                                    return null;
                                })()}
                                {(() => {
                                    const wd = waitingDays(p);
                                    return wd ? <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5 mt-2">⏳ 等反馈中 · 第 {wd} 天</div> : null;
                                })()}
                                {p.jd && (
                                    <div className="mt-2 flex items-start gap-1.5">
                                        <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                                        <div className="text-xs text-slate-500 leading-relaxed line-clamp-2 flex-1 whitespace-pre-wrap">{p.jd}</div>
                                        <button onClick={e => { e.stopPropagation(); openEditPosition(p); }} className="p-1 -mt-0.5 text-slate-300 hover:text-sky-500 shrink-0"><PencilSimple className="w-3.5 h-3.5" /></button>
                                    </div>
                                )}
                                {p.notes && (
                                    <div className="mt-1.5 flex items-start gap-1.5">
                                        <Notebook className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                                        <div className="text-xs text-slate-500 leading-relaxed line-clamp-2 flex-1 whitespace-pre-wrap">{p.notes}</div>
                                        <button onClick={e => { e.stopPropagation(); openEditPosition(p); }} className="p-1 -mt-0.5 text-slate-300 hover:text-indigo-500 shrink-0"><PencilSimple className="w-3.5 h-3.5" /></button>
                                    </div>
                                )}
                                {p.updatedAt && (
                                    <div className="text-[10px] text-slate-300 mt-2">最后更新 {relTimeLabel(p.updatedAt)}</div>
                                )}
                            </div>
                            );
                            })}
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
                                    <div className="text-[10px] text-slate-300 mt-1">{characters.find(c => c.id === n.charId)?.name || ''} · 最后更新 {relTimeLabel(n.updatedAt ?? n.createdAt)}</div>
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
                                        <button onClick={() => parseResume(r)} disabled={!!parsingResumeId}
                                            className="flex items-center gap-1 text-xs text-sky-600 font-semibold shrink-0 disabled:opacity-50">
                                            {parsingResumeId === r.id ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <ReadCvLogo className="w-3.5 h-3.5" />}
                                            {parsingResumeId === r.id ? '解析中' : '解析进档案'}
                                        </button>
                                        <button onClick={() => deleteResume(r)} className="p-1 text-slate-300 hover:text-rose-400"><Trash className="w-4 h-4" /></button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* 竞争力档案编辑弹窗（手改条目标 source:'user'，AI 重新解析不覆盖） */}
            {showProfileEdit && (() => {
                const base: JobProfile = jobProfile || { id: 'main', direction: '', strengths: [], gaps: [], resumeDigest: '', updatedAt: Date.now() };
                const addEdge = () => {
                    const t = profNewEdge.trim(); if (!t) return;
                    saveProfile({ ...base, direction: profDirection.trim(), strengths: [...base.strengths, { id: genId('edge'), text: t, source: 'user' }], updatedAt: Date.now() });
                    setProfNewEdge('');
                };
                const addGap = () => {
                    const t = profNewGap.trim(); if (!t) return;
                    saveProfile({ ...base, direction: profDirection.trim(), gaps: [...base.gaps, { id: genId('gap'), text: t, kind: profNewGapKind, source: 'user' }], updatedAt: Date.now() });
                    setProfNewGap('');
                };
                const delEdge = (id: string) => saveProfile({ ...base, direction: profDirection.trim(), strengths: base.strengths.filter(s => s.id !== id), updatedAt: Date.now() });
                const delGap = (id: string) => saveProfile({ ...base, direction: profDirection.trim(), gaps: base.gaps.filter(g => g.id !== id), updatedAt: Date.now() });
                const done = () => { saveProfile({ ...base, direction: profDirection.trim(), updatedAt: Date.now() }); setShowProfileEdit(false); };
                return (
                <div className="absolute inset-0 z-50 bg-black/30 flex items-end" onClick={() => setShowProfileEdit(false)}>
                    <div className="w-full bg-white rounded-t-3xl p-5 max-h-[85%] overflow-y-auto" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))' }}>
                        <div className="font-bold text-slate-800 mb-3">编辑竞争力档案</div>
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">求职方向</label>
                                <input value={profDirection} onChange={e => setProfDirection(e.target.value)} placeholder="一句话，比如：三年前端，主攻 C 端体验"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <div className="text-xs text-slate-500 font-semibold mb-1.5">竞争点</div>
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                    {base.strengths.map(s => (
                                        <span key={s.id} className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 flex items-center gap-1">
                                            {s.text}<button onClick={() => delEdge(s.id)} className="text-emerald-400 hover:text-rose-400 font-bold">×</button>
                                        </span>
                                    ))}
                                    {base.strengths.length === 0 && <span className="text-[11px] text-slate-300">还没有，加一条</span>}
                                </div>
                                <div className="flex gap-2">
                                    <input value={profNewEdge} onChange={e => setProfNewEdge(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addEdge(); }} placeholder="加一条竞争点"
                                        className="flex-1 bg-slate-100 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-200" />
                                    <button onClick={addEdge} className="px-3 rounded-xl bg-emerald-500 text-white text-sm font-semibold active:scale-95 transition-transform">加</button>
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-slate-500 font-semibold mb-1.5">改进点</div>
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                    {base.gaps.map(g => (
                                        <span key={g.id} className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
                                            {g.kind === 'resume' ? '简历·' : '策略·'}{g.text}<button onClick={() => delGap(g.id)} className="text-amber-400 hover:text-rose-400 font-bold">×</button>
                                        </span>
                                    ))}
                                    {base.gaps.length === 0 && <span className="text-[11px] text-slate-300">还没有，加一条</span>}
                                </div>
                                <div className="flex gap-2">
                                    <select value={profNewGapKind} onChange={e => setProfNewGapKind(e.target.value as 'strategy' | 'resume')}
                                        className="bg-slate-100 rounded-xl px-2 text-sm outline-none text-slate-500">
                                        <option value="strategy">策略</option>
                                        <option value="resume">简历</option>
                                    </select>
                                    <input value={profNewGap} onChange={e => setProfNewGap(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addGap(); }} placeholder="加一条改进点"
                                        className="flex-1 bg-slate-100 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200" />
                                    <button onClick={addGap} className="px-3 rounded-xl bg-amber-500 text-white text-sm font-semibold active:scale-95 transition-transform">加</button>
                                </div>
                            </div>
                        </div>
                        <button onClick={done} className="w-full mt-4 py-3 rounded-xl bg-sky-500 text-white text-sm font-bold active:scale-[0.98] transition-transform">完成</button>
                    </div>
                </div>
                );
            })()}

            {/* 模拟练习设置弹窗（C4：角色/目标/形态/两档/附加提示词+模板） */}
            {showPracticeSetup && (
                <div className="absolute inset-0 z-50 bg-black/30 flex items-end" onClick={() => setShowPracticeSetup(false)}>
                    <div className="w-full bg-white rounded-t-3xl p-5 max-h-[88%] overflow-y-auto" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))' }}>
                        <div className="font-bold text-slate-800 mb-3">模拟练习设置</div>
                        <div className="space-y-4">
                            <div>
                                <div className="text-xs text-slate-500 font-semibold mb-1.5">面试官角色</div>
                                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                                    {characters.map(c => (
                                        <button key={c.id} onClick={() => setSelectedCharId(c.id)}
                                            className={`flex flex-col items-center gap-1 shrink-0 ${selectedCharId === c.id ? '' : 'opacity-60'}`}>
                                            {c.avatar
                                                ? <img src={c.avatar} className={`w-11 h-11 rounded-full object-cover border-2 ${selectedCharId === c.id ? 'border-sky-400' : 'border-transparent'}`} alt={c.name} />
                                                : <div className={`w-11 h-11 rounded-full bg-sky-100 flex items-center justify-center text-sm text-sky-600 font-bold border-2 ${selectedCharId === c.id ? 'border-sky-400' : 'border-transparent'}`}>{c.name.slice(0, 1)}</div>}
                                            <span className="text-[10px] text-slate-500 max-w-[52px] truncate">{c.name}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-slate-500 font-semibold mb-1.5">练习目标</div>
                                <div className="flex flex-wrap gap-1.5">
                                    <button onClick={() => setPracticeTargetId('')}
                                        className={`text-xs px-3 py-1.5 rounded-xl font-semibold border transition-all active:scale-95 ${practiceTargetId === '' ? 'bg-sky-50 text-sky-600 border-sky-200 ring-1 ring-sky-100' : 'bg-white text-slate-500 border-slate-200'}`}>综合模式</button>
                                    {positions.filter(p => p.stage !== 'rejected').map(p => (
                                        <button key={p.id} onClick={() => setPracticeTargetId(p.id)}
                                            className={`text-xs px-3 py-1.5 rounded-xl font-semibold border transition-all active:scale-95 ${practiceTargetId === p.id ? 'bg-sky-50 text-sky-600 border-sky-200 ring-1 ring-sky-100' : 'bg-white text-slate-500 border-slate-200'}`}>{p.code} · {p.title}</button>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-slate-500 font-semibold mb-1.5">练习形态</div>
                                <div className="flex gap-2">
                                    <button onClick={() => setPracticeForm('text')}
                                        className={`flex-1 py-2.5 rounded-xl text-xs font-semibold border transition-all active:scale-95 ${practiceForm === 'text' ? 'bg-sky-50 text-sky-600 border-sky-200 ring-1 ring-sky-100' : 'bg-white text-slate-500 border-slate-200'}`}>文字</button>
                                    <button onClick={() => setPracticeForm('voice')}
                                        className={`flex-1 py-2.5 rounded-xl text-xs font-semibold border transition-all active:scale-95 ${practiceForm === 'voice' ? 'bg-sky-50 text-sky-600 border-sky-200 ring-1 ring-sky-100' : 'bg-white text-slate-500 border-slate-200'}`}>语音</button>
                                    <div className="flex-1 py-2.5 rounded-xl text-xs font-semibold border border-slate-200 bg-slate-50 text-slate-300 text-center">视频 · 研发中</div>
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-slate-500 font-semibold mb-1.5">面试官风格</div>
                                <div className="flex gap-2">
                                    {([['strict', '严肃面试官', '正式、有压力感'], ['coach', '轻松陪练', '鼓励、给提示']] as const).map(([v, label, desc]) => (
                                        <button key={v} onClick={() => setPracticeMode(v)}
                                            className={`flex-1 text-left px-3 py-2 rounded-xl border transition-all active:scale-[0.98] ${practiceMode === v ? 'bg-sky-50 border-sky-200 ring-1 ring-sky-100' : 'bg-white border-slate-200'}`}>
                                            <div className={`text-xs font-bold ${practiceMode === v ? 'text-sky-600' : 'text-slate-600'}`}>{label}</div>
                                            <div className="text-[10px] text-slate-400 mt-0.5">{desc}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-slate-500 font-semibold mb-1.5">附加提示词（选填）</div>
                                {jhSettings.practiceTemplates.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mb-2">
                                        {jhSettings.practiceTemplates.map(t => (
                                            <span key={t.id} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 flex items-center gap-1">
                                                <button onClick={() => setPracticeExtra(t.text)}>{t.name}</button>
                                                <button onClick={() => patchJhSettings({ practiceTemplates: jhSettings.practiceTemplates.filter(x => x.id !== t.id) })} className="text-slate-400 hover:text-rose-400 font-bold">×</button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <textarea value={practiceExtra} onChange={e => setPracticeExtra(e.target.value)} rows={3}
                                    placeholder="比如：多问项目里的技术难点；语气强势一点；重点考察系统设计……"
                                    className="w-full bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200 resize-none leading-relaxed" />
                                <div className="flex gap-2 mt-2">
                                    <input value={practiceTplName} onChange={e => setPracticeTplName(e.target.value)} placeholder="给这段提示词起个名，存为模板"
                                        className="flex-1 bg-slate-100 rounded-xl px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-sky-200" />
                                    <button onClick={() => { const name = practiceTplName.trim(); const text = practiceExtra.trim(); if (!name || !text) { addToast('模板名和提示词都要填', 'info'); return; } patchJhSettings({ practiceTemplates: [...jhSettings.practiceTemplates, { id: genId('ptpl'), name, text }] }); setPracticeTplName(''); addToast('已存为模板', 'success'); }}
                                        className="px-3 rounded-xl bg-slate-200 text-slate-600 text-xs font-semibold active:scale-95 transition-transform">存为模板</button>
                                </div>
                            </div>
                        </div>
                        <button onClick={startPractice} disabled={isSending}
                            className="w-full mt-4 py-3 rounded-xl bg-gradient-to-r from-violet-500 to-sky-500 text-white text-sm font-bold active:scale-[0.98] transition-transform disabled:opacity-60">开始练习</button>
                    </div>
                </div>
            )}

            {/* 新建/编辑岗位弹窗 */}
            {showNewPosition && (
                <div className="absolute inset-0 z-40 bg-black/30 flex items-end" onClick={() => { setShowNewPosition(false); setEditingPosition(null); }}>
                    <div className="w-full bg-white rounded-t-3xl p-5 max-h-[85%] overflow-y-auto" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))' }}>
                        <div className="font-bold text-slate-800 mb-4">{editingPosition ? '编辑岗位卡' : '新建岗位卡'}</div>
                        <div className="space-y-3">
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">公司代号 *（发给 AI 的只有代号）{(posCodeDirty || editingPosition?.codeLocked) && <span className="text-amber-500"> · 🔒已钉住，自动生成不再覆盖</span>}</label>
                                <input value={posCode} onChange={e => { setPosCode(e.target.value); setPosCodeDirty(true); }} placeholder="如：A厂、B司；填真实公司名会自动生成"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">岗位名 *</label>
                                <input value={posTitle} onChange={e => setPosTitle(e.target.value)} placeholder="如：前端开发工程师"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">真实公司名（选填，仅本机，永不发给 AI）</label>
                                <input value={posCompanyLocal}
                                    onChange={e => {
                                        const v = e.target.value;
                                        setPosCompanyLocal(v);
                                        // 自动档下顺手生成代号（离线拼音库，幂等去重）；用户手改过/已锁定的不碰
                                        if (!posCodeDirty && !editingPosition?.codeLocked) {
                                            const auto = genCompanyCode(v, jhSettings.redactMode.company, positions.filter(p => p.id !== editingPosition?.id));
                                            if (auto) setPosCode(auto);
                                        }
                                    }}
                                    placeholder="只是给你自己看的备注，填了会自动生成代号"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">项目名/业务线（选填）</label>
                                <input value={posProjectName} onChange={e => setPosProjectName(e.target.value)} placeholder="如：商家后台、风控中台 — AI 会用它分析岗位"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">工作地点（选填）</label>
                                <input value={posLocation} onChange={e => setPosLocation(e.target.value)} placeholder="如：上海、杭州·远程 — AI 可见，也能帮你改"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">HR 名（选填，仅本机可见，永不发给 AI）</label>
                                <input value={posHrName} onChange={e => setPosHrName(e.target.value)} placeholder="方便你记住对接人，真实人名不进任何提示词"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">JD 岗位描述（选填，直接粘贴）</label>
                                <textarea value={posJd} onChange={e => setPosJd(e.target.value)} rows={5}
                                    placeholder="把招聘页的 JD 粘进来。发给 AI 前会自动脱敏（手机/邮箱/真实公司名）并截取摘要"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200 resize-none leading-relaxed" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">下一步（选填）</label>
                                <input value={posNextStep} onChange={e => setPosNextStep(e.target.value)} placeholder="如：周四二面"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">岗位笔记（选填，面经/待遇/谈话要点都可以记）</label>
                                <textarea value={posNotes} onChange={e => setPosNotes(e.target.value)} rows={4}
                                    placeholder="比如：一面聊了项目难点、HR 说薪资 25-30k、二面会考系统设计……发给 AI 前会自动脱敏+截取摘要"
                                    className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200 resize-none leading-relaxed" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 font-semibold">面试时间（选填，桌面日历会显示琥珀点）</label>
                                <div className="flex items-center gap-2 mt-1">
                                    <input type="datetime-local" value={posInterviewAt} onChange={e => setPosInterviewAt(e.target.value)}
                                        className="flex-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-sky-200" />
                                    {posInterviewAt && (
                                        <button onClick={() => setPosInterviewAt('')} className="text-xs text-slate-400 px-2 py-2 shrink-0 active:scale-95 transition-transform">清除</button>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2.5">
                                <div>
                                    <div className="text-xs text-slate-600 font-semibold">等反馈中</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5">
                                        {posWaiting
                                            ? (editingPosition?.waitingSince ? `从 ${fmtJobTime(editingPosition.waitingSince)} 算起，已等 ${waitingDays(editingPosition) || 1} 天` : '保存后从今天算第 1 天')
                                            : '投完/面完在等消息时打开，AI 会知道你等了几天'}
                                    </div>
                                </div>
                                <button onClick={() => setPosWaiting(v => !v)}
                                    className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${posWaiting ? 'bg-amber-400' : 'bg-slate-200'}`}>
                                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${posWaiting ? 'left-[22px]' : 'left-0.5'}`} />
                                </button>
                            </div>
                        </div>
                        <button onClick={savePosition} className="w-full mt-4 py-3 rounded-xl bg-sky-500 text-white text-sm font-bold active:scale-[0.98] transition-transform">保存</button>
                        {editingPosition && (
                            <button onClick={() => { const p = editingPosition; setShowNewPosition(false); setEditingPosition(null); deletePosition(p); }}
                                className="w-full mt-2 py-2.5 rounded-xl text-rose-500 text-sm font-semibold active:scale-[0.98] transition-transform">删除这个岗位</button>
                        )}
                    </div>
                </div>
            )}

            {/* 笔记详情弹窗 */}
            {viewingNote && (
                <div className="absolute inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => { setViewingNote(null); setNoteEditing(false); }}>
                    <div className="w-full max-w-md bg-white rounded-3xl p-5 max-h-[85%] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2 mb-3">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${NOTE_KIND_STYLE[viewingNote.kind]}`}>{NOTE_KIND_LABEL[viewingNote.kind]}</span>
                            {noteEditing
                                ? <input value={noteEditTitle} onChange={e => setNoteEditTitle(e.target.value)} className="flex-1 bg-slate-100 rounded-lg px-2.5 py-1.5 text-sm font-bold text-slate-800 outline-none focus:ring-2 focus:ring-sky-200" />
                                : <span className="font-bold text-slate-800 truncate flex-1">{viewingNote.title}</span>}
                            {!noteEditing && (
                                <button onClick={() => { setNoteEditTitle(viewingNote.title); setNoteEditContent(viewingNote.content); setNoteEditing(true); }}
                                    className="flex items-center gap-1 text-xs text-sky-500 font-semibold px-1 active:scale-95 transition-transform"><PencilSimple className="w-3.5 h-3.5" />编辑</button>
                            )}
                            <button onClick={() => { setViewingNote(null); setNoteEditing(false); }} className="p-1 text-slate-400"><X className="w-4 h-4" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {noteEditing
                                ? <textarea value={noteEditContent} onChange={e => setNoteEditContent(e.target.value)} rows={12}
                                    className="w-full h-full min-h-[240px] bg-slate-100 rounded-xl px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-sky-200 resize-none leading-relaxed" />
                                : <MarkdownBlock text={viewingNote.content} />}
                        </div>
                        {noteEditing ? (
                            <div className="flex items-center gap-2 mt-3">
                                <button onClick={() => deleteNote(viewingNote)} className="text-xs text-rose-500 font-semibold active:scale-95 transition-transform">删除这篇笔记</button>
                                <button onClick={() => setNoteEditing(false)} className="ml-auto text-xs text-slate-400 px-2 py-1.5">取消</button>
                                <button onClick={saveNoteEdit} className="text-xs font-bold text-white bg-sky-500 rounded-xl px-4 py-1.5 active:scale-95 transition-transform">保存</button>
                            </div>
                        ) : (
                            <div className="mt-3">
                                <div className="text-[10px] text-slate-300">
                                    {characters.find(c => c.id === viewingNote.charId)?.name || ''} · 最后更新 {relTimeLabel(viewingNote.updatedAt ?? viewingNote.createdAt)}
                                    {viewingNote.sessionId && sessions.some(s => s.id === viewingNote.sessionId) && (
                                        <button className="text-sky-500 font-semibold ml-2"
                                            onClick={() => { const src = sessions.find(x => x.id === viewingNote.sessionId); if (src) { setViewingNote(null); setNoteEditing(false); setActiveSession(src); setView('chat'); } }}>
                                            回到来源会话 →
                                        </button>
                                    )}
                                </div>
                                <button onClick={() => deleteNote(viewingNote)} className="mt-2 text-xs text-rose-500 font-semibold active:scale-95 transition-transform">删除这篇笔记</button>
                            </div>
                        )}
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
            {pendingImport && renderImportOptions()}
            {resumePreview && renderRedactPreview()}
            {showJhSettings && renderSettingsModal()}

            {/* 隐私说明弹层（顶栏问号）：代号制 / 本地脱敏管线 / hrName 永不上云 / JD 脱敏截断 / 四档强度 */}
            {showPrivacyInfo && (
                <div className="absolute inset-0 z-50 flex items-center justify-center p-4"
                    style={{ background: 'rgba(15,23,42,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
                    onClick={() => setShowPrivacyInfo(false)}>
                    <div className="w-full max-w-md bg-white/90 rounded-3xl p-5 max-h-[85%] overflow-y-auto shadow-xl border border-white/60" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2 mb-3">
                            <ShieldCheck className="w-5 h-5 text-emerald-500" weight="fill" />
                            <span className="font-bold text-slate-800">你的隐私怎么保护</span>
                            <button onClick={() => setShowPrivacyInfo(false)} className="ml-auto p-1 text-slate-400"><X className="w-4 h-4" /></button>
                        </div>
                        <div className="space-y-3 text-[12px] leading-relaxed text-slate-600">
                            <div>
                                <div className="font-bold text-slate-700 mb-0.5">① 代号制：真实公司名永不发给 AI</div>
                                发给 AI 的只有你设的代号（A厂/Z2 这种）。真实公司名、HR 名只存在本机数据库，从不进任何提示词。
                            </div>
                            <div>
                                <div className="font-bold text-slate-700 mb-0.5">② 本地脱敏管线（全离线）</div>
                                简历/对话/笔记发出前，手机号、邮箱、身份证、银行卡、住址都会在本机打码；公司名拼音化用的是打包进 APK 的离线拼音库，不联网。
                            </div>
                            <div>
                                <div className="font-bold text-slate-700 mb-0.5">③ JD / 笔记：脱敏 + 截断后才注入</div>
                                岗位 JD 和笔记发给 AI 前会先过脱敏（手机/邮箱/真实公司名）并只取摘要，不会整段原文上云。
                            </div>
                            <div>
                                <div className="font-bold text-slate-700 mb-0.5">④ 四档模糊强度（设置里可选）</div>
                                拼音首字母（隐私高、辨识中）→ 完整拼音缩写（辨识高、但可能被反推）→ 自定义 → 不脱敏。默认用拼音首字母+去重。
                            </div>
                            <div className="text-[11px] text-slate-400 pt-1 border-t border-slate-100">
                                简而言之：真实公司名/HR名/真实姓名永远不会离开你的手机。
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default JobHuntApp;
