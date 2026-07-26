import React, { useState, useEffect, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { ArrowLeft, ArrowClockwise, WarningCircle } from '@phosphor-icons/react';
import { DB } from '../utils/db';
import { RealtimeContextManager } from '../utils/realtimeContext';
import type { HotNewsSnapshot, HotNewsItem } from '../types';

const SLOT_WINDOW = ['00:00–04:00', '04:00–08:00', '08:00–12:00', '12:00–16:00', '16:00–20:00', '20:00–24:00'];

// ─── 媒体墙视觉常量 ─────────────────────────────────────────
// 构成主义三色：纸白 / 黑墨 / 报纸黄（黄只做点缀）。纯扁平：无阴影无渐变无动画。
const PAGE_BG = '#faf7ef';
const INK = '#141414';
const YELLOW = '#f5d76e';      // LED 字 / 标签字
const YELLOW_PANEL = '#f3e6bd'; // 收音机面板底

// 每个信息源 = 一台媒介设备。官方源按名字 hash 固定映射（微博永远是那台电视）；
// 自定义 RSS 源掺时段盐随机换壳。
type DeviceKind = 'paper' | 'tv' | 'led' | 'fax' | 'radio';
const DEVICES: DeviceKind[] = ['paper', 'tv', 'led', 'fax', 'radio'];

const hashStr = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
    return Math.abs(h);
};

// ─── 通用小件 ───────────────────────────────────────────────
const TitleLink: React.FC<{ it: HotNewsItem; className?: string }> = ({ it, className }) =>
    it.url ? (
        <a href={it.url} target="_blank" rel="noreferrer" className={`${className || ''} active:opacity-50`}>
            {it.title}
        </a>
    ) : (
        <span className={className}>{it.title}</span>
    );

// ─── 设备外壳 1：报纸版面 ───────────────────────────────────
const PaperDevice: React.FC<{ source: string; items: HotNewsItem[]; edition: number }> = ({ source, items, edition }) => (
    <section className="border-2 bg-white" style={{ borderColor: INK }}>
        <div className="flex items-end justify-between px-3 pt-2.5 pb-1.5 border-b-2" style={{ borderColor: INK }}>
            <h3 className="font-serif font-black text-base tracking-wider break-words">{source}</h3>
            <span className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 shrink-0 ml-2">第{edition}版 · PRESS</span>
        </div>
        <div className="px-3 py-2.5">
            {items[0] && (
                <div className={items.length > 1 ? 'pb-2 mb-2 border-b border-neutral-300' : ''}>
                    <TitleLink it={items[0]} className="font-serif font-black text-[15px] leading-snug break-words" />
                    {items[0].desc && items[0].desc !== items[0].title && (
                        <p className="text-[11px] text-neutral-500 leading-snug mt-1 font-serif break-words">{items[0].desc}</p>
                    )}
                </div>
            )}
            {items.length > 1 && (
                <div style={{ columns: 2, columnGap: '14px', columnRule: '1px solid #d8d2c0' }}>
                    {items.slice(1).map((it, i) => (
                        <div key={i} className="break-inside-avoid mb-2 flex gap-1.5 items-start">
                            <span className="font-serif font-black text-[11px] shrink-0 mt-px">{String(i + 2).padStart(2, '0')}</span>
                            <TitleLink it={it} className="font-serif text-[12px] leading-snug break-words text-neutral-800 min-w-0" />
                        </div>
                    ))}
                </div>
            )}
        </div>
    </section>
);

// ─── 设备外壳 2：电视机 ─────────────────────────────────────
const TvDevice: React.FC<{ source: string; items: HotNewsItem[] }> = ({ source, items }) => {
    const ch = (hashStr(source) % 89) + 10;
    return (
        <section className="rounded-[14px] p-2.5 pb-3" style={{ background: INK }}>
            <div className="flex items-center justify-between px-1 pb-2 gap-2">
                <span className="font-mono text-[10px] font-bold tracking-widest shrink-0" style={{ color: YELLOW }}>CH-{ch}</span>
                <span className="text-white font-bold text-xs tracking-[0.25em] truncate">{source}</span>
                <span className="flex gap-1.5 items-center shrink-0">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white/80" />
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40" />
                </span>
            </div>
            <div className="bg-white rounded-[8px] px-3 py-1">
                <ol className="divide-y divide-neutral-200">
                    {items.map((it, i) => (
                        <li key={i} className="py-2 flex gap-2 items-start">
                            <span className="text-white text-[10px] font-black min-w-[18px] text-center py-px shrink-0" style={{ background: INK }}>{i + 1}</span>
                            <TitleLink it={it} className="text-[12.5px] font-bold leading-snug break-words min-w-0" />
                        </li>
                    ))}
                </ol>
            </div>
        </section>
    );
};

