/**
 * 资产系统 · 生成与直觉摘要
 *
 * 两块职责：
 *  1. 一键生成 / 重Roll：按角色人设调 LLM 产出 JSON（钱包档案 / 智能家居档案），
 *     带收支自洽约束（穷学生不许全款三套房）+ 数值清洗兜底。
 *  2. 直觉摘要（intuition）：从明细数据压出一段"人对自己财务/家里的日常直觉"，
 *     只有档位没有精确数字 —— 注入角色 prompt 用。纯确定性模板，不走 LLM，
 *     数据一变 walletOps 就能免费重算，永不失同步。
 */

import {
    APIConfig, CharacterProfile,
    CharWalletProfile, WalletAccount, WalletProperty, WalletLoan, WalletValuable,
    CharHomeProfile, HomeRoom, HomeItem, HomeSupply, HomeSupplyLevel,
} from '../types';
import { safeResponseJson } from './safeApi';

// ---------- 通用 ----------

const genId = (prefix: string, i: number) => `${prefix}-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;

const num = (v: unknown, fallback = 0): number => {
    const n = typeof v === 'string' ? parseFloat(v) : Number(v);
    return Number.isFinite(n) ? Math.round(n) : fallback;
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 从模型输出里抠出 JSON（容忍 ```json 围栏 / 前后废话） */
function extractJson(raw: string): any {
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object found');
    return JSON.parse(text.slice(start, end + 1));
}

/** 人设摘录：生成 prompt 用，控长度防 token 爆炸 */
function personaBrief(char: CharacterProfile): string {
    const parts: string[] = [`角色名：${char.name}`];
    if (char.systemPrompt) parts.push(`人设：${char.systemPrompt.slice(0, 1800)}`);
    if (char.worldview) parts.push(`世界观：${char.worldview.slice(0, 400)}`);
    return parts.join('\n');
}

async function callJsonLLM(apiConfig: APIConfig, system: string, user: string): Promise<any> {
    const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            temperature: 0.9,
            max_tokens: 2000,
        }),
    });
    if (!response.ok) throw new Error(`LLM ${response.status}`);
    const data = await safeResponseJson(response);
    const text = data?.choices?.[0]?.message?.content || '';
    return extractJson(text);
}

// ---------- 钱包生成 ----------

const WALLET_GEN_SYSTEM = `你是一个"角色生活档案生成器"。根据给定的角色人设，为这个角色生成一份**收支自洽**的个人资产档案。只输出一个 JSON 对象，不要输出任何其他文字。

JSON 结构（所有数组都允许为空；金额单位为元，整数）：
{
  "monthlyIncome": 8000,
  "incomeNote": "收入来源一句话（工资/生活费/稿费/兼职…）",
  "accounts": [
    { "type": "cash|savings|credit|investment", "name": "账户名", "balance": 0, "creditLimit": 0, "note": "一句话背景" }
  ],
  "properties": [
    { "kind": "home|car|other", "name": "描述性名字", "mode": "owned|renting|mortgaged",
      "estimatedValue": 0, "rentMonthly": 0, "rentDueDay": 15, "leaseEndDate": "YYYY-MM-DD", "deposit": 0,
      "loanMonthly": 0, "loanRemainingMonths": 0, "note": "一句话" }
  ],
  "loans": [
    { "name": "贷款名", "principal": 0, "monthly": 0, "remainingMonths": 0, "dueDay": 10, "note": "借钱原因" }
  ],
  "valuables": [
    { "name": "名下小物件", "estimatedValue": 0, "note": "一句话来历" }
  ]
}

硬性约束：
1. 必须有且只有一个 type=cash 的账户（零钱），balance 是随手能花的钱。
2. 收支自洽：资产量级必须与月收入和人设匹配。学生/低收入 → 可能没有储蓄卡以外的任何东西；普通上班族 → 租房+少量存款很常见；只有人设明确有钱才允许房产/大额投资。禁止"月薪几千却全款多套房产"。
3. 住房：绝大多数普通人是 renting（租的），要给 rentMonthly / rentDueDay / leaseEndDate（今天之后 2~14 个月内）/ deposit。mortgaged 要给月供和剩余期数。可以完全没有房（住宿舍/家里，就不写 home）。
4. credit 账户的 balance 表示已欠金额（正数），creditLimit 为额度；没有信用卡就不生成。
5. loans 里的每笔都要有真实可信的原因（note），跟人设呼应。
6. valuables 是 2~5 件有生活气的小物件（游戏机/乐器/首饰…），要跟人设有关。
7. 数字要"难看"一点才真实：用 3847 这种零头，别全是整千整万。`;

