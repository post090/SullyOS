/**
 * 资产系统 · 钱包运维
 *
 * 转账真扣钱的落地点：聊天里的转账被"接收"时（用户点收款 / 角色输出 TRANSFER_ACCEPT），
 * 调 settleTransfer 让钱真的从一侧零钱进另一侧零钱，并落两条流水。
 *
 * 容错原则（角色扮演的钱，宁松勿断）：
 *  - 用户档案不存在 → 懒创建（零钱从 0 开始，可以变负——欠着角色的账也是剧情）。
 *  - 角色档案不存在（该角色没开资产系统）→ 角色侧静默跳过，用户侧照常结算。
 *  - 任何失败只 console.warn，绝不阻塞聊天主流程。
 */

import { CharWalletProfile, WalletTransaction } from '../types';
import { DB } from './db';
import { buildWalletIntuition, buildHomeIntuition } from './assetGen';

/** 用户侧档案在 char_wallets 里的保留 charId */
export const WALLET_USER_ID = '__user__';

const dateStrOf = (d: Date) => `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;

/** 用户零钱档案：不存在就建一个最小骨架（只有 cash 账户） */
export async function getOrCreateUserWallet(): Promise<CharWalletProfile> {
    const existing = await DB.getWalletProfile(WALLET_USER_ID);
    if (existing) return existing;
    const profile: CharWalletProfile = {
        charId: WALLET_USER_ID,
        generatedAt: Date.now(),
        accounts: [{ id: `wa-user-cash`, type: 'cash', name: '零钱', balance: 0 }],
        properties: [], loans: [], valuables: [],
        visibility: 'full',
    };
    await DB.saveWalletProfile(profile);
    return profile;
}

/** 给某档案的零钱账户加减钱（找不到 cash 账户就补一个），顺手重算直觉摘要 */
async function adjustCash(profile: CharWalletProfile, delta: number): Promise<void> {
    let cash = profile.accounts.find(a => a.type === 'cash');
    if (!cash) {
        cash = { id: `wa-cash-${Date.now()}`, type: 'cash', name: '零钱', balance: 0 };
        profile.accounts.unshift(cash);
    }
    cash.balance = Math.round((cash.balance + delta) * 100) / 100;
    // 用户侧档案不注入 prompt，不用浪费；角色侧重算直觉
    if (profile.charId !== WALLET_USER_ID) {
        profile.intuition = buildWalletIntuition(profile);
    }
    await DB.saveWalletProfile(profile);
}

async function writeTx(charId: string, amount: number, category: string, note: string): Promise<void> {
    const now = new Date();
    const tx: WalletTransaction = {
        id: `wtx-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
        charId, amount, category, note,
        timestamp: now.getTime(),
        dateStr: dateStrOf(now),
    };
    await DB.saveWalletTransaction(tx);
}

/**
 * 转账结算：direction 指钱的流向。
 *  - 'user_to_char'：用户发的转账被角色收下 → 用户零钱 −，角色零钱 +
 *  - 'char_to_user'：角色发的转账被用户收下 → 角色零钱 −，用户零钱 +
 * amount 接受 string（聊天 metadata 里存的是字符串，可能带货币符号）。
 *
 * 并发安全：chatParser（后台解析）和 Chat（用户点收款）可能同时触发结算，
 * get→改→save 的读改写并发会丢更新（后写覆盖先写，余额算错）。
 * 这里用模块级 promise 队列把所有结算串行化。
 */
let settleQueue: Promise<void> = Promise.resolve();

/** 给外部模块（walletSettlement 固定收支）排队用：所有钱包余额读改写共享这一条串行队列 */
export function enqueueWalletOp(fn: () => Promise<void>): Promise<void> {
    const run = settleQueue.then(fn);
    settleQueue = run.catch(() => { /* 失败不阻塞后续 */ });
    return run;
}

export function settleTransfer(opts: {
    direction: 'user_to_char' | 'char_to_user';
    charId: string;
    charName: string;
    amount: string | number | undefined;
    note?: string;
}): Promise<void> {
    const run = settleQueue.then(() => doSettleTransfer(opts));
    settleQueue = run.catch(() => { /* 失败不阻塞后续结算 */ });
    return run;
}

async function doSettleTransfer(opts: {
    direction: 'user_to_char' | 'char_to_user';
    charId: string;
    charName: string;
    amount: string | number | undefined;
    note?: string;
}): Promise<void> {
    try {
        const n = typeof opts.amount === 'number'
            ? opts.amount
            : parseFloat(String(opts.amount ?? '').replace(/[^\d.]/g, ''));
        if (!Number.isFinite(n) || n <= 0) return;

        const userProfile = await getOrCreateUserWallet();
        const charProfile = await DB.getWalletProfile(opts.charId); // 没档案=角色没开资产系统，角色侧跳过
        const noteSuffix = opts.note ? `：${opts.note}` : '';

        if (opts.direction === 'user_to_char') {
            await adjustCash(userProfile, -n);
            await writeTx(WALLET_USER_ID, -n, 'transfer', `转账给${opts.charName}${noteSuffix}`);
            if (charProfile) {
                await adjustCash(charProfile, n);
                await writeTx(opts.charId, n, 'transfer', `收到转账${noteSuffix}`);
            }
        } else {
            await adjustCash(userProfile, n);
            await writeTx(WALLET_USER_ID, n, 'transfer', `收到${opts.charName}的转账${noteSuffix}`);
            if (charProfile) {
                await adjustCash(charProfile, -n);
                await writeTx(opts.charId, -n, 'transfer', `转账给对方${noteSuffix}`);
            }
        }
        console.log(`💰 [Wallet] 转账结算 ${opts.direction} ¥${n}（${opts.charName}）`);
    } catch (err) {
        console.warn('[Wallet] 转账结算失败（不影响聊天）:', err);
    }
}

