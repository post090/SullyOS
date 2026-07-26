/**
 * 事件驱动的日程修订引擎。
 *
 * 生活里的事会打乱计划：一通长电话、一场见面、群里聊出的约定、家园里发生的事……
 * 本模块让角色在这些事件后「顺手改一改今天接下来的安排」，让日程从静态计划表
 * 变成会呼吸的生活痕迹。
 *
 * 两种生成模式（char.scheduleConfig.revisionMode，默认 off）：
 *   - merged：单聊场景搭情绪评估的车——评估 prompt 末尾追加修订输出段，
 *     applyEmotionEvalRaw 落地时顺带解析，零额外 API 调用（本地 / instant 两路都覆盖）。
 *   - standalone：单聊也走独立轻量调用。
 *   群聊/通话/见面/家园没有情绪评估可搭，两种模式下都走 reviseScheduleForEvent() 独立调用。
 *
 * 硬规则：只修订「当前时刻之后」的时段（过去的不改）；修订次数不设上限；
 * reason 要求 LLM 用角色第一人称+性格口吻写。
 */
import type { CharacterProfile, DailySchedule, ScheduleRevision, ScheduleSlot } from '../types';
import { DB } from './db';
import { getLocalDailySchedule } from './dailySchedule';
import { safeFetchJson } from './safeApi';
import { extractAssistantText } from './emotionApply';

export type RevisionSource = ScheduleRevision['source'];

/** 修订落库后广播（日程 modal / 桌面小组件监听刷新） */
export const SCHEDULE_REVISED_EVENT = 'schedule-revised';

// ── 开关与工具 ──────────────────────────────────────────────

export function revisionModeOf(char: CharacterProfile): 'off' | 'merged' | 'standalone' {
    const m = char.scheduleConfig?.revisionMode;
    return m === 'merged' || m === 'standalone' ? m : 'off';
}

/** 修订功能是否可用：模式开了 + 日程功能本身开着 */
export function isRevisionEnabled(char: CharacterProfile): boolean {
    if (revisionModeOf(char) === 'off') return false;
    // 与日程功能的 enable 口径对齐：显式开 / 老用户已选风格视为开
    return char.scheduleFeatureEnabled === true || (char.scheduleFeatureEnabled === undefined && !!char.scheduleStyle);
}

/** 修订用的轻量 API：优先角色情绪评估副 API，回落传入的全局配置 */
export function revisionApiOf(
    char: CharacterProfile,
    fallback: { baseUrl: string; apiKey: string; model: string },
): { baseUrl: string; apiKey: string; model: string } {
    const e = char.emotionConfig?.api;
    return e?.baseUrl ? e : fallback;
}

/** 群聊防轰炸：同一角色 10 分钟内只修一次。返回 true = 本次可以修（并占用配额）。 */
export function claimGroupRevisionSlot(charId: string): boolean {
    const KEY = `sully_sched_rev_group_${charId}`;
    try {
        const last = parseInt(localStorage.getItem(KEY) || '0', 10);
        if (Date.now() - last < 10 * 60 * 1000) return false;
        localStorage.setItem(KEY, String(Date.now()));
        return true;
    } catch { return true; }
}

const nowHHMM = (): string => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const fmtSlots = (slots: ScheduleSlot[]): string =>
    slots.map(s => `- ${s.startTime} ${s.emoji || ''} ${s.activity}${s.description ? `（${s.description}）` : ''}`).join('\n');

// ── 修订载荷解析（merged 情绪 raw / standalone 独立 raw 共用） ──────

interface RevisionPayload {
    reason: string;
    changes: { type: 'modify' | 'add' | 'remove'; before?: ScheduleSlot; after?: ScheduleSlot }[];
}

const sanitizeSlot = (s: any): ScheduleSlot | undefined => {
    if (!s || typeof s !== 'object' || typeof s.startTime !== 'string') return undefined;
    if (!/^\d{1,2}:\d{2}$/.test(s.startTime.trim())) return undefined;
    const out: ScheduleSlot = {
        startTime: s.startTime.trim().padStart(5, '0'),
        activity: (typeof s.activity === 'string' ? s.activity.trim() : '').slice(0, 20) || '（未命名）',
    };
    if (typeof s.description === 'string' && s.description.trim()) out.description = s.description.trim().slice(0, 120);
    if (typeof s.emoji === 'string' && s.emoji.trim()) out.emoji = s.emoji.trim().slice(0, 4);
    if (typeof s.location === 'string' && s.location.trim()) out.location = s.location.trim().slice(0, 30);
    return out;
};

/** 从任意对象里规整出修订载荷（changes 空 = 无有效修订 → null） */
function sanitizePayload(j: any): RevisionPayload | null {
    if (!j || typeof j !== 'object') return null;
    const rawChanges = Array.isArray(j.changes) ? j.changes : [];
    const changes: RevisionPayload['changes'] = [];
    for (const c of rawChanges) {
        if (!c || typeof c !== 'object') continue;
        const type = c.type === 'add' || c.type === 'remove' || c.type === 'modify' ? c.type : null;
        if (!type) continue;
        const before = sanitizeSlot(c.before);
        const after = sanitizeSlot(c.after);
        if (type === 'modify' && before && after) changes.push({ type, before, after });
        else if (type === 'add' && after) changes.push({ type, after });
        else if (type === 'remove' && before) changes.push({ type, before });
        if (changes.length >= 5) break; // 单次修订最多 5 处，防模型大改
    }
    if (changes.length === 0) return null;
    const reason = (typeof j.reason === 'string' ? j.reason.trim() : '').slice(0, 120) || '临时有点变动';
    return { reason, changes };
}

