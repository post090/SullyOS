import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useOS } from '../../context/OSContext';
import { INSTALLED_APPS } from '../../constants';
import { AppID, CharacterProfile, RoomItem } from '../../types';
import { DB } from '../../utils/db';
import AppIcon from './AppIcon';
import TokenImg from './TokenImg';
import { useBlobRefUrl } from '../../utils/blobRef';
import { FURNITURE_ICONS } from '../../utils/furnitureIcons';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../../utils/devDebug';

// ===== 电子宠物主题（tamagotchi skin）=====
// 桌面不再是「放图标的手机」，而是一台华丽丽的二次元养成机：屏幕主体是角色
// **真实的小屋**（小小窝里用户亲手装修的那间，家具/地毯/墙地面/立绘原样搬入，只读舞台），
// 角色在里面呼吸、游荡、被戳会念聊天里说过的话；底部 CARE/TALK/HOME/ALBUM/SETTINGS 五键 dock。
// 视觉基调：薰衣草梦幻手游风——渐变描边、四角宝石、满屏星芒、发光经验条、糖果凸键。
//
// 性能红线（此文件的宪法）：
//   · 零常驻 JS 动画 —— 循环动效全部 CSS keyframes 且只碰 transform/opacity；
//     JS 只用 ≥15s 的一次性 setTimeout 换游荡坐标。
//   · 禁 backdrop-filter / blur；星芒云朵全是静态 span 与渐变；每元素阴影 ≤2 层。
//   · 渲染隔离 —— 舞台/状态卡拆 memo 子组件，分钟跳动不触达家具层 reconcile。
//   · 图片全走 TokenImg / useBlobRefUrl（blobref 令牌自动解析回收）+ lazy。

// —— 调色板（薰衣草梦幻 · 参考稿取色 + 手游强调色）——
const PAL = {
    frame: '#b3a3e0',    // 柔紫描边
    frameSoft: 'rgba(179,163,224,0.45)',
    cream: '#fdf9f2',    // 奶油卡片底
    ink: '#7a6cb8',      // 主文字 · 紫
    grape: '#6b5b9e',    // 深紫标题
    fade: '#a99bd4',     // 次文字 · 浅紫
    pink: '#f4a6cc',
    hot: '#ea76b4',      // 强调粉
    peri: '#a8b8e8',     // 蓝紫
    gold: '#f7d180',     // 点缀金
    heart: '#f2a7bb',
    heartDeep: '#e8879f',
    night: '#3a3560',    // 夜钟深紫
};
// 渐变描边（华丽框的灵魂）：粉 → 蓝紫 → 淡紫
const RIM = `linear-gradient(135deg, ${PAL.pink}, ${PAL.peri} 55%, #cabdf0)`;
const FONT_PX = `'Courier Prime', monospace`;                   // 像素/LCD 字
const FONT_CN = `'ZCOOL KuaiLe', 'Noto Sans SC', sans-serif`;   // 中文圆润
const FONT_NUM = `'DM Serif Display', serif`;                   // 大数字（时间 / Lv）

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

const isNightHour = (h: number) => h < 6 || h >= 23;

// 戳一戳兜底短语（角色还没说过话时用）
const POKE_FALLBACK = ['嗯？', '干嘛啦…', '我在呢！', '(被戳了一下)', '別戳了别戳了', '✦?', '在想事情…', '要陪我玩吗！'];

// 等级口径与 MobileGameHome 完全一致：每条消息 10 exp，三角曲线升级
const deriveStats = (msgCount: number) => {
    const totalExp = msgCount * 10;
    const base = 150;
    const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * totalExp) / base)) / 2));
    const need = (base * level * (level - 1)) / 2;
    const exp = Math.max(0, Math.round(totalExp - need));
    const expMax = base * level;
    return { level, exp, expMax };
};

// ─── 装饰小件（全静态，零成本）───────────────────────────────
// 星芒 ✦ 散布：按 [x%, y%, 字号px, 颜色, 透明度, 是否闪烁]
type Sp = [number, number, number, string, number, boolean?];
const Sparkles = React.memo<{ items: Sp[] }>(({ items }) => (
    <>
        {items.map(([x, y, s, c, o, tw], i) => (
            <span key={i} className="absolute pointer-events-none select-none leading-none"
                style={{
                    left: `${x}%`, top: `${y}%`, fontSize: s, color: c, opacity: o,
                    transform: 'translate(-50%,-50%)',
                    animation: tw ? `tama-twinkle ${2.4 + (i % 3) * 0.7}s ease-in-out ${(i % 4) * 0.6}s infinite` : undefined,
                }}>✦</span>
        ))}
    </>
));

