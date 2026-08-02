// 上岸计划 · 指令解析（LLM 输出标记 → 结构化落库）
// 沿用钱包 SPEND 那套「输出标记 → 正则解析 → 落库」的管线：
//   [[JOB_VIEW]]                          → 查看工作台全貌（岗位+笔记+教学）
//   [[JOB_SEARCH:关键词]]                  → 搜索岗位/笔记（返回列表，不含全文）
//   [[JOB_NOTE_READ:完整标题]]             → 读笔记全文（标题精确匹配）
//   [[JOB_UPDATE:代号|key:value|key:value]] → 建卡/更新（键值对，一次带全字段）
//     老三段式 [[JOB_UPDATE:代号|阶段|下一步]] 保留兼容
//   [[JOB_SET:代号|字段|值]]                → 改短字段（title/project/location/salary/stage/next）
//   [[JOB_EDIT:代号|字段|旧片段|新片段]]     → 改长字段（jd/notes）局部替换，旧片段精确匹配
//   [[JOB_ROUND:代号|轮次|类型|状态|时间]]   → 环节轮次
//   [[JOB_INTERVIEW:代号|时间]]             → 面试时间快捷
//   [[JOB_WAITING:代号]]                    → 开始/结束等反馈
//   [[JOB_DEL:代号]]                        → 删岗位卡
//   [[JOB_NOTE:类型|标题|正文]]             → 落笔记本
//   [[JOB_NOTE_EDIT:完整标题|旧片段|新片段]] → 改笔记（标题精确+片段替换，旧片段精确匹配）
//   [[JOB_NOTE_DEL:完整标题]]               → 删笔记（标题精确匹配）
// 正则全部用 [\s\S] 兜跨行，不写换行字面量（防工具链把它炸成真实换行）。

import { JobNoteKind, JobStage, JobRoundKind, JobRoundStatus } from '../types';

export interface ParsedJobUpdate {
    code: string;
    stage: JobStage;
    nextStep: string;
    /** 键值对模式下的额外字段（title/projectName/location/salary/jd/next 等） */
    fields?: Partial<Record<JobSettableField, string>>;
}

/** 岗位字段的可写白名单（AI 能改的字段；hrName/companyNameLocal 是真实人名/公司名，AI 看不到也不可写；code 永不入列） */
export type JobSettableField = 'title' | 'projectName' | 'jd' | 'nextStep' | 'stage' | 'notes' | 'location' | 'salary';

export interface ParsedJobSet {
    code: string;
    field: JobSettableField;
    value: string;
}

/** 长字段片段替换（jd / notes）：旧片段必须精确出现，否则拒绝 */
export interface ParsedJobEdit {
    code: string;
    field: 'jd' | 'notes';
    oldSnippet: string;
    newSnippet: string;
}

export interface ParsedJobNote {
    kind: JobNoteKind;
    title: string;
    content: string;
}

/** 环节指令：新建/更新某一轮面试或笔试的状态与时间 */
export interface ParsedJobRound {
    code: string;
    kind: JobRoundKind;
    index: number;            // 1~10
    status: JobRoundStatus;
    at?: number;              // 解析后的时间戳；缺省不改时间
    clearAt?: boolean;        // 显式清除时间
}

/** 面试时间快捷指令（写 interviewAt） */
export interface ParsedJobInterview {
    code: string;
    at?: number;              // undefined + clear=true 表示清除
    clear?: boolean;
}

/** 等反馈指令（写 waitingSince） */
export interface ParsedJobWaiting {
    code: string;
    clear?: boolean;
}

