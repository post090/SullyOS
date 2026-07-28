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
import { buildWalletIntuition } from './assetGen';

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
