import React, { useEffect, useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Icons, INSTALLED_APPS } from '../../constants';
import { AppID, CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import AppIcon from './AppIcon';
import { getMobileGameArt } from './mobilegameArt';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../../utils/devDebug';

// ===== 手游主题（mobilegame skin）=====
// 风格：梦幻粉紫二次元手游首页（照搬参考图）。浅粉紫底 + 深紫文字 + 粉色强调，
// 圆润可爱字体、满屏星芒 ✦、时钟 Hero 卡内嵌天空渐变 + 角色立绘贴纸。
// 背景透出用户自设壁纸（默认铺梦幻粉紫渐变壁纸）。
// 等级 / 经验 / 货币为按角色 id 稳定派生的装饰数值。

// —— 调色板（梦幻粉紫）——
const PAL = {
    ink: '#6b5b95',     // 主文字 · 深紫
    grape: '#7a6db0',   // 标题紫
    lilac: '#a99bd4',   // 次文字 · 浅紫
    pink: '#f4a6cc',    // 粉
    hot: '#ea76b4',     // 强调粉（+ / NEW / 高光）
    peri: '#a8b8e8',    // 蓝紫
    mist: '#efe9f9',    // 极浅紫
    cloud: '#faf6ff',   // 近白紫
};

// 白色磨砂粉紫卡（气泡黏土鼓润边：外柔影 + 底内阴影 + 顶内高光）
const CARD = {
    background: 'linear-gradient(150deg, rgba(255,255,255,0.78), rgba(238,231,249,0.56))',
    boxShadow: '0 9px 22px rgba(150,120,200,0.2), inset 0 -4px 8px rgba(180,150,214,0.18), inset 0 4px 6px rgba(255,255,255,0.95)',
    backdropFilter: 'blur(14px) saturate(1.1)',
    WebkitBackdropFilter: 'blur(14px) saturate(1.1)',
} as React.CSSProperties;

// 气泡黏土瓷砖（快捷入口图标底）—— 充气鼓润感
const CLAY = {
    background: 'linear-gradient(160deg, #ffffff 0%, #efe7f9 100%)',
    boxShadow: '0 10px 20px rgba(150,120,200,0.28), inset 0 -5px 9px rgba(182,152,216,0.34), inset 0 5px 7px rgba(255,255,255,0.98)',
} as React.CSSProperties;

const FONT_DISPLAY = `'DM Serif Display', serif`;     // 大时钟 / Lv / 日期数字
const FONT_CN = `'ZCOOL KuaiLe', 'Noto Sans SC', sans-serif`; // 中文圆润可爱
const FONT_SCRIPT = `'Caveat', cursive`;              // 问候手写

const hashStr = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
};

const QUICK_ENTRIES: { id: AppID; cn: string }[] = [
    { id: AppID.Character, cn: '神经链接' },
    { id: AppID.MemoryPalace, cn: '记忆宫殿' },
    { id: AppID.Call, cn: '电话' },
    { id: AppID.Room, cn: '小小窝' },
];

const GRID_CARDS: { id: AppID; cn: string; en: string }[] = [
    { id: AppID.CheckPhone, cn: '查手机', en: 'PHONE' },
    { id: AppID.Date, cn: '见面', en: 'CONTACTS' },
    { id: AppID.User, cn: '档案', en: 'ARCHIVES' },
    { id: AppID.Bank, cn: '存钱罐', en: 'PIGGYBANK' },
    { id: AppID.Schedule, cn: '日程', en: 'SCHEDULE' },
    { id: AppID.Settings, cn: '设置', en: 'SETTINGS' },
];

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

const renderGlyph = (iconKey: string, className: string) => {
    const Comp = Icons[iconKey] || Icons.Settings;
    return <Comp className={className} />;
};

// 有手游插画就用插画（自带配色），否则回退到 Phosphor 线性图标
const renderAppArt = (id: AppID): React.ReactNode =>
    getMobileGameArt(id) || renderGlyph(INSTALLED_APPS.find(a => a.id === id)?.icon || 'Settings', 'w-full h-full');