export interface JobParseResult {
    /** 去掉所有指令标记后的正文（用于渲染/入库） */
    cleanText: string;
    /** 查看工作台全貌 */
    view: boolean;
    /** 搜索岗位/笔记（返回列表，不含全文） */
    searches: string[];
    /** 读笔记全文（标题精确匹配） */
    noteReads: string[];
    updates: ParsedJobUpdate[];
    /** 岗位短字段编辑（title/project/location/salary/stage/next） */
    sets: ParsedJobSet[];
    /** 岗位长字段片段替换（jd/notes），旧片段精确匹配 */
    edits: ParsedJobEdit[];
    /** 环节轮次：新建/更新某轮面试或笔试 */
    rounds: ParsedJobRound[];
    /** 面试时间快捷指令 */
    interviews: ParsedJobInterview[];
    /** 等反馈开关指令 */
    waitings: ParsedJobWaiting[];
    notes: ParsedJobNote[];
    /** 要删除的岗位代号 */
    positionDeletes: string[];
    /** 笔记编辑：标题精确匹配 + 旧片段精确替换 */
    noteEdits: { title: string; oldSnippet: string; newSnippet: string }[];
    /** 要删除的笔记完整标题（精确匹配） */
    noteDeletes: string[];
    /** 竞争力档案编辑（写 JobProfile，source:'char'） */
    edgeAdds: string[];
    edgeDels: string[];
    gapAdds: { kind: 'strategy' | 'resume'; text: string }[];
    gapDels: string[];
    /** 求职方向（同批多条取最后一条）；undefined=不改 */
    direction?: string;
}

const JOB_VIEW_RE = /\[\[JOB_VIEW\]\]/g;
const JOB_SEARCH_RE = /\[\[JOB_SEARCH:([^\]]+)\]\]/g;
const JOB_NOTE_READ_RE = /\[\[JOB_NOTE_READ:([^\]]+)\]\]/g;
// JOB_UPDATE：代号|内容。内容按 | 分段；第一段含 : → 键值对模式；否则老三段式（阶段|下一步）
const JOB_UPDATE_RE = /\[\[JOB_UPDATE:([^|\]]+)\|([^\]]*)\]\]/g;
const JOB_SET_RE = /\[\[JOB_SET:([^|\]]+)\|([^|\]]+)\|([\s\S]*?)\]\]/g;
// JOB_EDIT：代号|字段(jd/notes)|旧片段|新片段。片段用 [\s\S]*? 非贪婪兜跨行
const JOB_EDIT_RE = /\[\[JOB_EDIT:([^|\]]+)\|([^|\]]+)\|([\s\S]*?)\|([\s\S]*?)\]\]/g;
const JOB_NOTE_RE = /\[\[JOB_NOTE:([^|\]]+)\|([^|\]]+)\|([\s\S]*?)\]\]/g;
const JOB_DEL_RE = /\[\[JOB_DEL:([^\]]+)\]\]/g;
// JOB_NOTE_EDIT：完整标题|旧片段|新片段（三段式，标题精确匹配+片段精确替换）
const JOB_NOTE_EDIT_RE = /\[\[JOB_NOTE_EDIT:([^|\]]+)\|([\s\S]*?)\|([\s\S]*?)\]\]/g;
const JOB_NOTE_DEL_RE = /\[\[JOB_NOTE_DEL:([^\]]+)\]\]/g;
const JOB_ROUND_RE = /\[\[JOB_ROUND:([^|\]]+)\|([^|\]]+)\|([^|\]]+)\|([^|\]]*)\|?([^\]]*)\]\]/g;
const JOB_INTERVIEW_RE = /\[\[JOB_INTERVIEW:([^|\]]+)\|([^\]]*)\]\]/g;
const JOB_WAITING_RE = /\[\[JOB_WAITING:([^|\]]+)\|?([^\]]*)\]\]/g;
// 竞争力档案指令（第八节）：文本段用 [\s\S] 兜跨行
const JOB_EDGE_ADD_RE = /\[\[JOB_EDGE_ADD:([\s\S]*?)\]\]/g;
const JOB_EDGE_DEL_RE = /\[\[JOB_EDGE_DEL:([\s\S]*?)\]\]/g;
const JOB_GAP_ADD_RE = /\[\[JOB_GAP_ADD:([^|\]]+)\|([\s\S]*?)\]\]/g;
const JOB_GAP_DEL_RE = /\[\[JOB_GAP_DEL:([\s\S]*?)\]\]/g;
const JOB_DIRECTION_RE = /\[\[JOB_DIRECTION:([\s\S]*?)\]\]/g;