/**
 * 角色日常收支入账：聊天里角色说「买了杯咖啡」「稿费到账了」时由
 * chatParser 解析 [[ACTION:SPEND/INCOME]] 调这里 —— 钱真实进出零钱、落一条流水。
 * 没建钱包档案的角色静默跳过（没开资产系统就不记账）。
 * 复用转账的串行队列：和转账结算共享余额读改写，必须排同一条队。
 */
export function settleCharExpense(opts: {
    charId: string;
    kind: 'spend' | 'income';
    amount: string | number | undefined;
    note?: string;
}): Promise<void> {
    const run = settleQueue.then(() => doSettleCharExpense(opts));
    settleQueue = run.catch(() => { /* 失败不阻塞后续结算 */ });
    return run;
}

async function doSettleCharExpense(opts: {
    charId: string;
    kind: 'spend' | 'income';
    amount: string | number | undefined;
    note?: string;
}): Promise<void> {
    try {
        const n = typeof opts.amount === 'number'
            ? opts.amount
            : parseFloat(String(opts.amount ?? '').replace(/[^\d.]/g, ''));
        if (!Number.isFinite(n) || n <= 0) return;
        // 单笔上限兜底：LLM 偶尔会写出离谱数字（"花了 999999"），拒掉防止一句话清空存款
        if (n > 100000) return;

        const profile = await DB.getWalletProfile(opts.charId);
        if (!profile) return; // 没开资产系统
        const delta = opts.kind === 'spend' ? -n : n;
        await adjustCash(profile, delta);
        await writeTx(opts.charId, delta, opts.kind === 'spend' ? 'daily' : 'income', opts.note || (opts.kind === 'spend' ? '日常消费' : '一笔进账'));
        console.log(`💰 [Wallet] 日常${opts.kind === 'spend' ? '消费' : '收入'} ¥${n}（${opts.note || ''}）`);
        // 钱包→栖居联动：买日用品时把家里对应补给补回充足档（角色说买了墨水，栖居的墨水库存也该同步）
        if (opts.kind === 'spend' && opts.note) {
            await restockHomeSupply(opts.charId, opts.note);
        }
    } catch (err) {
        console.warn('[Wallet] 日常收支入账失败（不影响聊天）:', err);
    }
}

/**
 * 消费 → 栖居补货联动：角色花钱买东西（SPEND 用途里写了品名）时，把栖居补给里
 * 匹配的条目补回「充足」。只补已有条目不新增——咖啡外卖打车也都走 SPEND，
 * 不是每笔消费都该进家里；最长公共子串 ≥ 2 个字才算同一样东西
 * （「一瓶墨水」↔「钢笔墨水」命中，「拿铁」↔「冰箱食材」不命中）。
 * 失败只 warn，绝不影响记账主流程。
 */
async function restockHomeSupply(charId: string, note: string): Promise<void> {
    try {
        const home = await DB.getHomeProfile(charId);
        if (!home || !Array.isArray(home.supplies) || home.supplies.length === 0) return;
        const target = home.supplies.find(s => supplyMatches(s.name || '', note));
        if (!target || target.level === 'plenty') return;
        const before = target.level;
        target.level = 'plenty';
        target.note = '刚补过货';
        home.intuition = buildHomeIntuition(home);
        await DB.saveHomeProfile(home);
        console.log(`🏠 [Home] 补货感知：${target.name} ${before} → plenty（${note}）`);
    } catch (err) {
        console.warn('[Home] 消费补货联动失败（不影响记账）:', err);
    }
}

/**
 * 补给条目 ↔ 消费用途是否说的同一样东西：
 * ① 最长公共子串 ≥ 2 字（「一瓶墨水」↔「钢笔墨水」）；
 * ② 别名组兜底——采购口语和档案品名常常零重叠（「买菜和鸡蛋」↔「冰箱食材」），
 *    两侧各自命中同一组关键词才算。
 */
const SUPPLY_ALIAS_GROUPS: string[][] = [
    ['食材', '冰箱', '买菜', '蔬菜', '青菜', '鸡蛋', '水果', '猪肉', '牛肉', '鸡肉', '海鲜', '囤菜', '超市采购', '米面'],
    ['纸巾', '卷纸', '抽纸', '卫生纸'],
    ['洗发', '沐浴', '洗护'],
];
function supplyMatches(supplyName: string, note: string): boolean {
    if (lcsLen(supplyName, note) >= 2) return true;
    return SUPPLY_ALIAS_GROUPS.some(group =>
        group.some(w => supplyName.includes(w)) && group.some(w => note.includes(w)));
}

/** 最长公共子串长度（品名都是短串，滚动数组 DP 足够） */
function lcsLen(a: string, b: string): number {
    if (!a || !b) return 0;
    let best = 0;
    const prev = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        let diag = 0;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            if (a[i - 1] === b[j - 1]) {
                prev[j] = diag + 1;
                if (prev[j] > best) best = prev[j];
            } else {
                prev[j] = 0;
            }
            diag = tmp;
        }
    }
    return best;
}
