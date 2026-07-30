/**
 * 全局 API 调用记录（给 设置 → API 调用记录 页面用）。
 *
 * 设计：项目里 LLM 调用分两类——走 `utils/safeApi.ts` 的 `safeFetchJson` 的，和
 * 各 App 自己写的裸 `fetch`（TRPG / 自习室 / 群聊 / 日记…）。为了一个都不漏，记录点
 * 放在 `OSContext` 里那个全局 `fetch` monkey-patch 上：所有 `/chat/completions`
 * （含 safeFetchJson 内部 fetch）都经过它，统一调 `recordApiCall`，不重复计。
 *
 * 「时间 / 哪个 API / 哪个模型 / token」从请求体 + 响应里自动解析；「哪个 App / 哪个
 * 角色 / 具体用途」靠两条来源：
 *   1. 显式 meta —— safeFetchJson 调用点通过第 5 个参数传，挂到 RequestInit 的
 *      `__sullyMeta` 上由拦截器读取（精确，含 purpose）。
 *   2. 环境兜底 ambientMeta —— OSContext 在切 App / 角色时写入「当前在哪个 App、
 *      当前角色」，裸 fetch 没有显式 meta 时用它兜底标 App / 角色。
 *
 * 只保留近 5 天，超期在 DB 层写入时丢弃。recordApiCall 是 best-effort：任何异常都
 * 吞掉，绝不影响主请求链路。
 */

/** 调用方可补充的语义信息（哪个 App / 角色 / 用途）。能填多少填多少。 */
export interface ApiCallMeta {
    /** AppID 字符串，如 'chat' / 'lifesim'，可空 */
    appId?: string;
    /** App 显示名，如 '消息' / '记忆宫殿'，列表里直接展示这个 */
    appName?: string;
    /** 角色 id，可空 */
    charId?: string;
    /** 角色名，可空 */
    charName?: string;
    /** 具体用途，如 '聊天回复' / '情绪评估' / '记忆提取'，可空 */
    purpose?: string;
    /** 本次请求向量化记忆宫殿召回了哪些条目（仅 memoryPalace 开启的聊天请求才有） */
    recalledMemories?: RecalledMemorySnapshot[];
}

/** 记忆召回快照（进 API 调用详情面板展示用，不进 prompt）。 */
export interface RecalledMemorySnapshot {
    id: string;
    room: string;
    preview: string;
    score: number;
    importance: number;
    isBox: boolean;
    isPinned: boolean;
}

/** 落库的一条记录。 */
export interface ApiCallLogEntry extends ApiCallMeta {
    id: string;
    /** 调用发起（实际是响应回来）时间戳 ms */
    timestamp: number;
    /** 命中的预设名；匹配不到时回退成 baseUrl 的 host */
    presetName: string;
    baseUrl: string;
    model: string;
    /**
     * 响应侧自报的模型（response.model）——实际服务这次请求的后端身份。
     * 中转的渠道名（如 `[千岛-自营]xxx`）只锁"店面"，上游内部降级/轮询时对外模型名
     * 不变，但后端会在响应里自报真身（如 `[逆-V]xxx-c`）。请求名 ≠ 自报名时，
     * 这个字段就是"被换后端了"的直接证据。拿不到（响应无 model 字段）则空。
     */
    backendModel?: string;
    /** HTTP 状态码（成功 / 失败均记，失败时可能是最后一次的状态） */
    status?: number;
    /** 请求是否成功拿到 JSON */
    ok: boolean;
    /** 输入 token（prompt_tokens），来自响应 usage，拿不到则空 */
    promptTokens?: number;
    /** 输出 token（completion_tokens） */
    completionTokens?: number;
    /** 总 token（total_tokens） */
    totalTokens?: number;
    /** 请求从发起到响应 / 报错的耗时 ms（NetworkError 类失败时 = 等了多久才断） */
    durationMs?: number;
    /**
     * 输入构成统计（每块的名字 + 字符数），回答「prompt_tokens 为什么这么大」。
     * 只存统计不存原文（原文一条就几十 KB，5 天日志会撑爆存储）；在响应回来后的
     * fire-and-forget 记录路径里扫一遍请求体算出，不占请求主链路。
     */
    promptBreakdown?: PromptBlockStat[];
}

