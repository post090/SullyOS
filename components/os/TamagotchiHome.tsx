import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useOS } from '../../context/OSContext';
import { Icons, INSTALLED_APPS } from '../../constants';
import { AppID, CharacterProfile, RoomItem } from '../../types';
import { DB } from '../../utils/db';
import AppIcon from './AppIcon';
import TokenImg from './TokenImg';
import { useBlobRefUrl } from '../../utils/blobRef';
import { FURNITURE_ICONS } from '../../utils/furnitureIcons';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../../utils/devDebug';

// ===== 电子宠物主题（tamagotchi skin）=====
// 桌面不再是「放图标的手机」，而是一台养成机：屏幕主体是角色**真实的小屋**
// （小小窝 App 里用户亲手装修的那间，家具/地毯/墙地面/立绘原样搬入，只读舞台），
// 角色在里面呼吸、游荡、深夜睡觉；下方四颗糖果实体键 = 见面 / 聊天 / 小小窝 / 记忆宫殿。
//
// 性能红线（此文件的宪法）：
//   · 零常驻 JS 动画 —— 循环动效全部 CSS keyframes 且只碰 transform/opacity；
//     JS 只用 ≥15s 的一次性 setTimeout 换游荡坐标。
//   · 禁 backdrop-filter；blur 仅限小面积静态装饰；每元素阴影 ≤1 层。
//   · 渲染隔离 —— 舞台/状态栏拆 memo 子组件，分钟跳动不触达家具层 reconcile。
//   · 图片全走 TokenImg / useBlobRefUrl（blobref 令牌自动解析回收）+ lazy。

// —— 调色板（90 年代玩具：奶油 + 薄荷 + 糖果橙，与手游风的粉紫拉开距离）——
const PAL = {
    ink: '#4a4238',      // 主文字 · 暖棕
    fade: '#9b9082',     // 次文字
    cream: '#fbf4e4',
    mint: '#8fd6ae',
    mintDeep: '#4fae7e',
    peach: '#ffb59c',
    peachDeep: '#f08a68',
    butter: '#ffd98e',
    butterDeep: '#e8ab4e',
    lav: '#c3b2ee',
    lavDeep: '#9678d8',
    hot: '#ef8fb0',
    lcd: '#e9f0dc',      // 液晶底 · 淡黄绿
    lcdInk: '#4a5a41',   // 液晶字
};
const FONT_PX = `'Courier Prime', monospace`;                   // 像素/LCD 字
const FONT_CN = `'ZCOOL KuaiLe', 'Noto Sans SC', sans-serif`;   // 中文圆润

const FLOOR_HORIZON = 65; // 与 RoomApp 一致：地平线 65%

// —— 兜底家具（角色从没装修过小屋时）——
// 注意：不能 import RoomApp（它是 lazy chunk，引了会把整个小屋 App 拽进主包），
// 这里放一份轻量镜像：通用默认 = RoomApp.DEFAULT_FURNITURE；Sully = SULLY_FURNITURE 的
// 摆位副本（去掉了舞台用不到的 descriptionPrompt）。Sully 首次进过小小窝后 roomConfig
// 会自动落库，此副本只服务于「装完还没进过屋」的新档。
const FALLBACK_DEFAULT: RoomItem[] = [
    { id: 'desk', name: '书桌', type: 'furniture', image: FURNITURE_ICONS.sofa, x: 20, y: 55, scale: 1.2, rotation: 0, isInteractive: true },
    { id: 'plant', name: '盆栽', type: 'decor', image: FURNITURE_ICONS.plant, x: 85, y: 40, scale: 0.8, rotation: 0, isInteractive: true },
];
const FALLBACK_SULLY: RoomItem[] = [
    { id: 'item-1768927221380', name: 'Sully床', type: 'furniture', image: 'https://sharkpan.xyz/f/A3XeUZ/BED.png', x: 78.46, y: 97.39, scale: 2.4, rotation: 0, isInteractive: true },
    { id: 'item-1768927255102', name: 'Sully电脑桌', type: 'furniture', image: 'https://sharkpan.xyz/f/G5n3Ul/DNZ.png', x: 28.85, y: 69.94, scale: 2.4, rotation: 0, isInteractive: true },
    { id: 'item-1768927271632', name: 'Sully垃圾桶', type: 'furniture', image: 'https://sharkpan.xyz/f/75Nvsj/LJT.png', x: 10.28, y: 80.5, scale: 0.9, rotation: 0, isInteractive: true },
    { id: 'item-1768927286526', name: 'Sully洞洞板', type: 'furniture', image: 'https://sharkpan.xyz/f/85K5ij/DDB.png', x: 32.61, y: 48.72, scale: 2.6, rotation: 0, isInteractive: true },
    { id: 'item-1768927303472', name: 'Sully书柜', type: 'furniture', image: 'https://sharkpan.xyz/f/zlpWS5/SG.png', x: 79.84, y: 68.94, scale: 2, rotation: 0, isInteractive: true },
];
const FALLBACK_WALL = 'radial-gradient(circle at 50% 50%, #fdfbf7 0%, #e2e8f0 100%)';
const FALLBACK_FLOOR = 'repeating-linear-gradient(90deg, #e7e5e4 0px, #e7e5e4 20px, #d6d3d1 21px)';

