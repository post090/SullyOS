// 群聊 LLM 输出解析 —— 两层容错（家规：严格层失败后进宽松层，绝不静默丢整轮输出）。
// 纯函数、无副作用，便于 vitest 直测。

export interface DirectorAction {
    charId: string;
    content: string;
}

/** 剥掉 markdown 代码围栏（```json / ```yaml / ``` 等），LLM 很爱裹这个 */
const stripFences = (raw: string): string =>
    String(raw ?? '')
        .replace(/```[a-zA-Z]*\r?\n?/g, '')
        .replace(/```/g, '')
        .trim();

/** 逐字段规整导演动作：charId 强转 string，content 非 string 时兜底转换，空的丢弃 */
const normalizeAction = (a: any): DirectorAction | null => {
    if (!a || typeof a !== 'object') return null;
    const charId = a.charId == null ? '' : String(a.charId).trim();
    const content = (typeof a.content === 'string' ? a.content : String(a.content ?? '')).trim();
    if (!charId || !content) return null;
    return { charId, content };
};

/**
 * 解析导演模式输出的 JSON 动作数组。
 * 第一层（严格）：剥围栏 → 截取最外层 [ ... ] → JSON.parse 整体。
 * 第二层（宽松）：正则逐个抠出含 "charId" 的对象逐个 parse，能救一个是一个。
 * 两层皆空时返回 []，由调用方决定是否提示用户。
 */
export function parseDirectorActions(raw: string): DirectorAction[] {
    const text = stripFences(raw);
    if (!text) return [];

    const first = text.indexOf('[');
    const last = text.lastIndexOf(']');
    if (first !== -1 && last > first) {
        try {
            const arr = JSON.parse(text.substring(first, last + 1));
            if (Array.isArray(arr)) {
                const normalized = arr.map(normalizeAction).filter((a): a is DirectorAction => a !== null);
                if (normalized.length > 0) return normalized;
            }
        } catch { /* 掉进第二层 */ }
    }

    const objMatches = text.match(/\{[^{}]*?["']charId["'][\s\S]*?\}/g) || [];
    const rescued: DirectorAction[] = [];
    for (const m of objMatches) {
        try {
            const action = normalizeAction(JSON.parse(m));
            if (action) rescued.push(action);
        } catch { /* 这个对象坏了，跳过它救别的 */ }
    }
    return rescued;
}

/**
 * [[SKIP]] 输出剥离兜底（提示词已不再教这个标记——轮询模式现在要求每位成员必发言）：
 * 模型若仍吐出 [[SKIP]] 或空内容，剥净后没剩正文 = 本轮跳过该成员。
 */
export function stripSkipMarker(raw: string): { skipped: boolean; content: string } {
    const content = stripFences(raw).replace(/\[\[\s*SKIP\s*\]\]/gi, '').trim();
    return { skipped: content === '', content };
}

/**
 * 解析群总结输出里的 summary 字段。
 * 第一层（严格）：剥围栏后匹配 `summary:` + 引号闭合配对（或裸值取到文末）。
 * 第二层（宽松）：剥 `summary:` 前缀、剥首尾引号，取全文 trim——
 * 模型没按 YAML 输出时，整段就当总结正文用。
 */
export function parseSummaryYaml(raw: string): string {
    const text = stripFences(raw);
    if (!text) return '';

    const quoted = text.match(/(?:^|\n)\s*summary\s*[:：]\s*(["'])([\s\S]*?)\1\s*(?:\n|$)/i);
    if (quoted && quoted[2].trim()) return quoted[2].trim();

    const bare = text.match(/(?:^|\n)\s*summary\s*[:：]\s*([\s\S]+)$/i);
    const candidate = bare ? bare[1] : text;
    return candidate
        .replace(/^summary\s*[:：]\s*/i, '')
        .trim()
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .trim();
}