export interface WalletGenResult {
    profile: CharWalletProfile;
}

export async function generateWalletProfile(
    char: CharacterProfile,
    apiConfig: APIConfig,
    prev?: CharWalletProfile | null,
): Promise<CharWalletProfile> {
    const todayStr = new Date().toISOString().slice(0, 10);
    const userPrompt = `${personaBrief(char)}\n\n今天的日期：${todayStr}\n${prev ? '这是一次重Roll：生成一份跟上次明显不同的新档案（换一种合理的生活状态）。\n' : ''}请生成这个角色的资产档案 JSON。`;
    const raw = await callJsonLLM(apiConfig, WALLET_GEN_SYSTEM, userPrompt);

    // 清洗 + 兜底：不信任模型输出的任何数值/枚举
    const accounts: WalletAccount[] = Array.isArray(raw.accounts) ? raw.accounts.map((a: any, i: number): WalletAccount => ({
        id: genId('wa', i),
        type: (['cash', 'savings', 'credit', 'investment'] as const).includes(a?.type) ? a.type : 'cash',
        name: str(a?.name) || '账户',
        balance: num(a?.balance),
        creditLimit: a?.creditLimit != null ? num(a.creditLimit) : undefined,
        note: str(a?.note) || undefined,
    })) : [];
    // 硬约束兜底：必须恰好一个 cash 账户
    const cashAccounts = accounts.filter(a => a.type === 'cash');
    if (cashAccounts.length === 0) {
        accounts.unshift({ id: genId('wa', 99), type: 'cash', name: '零钱', balance: 300 });
    } else if (cashAccounts.length > 1) {
        // 合并多余的 cash 到第一个
        const first = cashAccounts[0];
        for (const extra of cashAccounts.slice(1)) {
            first.balance += extra.balance;
            accounts.splice(accounts.indexOf(extra), 1);
        }
    }

    const properties: WalletProperty[] = Array.isArray(raw.properties) ? raw.properties.map((p: any, i: number): WalletProperty => ({
        id: genId('wp', i),
        kind: (['home', 'car', 'other'] as const).includes(p?.kind) ? p.kind : 'other',
        name: str(p?.name) || '资产',
        mode: (['owned', 'renting', 'mortgaged'] as const).includes(p?.mode) ? p.mode : 'owned',
        estimatedValue: p?.estimatedValue != null ? num(p.estimatedValue) : undefined,
        note: str(p?.note) || undefined,
        rentMonthly: p?.rentMonthly != null ? num(p.rentMonthly) : undefined,
        rentDueDay: p?.rentDueDay != null ? Math.min(28, Math.max(1, num(p.rentDueDay, 1))) : undefined,
        leaseEndDate: /^\d{4}-\d{2}-\d{2}$/.test(str(p?.leaseEndDate)) ? str(p.leaseEndDate) : undefined,
        deposit: p?.deposit != null ? num(p.deposit) : undefined,
        loanMonthly: p?.loanMonthly != null ? num(p.loanMonthly) : undefined,
        loanRemainingMonths: p?.loanRemainingMonths != null ? num(p.loanRemainingMonths) : undefined,
    })) : [];

    const loans: WalletLoan[] = Array.isArray(raw.loans) ? raw.loans.map((l: any, i: number): WalletLoan => ({
        id: genId('wl', i),
        name: str(l?.name) || '贷款',
        principal: num(l?.principal),
        monthly: num(l?.monthly),
        remainingMonths: l?.remainingMonths != null ? num(l.remainingMonths) : undefined,
        dueDay: l?.dueDay != null ? Math.min(28, Math.max(1, num(l.dueDay, 10))) : undefined,
        note: str(l?.note) || undefined,
    })) : [];

    const valuables: WalletValuable[] = Array.isArray(raw.valuables) ? raw.valuables.slice(0, 6).map((v: any, i: number): WalletValuable => ({
        id: genId('wv', i),
        name: str(v?.name) || '小物件',
        estimatedValue: v?.estimatedValue != null ? num(v.estimatedValue) : undefined,
        note: str(v?.note) || undefined,
    })) : [];

    const profile: CharWalletProfile = {
        charId: char.id,
        generatedAt: Date.now(),
        rerollCount: (prev?.rerollCount || 0) + (prev ? 1 : 0),
        monthlyIncome: raw.monthlyIncome != null ? num(raw.monthlyIncome) : undefined,
        incomeNote: str(raw.incomeNote) || undefined,
        accounts, properties, loans, valuables,
        visibility: prev?.visibility || 'full',
    };
    profile.intuition = buildWalletIntuition(profile);
    return profile;
}

// ---------- 智能家居生成 ----------

