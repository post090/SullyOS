/**
 * 转账指令的容错解析 —— 纯函数, 无 DB / 无副作用, 便于 vitest 直测。
 *
 * 为什么需要这层:
 * 拼历史上下文时, 角色自己发出的转账被渲染成第二人称系统日志喂给模型
 * (chatPrompts.ts buildMessageHistory: `[系统: 你向xx转账 1999]`)。人设里写了
 * "经常转账" 的角色, 会直接照抄这行文本, 而不是输出规范的 `[[ACTION:TRANSFER:1999]]`
 * —— 于是用户看到的是一条普通文字气泡, 不是转账卡片。
 *
 * 这类 "掉格式" 是常态而非异常 (OBSERVE 面板 / 信号坠落处 / 群聊红包都各自写了两层容错),
 * 所以解析端认得出角色的口语版写法, 比在 prompt 里让它别抄可靠。
 *
 * 三条设计约束:
 *
 *  1. **只认方括号包裹的整块**, 自由散文一律不认。角色在正文里叙述 "我刚给你转了1999"
 *     是在说话, 不是在转账; 把叙述也当指令会凭空多出一笔。
 *
 *  2. **方向由调用方的 role 决定, 不由文本决定**。文本里的方向信息只用来*校验*:
 *     `[系统: xx向你转账 1999]` 是角色在替用户转账 —— 这是伪造, 整块剥掉且不产生事件。
 *     现在方向本就不可伪造 (chatParser 落库时 role 硬编码 'assistant'), 这条保证
 *     容错层不会把这个安全性削掉。任何为了 "让模型看懂" 而加进语法的字段都只参与校验。
 *
 *  3. **解析不了就剥掉, 保正文** —— 对齐 groupChat/redpacket.ts extractPacketCommands
 *     的既有惯例。残留的日志文本落进气泡就是这次 bug 的原样复现。
 */

// ─── 记录形态: 历史渲染与输出语法的统一词汇表 ──────────────────────────────
//
// 历史上下文里同一条转账曾有四副面孔 (私聊 `[系统: 你向xx转账 1999]` / 归档第三人称 /
// 群摘要 `[转账1999]` / 输出语法 `[[ACTION:TRANSFER:100]]`), 模型每次输出都要做一次
// "从见过的翻译成该写的", 翻译就有失败率 —— 掉格式的根源。统一成共用词汇表:
//
//     历史:  [[记录:TRANSFER|to=user|amount=1999|status=已收下]]
//     输出:  [[ACTION:TRANSFER|to=user|amount=1999]]
//
// 字段是包含关系 (ACTION ⊂ 记录): status 只在记录里有 —— 模型没有"替用户宣布已收下"
// 的权限。前缀差异天然是幂等哨兵: 模型复读历史抄出来的是 [[记录:...]], 解析端消费丢弃,
// 不产生新转账。to 固定写 user / char 两个词, 不写真名 (改名不炸; 真名在 tag 外的
// 自然语言里本来就有)。
//
// TODO(记录形态推广): 转账这版观察一段时间, 没问题后把戳一戳 (interaction) / 时间间隔
// 提示等其他系统事件也迁到 [[记录:...]] 形态 —— 幂等哨兵和 sanitize 终线已按整个
// 记录命名空间实现, 迁移时只需要改渲染端。

export interface TransferRecordInput {
    /** 消息的 role —— 方向的唯一真理来源 (约束 2) */
    role: 'user' | 'assistant';
    amount?: string | number;
    /** 回执消息 (metadata.receipt) */
    receipt?: 'accepted' | 'returned';
    /** 原始转账的 live 状态 (metadata.status) —— 收/退后历史不再显示"待处理" */
    status?: string;
}

/**
 * 把一条 transfer 消息渲染成历史记录行。chatPrompts.buildMessageHistory (私聊历史) 与
 * messageFormat.normalizeMessageContent (归档 / 记忆宫殿) 共用, 保证全链路一副面孔。
 *
 * to 的取值: 原始转账 = role 的对手方 (assistant 发的钱流向 user); 回执 = 出回执一方
 * 自己 (user 出的回执说明钱当初流向 user)。status 的收/退主语恒为收款方, 无歧义。
 */