// 四角宝石（rotate-45 小方块，华丽卡片标配）
const GemCorners = React.memo<{ color?: string; inset?: number }>(({ color = 'rgba(234,118,180,0.75)', inset = 8 }) => (
    <>
        {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([r, b], i) => (
            <span key={i} className="absolute w-1.5 h-1.5 rotate-45 pointer-events-none"
                style={{ [r ? 'right' : 'left']: inset, [b ? 'bottom' : 'top']: inset, background: color } as React.CSSProperties} />
        ))}
    </>
));

// 页面氛围层：静态星野（多重 radial-gradient 星点）+ 顶部柔光
const BackDecor = React.memo(() => (
    <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 opacity-80" style={{
            backgroundImage:
                'radial-gradient(1.5px 1.5px at 12% 8%, rgba(255,255,255,0.9), transparent), radial-gradient(1px 1px at 78% 5%, rgba(255,220,240,0.8), transparent), radial-gradient(1.5px 1.5px at 40% 15%, rgba(255,255,255,0.7), transparent), radial-gradient(1px 1px at 90% 22%, rgba(220,225,255,0.7), transparent), radial-gradient(1px 1px at 6% 38%, rgba(255,255,255,0.6), transparent), radial-gradient(1.5px 1.5px at 95% 55%, rgba(255,230,250,0.6), transparent), radial-gradient(1px 1px at 4% 72%, rgba(255,255,255,0.55), transparent), radial-gradient(1px 1px at 92% 88%, rgba(230,220,255,0.6), transparent)',
        }} />
        <div className="absolute inset-x-0 top-0 h-40" style={{ background: 'radial-gradient(70% 100% at 50% 0%, rgba(255,255,255,0.5), transparent 70%)' }} />
        <Sparkles items={[
            [7, 12, 13, '#fff', 0.9, true], [93, 9, 11, PAL.gold, 0.85, true],
            [85, 30, 9, '#fff', 0.7], [4, 55, 10, PAL.pink, 0.6, true],
            [96, 68, 9, '#fff', 0.6], [8, 88, 11, PAL.gold, 0.7, true],
        ]} />
    </div>
));