// 与 RoomApp.getBgStyle 同口径：url 类走 background 简写（含缩放/平铺），渐变串原样返回
const getBgStyle = (img: string | undefined, scale: number | undefined, repeat: boolean | undefined, fallback: string): string => {
    if (!img) return fallback;
    const isUrl = img.startsWith('http') || img.startsWith('data') || img.startsWith('blob:');
    if (!isUrl) return img;
    const size = scale && scale > 0 ? `${scale}%` : 'cover';
    return `url(${img}) center center / ${size} ${repeat ? 'repeat' : 'no-repeat'}`;
};

// 与 RoomApp 一致的图层法则：地毯压进 [1,11] 底层区间，家具按 y 排 z，角色 y+20 必然在最上
const itemZ = (item: RoomItem) => item.type === 'rug' ? 1 + Math.floor(item.y / 10) : Math.floor(item.y);

type DayPhase = 'day' | 'dusk' | 'night';
const phaseOfHour = (h: number): DayPhase => (h < 6 || h >= 23) ? 'night' : (h >= 18 ? 'dusk' : 'day');

// 戳一戳短语（本地词库，不调 LLM）
const POKE_LINES = ['嗯？', '干嘛啦…', '我在呢！', '(被戳了一下)', '別戳了别戳了', '✦?', '在想事情…', '要陪我玩吗！'];

// 等级/天数口径与 MobileGameHome 完全一致：每条消息 10 exp，三角曲线升级
const deriveLevel = (msgCount: number) => {
    const totalExp = msgCount * 10;
    const base = 150;
    return Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * totalExp) / base)) / 2));
};

// ─── 像素状态栏（LCD 条）：分钟跳动只重渲染这一条 ───────────────
const PixelStatusBar = React.memo<{ hh: string; mm: string; level: number; days: number; unread: number; charName: string; multiChar: boolean; onSwitch: () => void }>(
    ({ hh, mm, level, days, unread, charName, multiChar, onSwitch }) => (
        <div className="flex items-center gap-2 rounded-xl px-3 py-1.5 mt-2.5"
            style={{ background: PAL.lcd, border: `2px solid ${PAL.ink}`, fontFamily: FONT_PX, color: PAL.lcdInk }}>
            <span className="text-[12px] font-bold tabular-nums tracking-[0.08em]">{hh}:{mm}</span>
            <span className="text-[9px] opacity-40">✦</span>
            <button onClick={onSwitch} className={`flex items-center gap-1 min-w-0 ${multiChar ? 'active:opacity-60' : ''}`}>
                <span className="text-[11px] font-bold truncate max-w-[72px] tracking-wide">{charName}</span>
                {multiChar && <span className="text-[8px] shrink-0 opacity-70">⇄</span>}
            </button>
            <span className="flex-1" />
            <span className="text-[11px] font-bold tracking-[0.06em]">Lv.{level}</span>
            <span className="text-[9px] opacity-40">✦</span>
            <span className="text-[11px] font-bold tracking-[0.06em]">D+{days}</span>
            {unread > 0 && (
                <>
                    <span className="text-[9px] opacity-40">✦</span>
                    <span className="text-[11px] font-bold" style={{ color: '#c2564e' }}>♥×{unread > 99 ? '99' : unread}</span>
                </>
            )}
        </div>
    )
);

