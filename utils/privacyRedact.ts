// 上岸计划 · 本地隐私脱敏
// 全程本地正则打码 + 离线拼音库（pinyin-pro 打包进 APK），不经任何网络。简历/对话文本发 LLM 前必须先过这里，
// 脱敏预览由 UI 侧负责（用户确认后才允许发送）。
// 规则顺序有讲究：长数字（身份证/银行卡）先于手机号，否则 18 位号码会被手机号规则拦腰截断。

import { pinyin } from 'pinyin-pro';

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
    /** 无 lookbehind 方案：组 1 = 前置字符（仅用于定位，不参与替换），组 2 = 真正要打码的主体 */
    bodyGroup?: boolean;
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
        // 13-19 位连续数字（先于手机号，避免长卡号被手机号规则截段）；容忍 4 位分组空格。
        // 不用 lookbehind（旧 iOS Safari 不支持，模块加载即炸）：组 1 吃掉前置非数字，组 2 是卡号主体
        re: /(^|\D)((?:\d[ -]?){12,18}\d)(?!\d)/g,
        replacement: '[银行卡已隐藏]',
        bodyGroup: true,
    },
    {
        label: '手机号',
        re: /(^|\D)(1[3-9]\d{9})(?!\d)/g,
        replacement: '[手机号已隐藏]',
        bodyGroup: true,
    },
    {
        label: '固定电话',
        re: /(^|\D)(0\d{2,3}-\d{7,8})(?!\d)/g,
        replacement: '[电话已隐藏]',
        bodyGroup: true,
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
 * @param opts.realNames 需要替换的真实姓名列表（如用户姓名）；空串/单字忽略，防止误伤
 * @param opts.nameMode 姓名档位：fixed=固定「候选人」（默认）/ pinyin=拼音缩写 / off=真名不替换
 */
export function redactPrivacy(raw: string, opts: { realNames?: string[]; nameMode?: NameRedactMode } = {}): RedactResult {
    let text = raw;
    const hits: RedactHit[] = [];

    for (const rule of RULES) {
        // bodyGroup 规则只取主体组：前置定位字符不进替换集，split/join 语义与原 lookbehind 版一致
        const matches = rule.bodyGroup
            ? Array.from(text.matchAll(rule.re), mm => mm[2]).filter(Boolean)
            : text.match(rule.re);
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

    // 姓名可选替换：只处理 ≥2 字的名字，按档位逐个全文替换（off 档不动）
    const nameMode: NameRedactMode = opts.nameMode || 'fixed';
    const names = nameMode === 'off' ? [] : (opts.realNames || []).map(n => (n || '').trim()).filter(n => n.length >= 2);
    for (const name of names) {
        if (!text.includes(name)) continue;
        const count = text.split(name).length - 1;
        const replacement = nameMode === 'pinyin' ? (pinyinAbbr(name, false) || '候选人') : '候选人';
        text = text.split(name).join(replacement);
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

// ─── 四档公司代号生成（离线拼音库，幂等去重）───

export type CompanyRedactMode = 'initial' | 'pinyin' | 'custom' | 'off';
export type NameRedactMode = 'fixed' | 'pinyin' | 'off';

/** 中英混合取首字母缩写：中文走离线拼音库，字母/数字原样保留；firstOnly=只取第一个字符 */
export function pinyinAbbr(text: string, firstOnly: boolean): string {
    const clean = (text || '').trim().replace(/[（(].*?[)）]/g, ''); // 去括号备注
    if (!clean) return '';
    const letters: string[] = [];
    for (const ch of Array.from(clean)) {
        if (/[\u4e00-\u9fa5]/.test(ch)) {
            const p = pinyin(ch, { pattern: 'first', toneType: 'none', type: 'array' })[0] || '';
            if (p) letters.push(p.toUpperCase());
        } else if (/[A-Za-z0-9]/.test(ch)) {
            letters.push(ch.toUpperCase());
        }
        if (firstOnly && letters.length >= 1) break;
    }
    return letters.join('');
}

/**
 * 公司代号生成（全离线、幂等）：
 * - 同一真名已有岗位 → 直接复用其代号（稳定映射）
 * - initial：拼音单个首字母（字节→Z）；撞车加数字后缀（招商→Z2）
 * - pinyin：完整拼音缩写（字节跳动→ZJTD）；同样去重
 * - custom：不自动生成（用户自填，手改即 codeLocked）；off：直接用真名
 */
export function genCompanyCode(
    realName: string,
    mode: CompanyRedactMode,
    existing: { code: string; companyNameLocal?: string }[],
): string {
    const real = (realName || '').trim();
    if (!real) return '';
    if (mode === 'off') return real;
    if (mode === 'custom') return '';
    const reuse = existing.find(p => (p.companyNameLocal || '').trim() === real);
    if (reuse) return reuse.code;
    const base = pinyinAbbr(real, mode === 'initial') || 'X';
    const taken = new Set(existing.map(p => p.code));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
        if (!taken.has(`${base}${i}`)) return `${base}${i}`;
    }
    return `${base}_${Date.now() % 1000}`; // 99 个同名公司？兆个不重复的兑底
}