/** 在 raw 文本里定位 "key": { ... } 的平衡对象并解析（尾逗号容忍）。 */
function extractKeyedObject(raw: string, key: string): any | null {
    const idx = raw.search(new RegExp(`"${key}"\\s*:\\s*\\{`));
    if (idx < 0) return null;
    const start = raw.indexOf('{', idx + key.length);
    let inStr = false, esc = false, depth = 0;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                const seg = raw.slice(start, i + 1);
                try { return JSON.parse(seg); } catch { /* 修复后再试 */ }
                try { return JSON.parse(seg.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
            }
        }
    }
    return null;
}

// ── 应用落库（共用） ──────────────────────────────────────────

// 同角色修订串行化：群聊/通话/家园几乎同时触发时，避免读-改-写竞态互相覆盖
const revisionChains = new Map<string, Promise<unknown>>();

/**
 * 把修订载荷应用到今天的日程并落库。只动「当前时刻之后」的时段；
 * 应用成功（至少 1 处生效）返回 true，并广播 SCHEDULE_REVISED_EVENT。
 */
export function applyScheduleRevision(
    charId: string,
    payload: RevisionPayload,
    source: RevisionSource,
    sourceLabel?: string,
): Promise<boolean> {
    const prev = revisionChains.get(charId) || Promise.resolve();
    const run = prev.then(() => applyRevisionInner(charId, payload, source, sourceLabel));
    revisionChains.set(charId, run.catch(() => {}));
    return run;
}

async function applyRevisionInner(
    charId: string,
    payload: RevisionPayload,
    source: RevisionSource,
    sourceLabel?: string,
): Promise<boolean> {
    const schedule = await getLocalDailySchedule(charId);
    if (!schedule || !Array.isArray(schedule.slots) || schedule.slots.length === 0) return false;
    const now = nowHHMM();
    let slots = [...schedule.slots];
    const applied: RevisionPayload['changes'] = [];

    for (const c of payload.changes) {
        // 硬规则：过去的不改——涉及的时段（改前/改后）都必须在当前时刻之后
        if (c.before && c.before.startTime <= now) continue;
        if (c.after && c.after.startTime <= now) continue;
        if (c.type === 'modify' && c.before && c.after) {
            const i = slots.findIndex(s => s.startTime === c.before!.startTime);
            if (i < 0) continue;
            // 保留原时段的小剧场缓存没意义（内容变了），直接换新
            const real = slots[i];
            applied.push({ type: 'modify', before: { ...real }, after: c.after });
            slots[i] = c.after;
        } else if (c.type === 'add' && c.after) {
            if (slots.some(s => s.startTime === c.after!.startTime)) continue;
            applied.push({ type: 'add', after: c.after });
            slots.push(c.after);
        } else if (c.type === 'remove' && c.before) {
            const i = slots.findIndex(s => s.startTime === c.before!.startTime);
            if (i < 0) continue;
            applied.push({ type: 'remove', before: { ...slots[i] } });
            slots.splice(i, 1);
        }
    }
    if (applied.length === 0) return false;

    slots = slots.sort((a, b) => a.startTime.localeCompare(b.startTime));
    const revision: ScheduleRevision = {
        id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        at: Date.now(),
        source,
        sourceLabel,
        reason: payload.reason,
        changes: applied,
    };
    const updated: DailySchedule = {
        ...schedule,
        slots,
        revisions: [...(schedule.revisions || []), revision],
    };
    await DB.saveDailySchedule(updated);
    try {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(SCHEDULE_REVISED_EVENT, { detail: { charId, revisionId: revision.id, source } }));
        }
    } catch { /* ignore */ }
    console.log(`📅 [ScheduleRev] ${charId} 修订 ${applied.length} 处（${source}）：${payload.reason}`);
    return true;
}

// ── merged 模式：搭情绪评估的车 ──────────────────────────────

/**
 * merged 模式给情绪评估 prompt 追加的输出段。日程功能关 / 模式不是 merged /
 * 今天没日程 / 今天已经没有未来时段 → 返回 ''（评估 prompt 保持原样）。
 */