// ─── 设备外壳 3：LED 点阵屏 ─────────────────────────────────
const LedDevice: React.FC<{ source: string; items: HotNewsItem[] }> = ({ source, items }) => (
    <section className="border-2" style={{ background: INK, borderColor: INK }}>
        <div className="flex justify-between items-center px-3 py-1.5 border-b border-neutral-700 gap-2">
            <span className="font-mono text-[10px] font-bold tracking-[0.3em] truncate" style={{ color: YELLOW }}>{source}</span>
            <span className="font-mono text-[8px] text-neutral-500 tracking-[0.2em] shrink-0">LED·INFO·BOARD</span>
        </div>
        <ol className="px-3 py-2.5 space-y-2" style={{ color: YELLOW }}>
            {items.map((it, i) => (
                <li key={i} className="flex gap-2 items-start font-mono">
                    <span className="text-[11px] shrink-0">▸</span>
                    <TitleLink it={it} className="text-[12px] leading-snug break-words min-w-0" />
                </li>
            ))}
        </ol>
    </section>
);

// ─── 设备外壳 4：传真纸 ─────────────────────────────────────
const FaxDevice: React.FC<{ source: string; items: HotNewsItem[] }> = ({ source, items }) => {
    const holes: React.CSSProperties = {
        backgroundImage: 'radial-gradient(circle, #e8e1cc 2.5px, transparent 3px)',
        backgroundSize: '16px 14px',
        backgroundPosition: 'center 7px',
    };
    return (
        <section className="relative bg-white border-2 overflow-hidden" style={{ borderColor: INK }}>
            <div className="absolute inset-y-0 left-0 w-4 border-r border-dashed border-neutral-300" style={holes} />
            <div className="absolute inset-y-0 right-0 w-4 border-l border-dashed border-neutral-300" style={holes} />
            <div className="mx-5 py-2.5 px-1.5 font-mono">
                <div className="flex justify-between items-center border-b border-dashed border-neutral-400 pb-1.5 mb-2 gap-2">
                    <span className="text-[10px] font-bold tracking-widest truncate">FROM: {source}</span>
                    <span className="text-[9px] -rotate-3 border-2 px-1 font-black tracking-widest shrink-0" style={{ borderColor: INK }}>已收讫</span>
                </div>
                <ol className="space-y-1.5">
                    {items.map((it, i) => (
                        <li key={i} className="flex gap-1.5 text-[12px] items-start">
                            <span className="shrink-0 text-neutral-400">{String(i + 1).padStart(2, '0')}.</span>
                            <TitleLink it={it} className="leading-snug break-words text-neutral-900 min-w-0" />
                        </li>
                    ))}
                </ol>
                <p className="text-right text-[8px] text-neutral-400 tracking-widest mt-2">— END OF FAX · P.01/01 —</p>
            </div>
        </section>
    );
};