// LLM 常会用中文写阶段/类型，宽容映射；不认识的一律回落安全默认值
const STAGE_MAP: Record<string, JobStage> = {
    watching: 'watching', applied: 'applied', written: 'written', interview: 'interview', rejected: 'rejected',
    '观望': 'watching', '观望中': 'watching', '意向': 'watching', '想投': 'watching', '还没投': 'watching', '待投递': 'watching',
    '投递': 'applied', '已投递': 'applied', '投了': 'applied', '网申': 'applied',
    '笔试': 'written', '测评': 'written',
    '面试': 'interview', '一面': 'interview', '二面': 'interview', '三面': 'interview', '终面': 'interview', 'hr面': 'interview',
    offer_talk: 'offer_talk', '沟通offer': 'offer_talk', 'offer沟通': 'offer_talk', '谈offer': 'offer_talk', '谈薪': 'offer_talk', '谈薪资': 'offer_talk', '薪资沟通': 'offer_talk', '初步通过': 'offer_talk', '聊offer': 'offer_talk',
    offer: 'offer', '录用': 'offer', '拿到offer': 'offer', '已接受offer': 'offer', '接受offer': 'offer', '接受了offer': 'offer', '已接受': 'offer', '入职': 'offer',
    '挂了': 'rejected', '被拒': 'rejected', '拒绝': 'rejected', '流程终止': 'rejected',
};

const NOTE_KIND_MAP: Record<string, JobNoteKind> = {
    eval: 'eval', resume_advice: 'resume_advice', analysis: 'analysis', note: 'note',
    '评价': 'eval', '面试评价': 'eval', '面评': 'eval',
    '简历': 'resume_advice', '简历建议': 'resume_advice',
    '分析': 'analysis', '岗位分析': 'analysis',
    '笔记': 'note', '随手记': 'note',
};

// 岗位字段名宽容映射（LLM 可能用中英文各种叫法）；不认识的返回 null → 该条丢弃
const FIELD_MAP: Record<string, JobSettableField> = {
    title: 'title', '岗位名': 'title', '职位': 'title', '职位名': 'title', '岗位': 'title',
    project: 'projectName', projectname: 'projectName', '项目': 'projectName', '项目名': 'projectName', '业务线': 'projectName',
    location: 'location', '地点': 'location', '城市': 'location', '工作地点': 'location', '工作城市': 'location',
    salary: 'salary', pay: 'salary', '薪资': 'salary', '薪水': 'salary', '工资': 'salary', '待遇': 'salary', '薪酬': 'salary', '薪': 'salary',
    jd: 'jd', '岗位描述': 'jd', '职位描述': 'jd', '描述': 'jd', 'jd描述': 'jd',
    next: 'nextStep', nextstep: 'nextStep', '下一步': 'nextStep', '下步': 'nextStep', '行动': 'nextStep',
    stage: 'stage', '阶段': 'stage', '状态': 'stage', '进展': 'stage',
    notes: 'notes', note: 'notes', '笔记': 'notes', '备注': 'notes', '岗位笔记': 'notes',
};

// 环节类型/状态宽容映射（JOB_ROUND 用）
const ROUND_KIND_MAP: Record<string, JobRoundKind> = {
    written: 'written', '笔试': 'written', '测评': 'written', '笔': 'written',
    interview: 'interview', '面试': 'interview', '面': 'interview',
};
const ROUND_STATUS_MAP: Record<string, JobRoundStatus> = {
    pending: 'pending', '待安排': 'pending', '未安排': 'pending',
    scheduled: 'scheduled', '待进行': 'scheduled', '已约': 'scheduled', '已安排': 'scheduled', '待面': 'scheduled', '待考': 'scheduled',
    awaiting: 'awaiting', '等结果': 'awaiting', '等反馈': 'awaiting', '已完成': 'awaiting', '面完': 'awaiting', '考完': 'awaiting',
    passed: 'passed', '通过': 'passed', '过了': 'passed',
    failed: 'failed', '挂了': 'failed', '未通过': 'failed', '被拒': 'failed',
};

export const normalizeRoundKind = (raw: string): JobRoundKind | null =>
    ROUND_KIND_MAP[(raw || '').trim().toLowerCase()] ?? null;