// ─── 状态卡（华丽版：渐变环头像 + Lv 徽章 + 大数字时间 + 发光爱心经验条）───
const StatusCard = React.memo<{ hh: string; mm: string; level: number; exp: number; expMax: number; charName: string; avatar?: string; multiChar: boolean; onSwitch: () => void }>(
    ({ hh, mm, level, exp, expMax, charName, avatar, multiChar, onSwitch }) => {
        const expPct = Math.min(100, Math.round((exp / expMax) * 100));
        return (
            <div className="relative rounded-[1.4rem] px-3.5 py-3 mt-2.5 flex items-center gap-3.5 overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.72)', border: `1.5px solid ${PAL.frameSoft}`, boxShadow: '0 5px 16px rgba(150,120,200,0.18)' }}>
                {/* 内描金细框 + 四角宝石 + 卡内星芒 */}
                <div className="absolute inset-[5px] rounded-[1.1rem] pointer-events-none" style={{ border: `1px solid rgba(179,163,224,0.3)` }} />
                <GemCorners inset={9} />
                <Sparkles items={[[88, 20, 9, PAL.pink, 0.8, true], [64, 78, 8, PAL.peri, 0.7], [95, 62, 8, PAL.gold, 0.75, true]]} />

                {/* 头像：渐变环 + Lv 徽章 */}
                <button onClick={onSwitch} className={`relative shrink-0 ${multiChar ? 'active:scale-95 transition-transform' : ''}`}>
                    <div className="w-[62px] h-[62px] rounded-full p-[2.5px]"
                        style={{ background: RIM, boxShadow: '0 4px 12px rgba(160,120,210,0.4)' }}>
                        <div className="w-full h-full rounded-full overflow-hidden" style={{ border: '2px solid #fff', background: '#fff' }}>
                            {avatar ? <img src={avatar} className="w-full h-full object-cover" alt="" loading="lazy" draggable={false} /> : <div className="w-full h-full flex items-center justify-center text-lg" style={{ color: PAL.fade }}>✦</div>}
                        </div>
                    </div>
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 px-2 py-[1px] rounded-md text-[10px] whitespace-nowrap"
                        style={{ background: `linear-gradient(135deg, ${PAL.grape}, #55488a)`, color: '#fff', fontFamily: FONT_NUM, boxShadow: '0 2px 6px rgba(107,91,149,0.45)', border: '1px solid rgba(255,255,255,0.5)' }}>
                        Lv.{level}
                    </div>
                    {multiChar && <span className="absolute -top-1 -right-1 w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px]" style={{ background: '#fff', border: `1.5px solid ${PAL.frame}`, color: PAL.ink, boxShadow: '0 1px 4px rgba(150,120,200,0.3)' }}>⇄</span>}
                </button>

                <div className="flex-1 min-w-0 relative">
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[26px] leading-none tabular-nums" style={{ fontFamily: FONT_NUM, color: PAL.grape, textShadow: '0 2px 0 rgba(255,255,255,0.9), 0 3px 10px rgba(160,120,210,0.35)' }}>{hh}:{mm}</span>
                        <span className="flex items-center gap-1 text-[8px] font-bold tracking-[0.14em] shrink-0" style={{ color: PAL.fade }}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#7cd992', boxShadow: '0 0 5px #7cd992' }} />LIVE·ON
                        </span>
                    </div>
                    <div className="text-[14px] truncate mt-1" style={{ fontFamily: FONT_CN, color: PAL.ink }}>{charName}</div>
                    {/* 发光爱心经验条 */}
                    <div className="flex items-center gap-1.5 mt-1.5">
                        <span className="text-[12px] leading-none" style={{ color: PAL.hot, textShadow: '0 0 6px rgba(234,118,180,0.6)' }}>♥</span>
                        <div className="flex-1 h-[8px] rounded-full overflow-hidden" style={{ background: 'rgba(179,163,224,0.22)', boxShadow: 'inset 0 1px 2px rgba(120,90,170,0.25)' }}>
                            <div className="h-full rounded-full" style={{ width: `${expPct}%`, background: `linear-gradient(90deg, ${PAL.peri}, ${PAL.pink}, ${PAL.hot})`, boxShadow: '0 0 8px rgba(234,118,180,0.65)' }} />
                        </div>
                        <span className="text-[9px] tabular-nums shrink-0 font-bold" style={{ fontFamily: FONT_PX, color: PAL.fade }}>{exp}/{expMax}</span>
                    </div>
                </div>
            </div>
        );
    }
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

// ─── 天窗挂饰（舞台顶部小窗 + 流星 + 悬星，纯静态 CSS）────────────
const StageWindow = React.memo(() => (
    <div className="absolute top-[4%] left-[5%] right-[5%] h-[13%] pointer-events-none" style={{ zIndex: 0 }}>
        <div className="absolute inset-0 rounded-xl overflow-hidden" style={{ border: '3px solid rgba(255,255,255,0.9)', background: 'linear-gradient(180deg, #bfe0f7 0%, #dff0fc 70%, #f0f8fe 100%)', boxShadow: '0 3px 10px rgba(150,120,200,0.25)' }}>
            {/* 云朵（静态圆角块，无 blur） */}
            <div className="absolute top-[28%] left-[12%] w-[26%] h-[36%] rounded-full" style={{ background: 'rgba(255,255,255,0.85)' }} />
            <div className="absolute top-[18%] left-[22%] w-[18%] h-[34%] rounded-full" style={{ background: 'rgba(255,255,255,0.75)' }} />
            <div className="absolute top-[42%] right-[16%] w-[22%] h-[32%] rounded-full" style={{ background: 'rgba(255,255,255,0.7)' }} />
            {/* 流星 */}
            <div className="absolute top-[24%] left-[42%] w-[18%] h-[2px] rotate-[24deg] origin-left rounded-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.95))' }} />
            <span className="absolute top-[12%] right-[36%] text-[9px]" style={{ color: '#fff', animation: 'tama-twinkle 2.8s ease-in-out infinite' }}>✦</span>
            <span className="absolute bottom-[16%] left-[38%] text-[7px]" style={{ color: 'rgba(255,255,255,0.9)' }}>✦</span>
        </div>
        {/* 悬挂的小星星 / 月亮 */}
        {[
            { x: '18%', drop: 14, char: '⭐', size: 11 },
            { x: '46%', drop: 22, char: '✦', size: 10 },
            { x: '64%', drop: 12, char: '💫', size: 10 },
            { x: '86%', drop: 26, char: '🌙', size: 12 },
        ].map((s, i) => (
            <div key={i} className="absolute top-full flex flex-col items-center" style={{ left: s.x }}>
                <span style={{ width: 1, height: s.drop, background: PAL.frameSoft }} />
                <span className="leading-none select-none" style={{ fontSize: s.size, color: PAL.fade }}>{s.char}</span>
            </div>
        ))}
    </div>
));

// ─── 角色（呼吸 / 游荡 / 戳一戳念聊天台词 / 夜间飘 Zzz），自治状态不外溢 ─
const Actor = React.memo<{ actorImg: string | undefined; night: boolean; pokeLines: string[]; unread: number; onChat: () => void }>(
    ({ actorImg, night, pokeLines, unread, onChat }) => {
        const [pos, setPos] = useState({ x: 48, y: 80 });
        const [bounce, setBounce] = useState(false);
        const [pokeText, setPokeText] = useState('');
        const pokeIdx = useRef(0); // 台词按顺序循环（最新一条开始往回念）

        // 游荡：≥18s 一次性的 setTimeout 链（无 rAF / 无短 interval），夜里停下休息
        useEffect(() => {
            if (night) return;
            let t: ReturnType<typeof setTimeout>;
            const wander = () => {
                setPos({ x: 22 + Math.random() * 56, y: 70 + Math.random() * 22 });
                t = setTimeout(wander, 18000 + Math.random() * 22000);
            };
            t = setTimeout(wander, 15000);
            return () => clearTimeout(t);
        }, [night]);

        const poke = (e: React.MouseEvent) => {
            e.stopPropagation();
            setBounce(true);
            setTimeout(() => setBounce(false), 450);
            // 从聊天里 ta 最近的回复按顺序循环取一条；一条没有就用兜底短语
            const lines = pokeLines.length > 0 ? pokeLines : POKE_FALLBACK;
            setPokeText(lines[pokeIdx.current % lines.length]);
            pokeIdx.current += 1;
            setTimeout(() => setPokeText(''), 3200);
        };

        // 气泡优先级：戳一戳台词 > 未读提醒
        const bubble = pokeText || (unread > 0 ? `♥ ${unread} 条新消息!` : '');
        const bubbleIsChat = !pokeText && unread > 0;

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
                        willChange: 'transform',
                    }} />
                {night && (
                    <span className="absolute -top-4 right-0 text-[13px] font-bold select-none" style={{ fontFamily: FONT_PX, color: PAL.ink, animation: 'tama-zzz 2.6s ease-in-out infinite' }}>Zzz</span>
                )}
                {bubble && (
                    <div onClick={(e) => { if (bubbleIsChat) { e.stopPropagation(); onChat(); } }}
                        className="absolute bottom-[102%] left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-xl rounded-bl-none max-w-[180px] animate-pop-in"
                        style={{ background: PAL.cream, border: `2px solid ${PAL.frame}`, boxShadow: '0 3px 10px rgba(150,120,200,0.3)', zIndex: 60 }}>
                        <p className="text-[10px] font-bold leading-snug break-words" style={{ fontFamily: FONT_PX, color: PAL.ink }}>{bubble}</p>
                    </div>
                )}
            </div>
        );
    }
);