export function formatTransferRecord(input: TransferRecordInput): string {
    const { role, amount, receipt } = input;
    const to = receipt
        ? (role === 'user' ? 'user' : 'char')
        : (role === 'user' ? 'char' : 'user');
    const status = receipt
        ? (receipt === 'accepted' ? '已收下' : '已退回')
        : input.status === 'accepted' ? '已收下'
        : input.status === 'returned' ? '已退回'
        : '待处理';
    const amountPart = (amount !== undefined && amount !== null && String(amount).trim() !== '')
        ? `|amount=${amount}`
        : '';
    return `[[记录:TRANSFER|to=${to}${amountPart}|status=${status}]]`;
}

/** 一条转账相关指令。方向不在这里 —— 见约束 2。 */
export type TransferEvent =
    /** 角色向用户转账。amount 是规范化后的字符串 (与 metadata.amount 的既有形态一致) */
    | { kind: 'send'; amount: string }
    /** 角色收下用户那笔待处理转账 */
    | { kind: 'accept' }
    /** 角色退回用户那笔待处理转账 */
    | { kind: 'return' };

/** 被剥掉的一段文本 + 它产生的事件 (null = 剥掉但不产生事件: 伪造 / 金额非法) */
interface Hit {
    start: number;
    end: number;
    event: TransferEvent | null;
}

/**
 * 宽松金额解析。放宽的动机: 原正则是 `(\d+)`, 角色写 `520元` / `1,999` / `[[ACTION:TRANSFER: 520]]`
 * (多一个空格) 时匹配失败, 标签接着被 sanitize 当无效业务标签清掉 —— 转账彻底消失,
 * 连文字都不剩, 比 "渲染成文字" 更难排查。
 *
 * 接受: 全角数字 / 千分位 / 币种符号 / 元·块·圆·RMB·CNY 后缀 / 两侧空白。
 * 拒绝: 非数字、0、负数、NaN、Infinity。上限不设 —— 人设引导出来的天价转账由用户自己负责。
 */
export function parseTransferAmount(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
    if (typeof raw !== 'string') return null;

    // 全角数字 / 全角句点 → 半角 (０-９ 与 ． 在 Unicode 里都是 +0xFEE0 偏移)
    let s = raw.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s
        .replace(/[¥￥$＄]/g, '')
        .replace(/(?:元|块钱|块|圆|RMB|CNY|credits?)/gi, '')
        .replace(/[,，\s]/g, '');

    if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

/**
 * 金额 → 落库形态。整数去小数点 (`520.00` → `520`), 非整数保留两位。
 * 存字符串是为了跟历史数据对齐 —— 老实现存的是正则捕获组, 本来就是字符串。
 */
export function formatTransferAmount(n: number): string {
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// ─── 规范标签 ──────────────────────────────────────────────────────────────

// 记录哨兵: `[[记录:TRANSFER|...]]` 是历史渲染形态 (formatTransferRecord), 模型复读历史
// 会连前缀一起抄出来。消费丢弃、恒不产生事件 —— 复读本来就不该产生新转账, 这个行为是对的。
const RECORD_TRANSFER_RE = /\[\[\s*[记記][录錄]\s*[:：]\s*TRANSFER[^\]]*\]\]/gi;

// 新 canonical: `[[ACTION:TRANSFER|to=user|amount=520]]` —— 跟记录行只差前缀和少一个
// status, 模型从"见过的"到"该写的"只换一个词。kv 顺序不敏感, 裸值容错 (`|520` 当 amount)。
// `(?:\|...)?` 不吃冒号, 所以跟老冒号形态 ACTION_SEND_RE 互不重叠; 也匹配裸
// `[[ACTION:TRANSFER]]` (无金额 → 剥掉不产生事件, 比漏进气泡好)。
const ACTION_SEND_KV_RE = /\[\[\s*ACTION\s*[:：]\s*TRANSFER\s*((?:\|[^\]]*)?)\s*\]\]/gi;

// `[[ACTION:TRANSFER:1999]]` (老写法, 永久兼容 —— 存量世界书 / 用户自定义 prompt 还会写它)。
// 冒号两侧容空白 / 全角, 金额交给 parseTransferAmount。
// 注意 payload 用 `[^\]]*?` 而不是 `\d+`: 金额非法时也要匹配上, 才能剥掉不留残骸。
// `TRANSFER` 后必须跟冒号, 所以不会误吃 `[[ACTION:TRANSFER_ACCEPT]]`。
const ACTION_SEND_RE = /\[\[\s*ACTION\s*[:：]\s*TRANSFER\s*[:：]\s*([^\]]*?)\s*\]\]/gi;

/**
 * `to=` 的伪造值 —— 明确指向角色自己的写法。命中即整块丢弃 (约束 2: 文本里的方向
 * 只做校验, 不做授权; 方向永远由 role 决定)。其余取值 (user / 用户 / 任意名字 / 缺省)
 * 一律放行: 私聊对手方唯一, 写名字大概率就是对方, 不需要把 userName 传进纯函数。
 */