export const normalizeRoundStatus = (raw: string): JobRoundStatus =>
    ROUND_STATUS_MAP[(raw || '').trim().toLowerCase()] ?? 'scheduled';

/**
 * 解析指令里的时间文本 → 时间戳（本机时区）。
 * 收：YYYY-M-D HH:mm / M-D HH:mm（年缺省取就近未来）/ M-D（默认 09:00）；分隔符 - 或 / 或 月日汉字。
 * 解不出返回 null（该指令不改时间，不报错不阻断）。
 */
export function parseJobTimeText(raw: string, now: Date = new Date()): number | null {
    const t = (raw || '').trim().replace(/日/g, '').replace(/[年月]/g, '-').replace(/\//g, '-');
    const m = t.match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2}))?$/);
    if (!m) return null;
    const month = parseInt(m[2], 10), day = parseInt(m[3], 10);
    const hour = m[4] !== undefined ? parseInt(m[4], 10) : 9;
    const minute = m[5] !== undefined ? parseInt(m[5], 10) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    if (m[1]) {
        const d = new Date(parseInt(m[1], 10), month - 1, day, hour, minute);
        return isNaN(d.getTime()) ? null : d.getTime();
    }
    // 年缺省：取就近未来——今年该日期已过去超过一天则算明年
    const thisYear = new Date(now.getFullYear(), month - 1, day, hour, minute);
    if (isNaN(thisYear.getTime())) return null;
    if (thisYear.getTime() < now.getTime() - 24 * 3600 * 1000) {
        return new Date(now.getFullYear() + 1, month - 1, day, hour, minute).getTime();
    }
    return thisYear.getTime();
}

export const normalizeJobField = (raw: string): JobSettableField | null =>
    FIELD_MAP[(raw || '').trim().toLowerCase()] ?? null;

export const normalizeJobStage = (raw: string): JobStage =>
    STAGE_MAP[raw.trim().toLowerCase()] ?? 'applied';

export const normalizeNoteKind = (raw: string): JobNoteKind =>
    NOTE_KIND_MAP[raw.trim().toLowerCase()] ?? 'note';

/** 改进点分层：认「简历/resume/写法」为 resume，其余回落 strategy */
export const normalizeGapKind = (raw: string): 'strategy' | 'resume' =>
    /简历|resume|写法/i.test((raw || '').trim()) ? 'resume' : 'strategy';