// 星芒 ✦ 装饰：按 [x%, y%, 字号px, 颜色, 透明度] 散落
type Sp = [number, number, number, string, number];
const Sparkles: React.FC<{ items: Sp[] }> = ({ items }) => (
    <>
        {items.map(([x, y, s, c, o], i) => (
            <span key={i} className="absolute pointer-events-none select-none leading-none"
                style={{ left: `${x}%`, top: `${y}%`, fontSize: s, color: c, opacity: o, transform: 'translate(-50%,-50%)' }}>✦</span>
        ))}
    </>
);

// 四角星芒 SVG（冒号 / 罗盘用）
const StarBurst: React.FC<{ className?: string; fill?: string }> = ({ className, fill = '#fff' }) => (
    <svg viewBox="0 0 24 24" className={className}>
        <path d="M12 1 L13.8 10.2 L23 12 L13.8 13.8 L12 23 L10.2 13.8 L1 12 L10.2 10.2 Z" fill={fill} />
    </svg>
);

// 居中分节标题（两侧发丝线 + 星芒）
const SectionLabel: React.FC<{ cn: string; en: string }> = ({ cn, en }) => (
    <div className="flex items-center gap-2.5 mt-7 mb-4">
        <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, transparent, ${PAL.lilac})`, opacity: 0.5 }} />
        <span className="text-[10px]" style={{ color: PAL.pink }}>✦</span>
        <div className="text-center leading-tight">
            <div className="text-[16px]" style={{ fontFamily: FONT_CN, color: PAL.grape, letterSpacing: '0.06em' }}>{cn}</div>
            <div className="text-[8px] font-bold mt-0.5" style={{ color: PAL.lilac, letterSpacing: '0.34em' }}>{en}</div>
        </div>
        <span className="text-[10px]" style={{ color: PAL.pink }}>✦</span>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, ${PAL.lilac}, transparent)`, opacity: 0.5 }} />
    </div>
);

