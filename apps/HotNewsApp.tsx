import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { ArrowLeft, ArrowClockwise, WarningCircle, CaretRight, Rss } from '@phosphor-icons/react';
import type { IconType } from 'react-icons';
import {
    SiSinaweibo, SiZhihu, SiBilibili, SiTiktok, SiBaidu, SiDouban,
    SiJuejin, SiGithub, SiStackoverflow, SiYcombinator, SiXiaohongshu,
} from 'react-icons/si';
import { Capacitor } from '@capacitor/core';
import { DB } from '../utils/db';
import { RealtimeContextManager } from '../utils/realtimeContext';
import { nativeFetch } from '../utils/nativeFetch';
import { getProxyWorkerUrl } from '../utils/proxyWorker';
import type { HotNewsSnapshot, HotNewsItem } from '../types';

const SLOT_WINDOW = ['00:00–04:00', '04:00–08:00', '08:00–12:00', '12:00–16:00', '16:00–20:00', '20:00–24:00'];

// 每张卡片正文最多露出 5 条，剩下的进「全部 N 条」详情页
const MAX_PREVIEW = 5;

// ─── 时段主题：白天浅色磨砂（随时段微调色温），夜间/凌晨切深色 ───
interface Theme {
    night: boolean;
    bg: string;          // 页面底（渐变）
    text: string;        // 主文字
    sub: string;         // 次级文字
    faint: string;       // 更弱的文字（页脚等）
    card: string;        // 磨砂卡片底
    cardBorder: string;  // 卡片 hairline 边
    chrome: string;      // sticky 头部底（带透明度，配 blur）
    divider: string;     // 列表分隔线
    btnBg: string;       // 圆形按钮底
}

const themeForHour = (h: number): Theme => {
    const night = h >= 19 || h < 6;
    if (night) {
        return {
            night,
            bg: 'linear-gradient(165deg, #101218 0%, #14161f 55%, #191c28 100%)',
            text: '#eceef4', sub: 'rgba(236,238,244,0.55)', faint: 'rgba(236,238,244,0.3)',
            card: 'rgba(255,255,255,0.06)', cardBorder: 'rgba(255,255,255,0.09)',
            chrome: 'rgba(16,18,24,0.72)', divider: 'rgba(255,255,255,0.07)',
            btnBg: 'rgba(255,255,255,0.08)',
        };
    }
    // 白天：三段色温。清晨金 / 午间冷白 / 午后暖 / 傍晚橘粉
    const bg =
        h < 9 ? 'linear-gradient(165deg, #fdf7ec 0%, #f9f0de 100%)' :
        h < 14 ? 'linear-gradient(165deg, #f6f8fb 0%, #eef2f8 100%)' :
        h < 17 ? 'linear-gradient(165deg, #fbf7ef 0%, #f5efe2 100%)' :
                 'linear-gradient(165deg, #fbf2ec 0%, #f7e9e4 100%)';
    return {
        night,
        bg,
        text: '#1c1e26', sub: 'rgba(28,30,38,0.55)', faint: 'rgba(28,30,38,0.32)',
        card: 'rgba(255,255,255,0.62)', cardBorder: 'rgba(28,30,38,0.07)',
        chrome: 'rgba(252,250,245,0.7)', divider: 'rgba(28,30,38,0.07)',
        btnBg: 'rgba(255,255,255,0.6)',
    };
};

// ─── 品牌档案：官方源的品牌色 + 图标（react-icons/Simple Icons）───
// 没有现成图标的用品牌色 + 字标兜底；完全不认识的源（自定义 RSS）用名字 hash 出色相。
interface Brand { color: string; Icon?: IconType; abbr?: string }