export async function buildScheduleRevisionSection(char: CharacterProfile): Promise<string> {
    try {
        if (revisionModeOf(char) !== 'merged' || !isRevisionEnabled(char)) return '';
        const schedule = await getLocalDailySchedule(char.id);
        if (!schedule || schedule.slots.length === 0) return '';
        const now = nowHHMM();
        if (!schedule.slots.some(s => s.startTime > now)) return '';
        return `

## 顺带任务：日程修订（可选输出）
「${char.name}」今天的日程（现在是 ${now}，**只能调整之后的时段**）：
${fmtSlots(schedule.slots)}
如果刚才的对话对 ta 今天**之后**的安排有实际影响（约了什么/取消了什么/心情变了想换个安排……），在上面的 JSON 里**额外**加一个 scheduleRevision 字段：
"scheduleRevision": { "reason": "以${char.name}第一人称、贴合 ta 性格口吻的一句话原因", "changes": [ { "type": "modify", "before": { "startTime": "原时段的startTime" }, "after": { "startTime": "HH:MM", "activity": "2-6字", "description": "一句话", "emoji": "一个emoji" } } ] }
changes 里 type 可选 modify / add / remove：modify 给 before.startTime + 完整 after；add 只给 after；remove 只给 before.startTime。改动要克制（1~3 处），别整天重排。**对话没有实际影响就不要输出这个字段**（绝大多数闲聊都不影响日程）。`;
    } catch { return ''; }
}

/**
 * merged 落地入口：从情绪评估 raw 里抠 scheduleRevision 字段并应用。
 * 挂在 applyEmotionEvalRaw（本地 / instant flush 共用落点）里，fire-and-forget。
 */
export async function applyMergedRevisionFromEvalRaw(raw: string, char: CharacterProfile): Promise<void> {
    try {
        if (revisionModeOf(char) !== 'merged' || !isRevisionEnabled(char)) return;
        const j = extractKeyedObject(raw || '', 'scheduleRevision');
        const payload = sanitizePayload(j);
        if (!payload) return;
        await applyScheduleRevision(char.id, payload, 'chat');
    } catch (e) {
        console.warn('📅 [ScheduleRev] merged 落地失败:', (e as any)?.message);
    }
}

// ── 独立轻量调用（standalone 单聊 + 群聊/通话/见面/家园） ──────────

/**
 * 事件驱动的独立修订调用：小 prompt（当前日程 + 事件摘要）→ 输出 revision JSON → 落库。
 * 低频、成本可控。开关没开 / 没日程 / 没未来时段时静默返回 false。
 */
export async function reviseScheduleForEvent(args: {
    char: CharacterProfile;
    api: { baseUrl: string; apiKey: string; model: string };
    source: RevisionSource;
    sourceLabel?: string;
    /** 事件摘要（通话时长+纪念句 / 群聊片段 / 家园 narrative 节选…） */
    eventSummary: string;
}): Promise<boolean> {
    const { char, api, source, sourceLabel, eventSummary } = args;
    try {
        // 修订模式是总阀门：选「关闭」时所有来源（含家园）都不改日程
        if (!isRevisionEnabled(char)) return false;
        if (!api?.baseUrl || !eventSummary.trim()) return false;
        const schedule = await getLocalDailySchedule(char.id);
        if (!schedule || schedule.slots.length === 0) return false;
        const now = nowHHMM();
        if (!schedule.slots.some(s => s.startTime > now)) return false;

        const prompt = `你是「${char.name}」本人在心里快速盘算日程。${char.description ? `\n\n## 你是谁\n${char.description.slice(0, 400)}` : ''}

## 你今天的日程（现在是 ${now}，只能调整之后的时段）
${fmtSlots(schedule.slots)}

## 刚发生的事${sourceLabel ? `（${sourceLabel}）` : ''}
${eventSummary.slice(0, 1200)}

这件事会不会让你调整今天**之后**的安排？严格输出一个 JSON 对象（不要输出 JSON 之外的文字）：
{ "revise": true, "reason": "第一人称、贴合你性格口吻的一句话原因（如：临时和你打了电话，把下午的画稿往后挪了）", "changes": [ { "type": "modify", "before": { "startTime": "原时段startTime" }, "after": { "startTime": "HH:MM", "activity": "2-6字", "description": "一句话", "emoji": "一个emoji" } } ] }
type 可选 modify / add / remove：modify 给 before.startTime + 完整 after；add 只给 after；remove 只给 before.startTime。
规则：只动 ${now} 之后的时段；改动克制（1~3 处）；大多数小事其实不影响日程——不影响就输出 { "revise": false }。`;

        const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.6,
                max_tokens: 1200,
            }),
        }, 1, 0, { appName: '日程', charId: char.id, charName: char.name, purpose: '日程修订' });

        const raw = extractAssistantText(data?.choices?.[0]?.message);
        if (!raw) return false;
        // 抠出第一个 JSON 对象
        let j: any = null;
        const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const cands = [fence?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)].filter(Boolean) as string[];
        for (const c of cands) {
            try { j = JSON.parse(c); break; } catch { /* next */ }
            try { j = JSON.parse(c.replace(/,\s*([}\]])/g, '$1')); break; } catch { /* next */ }
        }
        if (!j || j.revise === false) return false;
        const payload = sanitizePayload(j.scheduleRevision && typeof j.scheduleRevision === 'object' ? j.scheduleRevision : j);
        if (!payload) return false;
        return await applyScheduleRevision(char.id, payload, source, sourceLabel);
    } catch (e) {
        console.warn('📅 [ScheduleRev] 独立修订失败:', (e as any)?.message);
        return false;
    }
}