// ─── 右上角小电子钟：白天=天空底，夜里=星空底 +「夜深啦！」──────────
const StageClock = React.memo<{ hh: string; mm: string; night: boolean }>(({ hh, mm, night }) => (
    <div className="absolute top-2 right-2 z-[72] rounded-xl px-2.5 py-1.5 pointer-events-none select-none"
        style={{
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: '0 3px 10px rgba(120,95,180,0.3)',
            background: night
                ? `linear-gradient(160deg, ${PAL.night} 0%, #575083 100%)`
                : 'linear-gradient(160deg, #bfe0f7 0%, #e8f5fd 100%)',
        }}>
        {night && (
            <>
                <span className="absolute top-[3px] left-[7px] text-[6px]" style={{ color: '#efe8b8', animation: 'tama-twinkle 2.2s ease-in-out infinite' }}>✦</span>
                <span className="absolute bottom-[4px] right-[8px] text-[5px]" style={{ color: '#cdc6f0' }}>✦</span>
            </>
        )}
        <div className="flex items-center gap-1.5" style={{ fontFamily: FONT_PX }}>
            <span className="text-[11px] leading-none">{night ? '🌙' : '☁️'}</span>
            <div className="leading-none">
                <div className="text-[12px] font-bold tabular-nums tracking-[0.06em]" style={{ color: night ? '#f5f2ff' : PAL.ink }}>{hh}:{mm}</div>
                {night && <div className="text-[8px] mt-[2px] tracking-wide" style={{ color: '#cdc6f0', fontFamily: FONT_CN }}>夜深啦！</div>}
            </div>
        </div>
    </div>
));