const BRANDS: Record<string, Brand> = {
    '微博': { color: '#E6162D', Icon: SiSinaweibo },
    '知乎': { color: '#0084FF', Icon: SiZhihu },
    'B站': { color: '#FB7299', Icon: SiBilibili },
    '抖音': { color: '#170B1A', Icon: SiTiktok },
    '百度': { color: '#2932E1', Icon: SiBaidu },
    '豆瓣': { color: '#2D963D', Icon: SiDouban },
    '掘金': { color: '#1E80FF', Icon: SiJuejin },
    'GitHub': { color: '#24292F', Icon: SiGithub },
    'Stack Overflow': { color: '#F58025', Icon: SiStackoverflow },
    'Hacker News': { color: '#FF6600', Icon: SiYcombinator },
    '小红书': { color: '#FF2442', Icon: SiXiaohongshu },
    '虎扑': { color: '#C01E2F', abbr: '虎' },
    '贴吧': { color: '#4B6FE8', abbr: '贴' },
    '36氪': { color: '#3D5AE0', abbr: '氪' },
    '少数派': { color: '#D71A1B', abbr: '派' },
    '吾爱破解': { color: '#3A7BD5', abbr: '吾' },
    'V2EX': { color: '#556075', abbr: 'V2' },
    '今日头条': { color: '#F04142', abbr: '头' },
    '新浪财经': { color: '#E6162D', abbr: '新' },
    '东方财富': { color: '#D0021B', abbr: '东' },
    '雪球': { color: '#0C66FF', abbr: '雪' },
    '财联社': { color: '#D5262C', abbr: '财' },
    '腾讯网': { color: '#2577E3', abbr: '腾' },
    'BBC News World': { color: '#B80000', abbr: 'BBC' },
    'The Verge': { color: '#5200FF', abbr: 'TV' },
    'MIT Technology Review': { color: '#03A87C', abbr: 'MIT' },
    'NHK 日本語': { color: '#0A0A0A', abbr: 'NHK' },
};

// 乘法混淆 hash（做未知源的色相兜底）
const hashStr = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x45d9f3b);
    h ^= h >>> 16;
    return Math.abs(h);
};

const brandFor = (source: string): Brand => {
    if (BRANDS[source]) return BRANDS[source];
    // 模糊命中：源名里含关键词（RSS 标题常带后缀，如 "Hacker News Best"）
    for (const key of Object.keys(BRANDS)) {
        if (source.includes(key) || key.includes(source)) return BRANDS[key];
    }
    const hue = hashStr(source) % 360;
    return { color: `hsl(${hue}, 48%, 46%)`, abbr: source.slice(0, 2) };
};

// 品牌徽标：图标优先，缺图标用字标
const BrandBadge: React.FC<{ source: string; size?: number }> = ({ source, size = 30 }) => {
    const b = brandFor(source);
    const isRssIcon = !b.Icon && !BRANDS[source];
    return (
        <span
            className="shrink-0 rounded-[10px] flex items-center justify-center text-white font-black select-none"
            style={{ width: size, height: size, background: b.color, fontSize: size * 0.34 }}
        >
            {b.Icon
                ? <b.Icon size={size * 0.55} />
                : isRssIcon && (b.abbr || '').length > 1
                    ? <Rss size={size * 0.55} weight="bold" />
                    : b.abbr}
        </span>
    );
};

// ─── 通用小件 ───────────────────────────────────────────────
const TitleLink: React.FC<{ it: HotNewsItem; className?: string; style?: React.CSSProperties }> = ({ it, className, style }) =>
    it.url ? (
        <a href={it.url} target="_blank" rel="noreferrer" className={`${className || ''} active:opacity-50`} style={style}>
            {it.title}
        </a>
    ) : (
        <span className={className} style={style}>{it.title}</span>
    );

// 配图：RSS 源自带 / B站封面回填；挂了（防盗链/404）整块隐藏不占地
const NewsImg: React.FC<{ src: string; className?: string }> = ({ src, className }) => {
    const [dead, setDead] = useState(false);
    if (dead) return null;
    return (
        <img
            src={src}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setDead(true)}
            className={`w-full object-cover rounded-xl ${className || ''}`}
        />
    );
};

