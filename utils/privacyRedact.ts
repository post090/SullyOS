// 上岸计划 · 本地隐私脱敏
// 全程本地正则打码，不经任何网络。简历/对话文本发 LLM 前必须先过这里，
// 脱敏预览由 UI 侧负责（用户确认后才允许发送）。
// 规则顺序有讲究：长数字（身份证/银行卡）先于手机号，否则 18 位号码会被手机号规则拦腰截断。

export interface RedactHit {
    /** 命中类型（中文标签，直接用于预览提示） */
    label: string;
    count: number;
}

export interface RedactResult {
    text: string;
    hits: RedactHit[];
    /** 是否有任何命中（预览页用来决定展示"已打码 N 处"还是"未发现敏感信息"） */
    changed: boolean;
}

interface RedactRule {
    label: string;
    re: RegExp;
    replacement: string;
}

// 注意：所有正则均不含换行字面量，纯单行匹配（跨行内容按行各自命中）。
const RULES: RedactRule[] = [
    {
        label: '身份证号',
        // 18 位：6 位地址码 + 8 位出生日期 + 3 位顺序码 + 校验位（数字或 X）
        re: /\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g,
        replacement: '[身份证已隐藏]',
    },
    {
        label: '银行卡号',
        // 13-19 位连续数字（先于手机号，避免长卡号被手机号规则截段）；容忍 4 位分组空格
        re: /(?<!\d)(?:\d[ -]?){13,19}(?<!\s)(?!\d)/g,
        replacement: '[银行卡已隐藏]',
    },
    {
        label: '手机号',
        re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
        replacement: '[手机号已隐藏]',
    },
    {
        label: '固定电话',
        re: /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g,
        replacement: '[电话已隐藏]',
    },
    {
        label: '邮箱',
        re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
        replacement: '[邮箱已隐藏]',
    },
    {
        label: '详细住址',
        // 「××省/市 ××市/区/县 ××路/街/村 ××号/栋/室」式的组合地址；宽进严出宁可少匹配，
        // 只有出现"路/街/道/巷/村/镇 + 门牌层级"才认为是能定位到人的详细住址
        re: /[\u4e00-\u9fa5]{2,8}(?:省|市|自治区|特别行政区)?[\u4e00-\u9fa5]{2,8}(?:市|区|县|旗)[\u4e00-\u9fa5A-Za-z0-9]{1,20}(?:路|街|道|巷|村|镇)[\u4e00-\u9fa5A-Za-z0-9-]{0,20}(?:号|弄|栋|幢|座|单元|室|楼)[\u4e00-\u9fa5A-Za-z0-9-]{0,12}/g,
        replacement: '[住址已隐藏]',
    },
];

/**
 * 本地脱敏主入口。
 * @param raw 原始文本（简历正文 / 待入记忆宫殿的会话文本）
 * @param opts.realNames 需要替换成「候选人」的真实姓名列表（如用户姓名）；空串/单字忽略，防止误伤
 */
export function redactPrivacy(raw: string, opts: { realNames?: string[] } = {}): RedactResult {
    let text = raw;
    const hits: RedactHit[] = [];

    for (const rule of RULES) {
        const matches = text.match(rule.re);
        if (matches && matches.length > 0) {
            // 银行卡规则会连带匹配纯空格分组，过滤掉数字不足 13 位的伪命中
            const real = rule.label === '银行卡号'
                ? matches.filter(m => m.replace(/[^0-9]/g, '').length >= 13)
                : matches;
            if (real.length === 0) continue;
            for (const m of real) text = text.split(m).join(rule.replacement);
            hits.push({ label: rule.label, count: real.length });
        }
    }

    // 姓名可选替换：只处理 ≥2 字的名字，逐个全文替换为「候选人」
    const names = (opts.realNames || []).map(n => (n || '').trim()).filter(n => n.length >= 2);
    for (const name of names) {
        if (!text.includes(name)) continue;
        const count = text.split(name).length - 1;
        text = text.split(name).join('候选人');
        hits.push({ label: `姓名「${name.slice(0, 1)}**」`, count });
    }

    return { text, hits, changed: hits.length > 0 };
}

/** 岗位卡代号化辅助：把文本里出现的真实公司名（companyNameLocal）替换成对应代号。喂 LLM / 记忆宫殿前调用 */
export function codifyCompanies(raw: string, positions: { code: string; companyNameLocal?: string }[]): string {
    let text = raw;
    for (const p of positions) {
        const real = (p.companyNameLocal || '').trim();
        if (real.length >= 2 && text.includes(real)) {
            text = text.split(real).join(p.code);
        }
    }
    return text;
}
