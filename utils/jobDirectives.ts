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
import { JobNote, JobPosition, JobProfile, JobResume, JobRound, Message } from '../types';
import { JobParseResult, JOB_COMMAND_GUIDE, normalizeJobStage, JobSettableField } from './jobHuntParser';
import { redactPrivacy, codifyCompanies } from './privacyRedact';
import { loadJhSettings } from './jobHuntSettings';

const STAGE_LABEL: Record<string, string> = {
    watching: '观望中', applied: '已投递', written: '笔试中', interview: '面试中', offer_talk: '沟通Offer', offer: '已接受Offer', rejected: '已结束',
};
const NOTE_KIND_LABEL: Record<string, string> = {
    eval: '面试评价', resume_advice: '简历建议', analysis: '岗位分析', note: '随手记',
};
/** 环节展示文案（UI/转述/注入共用） */
export const ROUND_KIND_LABEL: Record<string, string> = { written: '笔试', interview: '面试' };
export const ROUND_STATUS_LABEL: Record<string, string> = {
    pending: '待安排', scheduled: '待进行', awaiting: '等结果', passed: '通过', failed: '挂了',
};

/** 时间戳 → 「M月D日 HH:mm」（本机时区，卡片/注入/转述共用） */
export const fmtJobTime = (ts: number): string => {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
};