// ─── 品牌磨砂卡片（一源一卡）────────────────────────────────
interface CardProps {
    source: string;
    items: HotNewsItem[];
    theme: Theme;
    onMore: () => void;
}

const SourceCard: React.FC<CardProps> = ({ source, items, theme, onMore }) => {
    const b = brandFor(source);
    const shown = items.slice(0, MAX_PREVIEW);
    return (
        <section
            className="rounded-2xl backdrop-blur-xl overflow-hidden"
            style={{ background: theme.card, border: `1px solid ${theme.cardBorder}` }}
        >
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                <BrandBadge source={source} />
                <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-[12.5px] leading-tight truncate" style={{ color: theme.text }}>{source}</h3>
                    <p className="text-[9px] mt-px" style={{ color: theme.faint }}>{items.length} 条更新</p>
                </div>
            </div>
            <div className="px-3 pb-1">
                {shown.map((it, i) => (
                    <div
                        key={i}
                        className="py-2 flex gap-2 items-start"
                        style={i > 0 ? { borderTop: `1px solid ${theme.divider}` } : undefined}
                    >
                        <span className="text-[10px] font-black shrink-0 mt-px w-3.5 text-center" style={{ color: i < 3 ? b.color : theme.faint }}>
                            {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                            {i === 0 && it.image && <NewsImg src={it.image} className="h-24 mb-1.5" />}
                            <TitleLink
                                it={it}
                                className={`block leading-snug break-words ${i === 0 ? 'text-[12px] font-semibold' : 'text-[11.5px]'}`}
                                style={{ color: i === 0 ? theme.text : theme.sub }}
                            />
                        </div>
                    </div>
                ))}
            </div>
            {items.length > MAX_PREVIEW && (
                <button
                    onClick={onMore}
                    className="w-full py-2 flex items-center justify-center gap-0.5 text-[10px] font-bold active:opacity-50 transition-opacity"
                    style={{ borderTop: `1px solid ${theme.divider}`, color: b.color }}
                >
                    全部 {items.length} 条 <CaretRight size={10} weight="bold" />
                </button>
            )}
        </section>
    );
};

// ─── App 主体 ───────────────────────────────────────────────
const HotNewsApp: React.FC = () => {
    const { closeApp, realtimeConfig, addToast, registerBackHandler } = useOS();
    const [snapshot, setSnapshot] = useState<HotNewsSnapshot | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // 详情页：某个源「全部 N 条」的完整列表
    const [detail, setDetail] = useState<{ source: string; items: HotNewsItem[] } | null>(null);
    const detailRef = useRef(detail);
    detailRef.current = detail;

    // 主题只在挂载时按当前小时算一次（App 打开几分钟内跨时段无所谓）
    const [theme] = useState<Theme>(() => themeForHour(new Date().getHours()));

    // Android 手势返回：详情页打开时先关详情页，别一杆子退回桌面
    useEffect(() => {
        const unregister = registerBackHandler(() => {
            if (detailRef.current) {
                setDetail(null);
                return true; // 已消费，不再冒泡到「关 App」
            }
            return false;
        });
        return unregister;
    }, [registerBackHandler]);

    // ─── B站封面回填 ───
    // orz.ai 热榜不给图，但 B站条目 URL 里带 BV 号：
    //   原生端 → CapacitorHttp 直连 B站 API（用户 IP 没风控，worker 的 CF 机房 IP 会被 412）
    //   web 端 → 走 worker /bili/covers 批量接口碰运气
    // 拿到的封面写回快照持久化，下次打开不用重拉。
    const enrichingRef = useRef(false);
    const BV_RE = /bilibili\.com\/video\/(BV[0-9A-Za-z]{5,12})/i;
    const enrichBiliCovers = useCallback(async (snap: HotNewsSnapshot) => {
        if (enrichingRef.current) return;
        const targets: string[] = [];
        for (const it of snap.items) {
            if (it.image || !it.url) continue;
            const bv = it.url.match(BV_RE)?.[1];
            if (bv && !targets.includes(bv)) targets.push(bv);
        }
        if (targets.length === 0) return;
        enrichingRef.current = true;
        try {
            const covers: Record<string, string> = {};
            if (Capacitor.isNativePlatform()) {
                await Promise.all(targets.slice(0, 15).map(async (bv) => {
                    try {
                        const r = await nativeFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, {
                            headers: { 'Referer': 'https://www.bilibili.com/' },
                        });
                        const j = await r.json().catch(() => null);
                        const pic = j?.code === 0 && typeof j?.data?.pic === 'string' ? j.data.pic : '';
                        if (pic) covers[bv] = pic.replace(/^http:/, 'https:');
                    } catch { /* 单个失败不影响其他 */ }
                }));
            } else {
                try {
                    const r = await fetch(`${getProxyWorkerUrl()}/bili/covers?bvids=${targets.slice(0, 25).join(',')}`);
                    const j = await r.json().catch(() => null);
                    Object.assign(covers, (j && j.covers) || {});
                } catch { /* web 端拿不到就算了 */ }
            }
            if (Object.keys(covers).length === 0) return;
            const items = snap.items.map(it => {
                const bv = !it.image && it.url ? it.url.match(BV_RE)?.[1] : undefined;
                return bv && covers[bv] ? { ...it, image: covers[bv] } : it;
            });
            const updated = { ...snap, items };
            setSnapshot(updated);
            try { await DB.saveHotNewsSnapshot(updated); } catch { /* 存不上下次再补 */ }
        } finally {
            enrichingRef.current = false;
        }
    }, []);

    useEffect(() => {
        if (snapshot) enrichBiliCovers(snapshot);
    }, [snapshot, enrichBiliCovers]);

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

    // 手动刷新：走 getSlottedHotNews(force) 强制重拉——跟自动拉取同一条路，
    // 自带「半边失败从最近快照打捞」保护
    const forceRefresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const items = await RealtimeContextManager.getSlottedHotNews(realtimeConfig, true);
            const { id, label } = RealtimeContextManager.getHotNewsSlot();
            let snap = await DB.getHotNewsSnapshot(id);
            if (!snap) snap = await DB.getLatestHotNewsSnapshot();
            setSnapshot(snap);
            if (items.length > 0) {
                addToast(`已刷新 · ${label} ${items.length} 条`, 'success');
            } else {
                addToast('刷新失败，沿用上次结果', 'error');
            }
        } catch (e: any) {
            setError(e?.message || '刷新失败');
        } finally {
            setLoading(false);
        }
    }, [realtimeConfig, addToast]);

    useEffect(() => { load(); }, [load]);

    // 头版头条 = 全局第一条（从卡片流里剔除，不重复出现）
    const headline: HotNewsItem | null = snapshot?.items[0] || null;
    const headlineBrand = headline ? brandFor(headline.source || '热点') : null;

    // 其余按源分组（保持首次出现顺序）
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

    // 疏密节奏：第一张卡整宽打头，其余双栏交错，左右各自向下堆
    const leadGroup = grouped[0] || null;
    const rest = grouped.slice(1);
    const leftCol = rest.filter((_, i) => i % 2 === 0);
    const rightCol = rest.filter((_, i) => i % 2 === 1);

    const renderCard = ({ source, items }: { source: string; items: HotNewsItem[] }) => (
        <SourceCard
            key={source}
            source={source}
            items={items}
            theme={theme}
            onMore={() => setDetail({ source, items })}
        />
    );

    const fetchedTime = snapshot
        ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';

    const roundBtn = (onClick: () => void, disabled: boolean, child: React.ReactNode, title?: string) => (
        <button
            onClick={onClick}
            disabled={disabled}
            title={title}
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center backdrop-blur-xl active:scale-90 transition-transform disabled:opacity-40"
            style={{ background: theme.btnBg, border: `1px solid ${theme.cardBorder}`, color: theme.text }}
        >
            {child}
        </button>
    );

    return (
        <div className="relative h-full w-full flex flex-col overflow-hidden" style={{ background: theme.bg, color: theme.text }}>
            {/* ─── 顶栏（sticky 磨砂）─── */}
            <header
                className="shrink-0 sticky top-0 z-10 backdrop-blur-xl"
                style={{ background: theme.chrome, borderBottom: `1px solid ${theme.cardBorder}`, paddingTop: 'var(--chrome-top)' }}
            >
                <div className="flex items-center px-3 pt-2 pb-2 gap-2">
                    {roundBtn(closeApp, false, <ArrowLeft size={16} weight="bold" />)}
                    <div className="flex-1 text-center min-w-0">
                        <h1 className="text-[17px] font-bold tracking-[0.15em] leading-tight">今日热点</h1>
                        {snapshot && (
                            <p className="text-[9px] mt-px truncate" style={{ color: theme.sub }}>
                                {snapshot.slotLabel}版（{SLOT_WINDOW[snapshot.slot] || ''}）· 更新 {fetchedTime} · {snapshot.items.length} 条
                            </p>
                        )}
                    </div>
                    {roundBtn(forceRefresh, loading,
                        <ArrowClockwise size={16} weight="bold" className={loading ? 'animate-spin' : ''} />,
                        '真·刷新（强制重新拉取本时段）')}
                </div>
            </header>

            <div className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar pb-24">
                {/* ─── 头版头条（大磨砂卡）─── */}
                {headline && headlineBrand && (
                    <section
                        className="mx-3 mt-3 rounded-3xl backdrop-blur-xl overflow-hidden"
                        style={{ background: theme.card, border: `1px solid ${theme.cardBorder}` }}
                    >
                        {headline.image && (
                            <div className="px-3 pt-3"><NewsImg src={headline.image} className="h-40 rounded-2xl" /></div>
                        )}
                        <div className="px-4 pt-3 pb-4">
                            <p className="flex items-center gap-1.5 mb-1.5">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ background: headlineBrand.color }} />
                                <span className="text-[9.5px] font-bold tracking-[0.2em]" style={{ color: headlineBrand.color }}>
                                    头条 · {headline.source || '热点'}
                                </span>
                            </p>
                            <TitleLink it={headline} className="block font-bold text-[19px] leading-snug break-words" style={{ color: theme.text }} />
                            {headline.desc && headline.desc !== headline.title && (
                                <p className="mt-2 text-[11.5px] leading-relaxed break-words" style={{ color: theme.sub }}>
                                    {headline.desc}
                                </p>
                            )}
                        </div>
                    </section>
                )}

                {/* ─── 编者按 ─── */}
                <div
                    className="mx-3 mt-3 rounded-2xl backdrop-blur-xl px-3.5 py-2.5"
                    style={{ background: theme.card, border: `1px solid ${theme.cardBorder}` }}
                >
                    <p className="text-[10.5px] leading-relaxed" style={{ color: theme.sub }}>
                        这只是<b style={{ color: theme.text }}>热点可视化</b>。聊天时角色会知道这些热点，但不一定会主动提；
                        当作背景认知自然存在，偶尔也会主动分享成新闻卡片找你聊。
                        {realtimeConfig.newsEnabled
                            ? '（已开启：角色会真的看到这些）'
                            : '（未开启「实时感知 → 新闻热点」，角色暂时看不到）'}
                    </p>
                </div>

                {/* ─── 状态 ─── */}
                {loading && !snapshot && (
                    <div className="text-center py-16 text-sm tracking-widest" style={{ color: theme.faint }}>正在拉取热点 …</div>
                )}
                {error && !snapshot && (
                    <div
                        className="mx-3 mt-3 rounded-2xl backdrop-blur-xl text-center py-10 px-6 text-sm leading-relaxed"
                        style={{ background: theme.card, border: `1px solid ${theme.cardBorder}`, color: theme.sub }}
                    >
                        <WarningCircle size={32} weight="thin" className="mx-auto mb-3" style={{ color: theme.faint }} />
                        {error}
                    </div>
                )}

                {/* ─── 卡片流：首卡整宽 + 双栏交错，一源一卡，每卡最多露 5 条 ─── */}
                {snapshot && grouped.length > 0 && (
                    <div className="px-3 mt-3 space-y-3">
                        {leadGroup && renderCard(leadGroup)}
                        {rest.length > 0 && (
                            <div className="flex gap-3 items-start">
                                <div className="flex-1 min-w-0 space-y-3">
                                    {leftCol.map(renderCard)}
                                </div>
                                <div className="flex-1 min-w-0 space-y-3">
                                    {rightCol.map(renderCard)}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* ─── 页脚 ─── */}
                {snapshot && (() => {
                    const builtinCount = (snapshot.rssUrls || []).length;
                    const customCount = (snapshot.rssCustom || []).length;
                    const totalRss = builtinCount + customCount;
                    const rssLabel = totalRss > 0 ? ` + RSS 订阅源 ${totalRss} 个${customCount > 0 ? `（含自定义 ${customCount}）` : ''}` : '';
                    return (
                        <div className="mx-3 mt-6">
                            <p className="text-center text-[9px] tracking-wide" style={{ color: theme.faint }}>
                                数据来自 hot_news（orz.ai）多平台热榜{rssLabel}
                            </p>
                            <p className="text-center text-[9px] tracking-wide mt-0.5" style={{ color: theme.faint }}>
                                每天 6 个时段自动更新 · 点右上角可手动真·刷新
                            </p>
                        </div>
                    );
                })()}
            </div>

            {/* ─── 详情页：某个源的完整列表（手势返回只关这层）─── */}
            {detail && (
                <div className="absolute inset-0 z-30 flex flex-col" style={{ background: theme.bg, color: theme.text }}>
                    <div
                        className="shrink-0 backdrop-blur-xl flex items-center px-3 pb-2 gap-2.5"
                        style={{ background: theme.chrome, borderBottom: `1px solid ${theme.cardBorder}`, paddingTop: 'var(--chrome-top)' }}
                    >
                        {roundBtn(() => setDetail(null), false, <ArrowLeft size={16} weight="bold" />)}
                        <BrandBadge source={detail.source} size={32} />
                        <div className="flex-1 min-w-0">
                            <h2 className="text-[15px] font-bold truncate leading-tight">{detail.source}</h2>
                            <p className="text-[9px]" style={{ color: theme.sub }}>{detail.items.length} 条更新</p>
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar px-3 py-3 pb-24">
                        <div
                            className="rounded-2xl backdrop-blur-xl px-3.5"
                            style={{ background: theme.card, border: `1px solid ${theme.cardBorder}` }}
                        >
                            {detail.items.map((it, i) => (
                                <div
                                    key={i}
                                    className="py-2.5 flex gap-2.5 items-start"
                                    style={i > 0 ? { borderTop: `1px solid ${theme.divider}` } : undefined}
                                >
                                    <span
                                        className="text-[11px] font-black shrink-0 w-5 text-right mt-px"
                                        style={{ color: i < 3 ? brandFor(detail.source).color : theme.faint }}
                                    >
                                        {i + 1}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <TitleLink it={it} className="block text-[12.5px] font-semibold leading-snug break-words" style={{ color: theme.text }} />
                                        {it.image && <NewsImg src={it.image} className="h-28 mt-1.5" />}
                                        {it.desc && it.desc !== it.title && (
                                            <p className="text-[11px] mt-1 leading-snug break-words" style={{ color: theme.sub }}>{it.desc}</p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <p className="text-center text-[9px] tracking-widest mt-4" style={{ color: theme.faint }}>— 完 —</p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default HotNewsApp;
