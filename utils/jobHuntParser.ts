// 上岸计划 · 指令解析（LLM 输出标记 → 结构化落库）
// 沿用钱包 SPEND 那套「输出标记 → 正则解析 → 落库」的管线：
//   [[JOB_UPDATE:代号|阶段|下一步]]  → 更新/新建岗位卡
//   [[JOB_NOTE:类型|标题|正文]]      → 落笔记本
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
}

const JOB_UPDATE_RE = /\[\[JOB_UPDATE:([^|\]]+)\|([^|\]]+)\|([^\]]*)\]\]/g;
const JOB_NOTE_RE = /\[\[JOB_NOTE:([^|\]]+)\|([^|\]]+)\|([\s\S]*?)\]\]/g;

// LLM 常会用中文写阶段/类型，宽容映射；不认识的一律回落安全默认值
const STAGE_MAP: Record<string, JobStage> = {
    applied: 'applied', written: 'written', interview: 'interview', rejected: 'rejected',
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

    let cleanText = text.replace(JOB_UPDATE_RE, (_m, code: string, stage: string, nextStep: string) => {
        const c = (code || '').trim();
        if (c) updates.push({ code: c, stage: normalizeJobStage(stage || ''), nextStep: (nextStep || '').trim() });
        return '';
    });

    cleanText = cleanText.replace(JOB_NOTE_RE, (_m, kind: string, title: string, content: string) => {
        const t = (title || '').trim();
        const body = (content || '').trim();
        if (t && body) notes.push({ kind: normalizeNoteKind(kind || ''), title: t, content: body });
        return '';
    });

    // 剥标记后可能留下成串空行，压回最多一个空行
    cleanText = cleanText.replace(/(\s*\r?\n){3,}/g, '\u000a\u000a').trim();

    return { cleanText, updates, notes };
}

/** 注入 system prompt 的指令说明段（教角色怎么用标记；只教「已建档才记、公司只用代号」） */
export const JOB_COMMAND_GUIDE = [
    '【工作台指令】当对话里出现岗位进展变化或值得沉淀的结论时，你可以在回复末尾追加指令（用户看不到标记本身）：',
    '1. 更新岗位卡：[[JOB_UPDATE:代号|阶段|下一步]]。阶段限 applied/written/interview/offer/rejected；「下一步」写一句话行动项，可留空。只更新对话里明确提到、且已在工作台建档的岗位，不要凭空新建。',
    '2. 记入笔记本：[[JOB_NOTE:类型|标题|正文]]。类型限 eval(面试评价)/resume_advice(简历建议)/analysis(岗位分析)/note(随手记)；正文用 markdown，可多行。只记真正值得回看的结论，不要把闲聊记进去。',
    '3. 隐私铁律：公司一律用代号（如 A厂、B司），绝不写真实公司名；用户的真实姓名、电话、住址等信息绝不写进任何指令或回复。',
].join('\u000a');