// ─── 舞台家具（静态贴纸，逐件 memo）───────────────────────────
const StageItem = React.memo<{ item: RoomItem }>(({ item }) => (
    <div className="absolute pointer-events-none select-none"
        style={{
            left: `${item.x}%`, top: `${item.y}%`,
            width: `${80 * item.scale}px`,
            transform: `translate(-50%, -100%) rotate(${item.rotation}deg)`,
            zIndex: itemZ(item),
        }}>
        <TokenImg value={item.image} className="w-full h-auto object-contain" draggable={false} loading="lazy" alt="" />
    </div>
));

// ─── 角色（呼吸 / 游荡 / 戳一戳 / 深夜睡觉），自治状态不外溢 ─────
const Actor = React.memo<{ actorImg: string | undefined; phase: DayPhase; sleepX: number; sleepY: number; unread: number; lastMessage: string; onChat: () => void }>(
    ({ actorImg, phase, sleepX, sleepY, unread, lastMessage, onChat }) => {
        const [pos, setPos] = useState({ x: 48, y: 80 });
        const [bounce, setBounce] = useState(false);
        const [pokeText, setPokeText] = useState('');
        const night = phase === 'night';

        // 游荡：≥18s 一次性的 setTimeout 链（无 rAF / 无短 interval），夜里归位睡觉
        useEffect(() => {
            if (night) { setPos({ x: sleepX, y: sleepY }); return; }
            let t: ReturnType<typeof setTimeout>;
            const wander = () => {
                setPos({ x: 22 + Math.random() * 56, y: 70 + Math.random() * 22 });
                t = setTimeout(wander, 18000 + Math.random() * 22000);
            };
            t = setTimeout(wander, 15000);
            return () => clearTimeout(t);
        }, [night, sleepX, sleepY]);

        const poke = (e: React.MouseEvent) => {
            e.stopPropagation();
            if (night) { setPokeText('Zzz…(睡着了)'); }
            else {
                setBounce(true);
                setPokeText(POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)]);
                setTimeout(() => setBounce(false), 450);
            }
            setTimeout(() => setPokeText(''), 2800);
        };

        // 气泡优先级：戳一戳 > 夜间 Zzz > 未读 > 最近一条消息
        const bubble = pokeText || (night ? 'Zzz…' : (unread > 0 ? `♥ ${unread} 条新消息!` : (lastMessage ? lastMessage.slice(0, 30) : '')));
        const bubbleIsChat = !pokeText && !night;

        return (
            <div onClick={poke}
                className="absolute cursor-pointer"
                style={{
                    left: `${pos.x}%`, top: `${pos.y}%`, width: '104px',
                    transform: 'translate(-50%, -100%)',
                    zIndex: Math.floor(pos.y) + 20,
                    transition: 'left 1.4s ease-in-out, top 1.4s ease-in-out',
                }}>
                <img src={actorImg} alt="" draggable={false} loading="lazy"
                    className="w-full h-auto object-contain select-none"
                    style={{
                        animation: bounce ? 'tama-bounce 0.45s ease-out' : (night ? 'none' : 'tama-breathe 3.2s ease-in-out infinite'),
                        transform: night ? 'rotate(-6deg)' : undefined,
                        willChange: 'transform',
                    }} />
                {night && (
                    <span className="absolute -top-4 right-0 text-[13px] font-bold select-none" style={{ fontFamily: FONT_PX, color: PAL.lcdInk, animation: 'tama-zzz 2.6s ease-in-out infinite' }}>Zzz</span>
                )}
                {bubble && (
                    <div onClick={(e) => { if (bubbleIsChat) { e.stopPropagation(); onChat(); } }}
                        className="absolute bottom-[102%] left-1/2 -translate-x-1/2 px-2.5 py-1.5 rounded-lg rounded-bl-none max-w-[170px] animate-pop-in"
                        style={{ background: PAL.lcd, border: `2px solid ${PAL.ink}`, zIndex: 60 }}>
                        <p className="text-[10px] font-bold leading-snug break-words whitespace-nowrap overflow-hidden text-ellipsis" style={{ fontFamily: FONT_PX, color: PAL.lcdInk }}>{bubble}</p>
                    </div>
                )}
            </div>
        );
    }
);

