/**
 * 栖居 App —— 资产系统的空间与物品面板（原「智能家居」，AppID 仍为 smart_home）。
 *
 * 世界观包装：假装角色家里装了一个"栖居统计 App"，把房间/物品/补给情况
 * 统计出来并共享给用户看——这解释了"你为什么能看到 ta 家里有几卷纸"。
 *
 *  - 两级导航：角色列表页（每人一张住所卡）→ 点击推入角色住所详情页
 *  - 房间卡网格 → 点开看物品清单（少数物品带保质期钩子，过期/临期高亮）
 *  - 补给（冰箱/日用品）走档位制：充足/还够/快没了/用完了——记类别不数鸡蛋
 *  - 一键生成/重Roll；生成时接入世界书主题触发 + 记忆宫殿 + 最近聊天（见 assetGen）
 *
 * UI：浅色玻璃 + 温和卡片（对齐全站扁平毛玻璃规范；安全区走 --chrome-top）。
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharHomeProfile, HomeRoom, HomeSupplyLevel } from '../types';
import { generateHomeProfile } from '../utils/assetGen';
import {
    ArrowLeft, Lightbulb, ArrowsClockwise, Sparkle, CaretDown, CaretUp, Warning, Timer,
} from '@phosphor-icons/react';

const CARD: React.CSSProperties = {
    background: 'rgba(255,255,255,0.72)',
    border: '1px solid rgba(255,255,255,0.85)',
    boxShadow: '0 1px 3px rgba(15,23,42,0.05)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
};

const LEVEL_META: Record<HomeSupplyLevel, { text: string; cls: string; bar: number }> = {
    plenty: { text: '充足', cls: 'bg-emerald-100 text-emerald-600', bar: 100 },
    ok: { text: '还够', cls: 'bg-sky-100 text-sky-600', bar: 60 },
    low: { text: '快没了', cls: 'bg-amber-100 text-amber-600', bar: 25 },
    out: { text: '用完了', cls: 'bg-rose-100 text-rose-600', bar: 4 },
};

const BAR_COLOR: Record<HomeSupplyLevel, string> = {
    plenty: 'bg-emerald-400', ok: 'bg-sky-400', low: 'bg-amber-400', out: 'bg-rose-400',
};

/** 距今天数：负=已过期 */
const daysUntil = (dateStr: string) => Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);