/** 相对时间文案（最后更新展示/注入共用）：刚刚/N分钟前/N小时前/昨天/N天前/M月D日 */
export const relTimeLabel = (ts: number, now: number = Date.now()): string => {
    const diff = now - ts;
    if (diff < 0) return fmtJobTime(ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min}分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}小时前`;
    const day = Math.floor(hr / 24);
    if (day === 1) return '昨天';
    if (day < 7) return `${day}天前`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
};

/** 下一场面试时间：rounds 里未完成 interview 环节的最近 at，其次 interviewAt（兼容读）；过期超 1 小时不算 */
export function nextInterviewTs(p: JobPosition, now: number = Date.now()): number | null {
    const floor = now - 3600 * 1000;
    const cands: number[] = [];
    (p.rounds || []).forEach(r => {
        if (r.kind === 'interview' && (r.status === 'scheduled' || r.status === 'pending') && r.at && r.at > floor) cands.push(r.at);
    });
    if (p.interviewAt && p.interviewAt > floor) cands.push(p.interviewAt);
    return cands.length ? Math.min(...cands) : null;
}

/** 等反馈天数（第 1 天起）；未在等返回 null */
export function waitingDays(p: JobPosition, now: number = Date.now()): number | null {
    if (!p.waitingSince) return null;
    return Math.max(1, Math.floor((now - p.waitingSince) / (24 * 3600 * 1000)) + 1);
}

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

/** 岗位注入行（单聊 / 工作台两处共用，保证对齐）：代号·岗位·阶段·环节·时间·项目·下一步·JD/笔记摘要 */
export function buildPositionPromptLine(p: JobPosition, allPositions: JobPosition[]): string {
    const parts = [`- ${p.code} · ${p.title} · ${STAGE_LABEL[p.stage] || p.stage}`];
    const rounds = p.rounds || [];
    if (rounds.length > 0) {
        const seg = rounds.map(r => {
            const base = `${ROUND_KIND_LABEL[r.kind]}${r.index}${ROUND_STATUS_LABEL[r.status] || r.status}`;
            return r.at ? `${base}(${fmtJobTime(r.at)})` : base;
        }).join('、');
        parts.push(`环节：${seg}`);
    }
    const nextTs = nextInterviewTs(p);
    if (nextTs) {
        const days = Math.ceil((nextTs - Date.now()) / (24 * 3600 * 1000));
        const hint = days <= 0 ? '就在今天' : days === 1 ? '就在明天' : `还有 ${days} 天`;
        parts.push(`下一场面试：${fmtJobTime(nextTs)}（${hint}）`);
    }
    const wd = waitingDays(p);
    if (wd) parts.push(`等反馈第 ${wd} 天`);
    if (p.projectName) parts.push(`项目：${codifyCompanies(p.projectName, allPositions)}`);
    if (p.location) parts.push(`地点：${codifyCompanies(p.location, allPositions)}`);
    if (p.nextStep) {
        // 下一步多为自由文本（可能写真实公司名/人名），同 JD/笔记一样先脱敏再代号化
        const ns = codifyCompanies(redactPrivacy(p.nextStep).text, allPositions).replace(/\s+/g, ' ').trim();
        parts.push(`下一步：${ns}`);
    }
    const jd = jdDigestForPrompt(p, allPositions);
    if (jd) parts.push(`JD 摘要：${jd}`);
    const notes = (p.notes || '').trim();
    if (notes) {
        let t = redactPrivacy(notes).text;
        t = codifyCompanies(t, allPositions).replace(/\s+/g, ' ').trim();
        parts.push(`岗位笔记：${t.length > 120 ? `${t.slice(0, 120)}…` : t}`);
    }
    if (p.updatedAt) parts.push(`最后更新：${relTimeLabel(p.updatedAt)}`);
    return parts.join(' · ');
}

/** 一张 job_card 消息的 metadata.jobCard 结构 */
export interface JobCardPayload {
    jobKind: 'update' | 'set' | 'round' | 'interview_time' | 'waiting' | 'delete' | 'note' | 'note_edit' | 'note_del' | 'edge_add' | 'edge_del' | 'gap_add' | 'gap_del' | 'direction';
    /** update/set/round/interview_time/waiting/delete：岗位代号 */
    code?: string;
    stage?: string;
    stageLabel?: string;
    nextStep?: string;
    /** update 时是否为新建卡 */
    created?: boolean;
    /** set：被改的字段中文标签 + 值摘要；waiting 也用 valuePreview 写状态文案 */
    fieldLabel?: string;
    valuePreview?: string;
    /** round：环节展示（面试/笔试 · 第几轮 · 状态） */
    roundKindLabel?: string;
    roundIndex?: number;
    roundStatusLabel?: string;
    /** round/interview_time：时间文案（如「8月6日 14:00」/「已清除」） */
    timeText?: string;
    /** note 系列 */
    noteId?: string;
    noteKind?: string;
    noteKindLabel?: string;
    title?: string;
    /** 笔记摘要（截断，点卡片弹全文时从 DB 按 noteId 取） */
    preview?: string;
}

const FIELD_LABEL: Record<JobSettableField, string> = {
    title: '岗位名', projectName: '项目名', jd: 'JD', nextStep: '下一步', stage: '阶段', notes: '岗位笔记', location: '地点',
};

/**
 * 求职模式 prompt 注入块：岗位列表 + 近期笔记标题（AI 能看见才能改/删）+ 指令教学。
 * 无岗位无笔记也返回教学段（开关已开 = 用户想让角色帮忙管理，AI 得知道能力存在）。
 */
export async function buildJobHuntPromptBlock(): Promise<string> {
    let positions: JobPosition[] = [];
    let notes: JobNote[] = [];
    let profile: JobProfile | null = null;
    let resumes: JobResume[] = [];
    try { positions = await DB.getJobPositions(); } catch { /* 表还没建等场景，静默 */ }
    try { notes = await DB.getJobNotes(); } catch { /* 同上 */ }
    try { profile = await DB.getJobProfile(); } catch { /* 同上 */ }
    try { resumes = await DB.getJobResumes(); } catch { /* 同上 */ }

    // 单聊注入档位（用户级全局设置；读失败用默认：档案开、简历摘要、岗位开）
    let inject: { resume: 'none' | 'raw' | 'digest'; profile: boolean; positions: boolean; notes: boolean } = { resume: 'digest', profile: true, positions: true, notes: true };
    try { inject = loadJhSettings().inject; } catch { /* 用默认 */ }

    const lines: string[] = ['### 【求职工作台 · 上岸计划】'];
    lines.push(`你在帮用户推进求职。以下是工作台当前状态（公司都是代号，真实公司名你看不到也不需要知道）：`);
    // 竞争力档案段（用户级单份；永远不含真名/真实公司）
    if (inject.profile && profile && (profile.direction || profile.strengths.length || profile.gaps.length)) {
        lines.push('【候选人竞争力档案】');
        if (profile.direction) lines.push(`求职方向：${profile.direction}`);
        if (profile.strengths.length) lines.push(`竞争点：${profile.strengths.map(s => s.text).join('；')}`);
        const gapS = profile.gaps.filter(g => g.kind === 'strategy').map(g => g.text);
        const gapR = profile.gaps.filter(g => g.kind === 'resume').map(g => g.text);
        if (gapS.length) lines.push(`求职策略层改进：${gapS.join('；')}`);
        if (gapR.length) lines.push(`简历写法层改进：${gapR.join('；')}`);
    }

    // 简历段：none 不注入 / raw 脱敏原文~1500 字 / digest 结构化摘要~600 字
    if (inject.resume === 'digest' && profile?.resumeDigest) {
        lines.push('【简历摘要】');
        lines.push(profile.resumeDigest.slice(0, 600));
    } else if (inject.resume === 'raw' && resumes[0]?.rawText) {
        lines.push('【简历原文（已脱敏）】');
        lines.push(resumes[0].rawText.slice(0, 1500));
    }

    // 岗位段
    if (inject.positions) {
        const active = positions.filter(p => p.stage !== 'rejected');
        if (active.length > 0) {
            lines.push('【在推进的岗位】');
            active.forEach(p => {
                lines.push(buildPositionPromptLine(p, positions));
            });
        } else {
            lines.push('【在推进的岗位】暂无建档岗位（用户聊到新投递时你可以用指令帮 ta 建卡）。');
        }
    }
    if (inject.notes && notes.length > 0) {
        // 只注入标题 + 类型 + 更新时间（不含正文，成本极低），按最近更新排序，全部塞过去，
        // 让 AI 知道笔记本里有哪些条目、能按标题 JOB_NOTE_EDIT / JOB_NOTE_DEL 精准操作。
        const sorted = [...notes].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
        lines.push('【笔记本条目】（可用 JOB_NOTE_EDIT / JOB_NOTE_DEL 按标题操作）');
        sorted.forEach(n => {
            const upd = n.updatedAt ?? n.createdAt;
            lines.push(`- [${NOTE_KIND_LABEL[n.kind] || n.kind}] ${n.title}（最后更新：${relTimeLabel(upd)}）`);
        });
    }
    lines.push('');
    lines.push(JOB_COMMAND_GUIDE);
    // AI 改动权限：把用户关掉的操作明确告知，避免 AI 反复发被拒指令、浪费 token
    try {
        const perms = loadJhSettings().aiPerms;
        const banned: string[] = [];
        if (!perms.posProgress) banned.push('改岗位阶段/进展、环节轮次、面试时间、等反馈状态');
        if (!perms.posFields) banned.push('改岗位名/项目/JD/地点/下一步等字段');
        if (!perms.posDelete) banned.push('删除岗位卡');
        if (!perms.noteCreate) banned.push('新建笔记');
        if (!perms.noteEdit) banned.push('改写已有笔记');
        if (!perms.noteDelete) banned.push('删除笔记');
        if (!perms.profile) banned.push('改竞争力档案（竞争点/改进点/方向）');
        if (banned.length) {
            lines.push('');
            lines.push(`⚠ 用户已关闭以下操作权限，你【绝对不要】尝试相应指令（发了也会被拒绝）：${banned.join('；')}。`);
        }
    } catch { /* 读不到设置就不加约束 */ }
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

    // AI 改动权限（纯人类授权，逐项开关）：关掉的类别直接丢弃该批指令。
    // 读失败用全开默认（不因设置读不到就把 AI 能力全封）。
    let perms = { posProgress: true, posFields: true, posDelete: true, noteCreate: true, noteEdit: true, noteDelete: true, profile: true };
    try { perms = loadJhSettings().aiPerms; } catch { /* 用全开默认 */ }

    // ── 岗位建卡/更新 ──
    for (const u of parsed.updates) {
        if (!perms.posProgress) break;
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

    // ── 岗位字段编辑（任意可写字段） ──
    for (const s of parsed.sets) {
        // stage 字段属于「进展」权限，其余字段属于「字段」权限
        if (s.field === 'stage' ? !perms.posProgress : !perms.posFields) continue;
        try {
            const all = await DB.getJobPositions();
            const target = all.find(p => p.code === s.code);
            if (!target) { rejected.push(`JOB_SET: 找不到代号「${s.code}」`); continue; }
            const next: JobPosition = { ...target, updatedAt: now };
            let valuePreview = s.value;
            if (s.field === 'stage') {
                const st = normalizeJobStage(s.value);
                next.stage = st;
                next.timeline = [...target.timeline, { ts: now, stage: st }];
                valuePreview = STAGE_LABEL[st] || st;
            } else if (s.field === 'title') {
                next.title = s.value;
            } else if (s.field === 'projectName') {
                next.projectName = s.value || undefined;
            } else if (s.field === 'location') {
                next.location = s.value || undefined;
            } else if (s.field === 'nextStep') {
                next.nextStep = s.value || undefined;
            } else if (s.field === 'jd') {
                next.jd = s.value || undefined;
                valuePreview = s.value.replace(/\s+/g, ' ').slice(0, 40);
            } else if (s.field === 'notes') {
                next.notes = s.value || undefined;
                valuePreview = s.value.replace(/\s+/g, ' ').slice(0, 40);
            }
            await DB.saveJobPosition(next);
            cards.push({
                jobKind: 'set', code: s.code,
                fieldLabel: FIELD_LABEL[s.field],
                valuePreview: valuePreview.length > 60 ? `${valuePreview.slice(0, 60)}…` : valuePreview,
            });
        } catch (e: any) { rejected.push(`JOB_SET ${s.code}: ${e?.message || e}`); }
    }

    // ── 环节轮次（同代号同类型同轮次 = 更新，否则新建） ──
    for (const r of parsed.rounds) {
        if (!perms.posProgress) break;
        try {
            const all = await DB.getJobPositions();
            const target = all.find(p => p.code === r.code);
            if (!target) { rejected.push(`JOB_ROUND: 找不到代号「${r.code}」`); continue; }
            const rounds: JobRound[] = [...(target.rounds || [])];
            const idx = rounds.findIndex(x => x.kind === r.kind && x.index === r.index);
            if (idx >= 0) {
                const prev = rounds[idx];
                rounds[idx] = { ...prev, status: r.status, at: r.clearAt ? undefined : (r.at ?? prev.at) };
            } else {
                rounds.push({ id: genId('jround'), kind: r.kind, index: r.index, status: r.status, at: r.clearAt ? undefined : r.at });
            }
            rounds.sort((a, b) => (a.kind === b.kind ? a.index - b.index : a.kind === 'written' ? -1 : 1));
            await DB.saveJobPosition({ ...target, rounds, updatedAt: now });
            const saved = idx >= 0 ? rounds[idx] : rounds.find(x => x.kind === r.kind && x.index === r.index)!;
            cards.push({
                jobKind: 'round', code: r.code,
                roundKindLabel: ROUND_KIND_LABEL[r.kind], roundIndex: r.index,
                roundStatusLabel: ROUND_STATUS_LABEL[r.status],
                timeText: r.clearAt ? '已清除' : (saved.at ? fmtJobTime(saved.at) : undefined),
            });
        } catch (e: any) { rejected.push(`JOB_ROUND ${r.code}: ${e?.message || e}`); }
    }

    // ── 面试时间快捷（interviewAt） ──
    for (const iv of parsed.interviews) {
        if (!perms.posProgress) break;
        try {
            const all = await DB.getJobPositions();
            const target = all.find(p => p.code === iv.code);
            if (!target) { rejected.push(`JOB_INTERVIEW: 找不到代号「${iv.code}」`); continue; }
            await DB.saveJobPosition({ ...target, interviewAt: iv.clear ? undefined : iv.at, updatedAt: now });
            cards.push({ jobKind: 'interview_time', code: iv.code, timeText: iv.clear ? '已清除' : fmtJobTime(iv.at!) });
        } catch (e: any) { rejected.push(`JOB_INTERVIEW ${iv.code}: ${e?.message || e}`); }
    }

    // ── 等反馈开关（waitingSince；已在等则保留原起点，天数不重置） ──
    for (const w of parsed.waitings) {
        if (!perms.posProgress) break;
        try {
            const all = await DB.getJobPositions();
            const target = all.find(p => p.code === w.code);
            if (!target) { rejected.push(`JOB_WAITING: 找不到代号「${w.code}」`); continue; }
            const waitingSince = w.clear ? undefined : (target.waitingSince || now);
            await DB.saveJobPosition({ ...target, waitingSince, updatedAt: now });
            cards.push({ jobKind: 'waiting', code: w.code, valuePreview: w.clear ? '结束等反馈' : '开始等反馈' });
        } catch (e: any) { rejected.push(`JOB_WAITING ${w.code}: ${e?.message || e}`); }
    }

    // ── 岗位删除 ──
    for (const code of parsed.positionDeletes) {
        if (!perms.posDelete) break;
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
        if (!perms.noteCreate) break;
        try {
            const note: JobNote = {
                id: genId('jnote'), kind: n.kind, title: n.title, content: n.content,
                charId, createdAt: now, updatedAt: now,
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
        if (!perms.noteEdit) break;
        try {
            const all = await DB.getJobNotes();
            const target = findNote(all, e2.titleKey);
            if (!target) { rejected.push(`JOB_NOTE_EDIT: 找不到标题含「${e2.titleKey}」的笔记`); continue; }
            await DB.saveJobNote({ ...target, content: e2.content, updatedAt: now });
            cards.push({
                jobKind: 'note_edit', noteId: target.id, noteKind: target.kind,
                noteKindLabel: NOTE_KIND_LABEL[target.kind] || target.kind,
                title: target.title, preview: e2.content.replace(/[#*`>]/g, '').slice(0, 120),
            });
        } catch (err: any) { rejected.push(`JOB_NOTE_EDIT ${e2.titleKey}: ${err?.message || err}`); }
    }

    // ── 笔记删除 ──
    for (const key of parsed.noteDeletes) {
        if (!perms.noteDelete) break;
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

    // ── 竞争力档案编辑（第八节；写 JobProfile，source:'char'，单份 main） ──
    const hasProfileEdit = parsed.edgeAdds.length > 0 || parsed.edgeDels.length > 0
        || parsed.gapAdds.length > 0 || parsed.gapDels.length > 0 || parsed.direction !== undefined;
    if (hasProfileEdit && perms.profile) {
        try {
            const existing = await DB.getJobProfile();
            const profile: JobProfile = existing || { id: 'main', direction: '', strengths: [], gaps: [], resumeDigest: '', updatedAt: now };
            let strengths = [...profile.strengths];
            let gaps = [...profile.gaps];
            const cut = (t: string) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);
            // 删（关键词 includes，大小写不敏感）
            for (const key of parsed.edgeDels) {
                const k = key.toLowerCase();
                const before = strengths.length;
                strengths = strengths.filter(s => !s.text.toLowerCase().includes(k));
                if (strengths.length < before) cards.push({ jobKind: 'edge_del', valuePreview: key });
                else rejected.push(`JOB_EDGE_DEL: 没匹配到含「${key}」的竞争点`);
            }
            for (const key of parsed.gapDels) {
                const k = key.toLowerCase();
                const before = gaps.length;
                gaps = gaps.filter(g => !g.text.toLowerCase().includes(k));
                if (gaps.length < before) cards.push({ jobKind: 'gap_del', valuePreview: key });
                else rejected.push(`JOB_GAP_DEL: 没匹配到含「${key}」的改进点`);
            }
            // 加
            for (const text of parsed.edgeAdds) {
                strengths.push({ id: genId('str'), text, source: 'char' });
                cards.push({ jobKind: 'edge_add', valuePreview: cut(text) });
            }
            for (const g of parsed.gapAdds) {
                gaps.push({ id: genId('gap'), text: g.text, kind: g.kind, source: 'char' });
                cards.push({ jobKind: 'gap_add', fieldLabel: g.kind === 'resume' ? '简历写法' : '求职策略', valuePreview: cut(g.text) });
            }
            const direction = parsed.direction !== undefined ? parsed.direction : profile.direction;
            if (parsed.direction !== undefined) cards.push({ jobKind: 'direction', valuePreview: parsed.direction });
            await DB.saveJobProfile({ id: 'main', direction, strengths, gaps, resumeDigest: profile.resumeDigest, updatedAt: now });
        } catch (e: any) { rejected.push(`JOB_PROFILE: ${e?.message || e}`); }
    }

    // 落库成功后广播刷新（桌面日历等常驻组件监听此事件即时更新）
    if (cards.length > 0 && typeof window !== 'undefined') {
        try { window.dispatchEvent(new CustomEvent('sully-job-updated')); } catch { /* 非浏览器环境忽略 */ }
    }

    return { cards, rejected };
}