// ─── 设备外壳 5：收音机 ─────────────────────────────────────
const RadioDevice: React.FC<{ source: string; items: HotNewsItem[] }> = ({ source, items }) => {
    const h = hashStr(source);
    const freq = (88 + (h % 200) / 10).toFixed(1);
    const needle = 15 + (h % 70);
    return (
        <section className="border-2" style={{ borderColor: INK, background: YELLOW_PANEL }}>
            {/* 频率刻度尺 */}
            <div className="relative h-7 border-b-2 overflow-hidden" style={{ borderColor: INK }}>
                <div
                    className="absolute bottom-0 left-0 right-0 h-2"
                    style={{ backgroundImage: `repeating-linear-gradient(90deg, ${INK} 0 1px, transparent 1px 8px)` }}
                />
                <span className="absolute left-2 top-1 text-[9px] font-mono font-bold">FM {freq}</span>
                <span className="absolute top-0 bottom-0 w-[3px]" style={{ left: `${needle}%`, background: INK }} />
                <span className="absolute right-2 top-1 text-[9px] font-mono tracking-widest text-neutral-600">RADIO</span>
            </div>
            <div className="flex">
                {/* 喇叭格栅 */}
                <div
                    className="w-9 shrink-0 border-r-2"
                    style={{
                        borderColor: INK,
                        backgroundImage: `radial-gradient(circle, ${INK} 1.5px, transparent 2px)`,
                        backgroundSize: '9px 9px',
                        backgroundPosition: '4px 4px',
                    }}
                />
                <div className="flex-1 min-w-0 bg-white/70">
                    <div className="px-3 pt-2 pb-1 border-b border-black/15">
                        <span className="font-black text-xs tracking-[0.3em] break-words">{source}</span>
                    </div>
                    <ol className="px-3 py-1 divide-y divide-black/10">
                        {items.map((it, i) => (
                            <li key={i} className="py-1.5 flex gap-2 items-start">
                                <span className="shrink-0 w-[18px] h-[18px] rounded-full border-2 text-[9px] font-black flex items-center justify-center mt-px" style={{ borderColor: INK }}>{i + 1}</span>
                                <TitleLink it={it} className="text-[12px] font-bold leading-snug break-words min-w-0" />
                            </li>
                        ))}
                    </ol>
                </div>
            </div>
        </section>
    );
};