/** 从 LLM 回复中提取全部指令并剥离标记。解析失败的标记直接丢弃（不阻塞正文渲染） */
export function parseJobHuntCommands(text: string): JobParseResult {
    const updates: ParsedJobUpdate[] = [];
    const sets: ParsedJobSet[] = [];
    const edits: ParsedJobEdit[] = [];
    const rounds: ParsedJobRound[] = [];
    const interviews: ParsedJobInterview[] = [];
    const waitings: ParsedJobWaiting[] = [];
    const notes: ParsedJobNote[] = [];
    const positionDeletes: string[] = [];
    const noteEdits: { title: string; oldSnippet: string; newSnippet: string }[] = [];
    const noteDeletes: string[] = [];
    const edgeAdds: string[] = [];
    const edgeDels: string[] = [];
    const gapAdds: { kind: 'strategy' | 'resume'; text: string }[] = [];
    const gapDels: string[] = [];
    const searches: string[] = [];
    const noteReads: string[] = [];
    let view = false;
    let direction: string | undefined;

    // ── 查看类（不落库，结果回灌给 AI + 挂折叠卡片） ──
    let cleanText = text.replace(JOB_VIEW_RE, () => {
        view = true;
        return '';
    });
    cleanText = cleanText.replace(JOB_SEARCH_RE, (_m, kw: string) => {
        const k = (kw || '').trim();
        if (k) searches.push(k);
        return '';
    });
    cleanText = cleanText.replace(JOB_NOTE_READ_RE, (_m, title: string) => {
        const t = (title || '').trim();
        if (t) noteReads.push(t);
        return '';
    });

    // ── 岗位建卡/更新（支持键值对 + 老三段式兼容） ──
    cleanText = cleanText.replace(JOB_UPDATE_RE, (_m, code: string, body: string) => {
        const c = (code || '').trim();
        if (!c) return '';
        const segments = (body || '').split('|').map(s => s.trim());
        // 第一段含冒号 → 键值对模式
        if (segments.length > 0 && segments[0].includes(':')) {
            const fields: Partial<Record<JobSettableField, string>> = {};
            let stage: JobStage = 'applied';
            let nextStep = '';
            for (const seg of segments) {
                const ci = seg.indexOf(':');
                if (ci < 0) continue;
                const rawKey = seg.slice(0, ci).trim().toLowerCase();
                const val = seg.slice(ci + 1).trim();
                const field = normalizeJobField(rawKey);
                if (!field || !val) continue;
                if (field === 'stage') {
                    stage = normalizeJobStage(val);
                } else if (field === 'nextStep' || rawKey === 'next') {
                    nextStep = val;
                    fields.nextStep = val;
                } else {
                    fields[field] = val;
                }
            }
            updates.push({ code: c, stage, nextStep, fields: Object.keys(fields).length > 0 ? fields : undefined });
        } else {
            // 老三段式：代号|阶段|下一步
            const stage = normalizeJobStage(segments[0] || '');
            const nextStep = (segments[1] || '').trim();
            updates.push({ code: c, stage, nextStep });
        }
        return '';
    });

    // ── 岗位短字段编辑 ──
    cleanText = cleanText.replace(JOB_SET_RE, (_m, code: string, field: string, value: string) => {
        const c = (code || '').trim();
        const f = normalizeJobField(field || '');
        const v = (value || '').trim();
        // jd / notes 不允许用 SET（防覆盖丢内容），必须用 JOB_EDIT 片段替换
        if (c && f && f !== 'jd' && f !== 'notes' && (f === 'stage' || v)) {
            sets.push({ code: c, field: f, value: v });
        }
        return '';
    });

    // ── 岗位长字段片段替换（jd / notes） ──
    cleanText = cleanText.replace(JOB_EDIT_RE, (_m, code: string, field: string, oldSnip: string, newSnip: string) => {
        const c = (code || '').trim();
        const f = (field || '').trim().toLowerCase();
        const oldS = (oldSnip || '').trim();
        const newS = (newSnip || '').trim();
        if (c && (f === 'jd' || f === 'notes') && oldS) {
            edits.push({ code: c, field: f, oldSnippet: oldS, newSnippet: newS });
        }
        return '';
    });

    // 环节指令：[[JOB_ROUND:代号|轮次|类型|状态|时间]]（时间段可省；填「清除」删时间）
    cleanText = cleanText.replace(JOB_ROUND_RE, (_m, code: string, idxRaw: string, kindRaw: string, statusRaw: string, atRaw: string) => {
        const c = (code || '').trim();
        const kind = normalizeRoundKind(kindRaw || '');
        const idx = parseInt((idxRaw || '').trim().replace(/[^0-9]/g, ''), 10);
        if (!c || !kind || !idx || idx < 1 || idx > 10) return '';
        const atText = (atRaw || '').trim();
        const clearAt = atText === '清除' || atText.toLowerCase() === 'clear';
        const at = clearAt ? undefined : (atText ? parseJobTimeText(atText) ?? undefined : undefined);
        rounds.push({ code: c, kind, index: idx, status: normalizeRoundStatus(statusRaw || ''), at, clearAt });
        return '';
    });

    // 面试时间快捷：[[JOB_INTERVIEW:代号|M-D HH:mm]] / [[JOB_INTERVIEW:代号|清除]]
    cleanText = cleanText.replace(JOB_INTERVIEW_RE, (_m, code: string, timeRaw: string) => {
        const c = (code || '').trim();
        if (!c) return '';
        const t = (timeRaw || '').trim();
        if (t === '清除' || t.toLowerCase() === 'clear') { interviews.push({ code: c, clear: true }); return ''; }
        const at = parseJobTimeText(t);
        if (at) interviews.push({ code: c, at });
        return '';
    });

    // 等反馈：[[JOB_WAITING:代号]] 开始等（=当前时间）/ [[JOB_WAITING:代号|清除]] 取消
    cleanText = cleanText.replace(JOB_WAITING_RE, (_m, code: string, flagRaw: string) => {
        const c = (code || '').trim();
        if (!c) return '';
        const flag = (flagRaw || '').trim();
        waitings.push({ code: c, clear: flag === '清除' || flag.toLowerCase() === 'clear' });
        return '';
    });

    // 笔记编辑（三段式：完整标题|旧片段|新片段）
    cleanText = cleanText.replace(JOB_NOTE_EDIT_RE, (_m, title: string, oldSnip: string, newSnip: string) => {
        const t = (title || '').trim();
        const oldS = (oldSnip || '').trim();
        const newS = (newSnip || '').trim();
        if (t && oldS) noteEdits.push({ title: t, oldSnippet: oldS, newSnippet: newS });
        return '';
    });

    cleanText = cleanText.replace(JOB_NOTE_DEL_RE, (_m, title: string) => {
        const t = (title || '').trim();
        if (t) noteDeletes.push(t);
        return '';
    });

    cleanText = cleanText.replace(JOB_NOTE_RE, (_m, kind: string, title: string, content: string) => {
        const t = (title || '').trim();
        const body = (content || '').trim();
        if (t && body) notes.push({ kind: normalizeNoteKind(kind || ''), title: t, content: body });
        return '';
    });

    cleanText = cleanText.replace(JOB_DEL_RE, (_m, code: string) => {
        const c = (code || '').trim();
        if (c) positionDeletes.push(c);
        return '';
    });

    // ── 竞争力档案（第八节）：方向 / 竞争点增删 / 改进点增删 ──
    cleanText = cleanText.replace(JOB_DIRECTION_RE, (_m, v: string) => {
        const t = (v || '').trim();
        if (t) direction = t; // 多条取最后一条
        return '';
    });
    cleanText = cleanText.replace(JOB_EDGE_ADD_RE, (_m, v: string) => {
        const t = (v || '').trim();
        if (t) edgeAdds.push(t);
        return '';
    });
    cleanText = cleanText.replace(JOB_EDGE_DEL_RE, (_m, v: string) => {
        const t = (v || '').trim();
        if (t) edgeDels.push(t);
        return '';
    });
    cleanText = cleanText.replace(JOB_GAP_ADD_RE, (_m, kindRaw: string, v: string) => {
        const t = (v || '').trim();
        if (t) gapAdds.push({ kind: normalizeGapKind(kindRaw || ''), text: t });
        return '';
    });
    cleanText = cleanText.replace(JOB_GAP_DEL_RE, (_m, v: string) => {
        const t = (v || '').trim();
        if (t) gapDels.push(t);
        return '';
    });

    // 剥标记后可能留下成串空行，压回最多一个空行
    cleanText = cleanText.replace(/(\s*\r?\n){3,}/g, '\u000a\u000a').trim();

    return { cleanText, view, searches, noteReads, updates, sets, edits, rounds, interviews, waitings, notes, positionDeletes, noteEdits, noteDeletes, edgeAdds, edgeDels, gapAdds, gapDels, direction };
}