const SmartHomeApp: React.FC = () => {
    const { closeApp, characters, apiConfig, addToast } = useOS();
    // 两级导航：selId=null → 角色列表页；有值 → 该角色的住所详情页
    const [selId, setSelId] = useState<string | null>(null);
    const [profile, setProfile] = useState<CharHomeProfile | null>(null);
    // 列表页角标用：每个角色是否已接入 + 住所名
    const [homeBriefs, setHomeBriefs] = useState<Record<string, string>>({});
    const [openRoomId, setOpenRoomId] = useState<string | null>(null);
    const [generating, setGenerating] = useState(false);
    const [confirmReroll, setConfirmReroll] = useState(false);
    const [loading, setLoading] = useState(true);

    const selChar = useMemo(() => characters.find(c => c.id === selId) || null, [characters, selId]);

    // 列表页：拉一遍所有角色的住所简讯（只取 homeName，轻量）
    useEffect(() => {
        if (selId) return;
        let cancelled = false;
        (async () => {
            const briefs: Record<string, string> = {};
            for (const c of characters) {
                try {
                    const p = await DB.getHomeProfile(c.id);
                    if (p) briefs[c.id] = p.homeName || '已接入';
                } catch { /* 单个失败不影响列表 */ }
            }
            if (!cancelled) setHomeBriefs(briefs);
        })();
        return () => { cancelled = true; };
    }, [selId, characters]);

    const reload = useCallback(async () => {
        if (!selId) { setLoading(false); return; }
        setLoading(true);
        try {
            setProfile(await DB.getHomeProfile(selId));
        } catch (e) {
            console.error('[栖居] load failed:', e);
        } finally {
            setLoading(false);
        }
    }, [selId]);

    useEffect(() => { reload(); setOpenRoomId(null); setConfirmReroll(false); }, [reload]);

    const handleGenerate = useCallback(async (isReroll: boolean) => {
        if (!selChar) return;
        if (!apiConfig?.apiKey) { addToast('先去系统设置配置 API 才能生成', 'error'); return; }
        setGenerating(true);
        setConfirmReroll(false);
        try {
            // 钱包里有住房 → 喂给生成器保持"租的房"跟"家里的样子"一致
            let walletHint: string | undefined;
            try {
                const wallet = await DB.getWalletProfile(selChar.id);
                const home = wallet?.properties.find(p => p.kind === 'home');
                if (home) walletHint = `${home.name}（${home.mode === 'renting' ? '租的' : home.mode === 'mortgaged' ? '还贷中' : '自有'}）`;
            } catch { /* 钱包没档案就自由发挥 */ }
            const next = await generateHomeProfile(selChar, apiConfig, walletHint, isReroll ? profile : null);
            await DB.saveHomeProfile(next);
            await reload();
            addToast(isReroll ? '已重新生成住所档案' : `${selChar.name}的家已统计完成`, 'success');
        } catch (e) {
            console.error('[SmartHome] generate failed:', e);
            addToast('生成失败了，稍后再试试', 'error');
        } finally {
            setGenerating(false);
        }
    }, [selChar, apiConfig, profile, reload, addToast]);

    // 需要关注的事：过期/临期物品 + 见底补给（放顶部当"今日提醒"）
    const alerts = useMemo(() => {
        if (!profile) return [];
        const out: { icon: React.ReactNode; text: string; tone: 'warn' | 'info' }[] = [];
        for (const room of profile.rooms) {
            for (const item of room.items) {
                if (!item.expiryDate) continue;
                const d = daysUntil(item.expiryDate);
                if (d < 0) out.push({ icon: <Warning size={13} weight="fill" />, text: `${item.name} 已过期 ${Math.abs(d)} 天`, tone: 'warn' });
                else if (d <= 14) out.push({ icon: <Timer size={13} weight="fill" />, text: `${item.name} 还有 ${d} 天到期`, tone: 'info' });
            }
        }
        for (const s of profile.supplies) {
            if (s.level === 'out') out.push({ icon: <Warning size={13} weight="fill" />, text: `${s.name}用完了，该补货了`, tone: 'warn' });
        }
        return out;
    }, [profile]);

    const renderRoom = (room: HomeRoom) => {
        const open = openRoomId === room.id;
        return (
            <div key={room.id} className="rounded-2xl overflow-hidden" style={CARD}>
                <button onClick={() => setOpenRoomId(open ? null : room.id)} className="w-full px-4 py-3.5 flex items-center gap-3 text-left active:scale-[0.995] transition-transform">
                    <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-100 flex items-center justify-center text-lg shrink-0">{room.icon || '🚪'}</div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-700 truncate">{room.name}</div>
                        <div className="text-[10px] text-slate-400 truncate mt-0.5">{room.note || `${room.items.length} 件物品`}</div>
                    </div>
                    <span className="text-[10px] text-slate-400 tabular-nums shrink-0">{room.items.length} 件</span>
                    {open ? <CaretUp size={14} className="text-slate-300 shrink-0" /> : <CaretDown size={14} className="text-slate-300 shrink-0" />}
                </button>
                {open && (
                    <div className="border-t border-slate-100 divide-y divide-slate-50">
                        {room.items.map(item => {
                            const d = item.expiryDate ? daysUntil(item.expiryDate) : null;
                            return (
                                <div key={item.id} className="px-4 py-2.5 flex items-center gap-3">
                                    <span className="text-base shrink-0 w-6 text-center">{item.icon || '·'}</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs font-bold text-slate-600 truncate">{item.name}</div>
                                        {item.note && <div className="text-[10px] text-slate-400 truncate mt-0.5">{item.note}</div>}
                                    </div>
                                    {d != null && (
                                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold shrink-0 ${d < 0 ? 'bg-rose-100 text-rose-500' : d <= 14 ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-400'}`}>
                                            {d < 0 ? `过期 ${Math.abs(d)} 天` : `${item.expiryDate} 到期`}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                        {room.items.length === 0 && <div className="px-4 py-3 text-[11px] text-slate-300">空荡荡的</div>}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="h-full w-full flex flex-col relative overflow-hidden bg-[#f0f5f4] text-slate-700 font-sans">
            {/* 背景辉光 */}
            <div className="absolute inset-x-0 top-0 h-[45%] pointer-events-none" style={{ background: 'radial-gradient(120% 70% at 50% 0%, rgba(255,255,255,0.9), rgba(94,234,212,0.14) 45%, transparent 72%)' }} />

            {/* Header：列表页返回=关App；详情页返回=回列表 */}
            <div className="border-b border-slate-200/60 sticky top-0 z-20 shrink-0 backdrop-blur-sm" style={{ paddingTop: 'var(--chrome-top)' }}>
                <div className="pt-1 pb-3 px-5 flex items-center gap-2.5">
                    <button onClick={() => selId ? setSelId(null) : closeApp()} className="p-2 -ml-2 rounded-full active:scale-90 transition-transform hover:bg-black/5" aria-label="返回">
                        <ArrowLeft size={22} className="text-teal-500" weight="bold" />
                    </button>
                    <div className="flex items-center gap-2">
                        {selId && selChar ? (
                            <>
                                <div className="w-6 h-6 rounded-lg overflow-hidden shrink-0">
                                    {selChar.avatar ? <img src={selChar.avatar} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full bg-slate-200 flex items-center justify-center text-[10px] font-bold">{selChar.name[0]}</div>}
                                </div>
                                <span className="text-sm font-bold tracking-wide">{selChar.name} 的栖居</span>
                            </>
                        ) : (
                            <>
                                <Lightbulb size={18} className="text-teal-500" weight="fill" />
                                <span className="text-sm font-bold tracking-wide">栖居</span>
                            </>
                        )}
                    </div>
                    <div className="ml-auto">
                        {selId && profile && (
                            <button onClick={() => setConfirmReroll(true)} disabled={generating} className="p-2 rounded-full active:scale-90 transition-transform hover:bg-black/5 disabled:opacity-40" aria-label="重Roll">
                                <ArrowsClockwise size={18} className="text-teal-500" weight="bold" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* 角色列表页 */}
            {!selId && (
                <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4 z-10">
                    <div className="text-[10px] text-slate-400 leading-relaxed mb-3 px-1">选一个人，看看 ta 栖身的地方。</div>
                    <div className="grid grid-cols-2 gap-3">
                        {characters.map(c => {
                            const brief = homeBriefs[c.id];
                            return (
                                <button key={c.id} onClick={() => setSelId(c.id)} className="rounded-3xl p-4 text-left active:scale-[0.97] transition-transform" style={CARD}>
                                    <div className="w-12 h-12 rounded-2xl overflow-hidden border-2 border-white shadow-sm">
                                        {c.avatar ? <img src={c.avatar} className="w-full h-full object-cover" alt="" loading="lazy" /> : <div className="w-full h-full bg-slate-200 flex items-center justify-center text-base font-bold">{c.name[0]}</div>}
                                    </div>
                                    <div className="text-sm font-black text-slate-700 truncate mt-3">{c.name}</div>
                                    <div className={`text-[10px] truncate mt-1 ${brief ? 'text-teal-600' : 'text-slate-300'}`}>
                                        {brief ? `🏠 ${brief}` : '还没接入'}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    {characters.length === 0 && <div className="text-center text-slate-300 text-xs py-16">还没有角色</div>}
                </div>
            )}

            {selId && (
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4 space-y-3 z-10">
                {loading && <div className="text-center text-slate-300 text-xs py-16">加载中…</div>}

                {/* 空档案引导 */}
                {!loading && !profile && selChar && (
                    <div className="rounded-3xl p-8 text-center" style={CARD}>
                        <Sparkle size={32} className="text-teal-400 mx-auto" weight="fill" />
                        <div className="text-base font-black mt-4 text-slate-700">{selChar.name} 的家还没接入</div>
                        <div className="text-[11px] text-slate-400 mt-2 leading-relaxed">一键统计 ta 家里的房间、物品和补给情况——<br />冰箱记"还剩多少"不数鸡蛋，只有两三件东西带保质期。</div>
                        <button onClick={() => handleGenerate(false)} disabled={generating}
                            className="mt-6 px-6 py-3 rounded-2xl text-sm font-bold text-white bg-teal-500 hover:bg-teal-400 active:scale-95 transition-all disabled:opacity-50 shadow-[0_6px_20px_rgba(20,184,166,0.35)]">
                            {generating ? '统计中…（十几秒）' : '💡 一键接入 ta 的家'}
                        </button>
                    </div>
                )}

                {!loading && profile && (
                    <>
                        {/* 住所 hero */}
                        <div className="rounded-3xl p-5" style={CARD}>
                            <div className="text-[10px] font-bold tracking-[0.25em] uppercase text-slate-400">{selChar?.name} 的家</div>
                            <div className="text-xl font-black text-slate-700 mt-1">{profile.homeName || '住所'}</div>
                            {profile.homeNote && <div className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">{profile.homeNote}</div>}
                        </div>

                        {/* 今日提醒 */}
                        {alerts.length > 0 && (
                            <div className="rounded-2xl p-4 space-y-2" style={CARD}>
                                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">需要留意</div>
                                {alerts.map((a, i) => (
                                    <div key={i} className={`flex items-center gap-2 text-[11px] font-semibold ${a.tone === 'warn' ? 'text-rose-500' : 'text-amber-600'}`}>
                                        {a.icon}<span>{a.text}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* 补给档位 */}
                        {profile.supplies.length > 0 && (
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400 px-1 mb-2">补给情况</div>
                                <div className="rounded-2xl divide-y divide-slate-50" style={CARD}>
                                    {profile.supplies.map(s => {
                                        const meta = LEVEL_META[s.level];
                                        return (
                                            <div key={s.id} className="px-4 py-3">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-base shrink-0 w-6 text-center">{s.icon || '📦'}</span>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-xs font-bold text-slate-600 truncate">{s.name}</div>
                                                        {s.note && <div className="text-[10px] text-slate-400 truncate mt-0.5">{s.note}</div>}
                                                    </div>
                                                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold shrink-0 ${meta.cls}`}>{meta.text}</span>
                                                </div>
                                                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-2 ml-9">
                                                    <div className={`h-full rounded-full transition-all duration-700 ${BAR_COLOR[s.level]}`} style={{ width: `${meta.bar}%` }} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* 房间 */}
                        {profile.rooms.length > 0 && (
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400 px-1 mb-2">房间</div>
                                <div className="space-y-2">{profile.rooms.map(renderRoom)}</div>
                            </div>
                        )}

                        <div className="text-[10px] text-slate-300 px-1 leading-relaxed">
                            角色对家里只有"直觉概念"（洗衣液快没了、那盒巧克力快过期了），聊天时会自然带出来，不会报库存清单。
                        </div>
                    </>
                )}
            </div>
            )}

            {/* 重Roll 确认 */}
            {confirmReroll && (
                <div className="absolute inset-0 z-50 flex items-center justify-center p-8 animate-fade-in">
                    <div className="absolute inset-0 bg-black/30" onClick={() => setConfirmReroll(false)} />
                    <div className="relative w-full rounded-3xl p-6 bg-white shadow-2xl border border-slate-100">
                        <div className="text-sm font-black text-slate-700">重新统计 {selChar?.name} 的家？</div>
                        <div className="text-[11px] text-slate-400 mt-2 leading-relaxed">会生成一套全新的住所（房间、物品、补给都换），旧档案不可恢复。</div>
                        <div className="flex gap-2 mt-5">
                            <button onClick={() => setConfirmReroll(false)} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-500 active:scale-95 transition-all">算了</button>
                            <button onClick={() => handleGenerate(true)} disabled={generating} className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white bg-teal-500 hover:bg-teal-400 active:scale-95 transition-all disabled:opacity-50">
                                {generating ? '统计中…' : '重Roll'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SmartHomeApp;