/** 输入构成里的一块：system prompt 的一个 ### 段落，或聚合后的聊天历史。 */
export interface PromptBlockStat {
    /** 块名：### 标题 / [System: …] 行 / 无标题时取首行摘要；历史消息聚合成「聊天历史·×N」 */
    label: string;
    /** 该块字符数（含标题行与换行） */
    chars: number;
    /**
     * 块全文预览（含块头行），供详情面板点开查看具体内容。存全文不截断
     * （用户确认存储空间够）；展示层用 max-h + overflow 控制可视高度。
     * 旧记录没有这个字段，点开显示"无预览"。
     */
    preview?: string;
    /**
     * 该块归属的功能模块（构建侧按「块头结构」锚定，不用关键词 contains，
     * 所以用户核心提示词绝不会因为字面含「记忆」被误判成记忆模块）。
     * 展示层按 module 把同模块的块合并成一条。旧记录没有这个字段，展示层
     * 回退用 classifyPromptBlock(label) 兜底。
     */
    module?: PromptModule;
    /** 该模块提示词的生成位置（回答"哪来的"），如 'context.ts · 角色设定'。 */
    source?: string;
}

const PRESETS_STORAGE_KEY = 'os_api_presets';

/**
 * 环境上下文（兜底用）：很多 App 走的是裸 fetch，调用点无法/来不及传 meta。
 * OSContext 会在切换 App / 角色时把「当前在哪个 App、当前角色是谁」写到这里，
 * 全局 fetch 拦截器记录裸 fetch 调用时拿它当兜底标签。
 * 注意：safeFetchJson 传了显式 meta 的调用以显式 meta 为准，不用兜底（避免后台
 * 任务被误标成用户当前所在的 App）。
 */
let ambientMeta: ApiCallMeta = {};

export function setApiCallAmbientContext(meta: ApiCallMeta): void {
    ambientMeta = meta || {};
}

/** Snapshot the current fallback context when a request starts. */
export function getApiCallAmbientContext(): ApiCallMeta {
    return { ...ambientMeta };
}

function hasMeta(meta?: ApiCallMeta): boolean {
    return !!meta && Object.values(meta).some((v) => v != null && v !== '');
}

function stripTrailingSlash(s: string): string {
    return s.replace(/\/+$/, '');
}

