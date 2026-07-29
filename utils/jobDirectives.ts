/**
 * 上岸计划 · 单聊侧指令执行器（照 memos.ts 的 parse/apply 分工）。
 *
 * 分工：
 *   - jobHuntParser.ts        → 正则解析 + 剥标签（parseJobHuntCommands）
 *   - 本文件                  → 把解析结果落库（job_positions / job_notes 增删改），
 *                               并为每条指令产出一张 job_card 消息的 metadata，
 *                               由 applyAssistantPostProcessing 落进单聊消息流。
 *   - buildJobHuntPromptBlock → 求职模式的 prompt 注入块（岗位列表 + 笔记标题清单 + 指令教学）。
 *                               仅 char.jobHuntEnabled 时由 chatPrompts 调用。
 *
 * 隐私铁律：companyNameLocal（真实公司名备注）永不出现在任何注入/卡片 preview 里。
 */

import { DB } from './db';
import { JobNote, JobPosition, Message } from '../types';
import { JobParseResult, JOB_COMMAND_GUIDE } from './jobHuntParser';
import { redactPrivacy, codifyCompanies } from './privacyRedact';

const STAGE_LABEL: Record<string, string> = {
    watching: '观望中', applied: '已投递', written: '笔试中', interview: '面试中', offer: 'Offer', rejected: '已结束',
};
const NOTE_KIND_LABEL: Record<string, string> = {
    eval: '面试评价', resume_advice: '简历建议', analysis: '岗位分析', note: '随手记',
};

const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * JD 摘要（喂 LLM 专用）：用户粘贴的 JD 原文可能带邮箱/手机/真实公司名，
 * 进 prompt 前先脱敏、再把真实公司名替换成岗位代号，最后截断、压成单行。
 * hrName 不经过这里——它根本不进 prompt。
 */