const HOME_GEN_SYSTEM = `你是一个"角色住所档案生成器"。根据角色人设生成 ta 家里的房间与物品统计（假装有一个智能家居 App 统计了这些）。只输出一个 JSON 对象，不要输出任何其他文字。

JSON 结构：
{
  "homeName": "住所一句话（如：老小区六楼一居室）",
  "homeNote": "整体氛围一句话",
  "rooms": [
    { "name": "房间名", "icon": "一个emoji", "note": "一句话氛围",
      "items": [ { "name": "物品名", "icon": "一个emoji", "note": "一句话（可省略）", "expiryDate": "YYYY-MM-DD（可省略）" } ] }
  ],
  "supplies": [
    { "name": "补给类别（冰箱食材/洗衣液/纸巾…）", "icon": "一个emoji", "level": "plenty|ok|low|out", "note": "一句话（可省略）" }
  ]
}

硬性约束：
1. 房间 1~4 间（住宿舍就 1 间），每间 3~8 件有生活气的物品，跟人设强相关。
2. supplies 固定 4~8 类，覆盖：冰箱食材、至少两种日用品；level 分布要真实（不能全是 plenty）。
3. **全屋最多 3 件物品带 expiryDate**（今天之后 3~60 天），选有剧情价值的（对方送的巧克力/快到期的酸奶）；其余物品一律不写 expiryDate。
4. 物品记类别不记个数（写"鸡蛋和青菜"，不写"鸡蛋×7"）。`;

export async function generateHomeProfile(
    char: CharacterProfile,
    apiConfig: APIConfig,
    walletHint?: string,
    prev?: CharHomeProfile | null,
): Promise<CharHomeProfile> {
    const todayStr = new Date().toISOString().slice(0, 10);
    const hint = walletHint ? `\n住房背景（必须与之一致）：${walletHint}` : '';
    const userPrompt = `${personaBrief(char)}${hint}\n\n今天的日期：${todayStr}\n${prev ? '这是一次重Roll：生成一份跟上次明显不同的新档案。\n' : ''}请生成这个角色的住所档案 JSON。`;
    const raw = await callJsonLLM(apiConfig, HOME_GEN_SYSTEM, userPrompt);

    let expiryBudget = 3; // 硬约束兜底：全屋最多 3 件带保质期
    const rooms: HomeRoom[] = Array.isArray(raw.rooms) ? raw.rooms.slice(0, 5).map((r: any, ri: number): HomeRoom => ({
        id: genId('hr', ri),
        name: str(r?.name) || '房间',
        icon: str(r?.icon) || undefined,
        note: str(r?.note) || undefined,
        items: Array.isArray(r?.items) ? r.items.slice(0, 10).map((it: any, ii: number): HomeItem => {
            let expiryDate: string | undefined;
            if (/^\d{4}-\d{2}-\d{2}$/.test(str(it?.expiryDate)) && expiryBudget > 0) {
                expiryDate = str(it.expiryDate);
                expiryBudget--;
            }
            return {
                id: genId('hi', ri * 100 + ii),
                name: str(it?.name) || '物品',
                icon: str(it?.icon) || undefined,
                note: str(it?.note) || undefined,
                expiryDate,
            };
        }) : [],
    })) : [];

    const supplies: HomeSupply[] = Array.isArray(raw.supplies) ? raw.supplies.slice(0, 10).map((s: any, i: number): HomeSupply => ({
        id: genId('hs', i),
        name: str(s?.name) || '日用品',
        icon: str(s?.icon) || undefined,
        level: (['plenty', 'ok', 'low', 'out'] as const).includes(s?.level) ? s.level : 'ok',
        note: str(s?.note) || undefined,
    })) : [];

    const profile: CharHomeProfile = {
        charId: char.id,
        generatedAt: Date.now(),
        rerollCount: (prev?.rerollCount || 0) + (prev ? 1 : 0),
        homeName: str(raw.homeName) || undefined,
        homeNote: str(raw.homeNote) || undefined,
        rooms, supplies,
    };
    profile.intuition = buildHomeIntuition(profile);
    return profile;
}

// ---------- 直觉摘要（确定性模板，不走 LLM） ----------

/** 金额 → 模糊档位（人对钱的日常直觉从来不是精确数字） */
export function fuzzyMoney(n: number): string {
    const abs = Math.abs(n);
    if (abs < 50) return '几十块';
    if (abs < 300) return '一两百块';
    if (abs < 1000) return '几百块';
    if (abs < 3000) return '一两千';
    if (abs < 10000) return '几千块';
    if (abs < 30000) return '一两万';
    if (abs < 100000) return '几万块';
    if (abs < 300000) return '一二十万';
    if (abs < 1000000) return '几十万';
    return '上百万';
}