/** job_card 的历史转述（buildMessageHistory / 归档 / 记忆宫殿读到的文本） */
export function describeJobCard(card: JobCardPayload | undefined, charName: string): string {
    if (!card) return '[求职工作台操作]';
    switch (card.jobKind) {
        case 'update':
            return `[系统: ${charName}${card.created ? '为你建了岗位卡' : '更新了岗位进展'} ${card.code} → ${card.stageLabel}${card.nextStep ? `，下一步：${card.nextStep}` : ''}]`;
        case 'set':
            return `[系统: ${charName}更新了岗位 ${card.code} 的${card.fieldLabel}${card.valuePreview ? `：${card.valuePreview}` : ''}]`;
        case 'round':
            return `[系统: ${charName}更新了岗位 ${card.code} 的${card.roundKindLabel}第${card.roundIndex}轮 → ${card.roundStatusLabel}${card.timeText ? `，时间：${card.timeText}` : ''}]`;
        case 'interview_time':
            return `[系统: ${charName}记下了岗位 ${card.code} 的面试时间：${card.timeText}]`;
        case 'waiting':
            return `[系统: ${charName}把岗位 ${card.code} 标记为${card.valuePreview}]`;
        case 'delete':
            return `[系统: ${charName}删除了岗位卡 ${card.code}]`;
        case 'note':
            return `[系统: ${charName}记了一篇${card.noteKindLabel}《${card.title}》到求职笔记本]`;
        case 'note_edit':
            return `[系统: ${charName}修改了求职笔记《${card.title}》]`;
        case 'note_del':
            return `[系统: ${charName}删除了求职笔记《${card.title}》]`;
        case 'edge_add':
            return `[系统: ${charName}给你的竞争力档案加了个竞争点：${card.valuePreview}]`;
        case 'edge_del':
            return `[系统: ${charName}移除了竞争点「${card.valuePreview}」]`;
        case 'gap_add':
            return `[系统: ${charName}加了个${card.fieldLabel || ''}改进点：${card.valuePreview}]`;
        case 'gap_del':
            return `[系统: ${charName}移除了改进点「${card.valuePreview}」]`;
        case 'direction':
            return `[系统: ${charName}把求职方向更新为：${card.valuePreview}]`;
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
            case 'set': return `改 ${c.code} 的${c.fieldLabel}${c.valuePreview ? `：${c.valuePreview}` : ''}`;
            case 'round': return `${c.code} ${c.roundKindLabel}第${c.roundIndex}轮 → ${c.roundStatusLabel}${c.timeText ? `（${c.timeText}）` : ''}`;
            case 'interview_time': return `${c.code} 面试时间：${c.timeText}`;
            case 'waiting': return `${c.code} ${c.valuePreview}`;
            case 'delete': return `删岗位卡 ${c.code}`;
            case 'note': return `记${c.noteKindLabel}《${c.title}》`;
            case 'note_edit': return `改笔记《${c.title}》`;
            case 'note_del': return `删笔记《${c.title}》`;
            case 'edge_add': return `加竞争点：${c.valuePreview}`;
            case 'edge_del': return `删竞争点「${c.valuePreview}」`;
            case 'gap_add': return `加${c.fieldLabel || ''}改进点：${c.valuePreview}`;
            case 'gap_del': return `删改进点「${c.valuePreview}」`;
            case 'direction': return `方向→${c.valuePreview}`;
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