// ─── 小屋舞台：渐变描边华丽框；props 全为原始值/memo 引用 ────────────
const RoomStage = React.memo<{
    items: RoomItem[]; wallStyle: string; floorStyle: string;
    actorImg: string | undefined; night: boolean; pokeLines: string[]; unread: number;
    hh: string; mm: string;
    onVisit: () => void; onChat: () => void;
}>(({ items, wallStyle, floorStyle, actorImg, night, pokeLines, unread, hh, mm, onVisit, onChat }) => (
    /* 外层：渐变描边圈（粉→蓝紫→淡紫）+ 彩色柔影 */
    <div className="relative flex-1 min-h-0 rounded-[2rem] p-[3px]"
        style={{ background: RIM, boxShadow: '0 8px 24px rgba(160,120,210,0.35)' }}>
        {/* 框上四角小白钻 */}
        {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([r, b], i) => (
            <span key={i} className="absolute w-2 h-2 rotate-45 pointer-events-none z-[80]"
                style={{ [r ? 'right' : 'left']: -3, [b ? 'bottom' : 'top']: -3, background: '#fff', boxShadow: `0 0 6px ${PAL.pink}` } as React.CSSProperties} />
        ))}
        <div onClick={onVisit}
            className="relative w-full h-full rounded-[1.85rem] overflow-hidden cursor-pointer active:opacity-95"
            style={{ border: '2px solid rgba(255,255,255,0.9)', contain: 'layout paint' }}>
            {/* 墙 / 地板（与 RoomApp 同分割线） */}
            <div className="absolute top-0 left-0 w-full h-[65%] z-0" style={{ background: wallStyle }} />
            <div className="absolute bottom-0 left-0 w-full h-[35%] z-0" style={{ background: floorStyle }} />
            <div className="absolute top-[65%] w-full h-6 bg-gradient-to-b from-black/10 to-transparent pointer-events-none z-0" />
            <StageWindow />

            {items.map(item => <StageItem key={item.id} item={item} />)}

            <Actor actorImg={actorImg} night={night} pokeLines={pokeLines} unread={unread} onChat={onChat} />

            {/* ✦LIVE 徽标（渐变粉 + 呼吸小点）+ 角落电子钟 */}
            <div className="absolute top-2 left-2 z-[72] rounded-full px-2.5 py-[4px] pointer-events-none select-none flex items-center gap-1.5"
                style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, border: '1.5px solid rgba(255,255,255,0.85)', boxShadow: '0 3px 8px rgba(234,118,180,0.45)' }}>
                <span className="w-1.5 h-1.5 rounded-full bg-white" style={{ animation: 'tama-twinkle 1.6s ease-in-out infinite' }} />
                <span className="text-[9px] font-bold tracking-[0.16em] text-white" style={{ fontFamily: FONT_PX }}>LIVE</span>
            </div>
            <StageClock hh={hh} mm={mm} night={night} />
        </div>
    </div>
));