// ─── App 主体 ───────────────────────────────────────────────
const HotNewsApp: React.FC = () => {
    const { closeApp, realtimeConfig, addToast } = useOS();
    const [snapshot, setSnapshot] = useState<HotNewsSnapshot | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            await RealtimeContextManager.getSlottedHotNews(realtimeConfig);
            const { id } = RealtimeContextManager.getHotNewsSlot();
            let snap = await DB.getHotNewsSnapshot(id);
            if (!snap) snap = await DB.getLatestHotNewsSnapshot();
            setSnapshot(snap);
            if (!snap) setError('暂时拉不到热点（可能是网络 / 浏览器 CORS 限制）。换到安卓端、或稍后再试。');
        } catch (e: any) {
            setError(e?.message || '加载失败');
        } finally {
            setLoading(false);
        }
    }, [realtimeConfig]);

    // 手动刷新：无视时段去重，强制重拉当前时段（orz.ai 热榜 + RSS 并发）
    const forceRefresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const { id, date, slot, label } = RealtimeContextManager.getHotNewsSlot();
            const platforms = (realtimeConfig.newsPlatforms && realtimeConfig.newsPlatforms.length > 0)
                ? realtimeConfig.newsPlatforms
                : RealtimeContextManager.DEFAULT_HOTNEWS_PLATFORMS;
            const rssUrls = Array.isArray(realtimeConfig.rssUrls) ? realtimeConfig.rssUrls.filter(u => typeof u === 'string' && u.trim()) : [];
            const rssCustom = Array.isArray(realtimeConfig.rssCustom)
                ? realtimeConfig.rssCustom.filter(c => c && c.url && c.name && c.enabled !== false)
                : [];
            const hasRss = rssUrls.length > 0 || rssCustom.length > 0;

            const [hotItems, rssItems] = await Promise.all([
                RealtimeContextManager.fetchHotNews(platforms),
                hasRss
                    ? RealtimeContextManager.fetchRssNews(rssUrls, rssCustom).catch(() => [] as any[])
                    : Promise.resolve([] as any[]),
            ]);
            // 跟 getSlottedHotNews 一样的混合策略：每 5 条插 1 条 RSS
            const merged: any[] = [];
            let rssIdx = 0;
            for (let i = 0; i < hotItems.length; i++) {
                merged.push(hotItems[i]);
                if (rssIdx < rssItems.length && (i + 1) % 5 === 0) merged.push(rssItems[rssIdx++]);
            }
            while (rssIdx < rssItems.length) merged.push(rssItems[rssIdx++]);

            if (merged.length > 0) {
                const fresh: HotNewsSnapshot = { id, date, slot, slotLabel: label, items: merged, platforms, rssUrls, rssCustom, fetchedAt: Date.now() };
                await DB.saveHotNewsSnapshot(fresh);
                setSnapshot(fresh);
                addToast(`已刷新 · ${label} ${merged.length} 条（RSS ${rssItems.length}）`, 'success');
            } else {
                const latest = await DB.getLatestHotNewsSnapshot();
                setSnapshot(latest);
                addToast('刷新失败，沿用上次结果', 'error');
            }
        } catch (e: any) {
            setError(e?.message || '刷新失败');
        } finally {
            setLoading(false);
        }
    }, [realtimeConfig, addToast]);

    useEffect(() => { load(); }, [load]);

    // 头版头条 = 全局第一条（从设备流里剔除，不重复出现）
    const headline: HotNewsItem | null = snapshot?.items[0] || null;

    // 其余按平台分组（保持首次出现顺序）
    const grouped: { source: string; items: HotNewsItem[] }[] = [];
    if (snapshot) {
        const map = new Map<string, HotNewsItem[]>();
        for (const it of snapshot.items.slice(1)) {
            const key = it.source || '热点';
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(it);
        }
        for (const [source, items] of map) grouped.push({ source, items });
    }

    // 设备分配：官方源固定 hash；自定义 RSS 源掺时段 id 当盐 → 每个时段随机换壳
    const customNames = new Set((snapshot?.rssCustom || []).map(c => c.name));
    const deviceFor = (source: string): DeviceKind => {
        const salt = customNames.has(source) ? (snapshot?.id || '') : '';
        return DEVICES[hashStr(source + salt) % DEVICES.length];
    };

    const fetchedTime = snapshot
        ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';

    return (
        <div className="h-full w-full flex flex-col overflow-hidden" style={{ background: PAGE_BG, color: INK }}>
            {/* ─── 报头（sticky）─── */}
            <header className="shrink-0 sticky top-0 z-10 border-b-[3px]" style={{ background: PAGE_BG, borderColor: INK, paddingTop: 'var(--chrome-top)' }}>
                <div className="flex items-center px-3 pt-2 pb-1.5 gap-2">
                    <button
                        onClick={closeApp}
                        className="w-8 h-8 shrink-0 border-2 flex items-center justify-center active:bg-black active:text-white transition-colors"
                        style={{ borderColor: INK }}
                    >
                        <ArrowLeft size={16} weight="bold" />
                    </button>
                    <div className="flex-1 text-center min-w-0">
                        <p className="text-[8px] tracking-[0.35em] font-bold uppercase text-neutral-500">Sullyos Daily · Media Wall</p>
                        <h1 className="text-xl font-black font-serif tracking-[0.3em] leading-tight">今日热点</h1>
                    </div>
                    <button
                        onClick={forceRefresh}
                        disabled={loading}
                        className="w-8 h-8 shrink-0 border-2 flex items-center justify-center active:bg-black active:text-white transition-colors disabled:opacity-40"
                        style={{ borderColor: INK }}
                        title="真·刷新（强制重新拉取本时段）"
                    >
                        <ArrowClockwise size={16} weight="bold" className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
                {snapshot && (
                    <div className="mx-3 mb-1.5 border-t pt-1 flex justify-center flex-wrap gap-x-2 text-[9px] font-bold tracking-wider text-neutral-600" style={{ borderColor: INK }}>
                        <span>{snapshot.date}</span>
                        <span>·</span>
                        <span>{snapshot.slotLabel}版 第{snapshot.slot + 1}刊（{SLOT_WINDOW[snapshot.slot] || ''}）</span>
                        <span>·</span>
                        <span>更新 {fetchedTime}</span>
                        <span>·</span>
                        <span>共 {snapshot.items.length} 条</span>
                    </div>
                )}
            </header>

            <div className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar pb-24">
                {/* ─── 头版头条 ─── */}
                {headline && (
                    <section className="relative border-b-[3px] overflow-hidden pt-5 pb-4 pl-3 pr-10" style={{ borderColor: INK }}>
                        <span
                            aria-hidden
                            className="absolute -right-2 -top-5 font-black leading-none select-none pointer-events-none"
                            style={{ fontSize: '7.5rem', color: 'transparent', WebkitTextStroke: '2px rgba(20,20,20,0.13)' }}
                        >01</span>
                        <span className="absolute right-2 bottom-3 text-[8px] tracking-[0.3em] text-neutral-400 font-bold" style={{ writingMode: 'vertical-rl' }}>
                            SULLYOS DAILY
                        </span>
                        <p className="flex items-center gap-2 mb-2 relative">
                            <span className="px-1.5 py-0.5 text-[9px] font-black tracking-[0.25em]" style={{ background: INK, color: YELLOW }}>头版头条</span>
                            <span className="text-[9px] font-bold tracking-widest text-neutral-500">{headline.source || '热点'}</span>
                        </p>
                        <TitleLink it={headline} className="relative font-serif font-black text-[22px] leading-snug break-words block" />
                        {headline.desc && headline.desc !== headline.title && (
                            <p className="relative mt-2 text-[11px] leading-relaxed text-neutral-600 font-serif border-l-[3px] pl-2 break-words" style={{ borderColor: YELLOW }}>
                                {headline.desc}
                            </p>
                        )}
                    </section>
                )}

                {/* ─── 编者按（可视化声明）─── */}
                <div className="mx-3 my-3 flex border-2 bg-white" style={{ borderColor: INK }}>
                    <span className="shrink-0 text-[10px] font-black tracking-[0.2em] px-1 py-2 flex items-center justify-center" style={{ background: INK, color: YELLOW, writingMode: 'vertical-rl' }}>
                        编者按
                    </span>
                    <p className="px-2.5 py-2 text-[10.5px] leading-relaxed text-neutral-700 font-serif">
                        这只是<b>热点可视化</b>。聊天时角色会知道<b>这些热点</b>，但不一定会主动提。
                        当作背景认知自然存在；偶尔也会主动<b>分享成新闻卡片</b>找你聊。
                        {realtimeConfig.newsEnabled
                            ? '（已开启：角色会真的看到这些）'
                            : '（未开启「实时感知 → 新闻热点」，角色暂时看不到，去设置打开后才会聊）'}
                    </p>
                </div>

                {/* ─── 状态 ─── */}
                {loading && !snapshot && (
                    <div className="text-center text-neutral-400 py-16 text-sm font-mono tracking-widest">— 正在接收电波 —</div>
                )}
                {error && !snapshot && (
                    <div className="mx-3 border-2 text-center text-neutral-600 py-10 px-6 text-sm leading-relaxed bg-white" style={{ borderColor: INK }}>
                        <WarningCircle size={32} weight="thin" className="mx-auto mb-3 text-neutral-400" />
                        {error}
                    </div>
                )}

                {/* ─── 媒体墙：一个源一台设备 ─── */}
                {snapshot && grouped.length > 0 && (
                    <div className="px-3 space-y-3">
                        {grouped.map(({ source, items }, gi) => {
                            const kind = deviceFor(source);
                            if (kind === 'tv') return <TvDevice key={source} source={source} items={items} />;
                            if (kind === 'led') return <LedDevice key={source} source={source} items={items} />;
                            if (kind === 'fax') return <FaxDevice key={source} source={source} items={items} />;
                            if (kind === 'radio') return <RadioDevice key={source} source={source} items={items} />;
                            return <PaperDevice key={source} source={source} items={items} edition={gi + 2} />;
                        })}
                    </div>
                )}

                {/* ─── 版权页脚 ─── */}
                {snapshot && (() => {
                    const builtinCount = (snapshot.rssUrls || []).length;
                    const customCount = (snapshot.rssCustom || []).length;
                    const totalRss = builtinCount + customCount;
                    const rssLabel = totalRss > 0 ? ` + RSS 订阅源 ${totalRss} 个${customCount > 0 ? `（含自定义 ${customCount}）` : ''}` : '';
                    return (
                        <div className="mx-3 mt-5 border-t-4 border-double pt-2" style={{ borderColor: INK }}>
                            <p className="text-center text-[9px] text-neutral-500 tracking-wide font-mono">
                                数据来自 hot_news（orz.ai）多平台热榜{rssLabel}
                            </p>
                            <p className="text-center text-[9px] text-neutral-400 tracking-wide font-mono mt-0.5">
                                每天 6 个时段自动更新 · 点报头右上角可手动真·刷新
                            </p>
                        </div>
                    );
                })()}
            </div>
        </div>
    );
};

export default HotNewsApp;
