/**
 * 资产系统 · 固定收支结算引擎
 *
 * 让钱包不再是"生成一次就冻住"的背景板：工资按月进账、房租/月供/贷款按日扣款。
 * 仿照 taskSettlement 的"打开 App 补结算"模式——App 没开的日子，下次启动时逐日补跑。
 *
 * 设计要点：
 *  - 触发点：Launcher 数据加载完成后跑一次（ref 闸门防重复）；不依赖 LLM。
 *  - 补结算窗口：lastSettledDate（缺省从 generatedAt 当天起算）到今天，上限 92 天，
 *    防止改系统时间之类的病态输入把循环干爆。
 *  - 结算日规则（生成器已把 dueDay 钳在 1~28，天然避开月末问题）：
 *      工资        → incomeDay（缺省 10 号）+monthlyIncome
 *      租房        → rentDueDay −rentMonthly
 *      房贷/车贷月供 → 每月 1 号 −loanMonthly（WalletProperty 没有单独 dueDay 字段）
 *      贷款        → dueDay（缺省 10 号）−monthly；本金递减，还清自动销账
 *  - 并发安全：整个角色的结算排进 walletOps 的串行队列（enqueueWalletOp），
 *    和聊天转账/日常记账共享一条队，余额读改写不打架。
 *  - 错误隔离：单个角色失败不影响其它角色。
 */

import { CharWalletProfile, WalletTransaction } from '../types';
import { DB } from './db';
import { WALLET_USER_ID, enqueueWalletOp } from './walletOps';
import { buildWalletIntuition } from './assetGen';

const dateStrOf = (d: Date) => `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;

/** 单个角色补结算：从上次结算日的次日逐日跑到今天。返回本次落了几笔流水。 */
async function settleProfile(profile: CharWalletProfile, now: Date): Promise<number> {
    const todayStr = dateStrOf(now);
    // 起点：上次结算日次日；没结算过就从档案生成当天起（不倒贴生成前的账）
    const startFrom = profile.lastSettledDate || dateStrOf(new Date(profile.generatedAt));
    if (startFrom >= todayStr) {
        // 已结算到今天（或未来——改过系统时间），只补写标记
        if (!profile.lastSettledDate) {
            profile.lastSettledDate = todayStr;
            await DB.saveWalletProfile(profile);
        }
        return 0;
    }

    const cursor = new Date(`${startFrom}T12:00:00`);
    cursor.setDate(cursor.getDate() + 1);
    const txs: WalletTransaction[] = [];
    let cashDelta = 0;
    let guard = 0;

    const pushTx = (day: Date, amount: number, category: string, note: string) => {
        cashDelta += amount;
        txs.push({
            id: `wfx-${day.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
            charId: profile.charId,
            amount, category, note,
            timestamp: day.getTime(),
            dateStr: dateStrOf(day),
        });
    };

    while (dateStrOf(cursor) <= todayStr && guard < 92) {
        guard++;
        const dom = cursor.getDate();

        // 工资/生活费
        if (profile.monthlyIncome && profile.monthlyIncome > 0) {
            const incomeDay = Math.min(28, Math.max(1, profile.incomeDay || 10));
            if (dom === incomeDay) pushTx(cursor, profile.monthlyIncome, 'salary', profile.incomeNote || '月收入到账');
        }

        for (const p of profile.properties) {
            if (p.mode === 'renting' && p.rentMonthly && p.rentDueDay === dom) {
                pushTx(cursor, -p.rentMonthly, 'rent', `${p.name} · 房租`);
            }
            if (p.mode === 'mortgaged' && p.loanMonthly && dom === 1) {
                pushTx(cursor, -p.loanMonthly, 'loan', `${p.name} · 月供`);
                if (p.loanRemainingMonths != null && p.loanRemainingMonths > 0) p.loanRemainingMonths -= 1;
            }
        }

        for (const l of [...profile.loans]) {
            const dueDay = Math.min(28, Math.max(1, l.dueDay || 10));
            if (l.monthly > 0 && dueDay === dom) {
                pushTx(cursor, -l.monthly, 'loan', `${l.name} · 月还款`);
                l.principal = Math.max(0, Math.round((l.principal - l.monthly) * 100) / 100);
                if (l.remainingMonths != null && l.remainingMonths > 0) l.remainingMonths -= 1;
                // 还清销账：本金见零或期数走完
                if (l.principal <= 0 || l.remainingMonths === 0) {
                    profile.loans = profile.loans.filter(x => x.id !== l.id);
                    pushTx(cursor, 0, 'loan', `${l.name} · 已还清 🎉`);
                }
            }
        }

        cursor.setDate(cursor.getDate() + 1);
    }

    profile.lastSettledDate = todayStr;
    if (txs.length > 0) {
        // 一次性调整零钱 + 批量落流水
        let cash = profile.accounts.find(a => a.type === 'cash');
        if (!cash) {
            cash = { id: `wa-cash-${Date.now()}`, type: 'cash', name: '零钱', balance: 0 };
            profile.accounts.unshift(cash);
        }
        cash.balance = Math.round((cash.balance + cashDelta) * 100) / 100;
        profile.intuition = buildWalletIntuition(profile);
        for (const tx of txs) await DB.saveWalletTransaction(tx);
    }
    await DB.saveWalletProfile(profile);
    return txs.length;
}

/**
 * 全量固定收支结算：Launcher 启动时调一次。
 * 返回总共落了几笔流水（上层可选 toast）。
 */
export async function runWalletDailySettlement(now: Date = new Date()): Promise<number> {
    let profiles: CharWalletProfile[] = [];
    try {
        profiles = await DB.getAllWalletProfiles();
    } catch (err) {
        console.warn('[WalletSettlement] load profiles failed:', err);
        return 0;
    }
    let total = 0;
    for (const profile of profiles) {
        if (profile.charId === WALLET_USER_ID) continue; // 用户侧只有零钱，没固定收支
        try {
            await enqueueWalletOp(async () => {
                // 队列里重读最新档案：入队等待期间聊天记账可能已改过余额
                const fresh = await DB.getWalletProfile(profile.charId);
                if (!fresh) return;
                const n = await settleProfile(fresh, now);
                total += n;
            });
        } catch (err) {
            console.warn(`[WalletSettlement] ${profile.charId} settle failed:`, err);
        }
    }
    if (total > 0) console.log(`💰 [WalletSettlement] 固定收支结算 ${total} 笔`);
    return total;
}
