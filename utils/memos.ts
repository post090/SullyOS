/**
 * 角色备忘录工具集 —— AI 自己的随手记 / 待办。
 *
 * 数据随角色走（CharacterProfile.memos），IndexedDB 通过 saveCharacter 落库，不单独建 store。
 * 上限 10 条，超限时 [[MEMO_ADD]] 会被拒绝（提示词里说清楚上限，AI 自己整理）。
 *
 * 三类消费者：
 *   1. chatPrompts.ts     → 把 memos 渲染成 prompt 段落注入 system prompt
 *   2. applyAssistantPostProcessing.ts → 解析 [[MEMO_ADD/EDIT/DEL:...]] 标签执行
 *   3. apps/MemoApp.tsx   → 用户视角的备忘录 App（可看可改可删）
 */

import type { CharacterMemo, CharacterProfile } from '../types';

/** 备忘录上限。超限时新增会被拒绝（仅单聊场景才允许新增）。 */
export const MEMO_MAX_COUNT = 10;

/** 单条备忘内容上限（字符数）。超长会被截断。 */
export const MEMO_MAX_CONTENT_LEN = 200;

/** 单条备忘 tag 上限。 */
export const MEMO_MAX_TAGS = 5;

/** 单个 tag 长度上限。 */
export const MEMO_MAX_TAG_LEN = 12;

/**
 * 备忘录注入场景。
 * - chat: 单聊（AI 可读可写，标签会执行）
 * - proactive: 主动消息（只读）
 * - call: 通话（只读）
 * - room: 小小窝挂机（只读）
 *
 * 注意：用户视角的 MemoApp 不走这里，直接读 character.memos。
 */
export type MemoScene = 'chat' | 'proactive' | 'call' | 'room';

/**
 * 把角色的备忘录渲染成 system prompt 段落。
 * - 空备忘录不返回任何内容（不污染 prompt）
 * - 时间用本地时区可读格式
 * - 单聊场景会额外附上 [[MEMO_ADD/EDIT/DEL]] 标签用法说明
 *
 * @param memos 角色当前备忘录
 * @param scene 注入场景
 * @returns 直接可塞进 system prompt 的字符串（已含 section 标题）；空则返回 ''
 */
export function renderMemosForPrompt(
    memos: CharacterMemo[] | undefined,
    scene: MemoScene,
): string {
    if (!memos || memos.length === 0) {
        // 单聊场景即便没备忘录也要告诉 AI 怎么用标签（这样 AI 知道这个能力存在）
        if (scene === 'chat') {
            return renderEmptyMemoWithInstructions();
        }
        return '';
    }

    // 按 updatedAt 倒序，最近改的排前面
    const sorted = [...memos].sort((a, b) => b.updatedAt - a.updatedAt);
    const lines: string[] = [];
    const lastSync = new Date(Math.max(...memos.map(m => m.updatedAt)))
        .toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

    lines.push(`【你的备忘录 · 共 ${memos.length}/${MEMO_MAX_COUNT} 条 · 最后修改 ${lastSync}】`);
    sorted.forEach((m, i) => {
        const typeLabel = m.type === 'todo'
            ? (m.status === 'done' ? '[待办·已划掉]' : '[待办]')
            : (m.status === 'done' ? '[备忘·已划掉]' : '[备忘]');
        const tagsStr = m.tags && m.tags.length > 0 ? ` #${m.tags.join(' #')}` : '';
        lines.push(`${i + 1}. ${typeLabel} ${m.content}${tagsStr}`);
    });

    if (scene === 'chat') {
        lines.push('');
        lines.push(renderMemoInstructions());
    }

    return lines.join('\n');
}

function renderEmptyMemoWithInstructions(): string {
    return [
        '【你的备忘录 · 0/10 条】',
        '（你还没有任何备忘录）',
        '',
        renderMemoInstructions(),
    ].join('\n');
}

/** 只渲染标签使用说明（不含备忘录列表本身）。给单聊场景用——列表已经由 buildCoreContext 注入，
 *  这里只补"怎么增删改"的教学段落。空备忘录也照样返回（让 AI 知道这个能力存在）。 */
export function renderMemoInstructionsOnly(): string {
    return `### 【你的备忘录 · 管理能力】\n${renderMemoInstructions()}`;
}

function renderMemoInstructions(): string {
    return [
        '你可以用以下标签管理自己的备忘录（用户不可见，标签会被自动剥离）：',
        `- 新建：[[MEMO_ADD:内容|type:note或todo|tags:标签1,标签2]] —— 上限 ${MEMO_MAX_COUNT} 条，满了会被拒绝；type 可省略默认 note；tags 可省略`,
        `- 编辑：[[MEMO_EDIT:编号|content:新内容|status:active或done|type:note或todo|tags:新标签]] —— 任意字段组合，编号就是上面的序号；status=done 表示划掉`,
        `- 删除：[[MEMO_DEL:编号]]`,
        '编号是上面列表里的序号（从 1 开始）。备忘录是随手记的性质，写短句即可，单条不超过 200 字。',
        '只有当前的【单聊】场景才能用这些标签；其他场景（主动消息/通话/小小窝）你只能看不能改。',
    ].join('\n');
}

