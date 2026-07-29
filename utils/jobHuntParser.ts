// 上岸计划 · 指令解析（LLM 输出标记 → 结构化落库）
// 沿用钱包 SPEND 那套「输出标记 → 正则解析 → 落库」的管线：
//   [[JOB_UPDATE:代号|阶段|下一步]]      → 更新/新建岗位卡
//   [[JOB_DEL:代号]]                    → 删岗位卡
//   [[JOB_NOTE:类型|标题|正文]]          → 落笔记本
//   [[JOB_NOTE_EDIT:标题关键词|新正文]]  → 改笔记（标题模糊匹配最新一条）
//   [[JOB_NOTE_DEL:标题关键词]]         → 删笔记
// 正则全部用 [\s\S] 兜跨行，不写换行字面量（防工具链把它炸成真实换行）。

import { JobNoteKind, JobStage } from '../types';

export interface ParsedJobUpdate {
    code: string;
    stage: JobStage;
    nextStep: string;
}

export interface ParsedJobNote {
    kind: JobNoteKind;
    title: string;
    content: string;
}

export interface JobParseResult {
    /** 去掉所有指令标记后的正文（用于渲染/入库） */
    cleanText: string;
    updates: ParsedJobUpdate[];
    notes: ParsedJobNote[];
    /** 要删除的岗位代号 */
    positionDeletes: string[];
    /** 笔记编辑：标题关键词匹配 + 新正文 */
    noteEdits: { titleKey: string; content: string }[];
    /** 要删除的笔记标题关键词 */
    noteDeletes: string[];
}

const JOB_UPDATE_RE = /\[\[JOB_UPDATE:([^|\]]+)\|([^|\]]+)\|([^\]]*)\]\]/g;
const JOB_NOTE_RE = /\[\[JOB_NOTE:([^|\]]+)\|([^|\]]+)\|([\s\S]*?)\]\]/g;
const JOB_DEL_RE = /\[\[JOB_DEL:([^\]]+)\]\]/g;
const JOB_NOTE_EDIT_RE = /\[\[JOB_NOTE_EDIT:([^|\]]+)\|([\s\S]*?)\]\]/g;
const JOB_NOTE_DEL_RE = /\[\[JOB_NOTE_DEL:([^\]]+)\]\]/g;

// LLM 常会用中文写阶段/类型，宽容映射；不认识的一律回落安全默认值
const STAGE_MAP: Record<string, JobStage> = {
    watching: 'watching', applied: 'applied', written: 'written', interview: 'interview', rejected: 'rejected',
    '观望': 'watching', '观望中': 'watching', '意向': 'watching', '想投': 'watching', '还没投': 'watching', '待投递': 'watching',
    '投递': 'applied', '已投递': 'applied', '投了': 'applied', '网申': 'applied',
    '笔试': 'written', '测评': 'written',
    '面试': 'interview', '一面': 'interview', '二面': 'interview', '三面': 'interview', '终面': 'interview', 'hr面': 'interview',
    'offer': 'offer', '录用': 'offer', '拿到offer': 'offer',
    '挂了': 'rejected', '被拒': 'rejected', '拒绝': 'rejected', '流程终止': 'rejected',
};

const NOTE_KIND_MAP: Record<string, JobNoteKind> = {
    eval: 'eval', resume_advice: 'resume_advice', analysis: 'analysis', note: 'note',
    '评价': 'eval', '面试评价': 'eval', '面评': 'eval',
    '简历': 'resume_advice', '简历建议': 'resume_advice',
    '分析': 'analysis', '岗位分析': 'analysis',
    '笔记': 'note', '随手记': 'note',
};

export const normalizeJobStage = (raw: string): JobStage =>
    STAGE_MAP[raw.trim().toLowerCase()] ?? 'applied';

export const normalizeNoteKind = (raw: string): JobNoteKind =>
    NOTE_KIND_MAP[raw.trim().toLowerCase()] ?? 'note';

/** 从 LLM 回复中提取全部指令并剥离标记。解析失败的标记直接丢弃（不阻塞正文渲染） */
export function parseJobHuntCommands(text: string): JobParseResult {
    const updates: ParsedJobUpdate[] = [];
    const notes: ParsedJobNote[] = [];
    const positionDeletes: string[] = [];
    const noteEdits: { titleKey: string; content: string }[] = [];
    const noteDeletes: string[] = [];

    let cleanText = text.replace(JOB_UPDATE_RE, (_m, code: string, stage: string, nextStep: string) => {
        const c = (code || '').trim();
        if (c) updates.push({ code: c, stage: normalizeJobStage(stage || ''), nextStep: (nextStep || '').trim() });
        return '';
    });

    cleanText = cleanText.replace(JOB_NOTE_EDIT_RE, (_m, titleKey: string, content: string) => {
        const k = (titleKey || '').trim();
        const body = (content || '').trim();
        if (k && body) noteEdits.push({ titleKey: k, content: body });
        return '';
    });

    cleanText = cleanText.replace(JOB_NOTE_DEL_RE, (_m, titleKey: string) => {
        const k = (titleKey || '').trim();
        if (k) noteDeletes.push(k);
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

    // 剥标记后可能留下成串空行，压回最多一个空行
    cleanText = cleanText.replace(/(\s*\r?\n){3,}/g, '\u000a\u000a').trim();

    return { cleanText, updates, notes, positionDeletes, noteEdits, noteDeletes };
}

/** 注入 system prompt 的指令说明段（教角色怎么用标记；全套增删改，删除要审慎） */
export const JOB_COMMAND_GUIDE = [
    '【求职工作台指令】对话里出现岗位进展变化或值得沉淀的结论时，你可以在回复末尾追加指令（用户看不到标记本身，会看到一张操作卡片）：',
    '1. 建卡/更新岗位：[[JOB_UPDATE:代号|阶段|下一步]]。阶段限 watching(观望中)/applied/written/interview/offer/rejected；「下一步」写一句话行动项，可留空。用户提到新投了岗位可以用它建卡（代号自拟，如 C司）；看上了但还没投的岗位用 watching；已建档的岗位有进展就更新。',
    '2. 删岗位卡：[[JOB_DEL:代号]]。仅当用户明确要求删除、或流程彻底结束且用户同意清理时才用，删除要克制。',
    '3. 记入笔记本：[[JOB_NOTE:类型|标题|正文]]。类型限 eval(面试评价)/resume_advice(简历建议)/analysis(岗位分析)/note(随手记)；正文用 markdown，可多行。只记真正值得回看的结论。',
    '4. 改笔记：[[JOB_NOTE_EDIT:标题关键词|新正文]]（整篇替换）；删笔记：[[JOB_NOTE_DEL:标题关键词]]。关键词按标题匹配最近一条，只能操作上面列出的笔记；删除同样审慎。',
    '5. 隐私铁律：公司一律用代号（如 A厂、B司），绝不写真实公司名；用户的真实姓名、电话、住址等信息绝不写进任何指令或回复。',
    '6. 这些指令只在聊到求职时才用，日常闲聊不要输出。',
].join('\u000a');