export function jdDigestForPrompt(pos: JobPosition, allPositions: JobPosition[], maxLen = 200): string {
    const raw = (pos.jd || '').trim();
    if (!raw) return '';
    let text = redactPrivacy(raw).text;
    text = codifyCompanies(text, allPositions);
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** 岗位注入行（单聊 / 工作台两处共用，保证对齐）：代号·岗位·阶段·项目·下一步·JD 摘要 */
export function buildPositionPromptLine(p: JobPosition, allPositions: JobPosition[]): string {
    const parts = [`- ${p.code} · ${p.title} · ${STAGE_LABEL[p.stage] || p.stage}`];
    if (p.projectName) parts.push(`项目：${p.projectName}`);
    if (p.nextStep) parts.push(`下一步：${p.nextStep}`);
    const jd = jdDigestForPrompt(p, allPositions);
    if (jd) parts.push(`JD 摘要：${jd}`);
    return parts.join(' · ');
}

/** 一张 job_card 消息的 metadata.jobCard 结构 */
export interface JobCardPayload {
    jobKind: 'update' | 'delete' | 'note' | 'note_edit' | 'note_del';
    /** update/delete：岗位代号 */
    code?: string;
    stage?: string;
    stageLabel?: string;
    nextStep?: string;
    /** update 时是否为新建卡 */
    created?: boolean;
    /** note 系列 */
    noteId?: string;
    noteKind?: string;
    noteKindLabel?: string;
    title?: string;
    /** 笔记摘要（截断，点卡片弹全文时从 DB 按 noteId 取） */
    preview?: string;
}

/**
 * 求职模式 prompt 注入块：岗位列表 + 近期笔记标题（AI 能看见才能改/删）+ 指令教学。
 * 无岗位无笔记也返回教学段（开关已开 = 用户想让角色帮忙管理，AI 得知道能力存在）。
 */
export async function buildJobHuntPromptBlock(): Promise<string> {
    let positions: JobPosition[] = [];
    let notes: JobNote[] = [];
    try { positions = await DB.getJobPositions(); } catch { /* 表还没建等场景，静默 */ }
    try { notes = await DB.getJobNotes(); } catch { /* 同上 */ }

    const lines: string[] = ['### 【求职工作台 · 上岸计划】'];
    lines.push(`你在帮用户推进求职。以下是工作台当前状态（公司都是代号，真实公司名你看不到也不需要知道）：`);
    const active = positions.filter(p => p.stage !== 'rejected');
    if (active.length > 0) {
        lines.push('【在推进的岗位】');
        active.forEach(p => {
            lines.push(buildPositionPromptLine(p, positions));
        });
    } else {
        lines.push('【在推进的岗位】暂无建档岗位（用户聊到新投递时你可以用指令帮 ta 建卡）。');
    }
    const recentNotes = notes.slice(0, 8);
    if (recentNotes.length > 0) {
        lines.push('【笔记本近期条目】（可用 JOB_NOTE_EDIT / JOB_NOTE_DEL 按标题操作）');
        recentNotes.forEach(n => {
            lines.push(`- [${NOTE_KIND_LABEL[n.kind] || n.kind}] ${n.title}`);
        });
    }
    lines.push('');
    lines.push(JOB_COMMAND_GUIDE);
    return lines.join('\n');
}

/**
 * 把 parseJobHuntCommands 的结果落库，返回每条成功指令对应的 job_card payload。
 * 与备忘录同款容错：单条失败跳过不拦其余；删除/编辑找不到目标记入 rejected。
 */
export async function applyJobDirectives(
    parsed: JobParseResult,
    charId: string,
): Promise<{ cards: JobCardPayload[]; rejected: string[] }> {
    const cards: JobCardPayload[] = [];
    const rejected: string[] = [];
    const now = Date.now();

    // ── 岗位建卡/更新 ──
    for (const u of parsed.updates) {
        try {
            const all = await DB.getJobPositions();
            const existing = all.find(p => p.code === u.code);
            if (existing) {
                await DB.saveJobPosition({
                    ...existing,
                    stage: u.stage,
                    nextStep: u.nextStep || existing.nextStep,
                    timeline: [...existing.timeline, { ts: now, stage: u.stage, note: u.nextStep || undefined }],
                    updatedAt: now,
                });
                cards.push({ jobKind: 'update', code: u.code, stage: u.stage, stageLabel: STAGE_LABEL[u.stage] || u.stage, nextStep: u.nextStep || undefined, created: false });
            } else {
                await DB.saveJobPosition({
                    id: genId('jpos'), code: u.code, title: u.code, stage: u.stage,
                    nextStep: u.nextStep || undefined, timeline: [{ ts: now, stage: u.stage }],
                    charId, createdAt: now, updatedAt: now,
                });
                cards.push({ jobKind: 'update', code: u.code, stage: u.stage, stageLabel: STAGE_LABEL[u.stage] || u.stage, nextStep: u.nextStep || undefined, created: true });
            }
        } catch (e: any) { rejected.push(`JOB_UPDATE ${u.code}: ${e?.message || e}`); }
    }

    // ── 岗位删除 ──
    for (const code of parsed.positionDeletes) {
        try {
            const all = await DB.getJobPositions();
            const target = all.find(p => p.code === code);
            if (!target) { rejected.push(`JOB_DEL: 找不到代号「${code}」`); continue; }
            await DB.deleteJobPosition(target.id);
            cards.push({ jobKind: 'delete', code, stage: target.stage, stageLabel: STAGE_LABEL[target.stage] || target.stage });
        } catch (e: any) { rejected.push(`JOB_DEL ${code}: ${e?.message || e}`); }
    }

    // ── 笔记新建 ──
    for (const n of parsed.notes) {
        try {
            const note: JobNote = {
                id: genId('jnote'), kind: n.kind, title: n.title, content: n.content,
                charId, createdAt: now,
            };
            await DB.saveJobNote(note);
            cards.push({
                jobKind: 'note', noteId: note.id, noteKind: n.kind,
                noteKindLabel: NOTE_KIND_LABEL[n.kind] || n.kind,
                title: n.title, preview: n.content.replace(/[#*`>]/g, '').slice(0, 120),
            });
        } catch (e: any) { rejected.push(`JOB_NOTE ${n.title}: ${e?.message || e}`); }
    }

    // 标题模糊匹配：includes 命中里取 createdAt 最新的一条（与 GUIDE 教学一致）
    const findNote = (all: JobNote[], titleKey: string): JobNote | undefined => {
        const key = titleKey.toLowerCase();
        return all
            .filter(x => (x.title || '').toLowerCase().includes(key))
            .sort((a, b) => b.createdAt - a.createdAt)[0];
    };

    // ── 笔记编辑（整篇替换） ──
    for (const e2 of parsed.noteEdits) {
        try {
            const all = await DB.getJobNotes();
            const target = findNote(all, e2.titleKey);
            if (!target) { rejected.push(`JOB_NOTE_EDIT: 找不到标题含「${e2.titleKey}」的笔记`); continue; }
            await DB.saveJobNote({ ...target, content: e2.content });
            cards.push({
                jobKind: 'note_edit', noteId: target.id, noteKind: target.kind,
                noteKindLabel: NOTE_KIND_LABEL[target.kind] || target.kind,
                title: target.title, preview: e2.content.replace(/[#*`>]/g, '').slice(0, 120),
            });
        } catch (err: any) { rejected.push(`JOB_NOTE_EDIT ${e2.titleKey}: ${err?.message || err}`); }
    }

    // ── 笔记删除 ──
    for (const key of parsed.noteDeletes) {
        try {
            const all = await DB.getJobNotes();
            const target = findNote(all, key);
            if (!target) { rejected.push(`JOB_NOTE_DEL: 找不到标题含「${key}」的笔记`); continue; }
            await DB.deleteJobNote(target.id);
            cards.push({
                jobKind: 'note_del', noteKind: target.kind,
                noteKindLabel: NOTE_KIND_LABEL[target.kind] || target.kind,
                title: target.title,
            });
        } catch (err: any) { rejected.push(`JOB_NOTE_DEL ${key}: ${err?.message || err}`); }
    }

    return { cards, rejected };
}

/** job_card 的历史转述（buildMessageHistory / 归档 / 记忆宫殿读到的文本） */
export function describeJobCard(card: JobCardPayload | undefined, charName: string): string {
    if (!card) return '[求职工作台操作]';
    switch (card.jobKind) {
        case 'update':
            return `[系统: ${charName}${card.created ? '为你建了岗位卡' : '更新了岗位进展'} ${card.code} → ${card.stageLabel}${card.nextStep ? `，下一步：${card.nextStep}` : ''}]`;
        case 'delete':
            return `[系统: ${charName}删除了岗位卡 ${card.code}]`;
        case 'note':
            return `[系统: ${charName}记了一篇${card.noteKindLabel}《${card.title}》到求职笔记本]`;
        case 'note_edit':
            return `[系统: ${charName}修改了求职笔记《${card.title}》]`;
        case 'note_del':
            return `[系统: ${charName}删除了求职笔记《${card.title}》]`;
        default:
            return '[求职工作台操作]';
    }
}

/**
 * 整批操作的一段话转述：同一轮回复的所有指令合并成一张聚合卡后，
 * content 用这段文本（历史/归档/记忆宫殿可读，不丢信息）。
 */
export function describeJobBatch(cards: JobCardPayload[], charName: string): string {
    if (cards.length === 0) return '[求职工作台操作]';
    if (cards.length === 1) return describeJobCard(cards[0], charName);
    const parts = cards.map(c => {
        switch (c.jobKind) {
            case 'update': return `${c.created ? '建卡' : '更新'} ${c.code} → ${c.stageLabel}${c.nextStep ? `（下一步：${c.nextStep}）` : ''}`;
            case 'delete': return `删岗位卡 ${c.code}`;
            case 'note': return `记${c.noteKindLabel}《${c.title}》`;
            case 'note_edit': return `改笔记《${c.title}》`;
            case 'note_del': return `删笔记《${c.title}》`;
            default: return '工作台操作';
        }
    });
    return `[系统: ${charName}更新了求职工作台（${cards.length} 项）：${parts.join('；')}]`;
}

/**
 * 一次性历史迁移：聚合卡上线前，每条 JOB 指令单独落一张卡（metadata.jobCard 单数），
 * AI 连发指令时聊天里刷屏。把同一轮回复产生的连续旧卡合并成一张聚合卡
 * （jobCards 数组，与新数据同构），正文重写成整批转述。
 * 判定「同一轮」：消息流里相邻（中间无其他消息）+ 时间戳间隔 ≤ 15 秒。
 * 单张旧卡不动（渲染端本就兼容单数形态）。返回被合并掉的消息条数。
 */
export async function mergeLegacyJobCardRuns(charIds: string[]): Promise<number> {
    let merged = 0;
    for (const charId of charIds) {
        try {
            const all: Message[] = await DB.getMessagesByCharId(charId, true);
            let run: Message[] = [];
            const flush = async () => {
                if (run.length >= 2) {
                    const cards = run.map(x => (x.metadata as any).jobCard as JobCardPayload);
                    const head = run[0];
                    const headName = String((head.metadata as any)?.charName || '');
                    await DB.updateMessageMetadata(head.id, (prev: any) => {
                        const { jobCard, ...rest } = prev || {};
                        return { ...rest, jobCards: cards };
                    });
                    await DB.updateMessage(head.id, describeJobBatch(cards, headName));
                    await DB.deleteMessages(run.slice(1).map(x => x.id));
                    merged += run.length - 1;
                }
                run = [];
            };
            for (const msg of all) {
                const meta: any = msg.metadata;
                const isLegacy = msg.type === 'job_card' && meta?.source === 'job-event' && !!meta.jobCard && !Array.isArray(meta.jobCards);
                if (isLegacy && (run.length === 0 || msg.timestamp - run[run.length - 1].timestamp <= 15000)) {
                    run.push(msg);
                } else {
                    await flush();
                    if (isLegacy) run.push(msg);
                }
            }
            await flush();
        } catch (e) {
            console.warn('💼 [JobHunt] 旧卡片合并迁移失败（该角色跳过）:', e);
        }
    }
    return merged;
}