const MobileGameHome: React.FC = () => {
    const { openApp, characters, activeCharacterId, virtualTime, unreadMessages, isDataLoaded, lastMsgTimestamp } = useOS();

    const [widgetChar, setWidgetChar] = useState<CharacterProfile | null>(null);
    const [lastMessage, setLastMessage] = useState<string>('');
    const [drawerOpen, setDrawerOpen] = useState(false);

    const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
    useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

    useEffect(() => {
        if (!isDataLoaded) return;
        if (!characters || characters.length === 0) {
            setWidgetChar(null);
            setLastMessage('');
            return;
        }
        const target = characters.find(c => c.id === activeCharacterId) || characters[0];
        setWidgetChar(target);
        DB.getMessagesByCharId(target.id).then(msgs => {
            const visible = msgs.filter(m => m.role !== 'system');
            if (visible.length > 0) {
                const last = visible[visible.length - 1];
                const clean = last.content.replace(/\[.*?\]/g, '').trim();
                setLastMessage(clean || (last.type === 'image' ? '[图片]' : '[消息]'));
            } else {
                setLastMessage(target.description || '');
            }
        }).catch(() => {});
    }, [activeCharacterId, lastMsgTimestamp, isDataLoaded, characters]);

    const totalUnread = useMemo(
        () => Object.values(unreadMessages).reduce((a, b) => a + b, 0),
        [unreadMessages]
    );

    const stats = useMemo(() => {
        const seed = hashStr(widgetChar?.id || 'sullyos');
        const level = 1 + (seed % 60);
        const expMax = 1200 + level * 200;
        const exp = 800 + ((seed >> 3) % (expMax - 800));
        const gems = 500 + ((seed >> 5) % 9000);
        const stars = 20 + ((seed >> 7) % 480);
        return { level, exp, expMax, gems, stars };
    }, [widgetChar?.id]);

    const greeting = virtualTime.hours < 5 ? 'Good Night'
        : virtualTime.hours < 12 ? 'Good Morning'
        : virtualTime.hours < 18 ? 'Good Afternoon'
        : 'Good Evening';
    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');
    const now = new Date();
    const dayName = DAYS[now.getDay()];
    const monthName = MONTHS[now.getMonth()];
    const dateNum = now.getDate();

    const charName = widgetChar?.name || 'SullyOS';
    const tagline = (widgetChar?.description || '不知名种草姬').slice(0, 36);
    const announcement = lastMessage || widgetChar?.description || '一切如常，等待新的故事发生。';
    const expPct = Math.min(100, Math.round((stats.exp / stats.expMax) * 100));

    const drawerApps = useMemo(
        () => INSTALLED_APPS.filter(a => a.id !== AppID.CharCreatorDev || devDebugVisible),
        [devDebugVisible]
    );

    // 货币大卡
    const CoinCard: React.FC<{ icon: React.ReactNode; value: string }> = ({ icon, value }) => (
        <div className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-2xl w-[118px]" style={CARD}>
            {icon}
            <span className="flex-1 text-right text-[14px] font-extrabold tabular-nums" style={{ color: PAL.ink }}>{value}</span>
            <span className="w-[20px] h-[20px] rounded-full flex items-center justify-center text-[14px] font-bold leading-none shrink-0"
                style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, color: '#fff', boxShadow: '0 2px 6px rgba(234,118,180,0.45)' }}>+</span>
        </div>
    );

    return (
        <div className="h-full w-full relative z-10 overflow-hidden select-none" style={{ color: PAL.ink, fontFamily: FONT_CN }}>
            {/* 极淡叠层：顶部提亮 + 底部微沉，让壁纸透出 */}
            <div className="absolute inset-0 pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 20%, rgba(255,255,255,0) 80%, rgba(180,150,220,0.16) 100%)' }} />

            <div className="relative h-full overflow-y-auto no-scrollbar px-5"
                style={{ paddingTop: 'calc(var(--safe-top, 0px) + 0.75rem)', paddingBottom: '7.5rem' }}>

                {/* ===== 报头 Masthead ===== */}
                <div className="flex items-center justify-between animate-fade-in">
                    <div className="flex items-center gap-2">
                        <span className="text-[11px]" style={{ color: PAL.pink }}>✦</span>
                        <span className="text-[11px] font-bold" style={{ color: PAL.grape, letterSpacing: '0.3em' }}>SULLYOS&nbsp;STATION</span>
                        <span className="text-[9px]" style={{ color: PAL.peri }}>✦</span>
                    </div>
                    <button onClick={() => openApp(AppID.Appearance)} aria-label="菜单" className="flex flex-col items-end gap-[3.5px] py-2 active:opacity-60 transition-opacity">
                        <span className="w-5 h-[2px] rounded-full" style={{ background: PAL.grape }} />
                        <span className="w-5 h-[2px] rounded-full" style={{ background: PAL.grape }} />
                        <span className="w-5 h-[2px] rounded-full" style={{ background: PAL.grape }} />
                    </button>
                </div>
                <div className="h-px mt-2" style={{ background: `linear-gradient(90deg, ${PAL.lilac}, transparent)`, opacity: 0.5 }} />

                {/* ===== 角色档案 Profile ===== */}
                <div className="flex items-center gap-3.5 mt-4 animate-fade-in">
                    <div className="relative shrink-0" onClick={() => openApp(AppID.Character)}>
                        <Sparkles items={[[2, 8, 12, '#fff', 0.95], [96, 22, 10, PAL.pink, 0.9], [6, 92, 9, PAL.peri, 0.85], [92, 88, 11, '#fff', 0.9]]} />
                        <div className="w-[68px] h-[68px] rounded-full p-[2.5px] cursor-pointer active:scale-95 transition-transform"
                            style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.peri}, ${PAL.lilac})`, boxShadow: '0 6px 16px rgba(150,120,200,0.35)' }}>
                            <div className="w-full h-full rounded-full overflow-hidden" style={{ border: '2px solid #fff' }}>
                                {widgetChar?.avatar
                                    ? <img src={widgetChar.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                                    : <div className="w-full h-full flex items-center justify-center text-2xl" style={{ background: PAL.mist, color: PAL.lilac }}>✦</div>}
                            </div>
                        </div>
                        <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 px-2.5 py-[1px] rounded-md text-[10px] tracking-wide whitespace-nowrap"
                            style={{ background: `linear-gradient(135deg, ${PAL.grape}, ${PAL.ink})`, color: '#fff', fontFamily: FONT_DISPLAY, boxShadow: '0 2px 8px rgba(107,91,149,0.4)' }}>
                            Lv.{stats.level}
                        </div>
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <h2 className="text-[24px] truncate" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{charName}</h2>
                            <span className="flex items-center gap-1 text-[9px] font-bold tracking-[0.12em] shrink-0" style={{ color: PAL.lilac }}>
                                <span className="w-2 h-2 rounded-full" style={{ background: '#7cd992', boxShadow: '0 0 5px #7cd992' }} />ONLINE
                            </span>
                        </div>
                        <p className="text-[12px] leading-snug mt-1 truncate" style={{ color: PAL.lilac }}>{tagline}</p>
                    </div>

                    <div className="flex flex-col items-end gap-2 shrink-0">
                        <CoinCard
                            icon={<svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0"><path d="M6 3h12l3 5-9 13L3 8z" fill={PAL.peri} stroke={PAL.grape} strokeWidth="1" strokeLinejoin="round" /></svg>}
                            value={stats.gems.toLocaleString()}
                        />
                        <CoinCard
                            icon={<svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z" fill={PAL.pink} stroke={PAL.hot} strokeWidth="0.6" strokeLinejoin="round" /></svg>}
                            value={stats.stars.toString()}
                        />
                    </div>
                </div>

                {/* EXP 条（全宽）*/}
                <div className="flex items-center gap-2.5 mt-3.5 animate-fade-in">
                    <span className="text-[11px] font-bold tracking-[0.16em]" style={{ color: PAL.grape }}>EXP</span>
                    <div className="flex-1 h-[9px] rounded-full overflow-hidden" style={{ background: 'rgba(150,120,200,0.16)', boxShadow: 'inset 0 1px 2px rgba(120,90,170,0.2)' }}>
                        <div className="h-full rounded-full" style={{ width: `${expPct}%`, background: `linear-gradient(90deg, ${PAL.peri}, ${PAL.lilac}, ${PAL.pink})`, boxShadow: '0 0 8px rgba(244,166,204,0.6)' }} />
                    </div>
                    <span className="text-[11px] tabular-nums whitespace-nowrap font-bold" style={{ color: PAL.lilac }}>{stats.exp} / {stats.expMax}</span>
                </div>

                {/* ===== 时钟 Hero 卡（内嵌天空 + 立绘）===== */}
                <div className="relative mt-4 rounded-3xl overflow-hidden animate-fade-in"
                    style={{ height: '13rem', border: '1px solid rgba(255,255,255,0.7)', boxShadow: '0 12px 30px rgba(150,120,200,0.25)' }}>
                    {/* 梦幻天空底 */}
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, #cfe0f7 0%, #e4d9f3 42%, #f3d9ec 72%, #f7d2e2 100%)' }} />
                    <div className="absolute inset-0" style={{ background: 'radial-gradient(80% 60% at 50% 18%, rgba(255,255,255,0.5), transparent 70%)' }} />
                    {/* 远景剪影（城市 / 朦胧）*/}
                    <div className="absolute bottom-0 left-0 right-0 h-16" style={{ background: 'linear-gradient(180deg, transparent, rgba(180,160,220,0.28))' }} />
                    {/* 星芒 */}
                    <Sparkles items={[[12, 22, 16, '#fff', 0.95], [22, 50, 10, '#fff', 0.8], [40, 16, 12, '#fff', 0.85], [86, 26, 14, '#fff', 0.9], [70, 60, 9, PAL.pink, 0.8], [50, 78, 8, '#fff', 0.7]]} />

                    {/* 日期 pill */}
                    <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[10px] font-bold whitespace-nowrap"
                        style={{ background: 'rgba(255,255,255,0.55)', color: PAL.grape, letterSpacing: '0.16em', border: '1px solid rgba(255,255,255,0.8)' }}>
                        {dayName} · {dateNum} {monthName}
                    </div>

                    {/* 大时钟 */}
                    <div className="absolute inset-x-0 top-[3.4rem] flex items-center justify-center">
                        <div className="flex items-center" style={{ fontFamily: FONT_DISPLAY, color: '#fff', fontFeatureSettings: '"tnum"', textShadow: '0 2px 0 rgba(168,150,220,0.55), 0 6px 18px rgba(140,110,190,0.45)' }}>
                            <span className="text-[5.2rem] leading-none">{hh}</span>
                            <StarBurst className="w-9 h-9 mx-0.5" fill={PAL.hot} />
                            <span className="text-[5.2rem] leading-none">{mm}</span>
                        </div>
                    </div>

                    {/* 问候（手写）*/}
                    <div className="absolute inset-x-0 bottom-7 flex items-center justify-center gap-2">
                        <span className="text-[12px]" style={{ color: PAL.pink }}>✦</span>
                        <span className="text-[2rem] leading-none italic" style={{ fontFamily: FONT_SCRIPT, fontWeight: 700, color: PAL.hot, textShadow: '0 1px 6px rgba(255,255,255,0.7)' }}>{greeting}</span>
                        <span className="text-[12px]" style={{ color: PAL.pink }}>✦</span>
                    </div>

                    {/* 角色立绘贴纸（右下，羽化融入卡片）*/}
                    {widgetChar?.avatar && (
                        <div className="absolute right-0 bottom-0 w-36 h-36 pointer-events-none"
                            style={{
                                WebkitMaskImage: 'radial-gradient(70% 70% at 58% 42%, #000 52%, transparent 80%)',
                                maskImage: 'radial-gradient(70% 70% at 58% 42%, #000 52%, transparent 80%)',
                                filter: 'drop-shadow(0 4px 10px rgba(150,120,200,0.35))',
                            }}>
                            <img src={widgetChar.avatar} className="w-full h-full object-cover" alt="" loading="lazy" />
                        </div>
                    )}
                </div>

                {/* ===== 最新公告 ===== */}
                <button onClick={() => openApp(AppID.HotNews)}
                    className="relative w-full text-left mt-4 rounded-2xl p-3.5 flex items-center gap-3 active:scale-[0.99] transition-transform animate-fade-in overflow-hidden"
                    style={CARD}>
                    <Sparkles items={[[8, 24, 9, PAL.pink, 0.7], [4, 70, 8, PAL.peri, 0.6]]} />
                    {/* 喇叭徽标 */}
                    <div className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, boxShadow: '0 4px 10px rgba(234,118,180,0.4)' }}>
                        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M15 8a4 4 0 0 1 0 8" /></svg>
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <span className="text-[14px]" style={{ fontFamily: FONT_CN, color: PAL.grape }}>最新公告</span>
                            <span className="px-1.5 py-px rounded text-[8px] font-bold tracking-wider" style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, color: '#fff' }}>NEW</span>
                        </div>
                        <p className="text-[11px] leading-relaxed line-clamp-2" style={{ color: PAL.lilac }}>{announcement}</p>
                    </div>
                    <div className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.85)' }}>
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke={PAL.hot} strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                    </div>
                </button>

                {/* ===== 快捷入口 ===== */}
                <SectionLabel cn="快捷入口" en="SHORTCUTS" />
                <div className="grid grid-cols-4 gap-2.5 animate-fade-in">
                    {QUICK_ENTRIES.map(e => (
                        <button key={e.id} onClick={() => openApp(e.id)} className="flex flex-col items-center gap-2 active:scale-90 transition-transform">
                            <div className="relative w-[3.9rem] h-[3.9rem] rounded-[1.55rem] flex items-center justify-center" style={CLAY}>
                                <span className="absolute top-1.5 right-2 text-[8px]" style={{ color: PAL.pink, opacity: 0.85 }}>✦</span>
                                <div className="w-[2.4rem] h-[2.4rem]" style={{ filter: 'drop-shadow(0 3px 5px rgba(150,120,200,0.3))' }}>{renderAppArt(e.id)}</div>
                            </div>
                            <span className="text-[11px]" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{e.cn}</span>
                        </button>
                    ))}
                </div>

                {/* ===== 应用目录 ===== */}
                <SectionLabel cn="应用目录" en="INDEX" />
                <div className="grid grid-cols-2 gap-3">
                    {GRID_CARDS.map((card, i) => (
                        <button key={card.id} onClick={() => openApp(card.id)}
                            className="relative h-[6.75rem] rounded-2xl p-4 flex flex-col justify-center text-left overflow-hidden active:scale-[0.97] transition-transform animate-fade-in"
                            style={CARD}>
                            <Sparkles items={[[10, 18, 9, PAL.pink, 0.7], [90, 80, 8, PAL.peri, 0.6]]} />
                            <span className="absolute top-2.5 left-3.5 text-[12px] tabular-nums" style={{ fontFamily: FONT_DISPLAY, color: PAL.lilac }}>{String(i + 1).padStart(2, '0')}</span>
                            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-[3.9rem] h-[3.9rem] pointer-events-none" style={{ filter: 'drop-shadow(0 4px 7px rgba(150,120,200,0.3))' }}>
                                {renderAppArt(card.id)}
                            </div>
                            <div className="relative mt-2">
                                <div className="text-[21px] leading-tight" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{card.cn}</div>
                                <div className="text-[9px] font-bold tracking-[0.26em] mt-1" style={{ color: PAL.lilac }}>{card.en}</div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* ===== 底部 Dock ===== */}
            <div className="absolute bottom-0 left-0 w-full px-3.5 z-30 pointer-events-none" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 0.75rem)' }}>
                <div className="relative pointer-events-auto rounded-[1.9rem] px-3 py-2.5 flex items-end justify-between"
                    style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.9)', boxShadow: '0 -6px 30px rgba(150,120,200,0.2), inset 0 1px 0 rgba(255,255,255,0.9)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }}>
                    <DockItem id={AppID.Chat} cn="消息" badge={totalUnread} onClick={() => openApp(AppID.Chat)} />
                    <DockItem id={AppID.Character} cn="好友" badge={characters?.length || 0} onClick={() => openApp(AppID.Character)} />
                    {/* 中央罗盘 */}
                    <button onClick={() => setDrawerOpen(true)} aria-label="全部应用" className="-mt-8 w-[4.2rem] h-[4.2rem] rounded-full flex items-center justify-center active:scale-95 transition-transform shrink-0"
                        style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.peri}, ${PAL.lilac})`, padding: '3px', boxShadow: '0 8px 22px rgba(234,118,180,0.5)' }}>
                        <div className="w-full h-full rounded-full flex items-center justify-center" style={{ background: `linear-gradient(135deg, #5a4d85, ${PAL.ink})` }}>
                            <StarBurst className="w-8 h-8" fill="#ffffff" />
                        </div>
                    </button>
                    <DockItem id={AppID.Social} cn="动态" onClick={() => openApp(AppID.Social)} />
                    <DockItem id={AppID.ThemeMaker} cn="创作" onClick={() => openApp(AppID.ThemeMaker)} />
                </div>
            </div>

            {/* ===== 全部应用抽屉 ===== */}
            {drawerOpen && (
                <div className="absolute inset-0 z-40 flex flex-col animate-fade-in" style={{ background: 'rgba(239,233,249,0.92)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }} onClick={() => setDrawerOpen(false)}>
                    <div className="flex items-center justify-between px-6" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1.25rem)', paddingBottom: '0.5rem' }}>
                        <h2 className="text-lg tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.grape }}>全部应用</h2>
                        <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }} aria-label="关闭" className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform" style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.9)' }}>
                            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke={PAL.ink} strokeWidth="2.5"><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8" onClick={(e) => e.stopPropagation()}>
                        <div className="grid grid-cols-4 gap-y-5 gap-x-2 place-items-center">
                            {drawerApps.map(app => (
                                <AppIcon key={app.id} app={app} size="md" onClick={() => { setDrawerOpen(false); openApp(app.id); }} />
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const DockItem: React.FC<{ id: AppID; cn: string; badge?: number; onClick: () => void }> = ({ id, cn, badge = 0, onClick }) => {
    const iconKey = INSTALLED_APPS.find(a => a.id === id)?.icon || 'Settings';
    return (
        <button onClick={onClick} className="relative flex flex-col items-center gap-1 w-14 active:scale-90 transition-transform">
            <div className="relative w-7 h-7" style={{ color: PAL.grape }}>
                {renderGlyph(iconKey, 'w-full h-full')}
                {badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                        style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, border: '1px solid #fff' }}>
                        {badge > 99 ? '99+' : badge}
                    </span>
                )}
            </div>
            <span className="text-[10px]" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{cn}</span>
        </button>
    );
};

export default MobileGameHome;