// ─── 底部五键 dock（参考稿：CARE / TALK / HOME / ALBUM / SETTINGS）───
const DOCK_GLYPHS: Record<string, React.ReactNode> = {
    heart: <svg viewBox="0 0 24 24" className="w-full h-full" fill="#fff"><path d="M12 21s-7.5-4.9-9.8-9.2C.7 8.9 2.4 5.4 5.7 5.1c1.9-.2 3.7.8 4.7 2.4h3.2c1-1.6 2.8-2.6 4.7-2.4 3.3.3 5 3.8 3.5 6.7C19.5 16.1 12 21 12 21z" transform="scale(0.92) translate(1,1)" /></svg>,
    talk: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3c-1.4 0-2.8-.3-4-.9L3 20l1.2-4.3a8 8 0 0 1-1.2-4.2A8.4 8.4 0 0 1 11.5 3.2 8.4 8.4 0 0 1 21 11.5z" /><circle cx="8.5" cy="11.5" r="0.6" fill="#fff" /><circle cx="12" cy="11.5" r="0.6" fill="#fff" /><circle cx="15.5" cy="11.5" r="0.6" fill="#fff" /></svg>,
    home: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9h13v-9" /><path d="M10 19v-5h4v5" /></svg>,
    album: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="M8 3.5v17" /><path d="M14.2 8.4l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill="#fff" stroke="none" /></svg>,
    gear: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" /></svg>,
};

// 糖果凸键：竖向渐变 + 顶部高光帽 + 白描边 + 彩色投影 + 角落小星
const DockKey: React.FC<{ glyph: string; label: string; top: string; deep: string; badge?: number; onClick: () => void }> = ({ glyph, label, top, deep, badge = 0, onClick }) => (
    <button onClick={onClick} className="flex flex-col items-center gap-1 group active:scale-90 transition-transform">
        <div className="relative w-11 h-11 rounded-[1.05rem] flex items-center justify-center"
            style={{ background: `linear-gradient(180deg, ${top}, ${deep})`, border: '2px solid rgba(255,255,255,0.85)', boxShadow: `0 4px 10px ${deep}66` }}>
            {/* 顶部高光帽（静态渐变） */}
            <div className="absolute top-[4px] left-1/2 -translate-x-1/2 w-[64%] h-[30%] rounded-full pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.6), rgba(255,255,255,0))' }} />
            <span className="absolute top-[3px] right-[5px] text-[7px] pointer-events-none" style={{ color: 'rgba(255,255,255,0.9)' }}>✦</span>
            <div className="w-5 h-5">{DOCK_GLYPHS[glyph]}</div>
            {badge > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[17px] h-[17px] px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                    style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, border: '1.5px solid #fff' }}>{badge > 99 ? '99+' : badge}</span>
            )}
        </div>
        <span className="text-[9px] font-bold tracking-[0.1em]" style={{ fontFamily: FONT_PX, color: PAL.ink }}>{label}</span>
    </button>
);