// ─── 小屋舞台（LCD 屏）：props 全为原始值/memo 引用，分钟跳动不进来 ───
const RoomStage = React.memo<{
    items: RoomItem[]; wallStyle: string; floorStyle: string;
    actorImg: string | undefined; phase: DayPhase; unread: number; lastMessage: string;
    onVisit: () => void; onChat: () => void;
}>(({ items, wallStyle, floorStyle, actorImg, phase, unread, lastMessage, onVisit, onChat }) => {
    // 睡觉位：找「床」，没有就找地毯，再没有就右下角
    const sleep = useMemo(() => {
        const bed = items.find(i => /床|bed/i.test(i.name)) || items.find(i => i.type === 'rug');
        return bed ? { x: bed.x, y: Math.max(FLOOR_HORIZON + 8, Math.min(96, bed.y - 2)) } : { x: 62, y: 84 };
    }, [items]);

    return (
        <div onClick={onVisit}
            className="relative flex-1 min-h-0 rounded-[1.6rem] overflow-hidden cursor-pointer active:opacity-95"
            style={{ border: `3px solid ${PAL.ink}`, boxShadow: '0 6px 0 rgba(74,66,56,0.18)', contain: 'layout paint' }}>
            {/* 墙 / 地板（与 RoomApp 同分割线） */}
            <div className="absolute top-0 left-0 w-full h-[65%] z-0" style={{ background: wallStyle }} />
            <div className="absolute bottom-0 left-0 w-full h-[35%] z-0" style={{ background: floorStyle }} />
            <div className="absolute top-[65%] w-full h-6 bg-gradient-to-b from-black/10 to-transparent pointer-events-none z-0" />

            {items.map(item => <StageItem key={item.id} item={item} />)}

            <Actor actorImg={actorImg} phase={phase} sleepX={sleep.x} sleepY={sleep.y} unread={unread} lastMessage={lastMessage} onChat={onChat} />

            {/* 暮色 / 夜色叠层：常驻两个静态渐变 div，只动 opacity（合成器通道） */}
            <div className="absolute inset-0 pointer-events-none z-[70] transition-opacity duration-1000"
                style={{ background: 'linear-gradient(180deg, rgba(255,148,84,0.16), rgba(120,66,120,0.2))', opacity: phase === 'dusk' ? 1 : 0 }} />
            <div className="absolute inset-0 pointer-events-none z-[70] transition-opacity duration-1000"
                style={{ background: 'linear-gradient(180deg, rgba(24,32,72,0.4), rgba(16,18,48,0.5))', opacity: phase === 'night' ? 1 : 0 }} />
            {/* LCD 扫描线（静态，几乎零成本） */}
            <div className="absolute inset-0 pointer-events-none z-[71]"
                style={{ background: 'repeating-linear-gradient(0deg, rgba(74,66,56,0.05) 0px, rgba(74,66,56,0.05) 1px, transparent 1px, transparent 3px)' }} />
            {/* 屏角像素装饰 */}
            <span className="absolute top-1.5 left-2.5 text-[9px] z-[72] pointer-events-none select-none" style={{ fontFamily: FONT_PX, color: 'rgba(74,66,56,0.4)' }}>▶ LIVE</span>
        </div>
    );
});

// ─── 糖果实体键 ────────────────────────────────────────────────
const CandyKey: React.FC<{ id: AppID; label: string; top: string; deep: string; badge?: number; onClick: () => void }> = ({ id, label, top, deep, badge = 0, onClick }) => {
    const iconKey = INSTALLED_APPS.find(a => a.id === id)?.icon || 'Settings';
    const Comp = Icons[iconKey] || Icons.Settings;
    return (
        <button onClick={onClick} className="flex flex-col items-center gap-1.5 group">
            <div className="relative w-[3.7rem] h-[3.7rem] rounded-full flex items-center justify-center transition-transform group-active:translate-y-[3px]"
                style={{
                    background: `linear-gradient(180deg, ${top}, ${deep})`,
                    border: `2.5px solid ${PAL.ink}`,
                    boxShadow: `0 4px 0 ${PAL.ink}`,
                }}>
                {/* 键帽内高光（静态渐变，非阴影） */}
                <div className="absolute top-[5px] left-1/2 -translate-x-1/2 w-[62%] h-[26%] rounded-full pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0))' }} />
                <div className="w-7 h-7 text-white"><Comp className="w-full h-full" /></div>
                {badge > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                        style={{ background: PAL.hot, border: `2px solid ${PAL.ink}` }}>{badge > 99 ? '99+' : badge}</span>
                )}
            </div>
            <span className="text-[11px]" style={{ fontFamily: FONT_CN, color: PAL.ink }}>{label}</span>
        </button>
    );
};

