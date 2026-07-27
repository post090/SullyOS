/**
 * 钱包 App —— 资产系统的金钱面板。
 *
 * 概念边界：跟 BankApp（用户记账储蓄罐）完全独立。这里管"谁名下有什么"：
 *  - 角色侧：账户（零钱/储蓄/信用/投资）、房车（自有/租/贷）、贷款、小物件、流水
 *  - 用户侧：P1 只有零钱 + 转账流水（选人条第一格"我"）
 *  - 没档案的角色一屏引导 → 一键生成（LLM 按人设产出，收支自洽）→ 可重Roll
 *  - 浏览范围：full 全明细 / summary 只看直觉摘要（给想保留神秘感的用户）
 *
 * UI：深色玻璃 + 数字大字版面（对齐全站扁平毛玻璃规范；安全区走 --chrome-top）。
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharWalletProfile, WalletTransaction, WalletProperty } from '../types';
import { generateWalletProfile } from '../utils/assetGen';
import { WALLET_USER_ID, getOrCreateUserWallet } from '../utils/walletOps';
import {
    ArrowLeft, Wallet as WalletIcon, ArrowsClockwise, Sparkle, Eye, EyeSlash,
    House, Car, Package, Bank, CreditCard, TrendUp, Coins, Receipt, CaretRight,
} from '@phosphor-icons/react';

const fmt = (n: number) => `¥${Math.round(n).toLocaleString('zh-CN')}`;

const GLASS_CARD: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.09)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
};

const ACCOUNT_META: Record<string, { label: string; icon: React.ReactNode; tint: string }> = {
    cash: { label: '零钱', icon: <Coins size={16} weight="fill" />, tint: 'text-amber-300' },
    savings: { label: '储蓄', icon: <Bank size={16} weight="fill" />, tint: 'text-sky-300' },
    credit: { label: '信用', icon: <CreditCard size={16} weight="fill" />, tint: 'text-rose-300' },
    investment: { label: '投资', icon: <TrendUp size={16} weight="fill" />, tint: 'text-emerald-300' },
};

const WalletApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, apiConfig, addToast } = useOS();
    const [selId, setSelId] = useState<string>(activeCharacterId || WALLET_USER_ID);
    const [profile, setProfile] = useState<CharWalletProfile | null>(null);
    const [txs, setTxs] = useState<WalletTransaction[]>([]);
    const [tab, setTab] = useState<'overview' | 'txs'>('overview');
    const [generating, setGenerating] = useState(false);
    const [confirmReroll, setConfirmReroll] = useState(false);
    const [loading, setLoading] = useState(true);

    const isUser = selId === WALLET_USER_ID;
    const selChar = useMemo(() => characters.find(c => c.id === selId) || null, [characters, selId]);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const p = isUser ? await getOrCreateUserWallet() : await DB.getWalletProfile(selId);
            setProfile(p);
            setTxs(await DB.getWalletTransactions(selId));
        } catch (e) {
            console.error('[Wallet] load failed:', e);
        } finally {
            setLoading(false);
        }
    }, [selId, isUser]);

    useEffect(() => { reload(); setTab('overview'); setConfirmReroll(false); }, [reload]);

    // 净资产：流动(现金+储蓄+投资) + 固定(自有/还贷中估值) − 负债(信用已用+贷款本金)
    const stats = useMemo(() => {
        if (!profile) return null;
        const liquid = profile.accounts.reduce((s, a) => s + (a.type === 'credit' ? 0 : a.balance), 0);
        const fixed = profile.properties.reduce((s, p) => s + ((p.mode !== 'renting' && p.estimatedValue) ? p.estimatedValue : 0), 0);
        const debt = profile.accounts.filter(a => a.type === 'credit').reduce((s, a) => s + a.balance, 0)
            + profile.loans.reduce((s, l) => s + l.principal, 0);
        return { liquid, fixed, debt, net: liquid + fixed - debt };
    }, [profile]);

    const handleGenerate = useCallback(async (isReroll: boolean) => {
        if (!selChar) return;
        if (!apiConfig?.apiKey) { addToast('先去系统设置配置 API 才能生成', 'error'); return; }
        setGenerating(true);
        setConfirmReroll(false);
        try {
            const next = await generateWalletProfile(selChar, apiConfig, isReroll ? profile : null);
            if (isReroll) await DB.deleteWalletTransactionsByChar(selChar.id);
            await DB.saveWalletProfile(next);
            await reload();
            addToast(isReroll ? '已重新生成资产档案' : `${selChar.name}的资产档案已生成`, 'success');
        } catch (e) {
            console.error('[Wallet] generate failed:', e);
            addToast('生成失败了，稍后再试试', 'error');
        } finally {
            setGenerating(false);
        }
    }, [selChar, apiConfig, profile, reload, addToast]);

    const toggleVisibility = useCallback(async () => {
        if (!profile || isUser) return;
        const next: CharWalletProfile = { ...profile, visibility: profile.visibility === 'full' ? 'summary' : 'full' };
        await DB.saveWalletProfile(next);
        setProfile(next);
    }, [profile, isUser]);

    const summaryOnly = !isUser && profile?.visibility === 'summary';

    // 流水按日期分组
    const txGroups = useMemo(() => {
        const map = new Map<string, WalletTransaction[]>();
        for (const t of txs) {
            if (!map.has(t.dateStr)) map.set(t.dateStr, []);
            map.get(t.dateStr)!.push(t);
        }
        return [...map.entries()];
    }, [txs]);

    const renderProperty = (p: WalletProperty) => {
        const modeText = p.mode === 'owned' ? '自有' : p.mode === 'renting' ? '租赁' : '还贷中';
        const modeTint = p.mode === 'owned' ? 'bg-emerald-400/15 text-emerald-300' : p.mode === 'renting' ? 'bg-sky-400/15 text-sky-300' : 'bg-amber-400/15 text-amber-300';
        return (
            <div key={p.id} className="rounded-2xl p-4" style={GLASS_CARD}>
                <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-white/10 text-white/80">
                        {p.kind === 'home' ? <House size={18} weight="fill" /> : p.kind === 'car' ? <Car size={18} weight="fill" /> : <Package size={18} weight="fill" />}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-white/95 truncate">{p.name}</div>
                        {p.note && <div className="text-[10px] text-white/40 truncate mt-0.5">{p.note}</div>}
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold shrink-0 ${modeTint}`}>{modeText}</span>
                </div>
                {/* 租约 / 贷款明细行 */}
                {p.mode === 'renting' && (
                    <div className="mt-3 pt-3 border-t border-white/[0.07] grid grid-cols-2 gap-y-1.5 text-[11px]">
                        {p.rentMonthly != null && <div className="text-white/45">月租 <span className="text-white/85 font-bold tabular-nums">{fmt(p.rentMonthly)}</span></div>}
                        {p.rentDueDay != null && <div className="text-white/45">每月 <span className="text-white/85 font-bold tabular-nums">{p.rentDueDay} 号</span> 交租</div>}
                        {p.deposit != null && <div className="text-white/45">押金 <span className="text-white/85 font-bold tabular-nums">{fmt(p.deposit)}</span></div>}
                        {p.leaseEndDate && <div className="text-white/45">租约到 <span className="text-white/85 font-bold tabular-nums">{p.leaseEndDate}</span></div>}
                    </div>
                )}
                {p.mode === 'mortgaged' && (
                    <div className="mt-3 pt-3 border-t border-white/[0.07] grid grid-cols-2 gap-y-1.5 text-[11px]">
                        {p.estimatedValue != null && <div className="text-white/45">估值 <span className="text-white/85 font-bold tabular-nums">{fmt(p.estimatedValue)}</span></div>}
                        {p.loanMonthly != null && <div className="text-white/45">月供 <span className="text-white/85 font-bold tabular-nums">{fmt(p.loanMonthly)}</span></div>}
                        {p.loanRemainingMonths != null && <div className="text-white/45">还剩 <span className="text-white/85 font-bold tabular-nums">{p.loanRemainingMonths} 期</span></div>}
                    </div>
                )}
                {p.mode === 'owned' && p.estimatedValue != null && (
                    <div className="mt-3 pt-3 border-t border-white/[0.07] text-[11px] text-white/45">估值 <span className="text-white/85 font-bold tabular-nums">{fmt(p.estimatedValue)}</span></div>
                )}
            </div>
        );
    };

    return (
        <div className="h-full w-full flex flex-col relative overflow-hidden bg-[#0b1120] text-white font-sans">
            {/* 背景辉光 */}
            <div className="absolute inset-x-0 top-0 h-[45%] pointer-events-none" style={{ background: 'radial-gradient(120% 70% at 50% 0%, rgba(139,92,246,0.16), rgba(56,189,248,0.06) 45%, transparent 72%)' }} />

            {/* Header */}
            <div className="border-b border-white/[0.06] sticky top-0 z-20 shrink-0" style={{ paddingTop: 'var(--chrome-top)' }}>
                <div className="pt-1 pb-3 px-5 flex items-center gap-2.5">
                    <button onClick={closeApp} className="p-2 -ml-2 rounded-full active:scale-90 transition-transform hover:bg-white/10" aria-label="返回">
                        <ArrowLeft size={22} className="text-violet-300" weight="bold" />
                    </button>
                    <div className="flex items-center gap-2">
                        <WalletIcon size={18} className="text-violet-300" weight="fill" />
                        <span className="text-sm font-bold tracking-wide">钱包</span>
                    </div>
                    <div className="ml-auto flex gap-2">
                        {!isUser && profile && (
                            <button onClick={toggleVisibility} className="px-2.5 h-8 flex items-center gap-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 active:scale-90 transition-all" aria-label="浏览范围">
                                {summaryOnly ? <EyeSlash size={13} className="text-white/60" /> : <Eye size={13} className="text-white/60" />}
                                <span className="text-[10px] font-bold text-white/60">{summaryOnly ? '只看摘要' : '全部明细'}</span>
                            </button>
                        )}
                        {!isUser && profile && (
                            <button onClick={() => setConfirmReroll(true)} disabled={generating} className="p-2 rounded-full active:scale-90 transition-transform hover:bg-white/10 disabled:opacity-40" aria-label="重Roll">
                                <ArrowsClockwise size={18} className="text-violet-300" weight="bold" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* 选人条：第一格是"我" */}
            <div className="shrink-0 px-5 pt-3 pb-1 z-10">
                <div className="flex gap-2 overflow-x-auto no-scrollbar py-1 -mx-1 px-1">
                    <button onClick={() => setSelId(WALLET_USER_ID)} className="shrink-0 flex flex-col items-center gap-1 active:scale-95 transition-transform" style={{ width: 52 }}>
                        <div className={`w-11 h-11 rounded-2xl flex items-center justify-center text-sm font-black transition-all ${isUser ? 'scale-105' : 'opacity-55'}`}
                            style={{ background: 'rgba(139,92,246,0.25)', border: isUser ? '2px solid hsl(260,70%,65%)' : '2px solid rgba(255,255,255,0.12)', boxShadow: isUser ? '0 6px 18px hsla(260,70%,55%,0.45)' : 'none' }}>
                            我
                        </div>
                        <span className={`text-[10px] font-semibold ${isUser ? 'opacity-100' : 'opacity-45'}`}>我的</span>
                    </button>
                    {characters.map(c => {
                        const active = c.id === selId;
                        return (
                            <button key={c.id} onClick={() => setSelId(c.id)} className="shrink-0 flex flex-col items-center gap-1 active:scale-95 transition-transform" style={{ width: 52 }}>
                                <div className={`w-11 h-11 rounded-2xl overflow-hidden transition-all ${active ? 'scale-105' : 'opacity-55'}`}
                                    style={{ border: active ? '2px solid hsl(260,70%,65%)' : '2px solid rgba(255,255,255,0.12)', boxShadow: active ? '0 6px 18px hsla(260,70%,55%,0.45)' : 'none' }}>
                                    {c.avatar ? <img src={c.avatar} className="w-full h-full object-cover" alt="" loading="lazy" /> : <div className="w-full h-full bg-white/10 flex items-center justify-center text-sm font-bold">{c.name[0]}</div>}
                                </div>
                                <span className={`text-[10px] truncate max-w-full font-semibold ${active ? 'opacity-100' : 'opacity-45'}`}>{c.name}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Tab */}
            <div className="shrink-0 px-5 pt-2 pb-1 z-10">
                <div className="flex gap-1 p-1 rounded-xl bg-white/[0.05] border border-white/[0.08]">
                    <button onClick={() => setTab('overview')} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${tab === 'overview' ? 'bg-violet-400/20 text-violet-200' : 'text-white/40'}`}>总览</button>
                    <button onClick={() => setTab('txs')} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${tab === 'txs' ? 'bg-violet-400/20 text-violet-200' : 'text-white/40'}`}>流水</button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4 space-y-3 z-10">
                {loading && <div className="text-center text-white/35 text-xs py-16">加载中…</div>}

                {/* 空档案引导（仅角色） */}
                {!loading && !profile && !isUser && (
                    <div className="rounded-3xl p-8 text-center" style={GLASS_CARD}>
                        <Sparkle size={32} className="text-violet-300 mx-auto" weight="fill" />
                        <div className="text-base font-black mt-4">{selChar?.name || 'TA'} 还没有资产档案</div>
                        <div className="text-[11px] text-white/45 mt-2 leading-relaxed">按人设一键生成 ta 的账户、房车、贷款和小物件——<br />穷学生就该只有零钱，社畜大概率背着房租，收支自洽。</div>
                        <button onClick={() => handleGenerate(false)} disabled={generating}
                            className="mt-6 px-6 py-3 rounded-2xl text-sm font-bold bg-violet-500 hover:bg-violet-400 active:scale-95 transition-all disabled:opacity-50 shadow-[0_6px_20px_rgba(139,92,246,0.35)]">
                            {generating ? '生成中…（十几秒）' : '✨ 一键生成资产档案'}
                        </button>
                    </div>
                )}

                {/* 总览 */}
                {!loading && profile && tab === 'overview' && (
                    <>
                        {/* 净资产 hero */}
                        <div className="rounded-3xl p-5" style={GLASS_CARD}>
                            <div className="text-[10px] font-bold tracking-[0.25em] uppercase text-white/40">{isUser ? 'My Pocket' : 'Net Worth'}</div>
                            {isUser ? (
                                <div className="text-3xl font-black tabular-nums mt-1.5">{fmt(profile.accounts.find(a => a.type === 'cash')?.balance || 0)}</div>
                            ) : summaryOnly ? (
                                <div className="text-sm text-white/80 leading-relaxed mt-2 italic">"{profile.intuition || '暂无摘要'}"</div>
                            ) : (
                                <>
                                    <div className={`text-3xl font-black tabular-nums mt-1.5 ${stats && stats.net < 0 ? 'text-rose-300' : ''}`}>{stats ? fmt(stats.net) : '—'}</div>
                                    {stats && (
                                        <div className="flex gap-4 mt-3 text-[11px] tabular-nums">
                                            <span className="text-white/45">流动 <span className="text-white/85 font-bold">{fmt(stats.liquid)}</span></span>
                                            {stats.fixed > 0 && <span className="text-white/45">固定 <span className="text-white/85 font-bold">{fmt(stats.fixed)}</span></span>}
                                            {stats.debt > 0 && <span className="text-white/45">负债 <span className="text-rose-300 font-bold">-{fmt(stats.debt).slice(1)}</span></span>}
                                        </div>
                                    )}
                                    {profile.monthlyIncome != null && profile.monthlyIncome > 0 && (
                                        <div className="mt-3 pt-3 border-t border-white/[0.07] text-[11px] text-white/45">
                                            月收入 <span className="text-white/85 font-bold tabular-nums">{fmt(profile.monthlyIncome)}</span>{profile.incomeNote ? ` · ${profile.incomeNote}` : ''}
                                        </div>
                                    )}
                                </>
                            )}
                            {isUser && <div className="text-[10px] text-white/35 mt-2">聊天里的转账会真实进出这里；余额可以是负的——欠 ta 的也是账。</div>}
                        </div>

                        {/* 账户组 */}
                        {!summaryOnly && !isUser && profile.accounts.length > 0 && (
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/35 px-1 mb-2">账户</div>
                                <div className="space-y-2">
                                    {profile.accounts.map(a => {
                                        const meta = ACCOUNT_META[a.type] || ACCOUNT_META.cash;
                                        return (
                                            <div key={a.id} className="rounded-2xl p-3.5 flex items-center gap-3" style={GLASS_CARD}>
                                                <div className={`w-9 h-9 rounded-xl flex items-center justify-center bg-white/10 ${meta.tint}`}>{meta.icon}</div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-sm font-bold text-white/95 truncate">{a.name}</div>
                                                    <div className="text-[10px] text-white/40 truncate mt-0.5">{meta.label}{a.note ? ` · ${a.note}` : ''}</div>
                                                </div>
                                                <div className="text-right shrink-0">
                                                    <div className={`text-sm font-black tabular-nums ${a.type === 'credit' ? 'text-rose-300' : 'text-white/95'}`}>{a.type === 'credit' ? `-${fmt(a.balance).slice(1)}` : fmt(a.balance)}</div>
                                                    {a.type === 'credit' && a.creditLimit != null && <div className="text-[9px] text-white/35 tabular-nums">额度 {fmt(a.creditLimit)}</div>}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* 房产车辆（租赁/贷款状态展开） */}
                        {!summaryOnly && !isUser && profile.properties.length > 0 && (
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/35 px-1 mb-2">房产 · 车辆</div>
                                <div className="space-y-2">{profile.properties.map(renderProperty)}</div>
                            </div>
                        )}

                        {/* 贷款 */}
                        {!summaryOnly && !isUser && profile.loans.length > 0 && (
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/35 px-1 mb-2">贷款</div>
                                <div className="space-y-2">
                                    {profile.loans.map(l => (
                                        <div key={l.id} className="rounded-2xl p-3.5" style={GLASS_CARD}>
                                            <div className="flex items-center justify-between">
                                                <div className="text-sm font-bold text-white/95">{l.name}</div>
                                                <div className="text-sm font-black tabular-nums text-rose-300">-{fmt(l.principal).slice(1)}</div>
                                            </div>
                                            <div className="text-[10px] text-white/40 mt-1">
                                                每月还 {fmt(l.monthly)}{l.dueDay ? ` · ${l.dueDay} 号扣` : ''}{l.remainingMonths != null ? ` · 还剩 ${l.remainingMonths} 期` : ''}
                                            </div>
                                            {l.note && <div className="text-[10px] text-white/35 mt-1 italic">"{l.note}"</div>}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* 小物件 */}
                        {!summaryOnly && !isUser && profile.valuables.length > 0 && (
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/35 px-1 mb-2">名下小物件</div>
                                <div className="rounded-2xl divide-y divide-white/[0.06]" style={GLASS_CARD}>
                                    {profile.valuables.map(v => (
                                        <div key={v.id} className="px-4 py-3 flex items-center gap-3">
                                            <Package size={15} className="text-white/40 shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-xs font-bold text-white/90 truncate">{v.name}</div>
                                                {v.note && <div className="text-[10px] text-white/35 truncate mt-0.5">{v.note}</div>}
                                            </div>
                                            {v.estimatedValue != null && <span className="text-[11px] tabular-nums text-white/50 shrink-0">{fmt(v.estimatedValue)}</span>}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {!isUser && profile && (
                            <div className="text-[10px] text-white/25 px-1 leading-relaxed">
                                角色对这些只有"直觉概念"（手头宽不宽裕、快到还款日了），不会背出精确数字——跟真人一样。转账被接收时钱会真实进出零钱。
                            </div>
                        )}
                    </>
                )}

                {/* 流水 */}
                {!loading && profile && tab === 'txs' && (
                    txGroups.length === 0 ? (
                        <div className="rounded-3xl p-10 text-center" style={GLASS_CARD}>
                            <Receipt size={28} className="text-white/25 mx-auto" />
                            <div className="text-xs text-white/40 mt-3">还没有流水；聊天里发生转账并被接收后会出现在这里</div>
                        </div>
                    ) : (
                        txGroups.map(([date, list]) => (
                            <div key={date}>
                                <div className="text-[10px] font-bold tabular-nums text-white/35 px-1 mb-1.5">{date}</div>
                                <div className="rounded-2xl divide-y divide-white/[0.06]" style={GLASS_CARD}>
                                    {list.map(t => (
                                        <div key={t.id} className="px-4 py-3 flex items-center gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="text-xs font-bold text-white/90 truncate">{t.note}</div>
                                                <div className="text-[10px] text-white/35 mt-0.5">{new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
                                            </div>
                                            <span className={`text-sm font-black tabular-nums shrink-0 ${t.amount >= 0 ? 'text-emerald-300' : 'text-white/85'}`}>{t.amount >= 0 ? '+' : ''}{fmt(t.amount).replace('¥-', '-¥')}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))
                    )
                )}
            </div>

            {/* 重Roll 确认 */}
            {confirmReroll && (
                <div className="absolute inset-0 z-50 flex items-center justify-center p-8 animate-fade-in">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmReroll(false)} />
                    <div className="relative w-full rounded-3xl p-6" style={{ background: 'rgba(18,22,38,0.92)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(20px)' }}>
                        <div className="text-sm font-black">重新生成 {selChar?.name} 的资产档案？</div>
                        <div className="text-[11px] text-white/45 mt-2 leading-relaxed">会换一套全新的生活状态，旧档案和 ta 的历史流水都会被清掉，不可恢复。</div>
                        <div className="flex gap-2 mt-5">
                            <button onClick={() => setConfirmReroll(false)} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-white/8 border border-white/12 active:scale-95 transition-all">算了</button>
                            <button onClick={() => handleGenerate(true)} disabled={generating} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-violet-500 hover:bg-violet-400 active:scale-95 transition-all disabled:opacity-50">
                                {generating ? '生成中…' : '重Roll'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default WalletApp;