// ─── 主组件 ───────────────────────────────────────────────────
const TamagotchiHome: React.FC = () => {
    const { openApp, characters, activeCharacterId, setActiveCharacterId, virtualTime, unreadMessages, isDataLoaded, lastMsgTimestamp } = useOS();

    const [stat, setStat] = useState<{ msgCount: number; pokeLines: string[] }>({ msgCount: 0, pokeLines: [] });
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
    useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

    const char: CharacterProfile | null = useMemo(
        () => characters.find(c => c.id === activeCharacterId) || characters[0] || null,
        [characters, activeCharacterId]
    );

    // 取数：消息数（Lv/经验条）+ ta 最近 30 条文字回复（戳一戳台词，最新在前按顺序循环）
    useEffect(() => {
        if (!isDataLoaded || !char) { setStat({ msgCount: 0, pokeLines: [] }); return; }
        DB.getMessagesByCharId(char.id).then(msgs => {
            const visible = msgs.filter(m => m.role !== 'system');
            const lines = visible
                .filter(m => m.role === 'assistant')
                .map(m => m.content.replace(/\[.*?\]/g, '').trim())
                .filter(t => t.length > 0)
                .slice(-30)
                .reverse()
                .map(t => t.length > 42 ? t.slice(0, 42) + '…' : t);
            setStat({ msgCount: visible.length, pokeLines: lines });
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

    const night = isNightHour(virtualTime.hours);
    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');
    const { level, exp, expMax } = deriveStats(stat.msgCount);
    const totalUnread = useMemo(() => Object.values(unreadMessages).reduce((a, b) => a + b, 0), [unreadMessages]);
    const charUnread = char ? (unreadMessages[char.id] || 0) : 0;

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
        <div className="h-full w-full relative z-10 overflow-hidden select-none flex flex-col px-4"
            style={{ color: PAL.ink, fontFamily: FONT_CN, paddingTop: 'calc(var(--safe-top, 0px) + 0.75rem)', paddingBottom: 'calc(var(--safe-bottom, 0px) + 0.9rem)' }}>
            {/* 本皮肤专用 keyframes（只碰 transform/opacity） */}
            <style>{`
                @keyframes tama-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
                @keyframes tama-bounce { 0% { transform: scale(1); } 35% { transform: scale(1.12, 0.9); } 70% { transform: scale(0.95, 1.06); } 100% { transform: scale(1); } }
                @keyframes tama-zzz { 0%,100% { opacity: 0.35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-4px); } }
                @keyframes tama-twinkle { 0%,100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
            `}</style>

            <BackDecor />

            {/* ===== 报头（小头像 + 品牌字 + ⋯）===== */}
            <div className="relative flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    {char && (
                        <div className="w-8 h-8 rounded-full p-[2px] shrink-0" style={{ background: RIM }}>
                            <div className="w-full h-full rounded-full overflow-hidden" style={{ border: '1.5px solid #fff', background: '#fff' }}>
                                <img src={char.avatar} className="w-full h-full object-cover" alt="" loading="lazy" draggable={false} />
                            </div>
                        </div>
                    )}
                    <span className="text-[10px]" style={{ color: PAL.hot }}>✦</span>
                    <span className="text-[13px] font-bold tracking-[0.26em] truncate" style={{ fontFamily: FONT_PX, color: PAL.grape, textShadow: '0 1px 0 rgba(255,255,255,0.9), 0 2px 10px rgba(190,160,255,0.55)' }}>SULLY·GOTCHI</span>
                    <span className="text-[9px] shrink-0" style={{ color: PAL.gold, animation: 'tama-twinkle 2.6s ease-in-out infinite' }}>✦</span>
                </div>
                <div className="rounded-xl p-[2px] shrink-0" style={{ background: RIM, boxShadow: '0 3px 8px rgba(160,120,210,0.3)' }}>
                    <button onClick={() => setDrawerOpen(true)} aria-label="全部应用"
                        className="w-9 h-8 rounded-[0.65rem] flex items-center justify-center active:scale-90 transition-transform"
                        style={{ background: PAL.cream }}>
                        <span className="text-[15px] font-bold leading-none tracking-widest" style={{ fontFamily: FONT_PX, color: PAL.ink }}>⋯</span>
                    </button>
                </div>
            </div>

            {char ? (
                <>
                    <StatusCard hh={hh} mm={mm} level={level} exp={exp} expMax={expMax} charName={char.name} avatar={char.avatar} multiChar={characters.length > 1} onSwitch={switchChar} />

                    {/* ===== 小屋舞台 ===== */}
                    <div className="relative flex-1 min-h-0 flex flex-col mt-3.5">
                        <RoomStage
                            items={items} wallStyle={wallStyle} floorStyle={floorStyle}
                            actorImg={actorImg} night={night} pokeLines={stat.pokeLines} unread={charUnread}
                            hh={hh} mm={mm}
                            onVisit={openRoom} onChat={openChat}
                        />
                        {/* 华丽分节丝带：发丝线 + 星芒 + 文字 */}
                        <div className="flex items-center gap-2 mt-2 shrink-0 px-2">
                            <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, transparent, ${PAL.frame})`, opacity: 0.6 }} />
                            <span className="text-[8px]" style={{ color: PAL.hot }}>✦</span>
                            <span className="text-[9px] tracking-[0.3em] font-bold" style={{ fontFamily: FONT_PX, color: PAL.fade }}>TAP SCREEN TO VISIT</span>
                            <span className="text-[8px]" style={{ color: PAL.hot }}>✦</span>
                            <div className="flex-1 h-px" style={{ background: `linear-gradient(270deg, transparent, ${PAL.frame})`, opacity: 0.6 }} />
                        </div>
                    </div>

                    {/* ===== 五键 dock：渐变描边华丽条 ===== */}
                    <div className="shrink-0 rounded-[1.5rem] p-[2.5px] mt-1.5" style={{ background: RIM, boxShadow: '0 6px 18px rgba(160,120,210,0.35)' }}>
                        <div className="relative rounded-[1.35rem] px-3 pt-2 pb-1.5 flex items-end justify-between"
                            style={{ background: 'rgba(255,255,255,0.88)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.95)' }}>
                            <Sparkles items={[[6, 18, 8, PAL.pink, 0.7], [94, 22, 8, PAL.peri, 0.7], [50, 6, 7, PAL.gold, 0.8, true]]} />
                            <DockKey glyph="heart" label="CARE" top="#f7a8b8" deep="#ee7d9c" onClick={() => openApp(AppID.Date)} />
                            <DockKey glyph="talk" label="TALK" top="#9fdcc0" deep="#5fbf96" badge={totalUnread} onClick={openChat} />
                            {/* 中央 HOME：渐变环 + 悬浮 */}
                            <button onClick={openRoom} className="relative flex flex-col items-center gap-1 -mt-6 active:scale-95 transition-transform">
                                <div className="w-[3.6rem] h-[3.6rem] rounded-[1.3rem] p-[3px]" style={{ background: RIM, boxShadow: '0 6px 16px rgba(234,118,180,0.45)' }}>
                                    <div className="relative w-full h-full rounded-[1.05rem] flex items-center justify-center" style={{ background: `linear-gradient(180deg, #ffffff, ${PAL.cream})`, color: PAL.grape }}>
                                        <div className="absolute top-[3px] left-1/2 -translate-x-1/2 w-[60%] h-[24%] rounded-full pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.9), rgba(255,255,255,0))' }} />
                                        <div className="w-7 h-7">{DOCK_GLYPHS.home}</div>
                                        <span className="absolute -top-1 -right-1 text-[10px]" style={{ color: PAL.gold, animation: 'tama-twinkle 2s ease-in-out infinite' }}>✦</span>
                                    </div>
                                </div>
                                <span className="text-[9px] font-bold tracking-[0.1em]" style={{ fontFamily: FONT_PX, color: PAL.ink }}>HOME</span>
                            </button>
                            <DockKey glyph="album" label="ALBUM" top="#c9b8f2" deep="#a186e0" onClick={() => openApp(AppID.MemoryPalace)} />
                            <DockKey glyph="gear" label="SETTINGS" top="#b8c4ee" deep="#8b9be0" onClick={() => openApp(AppID.Settings)} />
                        </div>
                    </div>
                </>
            ) : (
                /* 零角色兜底：像素小蛋 */
                <div className="relative flex-1 flex flex-col items-center justify-center gap-4">
                    <Sparkles items={[[30, 30, 12, PAL.pink, 0.8, true], [70, 26, 10, PAL.gold, 0.8, true], [24, 62, 9, PAL.peri, 0.7], [76, 66, 11, '#fff', 0.8, true]]} />
                    <div className="w-24 h-28 rounded-[50%_50%_46%_46%/58%_58%_42%_42%]"
                        style={{ background: `linear-gradient(180deg, ${PAL.cream}, #e8ddfb)`, border: `2.5px solid ${PAL.frame}`, boxShadow: '0 8px 20px rgba(160,120,210,0.35)', animation: 'tama-breathe 2.4s ease-in-out infinite' }} />
                    <p className="text-[12px] text-center leading-relaxed" style={{ fontFamily: FONT_PX, color: PAL.fade }}>EMPTY EGG…</p>
                    <button onClick={() => openApp(AppID.Character)} className="px-5 py-2.5 rounded-2xl text-[13px] font-bold text-white active:scale-95 transition-transform"
                        style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, border: '2px solid rgba(255,255,255,0.8)', boxShadow: '0 5px 14px rgba(234,118,180,0.5)', fontFamily: FONT_CN }}>
                        去神经链接领养一只
                    </button>
                </div>
            )}

            {/* ===== 全部应用抽屉（逃生舱口：外观 / 全部 App 都在这） ===== */}
            {drawerOpen && (
                <div className="absolute inset-0 z-40 flex flex-col animate-fade-in" style={{ background: 'rgba(240,235,250,0.97)' }} onClick={() => setDrawerOpen(false)}>
                    <div className="flex items-center justify-between px-6" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1.25rem)', paddingBottom: '0.5rem' }}>
                        <h2 className="text-lg tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.ink }}>全部应用</h2>
                        <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }} aria-label="关闭"
                            className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-transform"
                            style={{ background: '#fff', border: `2px solid ${PAL.frame}` }}>
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