// ─── 主组件 ───────────────────────────────────────────────────
const TamagotchiHome: React.FC = () => {
    const { openApp, characters, activeCharacterId, setActiveCharacterId, virtualTime, unreadMessages, isDataLoaded, lastMsgTimestamp } = useOS();

    const [stat, setStat] = useState({ msgCount: 0, firstTs: 0 });
    const [lastMessage, setLastMessage] = useState('');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
    useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

    const char: CharacterProfile | null = useMemo(
        () => characters.find(c => c.id === activeCharacterId) || characters[0] || null,
        [characters, activeCharacterId]
    );

    // 取数口径与 MobileGameHome 一致：消息数（Lv）、最早消息（认识天数）、最近一条可见消息
    useEffect(() => {
        if (!isDataLoaded || !char) { setStat({ msgCount: 0, firstTs: 0 }); setLastMessage(''); return; }
        DB.getMessagesByCharId(char.id).then(msgs => {
            const visible = msgs.filter(m => m.role !== 'system');
            setStat({ msgCount: visible.length, firstTs: visible[0]?.timestamp || 0 });
            const last = visible[visible.length - 1];
            const clean = last ? last.content.replace(/\[.*?\]/g, '').trim() : '';
            setLastMessage(clean || (last?.type === 'image' ? '[图片]' : ''));
        }).catch(() => {});
    }, [char?.id, lastMsgTimestamp, isDataLoaded]);

    // 小屋数据：优先角色 roomConfig，兜底镜像样板房（见文件头注释）
    const isSully = char?.id === 'preset-sully-v2' || char?.name === 'Sully';
    const items = useMemo<RoomItem[]>(() => {
        const saved = char?.roomConfig?.items;
        if (saved && saved.length > 0) return saved;
        return isSully ? FALLBACK_SULLY : FALLBACK_DEFAULT;
    }, [char?.roomConfig?.items, isSully]);

    // blobref 令牌 → 可渲染 url（hook 需无条件顶层调用）
    const wallImg = useBlobRefUrl(char?.roomConfig?.wallImage);
    const floorImg = useBlobRefUrl(char?.roomConfig?.floorImage);
    const actorImg = useBlobRefUrl(char?.sprites?.['chibi'] || char?.avatar);
    const wallStyle = getBgStyle(wallImg, char?.roomConfig?.wallScale, char?.roomConfig?.wallRepeat, FALLBACK_WALL);
    const floorStyle = getBgStyle(floorImg, char?.roomConfig?.floorScale, char?.roomConfig?.floorRepeat, FALLBACK_FLOOR);

    const phase = phaseOfHour(virtualTime.hours);
    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');
    const level = deriveLevel(stat.msgCount);
    const days = stat.firstTs ? Math.max(1, Math.floor((Date.now() - stat.firstTs) / 86400000) + 1) : 1;
    const charUnread = char ? (unreadMessages[char.id] || 0) : 0;
    const totalUnread = useMemo(() => Object.values(unreadMessages).reduce((a, b) => a + b, 0), [unreadMessages]);

    const openRoom = useCallback(() => openApp(AppID.Room), [openApp]);
    const openChat = useCallback(() => openApp(AppID.Chat), [openApp]);
    const switchChar = useCallback(() => {
        if (characters.length < 2 || !char) return;
        const idx = characters.findIndex(c => c.id === char.id);
        setActiveCharacterId(characters[(idx + 1) % characters.length].id);
    }, [characters, char, setActiveCharacterId]);

    const drawerApps = useMemo(
        () => INSTALLED_APPS.filter(a => a.id !== AppID.CharCreatorDev || devDebugVisible),
        [devDebugVisible]
    );

    return (
        <div className="h-full w-full relative z-10 overflow-hidden select-none flex flex-col px-5"
            style={{ color: PAL.ink, fontFamily: FONT_CN, paddingTop: 'calc(var(--safe-top, 0px) + 0.75rem)', paddingBottom: 'calc(var(--safe-bottom, 0px) + 1rem)' }}>
            {/* 本皮肤专用 keyframes（只碰 transform/opacity） */}
            <style>{`
                @keyframes tama-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
                @keyframes tama-bounce { 0% { transform: scale(1); } 35% { transform: scale(1.12, 0.9); } 70% { transform: scale(0.95, 1.06); } 100% { transform: scale(1); } }
                @keyframes tama-zzz { 0%,100% { opacity: 0.35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-4px); } }
            `}</style>

            {/* ===== 报头 ===== */}
            <div className="flex items-center justify-between shrink-0">
                <div className="flex items-center gap-1.5" style={{ fontFamily: FONT_PX }}>
                    <span className="text-[11px]" style={{ color: PAL.peachDeep }}>✦</span>
                    <span className="text-[12px] font-bold tracking-[0.28em]">SULLY·GOTCHI</span>
                    <span className="text-[9px]" style={{ color: PAL.mintDeep }}>✦</span>
                </div>
                <button onClick={() => setDrawerOpen(true)} aria-label="全部应用"
                    className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-transform"
                    style={{ background: PAL.cream, border: `2px solid ${PAL.ink}`, boxShadow: `0 2.5px 0 ${PAL.ink}` }}>
                    <span className="text-[15px] font-bold leading-none tracking-widest" style={{ fontFamily: FONT_PX }}>⋯</span>
                </button>
            </div>

            {char ? (
                <>
                    <PixelStatusBar hh={hh} mm={mm} level={level} days={days} unread={charUnread} charName={char.name} multiChar={characters.length > 1} onSwitch={switchChar} />

                    {/* ===== 液晶屏 · 小屋舞台 ===== */}
                    <div className="flex-1 min-h-0 flex flex-col mt-3">
                        <RoomStage
                            items={items} wallStyle={wallStyle} floorStyle={floorStyle}
                            actorImg={actorImg} phase={phase} unread={charUnread} lastMessage={lastMessage}
                            onVisit={openRoom} onChat={openChat}
                        />
                        <div className="text-center text-[9px] mt-1.5 tracking-[0.3em] shrink-0" style={{ fontFamily: FONT_PX, color: PAL.fade }}>
                            ◂ TAP SCREEN TO VISIT ▸
                        </div>
                    </div>

                    {/* ===== 四颗糖果实体键 ===== */}
                    <div className="shrink-0 flex items-start justify-around pt-3">
                        <CandyKey id={AppID.Date} label="见面" top={PAL.peach} deep={PAL.peachDeep} onClick={() => openApp(AppID.Date)} />
                        <CandyKey id={AppID.Chat} label="聊天" top={PAL.mint} deep={PAL.mintDeep} badge={totalUnread} onClick={openChat} />
                        <CandyKey id={AppID.Room} label="小小窝" top={PAL.butter} deep={PAL.butterDeep} onClick={openRoom} />
                        <CandyKey id={AppID.MemoryPalace} label="记忆宫殿" top={PAL.lav} deep={PAL.lavDeep} onClick={() => openApp(AppID.MemoryPalace)} />
                    </div>
                </>
            ) : (
                /* 零角色兜底：像素小蛋 */
                <div className="flex-1 flex flex-col items-center justify-center gap-4">
                    <div className="w-24 h-28 rounded-[50%_50%_46%_46%/58%_58%_42%_42%]"
                        style={{ background: `linear-gradient(180deg, ${PAL.cream}, ${PAL.butter})`, border: `3px solid ${PAL.ink}`, animation: 'tama-breathe 2.4s ease-in-out infinite' }} />
                    <p className="text-[12px] text-center leading-relaxed" style={{ fontFamily: FONT_PX, color: PAL.fade }}>EMPTY EGG…</p>
                    <button onClick={() => openApp(AppID.Character)} className="px-5 py-2.5 rounded-2xl text-[13px] font-bold text-white active:scale-95 transition-transform"
                        style={{ background: `linear-gradient(180deg, ${PAL.mint}, ${PAL.mintDeep})`, border: `2.5px solid ${PAL.ink}`, boxShadow: `0 3px 0 ${PAL.ink}`, fontFamily: FONT_CN }}>
                        去神经链接领养一只
                    </button>
                </div>
            )}

            {/* ===== 全部应用抽屉（逃生舱口：设置 / 外观都在这） ===== */}
            {drawerOpen && (
                <div className="absolute inset-0 z-40 flex flex-col animate-fade-in" style={{ background: 'rgba(251,244,228,0.97)' }} onClick={() => setDrawerOpen(false)}>
                    <div className="flex items-center justify-between px-6" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1.25rem)', paddingBottom: '0.5rem' }}>
                        <h2 className="text-lg tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.ink }}>全部应用</h2>
                        <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }} aria-label="关闭"
                            className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-transform"
                            style={{ background: '#fff', border: `2px solid ${PAL.ink}` }}>
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

export default TamagotchiHome;