export function buildWalletIntuition(profile: CharWalletProfile): string {
    const parts: string[] = [];
    const cash = profile.accounts.find(a => a.type === 'cash');
    const savingsSum = profile.accounts.filter(a => a.type === 'savings').reduce((s, a) => s + a.balance, 0);
    const creditDebt = profile.accounts.filter(a => a.type === 'credit').reduce((s, a) => s + a.balance, 0);
    const hasInvest = profile.accounts.some(a => a.type === 'investment');

    if (cash) parts.push(cash.balance <= 0 ? '手头零钱基本见底' : `手头零钱${fuzzyMoney(cash.balance)}`);
    if (savingsSum > 0) parts.push(`卡里存款${fuzzyMoney(savingsSum)}`);
    else if (profile.accounts.some(a => a.type === 'savings')) parts.push('没什么存款');
    if (creditDebt > 0) parts.push(`信用账单欠着${fuzzyMoney(creditDebt)}`);
    if (hasInvest) parts.push('有点投资，行情起起伏伏懒得天天看');
    if (profile.monthlyIncome && profile.monthlyIncome > 0) {
        parts.push(`每月${fuzzyMoney(profile.monthlyIncome)}的进账${profile.incomeNote ? `（${profile.incomeNote}）` : ''}`);
    }

    for (const p of profile.properties) {
        if (p.mode === 'renting') {
            let s = `${p.kind === 'home' ? '房子是租的' : `${p.name}是租的`}${p.rentDueDay ? `，每月${p.rentDueDay}号交租` : ''}`;
            if (p.leaseEndDate) {
                const days = Math.ceil((new Date(p.leaseEndDate).getTime() - Date.now()) / 86400000);
                if (days > 0 && days <= 60) s += '，租约快到期了心里有点惦记续租的事';
            }
            parts.push(s);
        } else if (p.mode === 'mortgaged') {
            parts.push(`${p.kind === 'home' ? '背着房贷' : p.kind === 'car' ? '背着车贷' : `${p.name}还在还贷`}${p.loanMonthly ? '，每月还月供' : ''}`);
        } else if (p.kind === 'home') {
            parts.push('住自己的房子');
        } else if (p.kind === 'car') {
            parts.push(`有辆${p.name}`);
        }
    }
    if (profile.loans.length > 0) {
        parts.push(`另外背着${profile.loans.map(l => l.name).slice(0, 2).join('和')}${profile.loans.length > 2 ? '等几笔' : ''}要按月还`);
    }

    // 松紧总评：可支配 vs 月固定支出
    const liquid = (cash?.balance || 0) + savingsSum;
    const monthlyOut = profile.properties.reduce((s, p) => s + (p.rentMonthly || 0) + (p.loanMonthly || 0), 0)
        + profile.loans.reduce((s, l) => s + l.monthly, 0);
    if (monthlyOut > 0) {
        if (liquid < monthlyOut) parts.push('这个月手头很紧');
        else if (liquid < monthlyOut * 3) parts.push('手头不算宽裕，花钱要掂量');
        else parts.push('日子过得开，不至于为钱发愁');
    }
    return parts.join('；');
}

const LEVEL_TEXT: Record<HomeSupplyLevel, string> = {
    plenty: '很充足', ok: '还够用', low: '快没了', out: '已经用完了',
};

export function buildHomeIntuition(profile: CharHomeProfile): string {
    const parts: string[] = [];
    if (profile.homeName) parts.push(`住的是${profile.homeName}`);

    const lows = profile.supplies.filter(s => s.level === 'low');
    const outs = profile.supplies.filter(s => s.level === 'out');
    if (outs.length > 0) parts.push(`${outs.map(s => s.name).join('、')}已经用完了，该补了`);
    if (lows.length > 0) parts.push(`${lows.map(s => s.name).join('、')}快没了`);
    if (outs.length === 0 && lows.length === 0 && profile.supplies.length > 0) parts.push('家里日常补给大体够用');

    // 保质期钩子：14 天内到期 / 已过期的东西会浮上心头
    const now = Date.now();
    for (const room of profile.rooms) {
        for (const item of room.items) {
            if (!item.expiryDate) continue;
            const days = Math.ceil((new Date(item.expiryDate).getTime() - now) / 86400000);
            if (days < 0) parts.push(`${item.name}好像已经过期了，还没来得及处理`);
            else if (days <= 14) parts.push(`${item.name}快到保质期了，记得吃掉/用掉`);
        }
    }
    return parts.join('；');
}