// ──────────────────────────────────────────────────────────────
// 标签解析 + 执行（applyAssistantPostProcessing 调用）
// ──────────────────────────────────────────────────────────────

export interface MemoAddDirective {
    kind: 'add';
    content: string;
    type?: 'note' | 'todo';
    tags?: string[];
}

export interface MemoEditDirective {
    kind: 'edit';
    index: number;       // 用户输入的 1-based 序号
    content?: string;
    status?: 'active' | 'done';
    type?: 'note' | 'todo';
    tags?: string[];
}

export interface MemoDelDirective {
    kind: 'del';
    index: number;
}

export type MemoDirective = MemoAddDirective | MemoEditDirective | MemoDelDirective;

/**
 * 从 AI 回复正文里抠出所有 [[MEMO_*:...]] 标签。
 * 支持多个标签同时出现。失败 / 不合规的标签会被忽略（不影响其他标签执行）。
 *
 * 标签格式：
 *   [[MEMO_ADD:内容|type:note|tags:生活,用户]]
 *   [[MEMO_EDIT:2|content:新内容|status:done]]
 *   [[MEMO_DEL:3]]
 */
export function parseMemoDirectives(text: string): MemoDirective[] {
    const out: MemoDirective[] = [];
    // 贪婪匹配到 ]] 结束；内容里允许任意字符（除 ]] 自身）
    const re = /\[\[MEMO_(ADD|EDIT|DEL):([\s\S]*?)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const kind = m[1].toLowerCase();
        const body = m[2].trim();
        try {
            if (kind === 'add') {
                const d = parseAdd(body);
                if (d) out.push(d);
            } else if (kind === 'edit') {
                const d = parseEdit(body);
                if (d) out.push(d);
            } else if (kind === 'del') {
                const d = parseDel(body);
                if (d) out.push(d);
            }
        } catch {
            // 单个标签解析失败跳过
        }
    }
    return out;
}

function parseAdd(body: string): MemoAddDirective | null {
    // 第一个 | 之前是 content（content 里可能含冒号但不能含 |）；之后是 key:value 对
    const parts = body.split('|');
    const content = parts[0]?.trim();
    if (!content) return null;
    const d: MemoAddDirective = { kind: 'add', content: content.slice(0, MEMO_MAX_CONTENT_LEN) };
    for (let i = 1; i < parts.length; i++) {
        const kv = parts[i];
        const ci = kv.indexOf(':');
        if (ci < 0) continue;
        const k = kv.slice(0, ci).trim().toLowerCase();
        const v = kv.slice(ci + 1).trim();
        if (k === 'type' && (v === 'note' || v === 'todo')) d.type = v;
        else if (k === 'tags') d.tags = sanitizeTags(v);
    }
    return d;
}

function parseEdit(body: string): MemoEditDirective | null {
    const parts = body.split('|');
    const idxRaw = parts[0]?.trim();
    const idx = parseInt(idxRaw || '', 10);
    if (!Number.isFinite(idx) || idx < 1) return null;
    const d: MemoEditDirective = { kind: 'edit', index: idx };
    for (let i = 1; i < parts.length; i++) {
        const kv = parts[i];
        const ci = kv.indexOf(':');
        if (ci < 0) continue;
        const k = kv.slice(0, ci).trim().toLowerCase();
        const v = kv.slice(ci + 1).trim();
        if (k === 'content') d.content = v.slice(0, MEMO_MAX_CONTENT_LEN);
        else if (k === 'status' && (v === 'active' || v === 'done')) d.status = v;
        else if (k === 'type' && (v === 'note' || v === 'todo')) d.type = v;
        else if (k === 'tags') d.tags = sanitizeTags(v);
    }
    // 至少要改一个字段
    if (d.content === undefined && d.status === undefined && d.type === undefined && d.tags === undefined) {
        return null;
    }
    return d;
}

function parseDel(body: string): MemoDelDirective | null {
    const idx = parseInt(body.trim(), 10);
    if (!Number.isFinite(idx) || idx < 1) return null;
    return { kind: 'del', index: idx };
}

function sanitizeTags(raw: string): string[] {
    return raw
        .split(/[,，]/)
        .map(t => t.trim().replace(/^#/, '').slice(0, MEMO_MAX_TAG_LEN))
        .filter(t => t)
        .slice(0, MEMO_MAX_TAGS);
}

/**
 * 应用一批指令到角色备忘录上，返回新备忘录数组（不可变）+ 执行报告。
 * 调用方负责把新数组塞回 character.memos 并 saveCharacter 落库。
 *
 * - 序号基于当前 memos 的 updatedAt 倒序排列（跟 renderMemosForPrompt 一致）
 * - ADD 超过上限会被拒绝并记入 report.rejected
 * - EDIT 序号越界会被拒绝
 * - DEL 序号越界会被拒绝
 */
export function applyMemoDirectives(
    memos: CharacterMemo[] | undefined,
    directives: MemoDirective[],
): {
    newMemos: CharacterMemo[];
    added: number;
    edited: number;
    deleted: number;
    rejected: { directive: MemoDirective; reason: string }[];
} {
    const rejected: { directive: MemoDirective; reason: string }[] = [];
    // 工作副本（renderMemosForPrompt 按 updatedAt 倒序展示，所以序号也按这个排序）
    const sorted = [...(memos || [])].sort((a, b) => b.updatedAt - a.updatedAt);
    let added = 0, edited = 0, deleted = 0;

    for (const d of directives) {
        if (d.kind === 'add') {
            if (sorted.length >= MEMO_MAX_COUNT) {
                rejected.push({ directive: d, reason: `备忘录已满 ${MEMO_MAX_COUNT} 条上限，请先删除或编辑已有条目` });
                continue;
            }
            const now = Date.now();
            sorted.push({
                id: genId(),
                content: d.content,
                type: d.type || 'note',
                status: 'active',
                tags: d.tags || [],
                createdAt: now,
                updatedAt: now,
            });
            added++;
        } else if (d.kind === 'edit') {
            const target = sorted[d.index - 1];
            if (!target) {
                rejected.push({ directive: d, reason: `序号 ${d.index} 不存在` });
                continue;
            }
            if (d.content !== undefined) target.content = d.content;
            if (d.status !== undefined) target.status = d.status;
            if (d.type !== undefined) target.type = d.type;
            if (d.tags !== undefined) target.tags = d.tags;
            target.updatedAt = Date.now();
            edited++;
        } else if (d.kind === 'del') {
            const idx = d.index - 1;
            if (idx < 0 || idx >= sorted.length) {
                rejected.push({ directive: d, reason: `序号 ${d.index} 不存在` });
                continue;
            }
            sorted.splice(idx, 1);
            deleted++;
        }
    }

    return {
        newMemos: sorted,
        added,
        edited,
        deleted,
        rejected,
    };
}

/** 从 AI 回复正文里剥离所有 [[MEMO_*:...]] 标签（用户不可见）。 */
export function stripMemoTags(text: string): string {
    return text.replace(/\s*\[\[MEMO_(?:ADD|EDIT|DEL):[\s\S]*?\]\]\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function genId(): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch { /* fallthrough */ }
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ──────────────────────────────────────────────────────────────
// 用户视角工具（MemoApp 用）
// ──────────────────────────────────────────────────────────────

/** 创建一条新备忘录（用户视角）。返回新数组，调用方负责落库。满了返回 null。 */
export function userAddMemo(
    character: CharacterProfile,
    content: string,
    type: 'note' | 'todo' = 'note',
    tags: string[] = [],
): { newMemos: CharacterMemo[]; added: CharacterMemo } | { newMemos: CharacterMemo[]; added: null } {
    const list = [...(character.memos || [])];
    if (list.length >= MEMO_MAX_COUNT) return { newMemos: list, added: null };
    const now = Date.now();
    const memo: CharacterMemo = {
        id: genId(),
        content: content.slice(0, MEMO_MAX_CONTENT_LEN),
        type,
        status: 'active',
        tags: tags.slice(0, MEMO_MAX_TAGS),
        createdAt: now,
        updatedAt: now,
    };
    list.push(memo);
    return { newMemos: list, added: memo };
}

/** 编辑一条备忘录（按 id 找）。返回新数组。 */
export function userEditMemo(
    character: CharacterProfile,
    id: string,
    patch: Partial<Pick<CharacterMemo, 'content' | 'type' | 'status' | 'tags'>>,
): CharacterMemo[] {
    return (character.memos || []).map(m => {
        if (m.id !== id) return m;
        const next: CharacterMemo = { ...m };
        if (patch.content !== undefined) next.content = patch.content.slice(0, MEMO_MAX_CONTENT_LEN);
        if (patch.type !== undefined) next.type = patch.type;
        if (patch.status !== undefined) next.status = patch.status;
        if (patch.tags !== undefined) next.tags = patch.tags.slice(0, MEMO_MAX_TAGS);
        next.updatedAt = Date.now();
        return next;
    });
}

/** 删除一条备忘录（按 id 找）。返回新数组。 */
export function userDeleteMemo(character: CharacterProfile, id: string): CharacterMemo[] {
    return (character.memos || []).filter(m => m.id !== id);
}