/** 把 `https://host/v1/chat/completions` 还原成 `https://host/v1`（预设里存的 baseUrl 形态）。 */
function deriveBaseUrl(url: string): string {
    return stripTrailingSlash(url.replace(/\/chat\/completions\/?$/i, ''));
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * 模型名的"核心名"：剥掉渠道标签（[方括号]、(半角圆括号)、（全角圆括号））、
 * 去空白、统一小写。用于判断「请求名 vs 后端自报名」是不是同一个模型——
 * `(按次)gemini-3.1-pro-preview` 和 `gemini-3.1-pro-preview` 是同一个（只是渠道标签），
 * `gemini-3.1-pro-preview` 和 `gemini-3.1-pro-preview-c` 才是真的换了后端。
 */
/**
 * 已知模型家族开头（gemini-…/gpt-…/claude-…）。渠道前缀的花样穷举不完，
 * 但家族名是个短且稳定的清单——把它当锚点：名字开头若不是家族名、且剥掉
 * 一段裸前缀（`gcli-` / `vertex-ai/`）后就是，则认定那段是渠道标签。
 * 这样「两头贴了不同裸前缀」（gcli-X vs vertex-X）也能对上核心名。
 */
const MODEL_FAMILY_RE = /^(gemini|gemma|gpt|chatgpt|o\d|claude|deepseek|qwen|qwq|glm|llama|grok|kimi|moonshot|mistral|mixtral|doubao|hunyuan|minimax|ernie|command|nova|phi)[-_.\d]/i;

function stripBareChannelPrefixes(s: string): string {
    let cur = s;
    // 最多剥 3 层（渠道套渠道），每刀都必须让剩余部分以已知家族名开头才算数
    for (let i = 0; i < 3; i++) {
        if (MODEL_FAMILY_RE.test(cur)) return cur;
        // 非贪婪取最短首段：'chatgpt-4o' 不会被误劈成 'chatgpt-4o' + …
        const m = cur.match(/^[a-z0-9_.]{1,24}?[-/](.+)$/i);
        if (!m || !MODEL_FAMILY_RE.test(m[1])) return cur;
        cur = m[1];
    }
    return cur;
}

export function coreModelName(m: string): string {
    const stripped = (m || '')
        .replace(/\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    return stripBareChannelPrefixes(stripped);
}

/**
 * 「请求的模型」和「后端自报的模型」是否应视为同一个（＝不该报琥珀 ⚠️）。
 *
 * 贩子的渠道标签格式穷举不完（[方括号]、(按次)、gcli- 裸前缀…），所以不枚举格式，
 * 改用方向性判定——核心名归一后：
 *   - 完全相等 → 同一个
 *   - 一方是另一方**去掉开头一截**的结果（endsWith）→ 同一个。
 *     覆盖两个方向：请求带渠道前缀（gcli-X ↔ X）、后端带路径/前缀（X ↔ models/X）。
 *     「开头多一截」只是运营商贴标签，不改变模型本体。
 *   - 其余（尤其**尾巴多一截**：X ↔ X-c / X-lite）→ 不同。缩水变体都长在尾巴上，
 *     这正是要抓的降级信号，绝不放行。
 * 短名（<8 字符）不做 endsWith 宽容，防止病态短串误匹配。
 */
export function isSameCoreModel(requested: string, backend: string): boolean {
    const a = coreModelName(requested);
    const b = coreModelName(backend);
    if (!a || !b) return true;   // 有一方空：无从比较，不报警
    if (a === b) return true;
    const shorter = a.length < b.length ? a : b;
    if (shorter.length < 8) return false;
    return a.endsWith(b) || b.endsWith(a);
}

/** 从请求体里抠出 model 字段（body 可能是 JSON 字符串或对象）。 */
function extractModel(body: unknown): string {
    if (!body) return '';
    let parsed: any = body;
    if (typeof body === 'string') {
        try { parsed = JSON.parse(body); } catch { return ''; }
    }
    return typeof parsed?.model === 'string' ? parsed.model : '';
}

/**
 * 用 baseUrl + model 在用户保存的预设里反查预设名（截图里的「奇异果 / 铃兰 / 千岛2」那些）。
 * 预设结构见 types.ts ApiPreset：{ id, name, config: { baseUrl, apiKey, model } }。
 * 匹配不到（比如用的是没存成预设的临时配置）就回退成 host。
 */
function resolvePresetName(baseUrl: string, model: string): string {
    try {
        if (typeof localStorage === 'undefined') return hostOf(baseUrl);
        const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
        if (!raw) return hostOf(baseUrl);
        const presets = JSON.parse(raw);
        if (!Array.isArray(presets)) return hostOf(baseUrl);
        const normBase = stripTrailingSlash(baseUrl);
        // 优先 baseUrl + model 都对上；退而求其次只对 baseUrl
        const exact = presets.find((p: any) =>
            stripTrailingSlash(p?.config?.baseUrl || '') === normBase &&
            (p?.config?.model || '') === model);
        if (exact?.name) return exact.name;
        const byBase = presets.find((p: any) =>
            stripTrailingSlash(p?.config?.baseUrl || '') === normBase);
        if (byBase?.name) return byBase.name;
        return hostOf(baseUrl);
    } catch {
        return hostOf(baseUrl);
    }
}

/**
 * 记录一次 API 调用。fire-and-forget，绝不 throw / 阻塞主链路。
 * 在 safeFetchJson 里对 `/chat/completions` 的成功与失败都会调用。
 */
/** 从 OpenAI 兼容响应里抠 usage（各家代理大多遵循这个字段）。 */
function extractUsage(response: unknown): { prompt?: number; completion?: number; total?: number } {
    const usage = (response as any)?.usage;
    if (!usage || typeof usage !== 'object') return {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return {
        prompt: num(usage.prompt_tokens),
        completion: num(usage.completion_tokens),
        total: num(usage.total_tokens),
    };
}

/**
 * SSE 流式响应文本的兜底解析：扫 `data: {...}` 行，抠后端自报 model（首个非空）
 * 和 usage（取最后一个非空，OpenAI 约定 usage 在末尾 chunk）。
 * 拦截器 clone 出的流式响应 JSON.parse 必然失败，之前流式调用在记录里
 * 既没有 token 数也没有后端身份——这里补上。
 */
export function scanSseForLog(text: string): { model?: string; usage?: unknown } {
    let model: string | undefined;
    let usage: unknown;
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (!model && typeof chunk?.model === 'string' && chunk.model) model = chunk.model;
        if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage;
    }
    return { model, usage };
}

// ── 输入构成统计（promptBreakdown） ──────────────────────────────────────

/** 多模态 content 摊平成可计数文本（图片按占位符计，与 emotion eval 的展平口径一致）。 */
function contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part: any) => {
            if (part?.type === 'text') return part.text || '';
            if (part?.type === 'image_url') return '[图片]';
            return '';
        }).filter(Boolean).join(' ');
    }
    if (content == null) return '';
    try { return JSON.stringify(content) ?? ''; } catch { return String(content); }
}