const FORGED_TO_VALUES = new Set(['char', 'self', 'me', '角色', '自己', '我', '自分', '本人']);

/** `to=user|amount=520` → { to: 'user', amount: '520' }。裸值 (无 `=`) 且像金额 → 当 amount。 */
function parseKvArgs(argStr: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of argStr.split(/[|｜]/)) {
        const seg = part.trim();
        if (!seg) continue;
        const eq = seg.search(/[=＝]/);
        if (eq < 0) {
            if (!('amount' in out) && parseTransferAmount(seg) !== null) out.amount = seg;
            continue;
        }
        const k = seg.slice(0, eq).trim().toLowerCase();
        const v = seg.slice(eq + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

/** kv 形态 → 事件。to 伪造 / 金额非法 → null (剥掉不产生事件)。 */
function kvToSendEvent(argStr: string): TransferEvent | null {
    const kv = parseKvArgs(argStr);
    const to = (kv.to ?? kv['给'] ?? '').toLowerCase();
    if (to && FORGED_TO_VALUES.has(to)) return null;
    const amount = parseTransferAmount(kv.amount ?? kv['金额']);
    return amount === null ? null : { kind: 'send', amount: formatTransferAmount(amount) };
}
const ACTION_ACCEPT_RE = /\[\[\s*ACTION\s*[:：]\s*TRANSFER_ACCEPT\s*\]\]/gi;
const ACTION_RETURN_RE = /\[\[\s*ACTION\s*[:：]\s*TRANSFER_RETURN\s*\]\]/gi;

// ─── 模仿历史渲染的口语形态 ────────────────────────────────────────────────

/**
 * `[系统: ...]` / `[系统：...]` / `[系统提示: ...]` / `[System: ...]` / `【系统：...】` 整块。
 * 全角括号【】一并认 (master 的 extractAssistantTransfers 覆盖过这个变体, 合并时并入)。
 * 内层禁止再出现任何一种括号, 保证不会跨块吞掉正文。
 */
const SYSTEM_LOG_RE = /[\[【]\s*(?:系统|系統|System)\s*(?:提示)?\s*[:：]\s*([^\[\]【】]*?)\s*[\]】]/gi;

/**
 * 群活动注入到私聊背景时的压缩形态 (chatPrompts.ts summarizeGroupMsgContent): `[转账1999]`。
 * 没有方向信息 —— 私聊只有两方, 方向由 role 决定, 见约束 2。
 */
const BARE_TRANSFER_RE = /\[\s*转[账帐]\s*[:：]?\s*([^\[\]]{0,24}?)\s*\]/gi;

/** 金额片段: 可选币种符号 + 数字 (含全角/千分位/小数) + 可选单位 */
const AMOUNT_FRAGMENT = String.raw`[¥￥$＄]?\s*([0-9０-９][0-9０-９.,，]*)\s*(?:元|块钱|块|圆)?`;

/**
 * 角色 → 用户: `你向xx转账 1999` / `你给xx转了1999` / `我向你转账￥520元`。
 * 主语锚定「你/我」—— 历史日志用第二人称「你」称呼角色, 而模型以第一人称说话时会写
 * 「我向你转账」, 这里的「我」同样是角色自己 (说话者是 assistant), 都是合法转账。
 * 主语是第三方名字 (`用户向你转账`) 的不在此列, 落到 LOG_FORGED_RE。
 */
const LOG_SEND_RE = new RegExp(String.raw`^(?:你|我)\s*(?:向|给).*?转(?:[账帐]了?|了)\s*${AMOUNT_FRAGMENT}`);
/** 角色处理用户的转账: `你接收了xx的转账 520` / `你退回了xx的转账 520` */
const LOG_ACCEPT_RE = /^你(?:接收|接受|收下|领取)了.*?转[账帐]/;
const LOG_RETURN_RE = /^你退回了.*?转[账帐]/;
/**
 * 伪造: 主语是用户 (第三方名字)。`xx向你转账 1999` 是角色在替用户转账;
 * `xx接收了你的转账` 是角色在替用户签收。两者都必须拦下, 不能渲染。
 *
 * 判定顺序上必须排在 LOG_SEND_RE **之后**: `我向你转账 520` 也含「向你转账」,
 * 但主语「我」= 角色自己, 是合法 send —— 先按主语锚定认领, 剩下的才算伪造。
 */
const LOG_FORGED_RE = /(?:向|给)你转[账帐]|(?:接收|接受|收下|领取|退回)了你的转[账帐]/;

/**
 * 是否是转账相关的系统日志 (用来区分 "该消费但无事件" 和 "根本不归我管")。
 * 第二个分支收口语版 `转了1999` —— 没有"账"字, 但后面直接跟金额。
 */
const LOG_IS_TRANSFER_RE = /转[账帐]|转了?\s*[¥￥$＄]?\s*[0-9０-９]/;

/**
 * 分类一条 `[系统: ...]` 的内层文本。
 * @returns 事件 / null (消费但不产生事件) / undefined (不归转账管, 别消费)
 */
function classifySystemLog(inner: string): TransferEvent | null | undefined {
    const s = inner.trim();
    if (!LOG_IS_TRANSFER_RE.test(s)) return undefined;

    // 主语锚定 (^你 / ^我) 的形态先认领 —— `我向你转账` 的「我」是角色自己, 合法 send,
    // 不能被下面按「向你转账」子串判伪造的规则误杀。
    if (LOG_ACCEPT_RE.test(s)) return { kind: 'accept' };
    if (LOG_RETURN_RE.test(s)) return { kind: 'return' };

    const m = s.match(LOG_SEND_RE);
    if (m) {
        const amount = parseTransferAmount(m[1]);
        return amount === null ? null : { kind: 'send', amount: formatTransferAmount(amount) };
    }

    // 主语不是你/我的剩余形态: 伪造 (角色替用户转账/签收), 剥掉且零事件 —— 约束 2
    if (LOG_FORGED_RE.test(s)) return null;

    // 其余转账相关日志 (回执的其它措辞等): 剥掉保正文, 不产生事件
    return null;
}

/** 收集一条正则的所有命中, 跳过与已有命中重叠的部分 (先注册的模式优先) */
function collect(
    text: string,
    re: RegExp,
    toEvent: (m: RegExpExecArray) => TransferEvent | null | undefined,
    hits: Hit[],
): void {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (hits.some(h => start < h.end && end > h.start)) continue;
        const event = toEvent(m);
        if (event === undefined) continue; // 不归转账管, 留给 sanitize 终线
        hits.push({ start, end, event });
    }
}

/**
 * 从角色输出里抠出全部转账指令, 返回剥净后的正文 + 按出现顺序排列的事件。
 *
 * 一条回复里的多笔转账全部保留, 不设数量上限 —— "经常转账" 的人设一次回复转两笔是
 * 合理行为。(顺带修掉老实现的一个静默丢失: 它只 match 第一个标签, 第二笔会留在正文里
 * 被 sanitize 当无效业务标签清掉, 既不落库也不显示。)
 */
export function extractTransferCommands(content: string): {
    text: string;
    events: TransferEvent[];
    /** 被剥掉的块数 (含无事件的伪造/非法块) —— 调用方据此判断要不要回写 text */
    consumed: number;
} {
    const src = String(content ?? '');
    if (!src) return { text: '', events: [], consumed: 0 };

    const hits: Hit[] = [];

    // 记录哨兵最先注册 —— 复读历史的记录行在任何其他模式之前被消费掉 (恒零事件)
    collect(src, RECORD_TRANSFER_RE, () => null, hits);
    collect(src, ACTION_SEND_KV_RE, m => kvToSendEvent(m[1] ?? ''), hits);
    collect(src, ACTION_SEND_RE, m => {
        const amount = parseTransferAmount(m[1]);
        return amount === null ? null : { kind: 'send', amount: formatTransferAmount(amount) };
    }, hits);
    collect(src, ACTION_ACCEPT_RE, () => ({ kind: 'accept' }), hits);
    collect(src, ACTION_RETURN_RE, () => ({ kind: 'return' }), hits);
    collect(src, SYSTEM_LOG_RE, m => classifySystemLog(m[1] ?? ''), hits);
    collect(src, BARE_TRANSFER_RE, m => {
        const amount = parseTransferAmount(m[1]);
        return amount === null ? null : { kind: 'send', amount: formatTransferAmount(amount) };
    }, hits);

    hits.sort((a, b) => a.start - b.start);

    let text = '';
    let cursor = 0;
    for (const h of hits) {
        text += src.slice(cursor, h.start);
        cursor = h.end;
    }
    text += src.slice(cursor);

    return {
        text: text.trim(),
        events: hits.map(h => h.event).filter((e): e is TransferEvent => e !== null),
        consumed: hits.length,
    };
}