/** 注入 system prompt 的指令说明段（教角色怎么用标记；精确匹配优先，删除要审慎） */
export const JOB_COMMAND_GUIDE = [
    '【求职工作台指令】对话里出现岗位进展变化或值得沉淀的结论时，你可以在回复末尾追加指令（用户看不到标记本身，会看到一张操作卡片）。系统摘要里已列出在推进的岗位代号和阶段——日常编辑直接用这些代号，不需要先查看。',
    '',
    '【查看类】需要看 JD / 笔记 / 详情时才用，日常编辑不用。',
    '- 查看工作台全貌（岗位详情+笔记列表+教学）：[[JOB_VIEW]]',
    '- 搜索岗位/笔记（返回匹配列表，不含全文，上限10条）：[[JOB_SEARCH:关键词]]',
    '- 读笔记全文（标题必须精确匹配）：[[JOB_NOTE_READ:完整标题]]',
    '',
    '【岗位编辑类】',
    '1. 建卡/批量录入（推荐键值对，一次带全字段）：[[JOB_UPDATE:代号|stage:阶段|title:岗位名|project:项目|location:地点|salary:薪资|next:下一步|jd:岗位描述]]。字段可省，顺序无所谓。阶段限 watching(观望中)/applied(已投递)/written(笔试)/interview(面试)/offer_talk(沟通Offer)/offer(已接受Offer)/rejected(挂了)。例：[[JOB_UPDATE:C司|stage:面试|title:前端工程师|location:北京|salary:25k|next:准备二面]]。老格式 [[JOB_UPDATE:代号|阶段|下一步]] 仍兼容。用户提到新投了岗位就建卡（代号自拟，如 C司）；看上了但还没投用 watching。',
    '2. 改短字段（覆盖语义，用于 title/project/location/salary/stage/next）：[[JOB_SET:代号|字段|值]]，一条改一个字段。例：[[JOB_SET:C司|salary|28k]]。只能改已建档的岗位。',
    '3. 改长字段 jd / notes（片段替换，必须精确匹配旧片段）：[[JOB_EDIT:代号|字段|旧片段|新片段]]。旧片段必须在现有内容里精确出现，否则拒绝。例：[[JOB_EDIT:C司|jd|负责前端开发|负责 React 前端开发]]。没看过现有内容写不出旧片段 → 改不了 → 自然需要先 [[JOB_VIEW]] 看一眼。追加内容时找一个锚点片段替换成「锚点+新内容」。',
    '4. 环节轮次：[[JOB_ROUND:代号|轮次|类型|状态|时间]]。类型限 interview(面试)/written(笔试)；轮次 1~10；状态限 pending(待安排)/scheduled(待进行)/awaiting(等结果)/passed(通过)/failed(挂了)；时间可省，格式 M-D HH:mm（如 8-2 14:00），填「清除」删时间。例：[[JOB_ROUND:C司|3|面试|待进行|8-6 14:00]]。同代号同类型同轮次再发即更新该轮。',
    '5. 面试时间快捷：[[JOB_INTERVIEW:代号|M-D HH:mm]] / [[JOB_INTERVIEW:代号|清除]]；等反馈：[[JOB_WAITING:代号]]（开始）/ [[JOB_WAITING:代号|清除]]（结束）。',
    '6. 删岗位卡：[[JOB_DEL:代号]]。仅当用户明确要求删除时才用，删除要克制。',
    '',
    '【笔记类】',
    '7. 记入笔记本：[[JOB_NOTE:类型|标题|正文]]。类型限 eval(面试评价)/resume_advice(简历建议)/analysis(岗位分析)/note(随手记)；正文用 markdown，可多行。只记真正值得回看的结论。',
    '8. 改笔记（标题精确匹配 + 旧片段精确替换）：[[JOB_NOTE_EDIT:完整标题|旧片段|新片段]]。标题必须精确出现，旧片段必须在正文里精确出现，否则拒绝。例：[[JOB_NOTE_EDIT:C司一面复盘|面试官问了项目|面试官重点问了项目细节和性能优化]]。',
    '9. 删笔记（标题精确匹配）：[[JOB_NOTE_DEL:完整标题]]。标题必须精确出现，否则拒绝。删除审慎。',
    '',
    '【竞争力档案】（聊到相关话题才用）',
    '10. 加竞争点 [[JOB_EDGE_ADD:一句话优势]]；删竞争点 [[JOB_EDGE_DEL:关键词]]；加改进点 [[JOB_GAP_ADD:strategy或resume|一句话]]（strategy=求职策略层，resume=简历写法层）；删改进点 [[JOB_GAP_DEL:关键词]]；设求职方向 [[JOB_DIRECTION:一句话方向]]（覆盖式）。删除或覆盖前先跟用户确认。',
    '',
    '【原则】',
    '11. 精确匹配：岗位代号、笔记标题、编辑旧片段都必须精确匹配，匹配不上直接拒绝。没看过就写不出精确值 → 自然改不了 → 需要先查看。这是工具设计的安全机制，不是缺陷。',
    '12. 隐私铁律：公司一律用代号（如 A厂、B司），绝不写真实公司名；用户的真实姓名、电话、住址等信息绝不写进任何指令或回复。',
    '13. 这些指令只在聊到求职时才用，日常闲聊不要输出。',
].join('\u000a');