const BLOCK_LABEL_MAX = 40;
/**
 * 块预览存全文（用户确认存储空间够）。展示层用 max-h + overflow 控制可视高度，
 * 存储侧不再截断。
 */
const PREVIEW_MAX_CHARS = Number.MAX_SAFE_INTEGER;

/** 行是块头？返回块名（`## / ### 标题` 或 `[System: …]`），否则 null。 */
const matchBlockHeader = (line: string): string | null => {
    const m = line.match(/^\s*#{2,3}\s+(.+?)\s*$/) || line.match(/^\s*(\[System:[^\]]*\])/);
    return m ? m[1].trim() : null;
};

/**
 * 计算哪些行是有效的 ``` 围栏开合线。围栏必须**成对**才生效：用户数据（记忆
 * 摘要等）里落单的半个 ``` 会把围栏状态永久翻转，后面所有块头全被吞进上一块
 * （实测：62K 的「记忆系统」行吞掉了对话历史+评估框架）。奇数个时最后一个不算。
 */
function fenceToggleLines(lines: string[]): Set<number> {
    const indices: number[] = [];
    lines.forEach((line, i) => { if (/^\s*```/.test(line)) indices.push(i); });
    if (indices.length % 2 === 1) indices.pop();
    return new Set(indices);
}

/**
 * 把一条 system 消息按块头切开。``` 围栏内的行不算块头——行为规范里的日记
 * 示例（`## 今天的小确幸` 等）都在代码块里，不加围栏感知会被误切成独立块。
 * 一个块头都没有的短消息（双语 / MCP 尾部提醒等）整条算一块，取首行当名字。
 */
function splitSystemBlocks(text: string): PromptBlockStat[] {
    const out: PromptBlockStat[] = [];
    let label = '（开头·未分块部分）';
    let chars = 0;
    let buffer = ''; // 累积当前块原文，结束时存全文进 preview
    let sawHeader = false;
    let inFence = false;
    // 模块：开头部分（人设）默认 character；未知块头继承上一块——这样用户在
    // 自己核心提示词里写的小标题会归到 character，不会散成 other。
    let mod: PromptModule = 'character';
    const lines = text.split('\n');
    const fenceAt = fenceToggleLines(lines);
    const flush = () => {
        if (chars > 0) out.push({ label, chars, preview: buffer.slice(0, PREVIEW_MAX_CHARS) || undefined, module: mod, source: PROMPT_MODULE_INFO[mod].source });
        chars = 0;
        buffer = '';
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fenceAt.has(i)) inFence = !inFence;
        const header = inFence ? null : matchBlockHeader(line);
        if (header) {
            flush();
            label = header.slice(0, BLOCK_LABEL_MAX);
            mod = matchModuleForHeader(header) ?? mod;
            chars = line.length + 1;
            buffer = line + '\n';
            sawHeader = true;
        } else {
            chars += line.length + 1;
            // preview 还没满才追加，省得 buffer 无限增长
            if (buffer.length < PREVIEW_MAX_CHARS) {
                buffer += line + '\n';
            }
        }
    }
    flush();
    if (!sawHeader && out.length === 1) {
        const firstLine = text.trimStart().split('\n', 1)[0] || '(空 system)';
        // 无块头的短消息（MCP 尾部提醒等）：用首行当名字，并据此重新归属模块。
        const m = matchModuleForHeader(firstLine);
        out[0] = { ...out[0], label: firstLine.slice(0, BLOCK_LABEL_MAX), module: m ?? out[0].module, source: PROMPT_MODULE_INFO[m ?? out[0].module!].source };
    }
    return out;
}

/**
 * 已知的「写死的固定骨架」块名前缀（规则/格式/钢印类，内容不随用户数据变化）。
 * 构成面板的展示层把命中的块合并成一行「固定提示词」，突出真正能优化的数据块。
 * 新增固定提示词块时记得把块头加进来（漏加只是显示散一点，无功能影响）。
 */
const FIXED_PROMPT_LABEL_PREFIXES = [
    '聊天 App 行为规范',
    '表达底线',
    '🎤 语音消息功能',
    '关于对方的表达',
    '最后，回到你自己',
    '【音乐互动工具】',
    '关于《彼方》',
    '[MCP 工具 ON',
    '[Reminder:',
    // 思考链提示词（thinkingChainPrompt.ts）的章节头
    '语言铁律',
    '你不是在演',
    '起点:你本来在干嘛',
    '同时被激活的多个东西',
    '别急着安慰',
    '别造谣',
    '温度:脑内比嘴上更吵',
    'Thinking 写法总则',
];

export const isFixedPromptBlockLabel = (label: string): boolean =>
    FIXED_PROMPT_LABEL_PREFIXES.some(prefix => label.startsWith(prefix));

/**
 * 思考链提示词（thinkingChainPrompt.ts）的章节头前缀。
 * 这些块虽然是"固定写死的骨架"，但性质跟行为规范/表达底线不同——它们是
 * 引导模型做内心独白的元规则。构成面板把它们单独拆出来不合并，并打「思考链」
 * 胶囊标签，让人一眼看出 prompt 里有多少是思考链开销。
 */
const THINKING_CHAIN_LABEL_PREFIXES = [
    '语言铁律',
    '你不是在演',
    '起点:你本来在干嘛',
    '同时被激活的多个东西',
    '别急着安慰',
    '别造谣',
    '温度:脑内比嘴上更吵',
    'Thinking 写法总则',
];

export const isThinkingChainBlockLabel = (label: string): boolean =>
    THINKING_CHAIN_LABEL_PREFIXES.some(prefix => label.startsWith(prefix));

// ── 模块归属（按「块头结构」锚定，不用关键词 contains） ─────────────────────

/**
 * 提示词功能模块。每一块 system prompt 都有个结构化块头（### 标题 / [System:]），
 * 根据块头就能精确归属到哪个功能——这比“标签里含不含记忆二字”可靠得多（人设
 * 里写了“我记性很好”不会被当成记忆模块）。
 */
export type PromptModule =
    | 'character' | 'worldbook' | 'memory' | 'memo' | 'realtime' | 'schedule'
    | 'music' | 'group' | 'diary' | 'asset' | 'task' | 'jobhunt' | 'vr'
    | 'rules' | 'voice' | 'thinking' | 'recency' | 'mcp' | 'bilingual'
    | 'history_user' | 'history_assistant' | 'history_tool' | 'solo_prompt' | 'other';

/** 模块元数据：展示名 + 来源（回答"哪来的"）。 */
export const PROMPT_MODULE_INFO: Record<PromptModule, { name: string; source: string }> = {
    character:         { name: '角色人设',   source: 'context.ts · 角色设定' },
    worldbook:         { name: '世界书',     source: 'worldbook.ts' },
    memory:            { name: '记忆系统',   source: 'context.ts / memoryPalace' },
    memo:              { name: '备忘录',     source: 'memos.ts' },
    realtime:          { name: '实时状态',   source: 'RealtimeContext' },
    schedule:          { name: '日程',       source: 'context.ts · 日程' },
    music:             { name: '音乐氛围',   source: 'context.ts · 音乐' },
    group:             { name: '群聊背景',   source: 'chatPrompts · 群聊' },
    diary:             { name: '日记/笔记',  source: 'chatPrompts · 日记笔记' },
    asset:             { name: '经济直觉',   source: 'chatPrompts · 资产' },
    task:              { name: '时光契约',   source: 'taskPrompts' },
    jobhunt:           { name: '上岸计划',   source: 'jobDirectives' },
    vr:                { name: '彼方',       source: 'chatPrompts · 彼方' },
    rules:             { name: '规则/格式',  source: 'chatPrompts · 行为规范' },
    voice:             { name: '语音功能',   source: 'chatPrompts · 语音' },
    thinking:          { name: '思考链',     source: 'thinkingChainPrompt' },
    recency:           { name: '结尾钢印',   source: 'chatPrompts · 钢印' },
    mcp:               { name: 'MCP 工具',    source: 'MCP' },
    bilingual:         { name: '双语指令',   source: 'chatPrompts · 双语' },
    history_user:      { name: '历史·用户',  source: '消息历史' },
    history_assistant: { name: '历史·角色',  source: '消息历史' },
    history_tool:      { name: '历史·工具',  source: '消息历史' },
    solo_prompt:       { name: '任务提示词', source: '单条任务请求' },
    other:             { name: '其他',       source: '未归类' },
};

/**
 * 块头关键词 → 模块。注意：这里只匿配「块头」（结构化标题），不匿配正文，
 * 所以不会把正文里提到的词当成模块信号。顺序：更具体的在前。
 */
const HEADER_MODULE_TABLE: [PromptModule, string[]][] = [
    ['memory',    ['记忆宫殿', '记忆系统', '记忆摘要', '长期核心记忆', '当前激活的详细回忆', 'Memory Bank', 'Memory Palace', 'Memory Reference']],
    ['memo',      ['你的备忘录', '备忘录']],
    ['worldbook', ['世界书', '扩展设定集', 'Worldbook']],
    ['recency',   ['关于对方的表达', '最后，回到你自己']],
    ['voice',     ['语音消息功能']],
    ['vr',        ['关于《彼方》', '在《彼方》里', '彼方']],
    ['jobhunt',   ['求职工作台', '上岸计划']],
    ['task',      ['时光契约', '任务监督']],
    ['group',     ['群聊背景']],
    ['diary',     ['最近写的日记', '最近写的笔记']],
    ['asset',     ['经济与生活直觉']],
    ['music',     ['音乐互动工具', '正在听', '此刻在听']],
    ['schedule',  ['今日行程', '当前日程', '意识流']],
    ['realtime',  ['当前时间', '实时状态', 'Live Context', '今日特殊', 'Background Context']],
    ['mcp',       ['MCP 工具', 'MCP']],
    ['rules',     ['聊天 App 行为规范', '表达底线', 'Chat App Rules', 'Anti-Filler']],
    ['character', ['你的身份', '角色名', '核心指令', '内在认知', '世界观与设定', 'World Settings', 'Self Insights', '互动对象', '私密档案', 'Private Impression', 'Character', '底色认知', 'Resident Knowledge']],
];

/** 根据块头文本判定模块；认不出返回 null（由调用方决定继承/兜底）。 */
export function matchModuleForHeader(header: string): PromptModule | null {
    if (isThinkingChainBlockLabel(header)) return 'thinking';
    for (const [mod, keys] of HEADER_MODULE_TABLE) {
        if (keys.some(k => header.includes(k))) return mod;
    }
    return null;
}

/**
 * 输入构成块的分类 key（展示层用 CATEGORY_META 映射成胶囊标签 + 颜色）。
 * 判断顺序很关键：越具体的前缀匹配越要先判，contains 类（记忆/世界书/角色）放最后，
 * 否则会被"聊天历史·用户消息 ×N"这类聚合标签里的字面词带偏。
 */
export type PromptBlockCategory =
    | 'thinking' | 'rule' | 'memory' | 'worldbook' | 'character'
    | 'history_user' | 'history_assistant' | 'history_tool'
    | 'task' | 'other';

export function classifyPromptBlock(label: string): PromptBlockCategory {
    // 1. 思考链章节（最具体，先判）
    if (isThinkingChainBlockLabel(label)) return 'thinking';
    // 2. 合并后的固定块「固定提示词（规则/格式，共 N 块）」或任一 fixed 前缀
    if (label.startsWith('固定提示词（') || isFixedPromptBlockLabel(label)) return 'rule';
    // 3. 聚合历史消息（前缀精确匹配，避免 contains 误伤）
    if (label.startsWith('聊天历史·用户消息')) return 'history_user';
    if (label.startsWith('聊天历史·角色消息')) return 'history_assistant';
    if (label.startsWith('其他消息（tool')) return 'history_tool';
    // 4. 单条任务提示词
    if (label.startsWith('提示词整体「')) return 'task';
    // 5. contains 类（放最后）
    if (/记忆/.test(label)) return 'memory';
    if (/世界书|世界观/.test(label)) return 'worldbook';
    if (/角色|档案|人设|设定/.test(label)) return 'character';
    return 'other';
}

/**
 * 从 chat/completions 请求体算输入构成。解析不了 / 没有 messages 时返回 undefined。
 * system 逐块统计，历史消息按角色聚合（用户只关心"内置注入哪块肥"，不关心第几条历史）。
 */
export function buildPromptBreakdown(body: unknown): PromptBlockStat[] | undefined {
    try {
        let parsed: any = body;
        if (typeof body === 'string') {
            try { parsed = JSON.parse(body); } catch { return undefined; }
        }
        const messages = parsed?.messages;
        if (!Array.isArray(messages) || messages.length === 0) return undefined;

        const out: PromptBlockStat[] = [];
        let userChars = 0, userCount = 0, asstChars = 0, asstCount = 0, otherChars = 0, otherCount = 0;
        // 聚合消息的 preview：把多条消息原文拼起来存全文，让点开能看到实际聊了啥
        let userPreview = '', asstPreview = '', otherPreview = '';
        const appendPreview = (buf: string, text: string): string => {
            if (buf.length >= PREVIEW_MAX_CHARS) return buf;
            return buf + text.slice(0, PREVIEW_MAX_CHARS - buf.length) + '\n';
        };
        // 情绪评估等路径把「完整 system prompt + 展平历史 + 任务说明」整个打包成一条
        // user 消息发送——不拆的话构成面板只会显示「用户消息 ×1 · 100%」，看不出内里。
        // 巨型且含多个块头的 user 消息按 system 同款规则拆块；普通聊天消息不受影响。
        const HUGE_USER_MSG_SPLIT_CHARS = 8000;
        const countBlockHeaders = (text: string): number => {
            let n = 0, inFence = false;
            const lines = text.split('\n');
            const fenceAt = fenceToggleLines(lines);
            for (let i = 0; i < lines.length; i++) {
                if (fenceAt.has(i)) inFence = !inFence;
                if (!inFence && matchBlockHeader(lines[i])) n++;
            }
            return n;
        };
        for (const msg of messages) {
            const text = contentToText(msg?.content);
            if (msg?.role === 'system') {
                out.push(...splitSystemBlocks(text));
            } else if (msg?.role === 'user') {
                if (text.length > HUGE_USER_MSG_SPLIT_CHARS && countBlockHeaders(text) >= 2) {
                    out.push(...splitSystemBlocks(text));
                } else {
                    userChars += text.length; userCount++;
                    userPreview = appendPreview(userPreview, text);
                }
            } else if (msg?.role === 'assistant') {
                asstChars += text.length; asstCount++;
                asstPreview = appendPreview(asstPreview, text);
            } else {
                otherChars += text.length; otherCount++;
                otherPreview = appendPreview(otherPreview, text);
            }
        }
        if (userCount) {
            // 记忆提取/日程生成/查手机等大量调用点是「单条 user 提示词」形态——
            // 标成"聊天历史"纯属误导，改用首行摘要让人一眼看出是什么任务。
            const soloPrompt = messages.length === 1 && userCount === 1;
            const firstLine = soloPrompt
                ? (contentToText(messages[0]?.content).trimStart().split('\n', 1)[0] || '').slice(0, BLOCK_LABEL_MAX)
                : '';
            out.push(soloPrompt
                ? { label: `提示词整体「${firstLine}」`, chars: userChars, preview: userPreview.trim() || undefined, module: 'solo_prompt', source: PROMPT_MODULE_INFO.solo_prompt.source }
                : { label: `聊天历史·用户消息 ×${userCount}`, chars: userChars, preview: userPreview.trim() || undefined, module: 'history_user', source: PROMPT_MODULE_INFO.history_user.source });
        }
        if (asstCount) out.push({ label: `聊天历史·角色消息 ×${asstCount}`, chars: asstChars, preview: asstPreview.trim() || undefined, module: 'history_assistant', source: PROMPT_MODULE_INFO.history_assistant.source });
        if (otherCount) out.push({ label: `其他消息（tool 等）×${otherCount}`, chars: otherChars, preview: otherPreview.trim() || undefined, module: 'history_tool', source: PROMPT_MODULE_INFO.history_tool.source });
        if (out.length === 0) return undefined;
        // 不再按块数截断成「其余 N 块合计」——展示层按模块合并成一条，块数自然收敛。
        return out;
    } catch {
        return undefined;
    }
}

export function recordApiCall(input: {
    /** 同一条 HTTP 请求在显式记录与全局 fetch 兜底间共享的 ID，用于原子去重。 */
    requestId?: string;
    url: string;
    body?: unknown;
    status?: number;
    ok: boolean;
    response?: unknown;
    /** 响应原始文本（JSON.parse 失败时传入，供 SSE 兜底解析 model / usage） */
    responseText?: string;
    meta?: ApiCallMeta;
    durationMs?: number;
}): void {
    try {
        const baseUrl = deriveBaseUrl(input.url);
        const model = extractModel(input.body);
        // 显式 meta 优先（safeFetchJson 各调用点传的精确信息）；没有就用环境兜底（裸 fetch）。
        const meta = hasMeta(input.meta) ? input.meta! : ambientMeta;
        // 整包 JSON 直接读；流式响应（response 为空但有原始文本）走 SSE 兜底扫描
        let responseForExtract: unknown = input.response;
        let backendModel: string | undefined =
            typeof (input.response as any)?.model === 'string' && (input.response as any).model
                ? (input.response as any).model : undefined;
        if (input.response === undefined && typeof input.responseText === 'string' && input.responseText.trimStart().startsWith('data:')) {
            const scanned = scanSseForLog(input.responseText);
            backendModel = scanned.model;
            if (scanned.usage) responseForExtract = { usage: scanned.usage };
        }
        const usage = extractUsage(responseForExtract);
        const entry: ApiCallLogEntry = {
            id: input.requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            presetName: resolvePresetName(baseUrl, model),
            baseUrl,
            model,
            backendModel,
            status: input.status,
            ok: input.ok,
            promptTokens: usage.prompt,
            completionTokens: usage.completion,
            totalTokens: usage.total,
            durationMs: input.durationMs,
            promptBreakdown: buildPromptBreakdown(input.body),
            appId: meta.appId,
            appName: meta.appName,
            charId: meta.charId,
            charName: meta.charName,
            purpose: meta.purpose,
            recalledMemories: meta.recalledMemories,
        };
        // 动态 import 避开 safeApi ↔ db 的潜在加载顺序问题；写库失败静默吞掉。
        import('./db')
            .then(({ DB }) => DB.appendApiCallLog(entry))
            .catch(() => {});
    } catch {
        // best-effort：任何异常都不影响主请求
    }
}
