import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Lightning } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import {
    FloatBallConfig, loadFloatBallConfig, saveFloatBallConfig, FLOATBALL_EVENT,
    deriveStations, findActiveStation, Station,
} from '../utils/apiStations';
import { clampBubblePos, resolveInsets, resolveSafeTopInset } from '../utils/floatingBallBounds';
import { isIOSStandaloneWebApp, readSafeAreaInsets } from '../utils/iosStandalone';
import GlassSelect from './os/GlassSelect';

/**
 * 全局 API 切换悬浮球。
 *   - 挂在 PhoneShell 外壳层，所有 App 之上（toast 之下）
 *   - 手感对齐音乐悬浮球（GlobalMiniPlayer）：按下记指尖偏移、自由摆放不吸边、
 *     clampBubblePos 防钻刘海/home 条、长按 0.6s 本次会话隐藏
 *   - 点一下弹小面板（窄卡片，贴球所在侧）：站点 / 模型两个玻璃下拉，选完即切
 *   - 默认跟随主题色（--primary-hue），可在设置里自定义颜色/大小/透明度
 */

const HIDDEN_KEY = 'apiFloatBall.hidden.v1';
const DRAG_THRESHOLD = 4;   // 同音乐球：超过 4px 位移算拖动，不触发点击
const PANEL_W = 232;        // 面板宽度（窄卡片）

// 顶/底安全区：复用音乐球的合成逻辑（外壳 padding + 真机刘海取大）
const computeInsets = (parent: HTMLElement): { insetTop: number; insetBottom: number } => {
    const cs = window.getComputedStyle(parent);
    const standaloneSafeTop = parseFloat(
        window.getComputedStyle(document.documentElement).getPropertyValue('--standalone-safe-area-top'),
    ) || 0;
    const safeTop = resolveSafeTopInset({
        standaloneSafeTop,
        probedSafeTop: readSafeAreaInsets().top || 0,
        isIOSStandalone: isIOSStandaloneWebApp(),
    });
    return resolveInsets({
        padTop: parseFloat(cs.paddingTop) || 0,
        padBottom: parseFloat(cs.paddingBottom) || 0,
        safeTop,
    });
};

const ApiFloatBall: React.FC = () => {
    const { apiPresets, apiConfig, updateApiConfig, addToast } = useOS();
    const [config, setConfig] = useState<FloatBallConfig>(() => loadFloatBallConfig());
    const [open, setOpen] = useState(false);
    const [panel, setPanel] = useState<{ side: 'left' | 'right'; top: number }>({ side: 'right', top: 120 });
    // 拖动中的实时像素位（null = 没在拖，用 config 的持久化位置）
    const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
    const [hidden, setHidden] = useState<boolean>(() => {
        try { return sessionStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
    });

    const rootRef = useRef<HTMLDivElement>(null);
    const dragState = useRef<{
        startX: number; startY: number;
        offX: number; offY: number;       // 指尖相对球左上角的偏移 — 拖起来球不瞬移
        parentW: number; parentH: number;
        insetTop: number; insetBottom: number;
        moved: boolean;
        last: { x: number; y: number } | null;
    } | null>(null);
    const longPressTimer = useRef<number | null>(null);

    // 设置页改配置 → 事件同步过来；重新开启开关时顺带解除会话隐藏
    useEffect(() => {
        const onCfg = (e: Event) => {
            const next = (e as CustomEvent).detail as FloatBallConfig;
            setConfig({ ...next });
            if (next.enabled) {
                setHidden(false);
                try { sessionStorage.removeItem(HIDDEN_KEY); } catch {}
            }
        };
        window.addEventListener(FLOATBALL_EVENT, onCfg);
        return () => window.removeEventListener(FLOATBALL_EVENT, onCfg);
    }, []);

    const stations = deriveStations(apiPresets);
    const active = findActiveStation(stations, apiConfig);

    const applyStation = useCallback((st: Station, presetId?: string) => {
        const m = (presetId ? st.models.find(x => x.presetId === presetId) : undefined)
            // 站内没指定模型 → 优先保当前模型（同站切换时），否则用第一个
            || st.models.find(x => x.model === apiConfig.model)
            || st.models[0];
        if (!m) return;
        updateApiConfig({ baseUrl: st.baseUrl, apiKey: st.apiKey, model: m.model, stream: m.stream, temperature: m.temperature });
        addToast(`已切换 · ${st.name}（${m.label}）`, 'success');
    }, [apiConfig.model, updateApiConfig, addToast]);

    // 球当前的像素位（没有 x/y 的旧配置按 side/yPct 换算一次）
    const ballXY = (parentW: number, parentH: number): { x: number; y: number } => {
        if (config.x != null && config.y != null) return { x: config.x, y: config.y };
        return {
            x: config.side === 'left' ? 8 : parentW - config.size - 8,
            y: (config.yPct / 100) * parentH,
        };
    };

    const hide = useCallback(() => {
        setHidden(true);
        setOpen(false);
        try { sessionStorage.setItem(HIDDEN_KEY, '1'); } catch {}
        addToast('悬浮球已隐藏（本次会话）— 设置里重新开关可立即恢复', 'info');
    }, [addToast]);

    // ─── 拖动（音乐球同款配方）───
    const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        const host = rootRef.current?.parentElement;
        if (!host) return;
        const parentRect = host.getBoundingClientRect();
        const ballRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        dragState.current = {
            startX: e.clientX,
            startY: e.clientY,
            offX: e.clientX - ballRect.left,
            offY: e.clientY - ballRect.top,
            parentW: parentRect.width,
            parentH: parentRect.height,
            ...computeInsets(host),
            moved: false,
            last: null,
        };
        // 长按隐藏（拖动会取消）
        if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
        longPressTimer.current = window.setTimeout(() => {
            if (dragState.current && !dragState.current.moved) {
                hide();
                dragState.current = null;
            }
        }, 600);
        try { (e.currentTarget as any).setPointerCapture?.(e.pointerId); } catch {}
    };

    const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
        const ds = dragState.current;
        const host = rootRef.current?.parentElement;
        if (!ds || !host) return;
        const dx = e.clientX - ds.startX;
        const dy = e.clientY - ds.startY;
        if (!ds.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            ds.moved = true;
            if (longPressTimer.current) {
                window.clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
            }
        }
        if (!ds.moved) return;
        const parentRect = host.getBoundingClientRect();
        const next = clampBubblePos(
            e.clientX - parentRect.left - ds.offX,
            e.clientY - parentRect.top - ds.offY,
            { parentW: ds.parentW, parentH: ds.parentH, insetTop: ds.insetTop, insetBottom: ds.insetBottom, bubble: config.size },
        );
        ds.last = next;
        setDragPos(next);
    };

    const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
        const ds = dragState.current;
        dragState.current = null;
        if (longPressTimer.current) {
            window.clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
        try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
        if (!ds) return;
        if (ds.moved) {
            // 自由摆放：松手停在原地（不吸边），像素位持久化
            const p = ds.last;
            if (p) setConfig(saveFloatBallConfig({ x: p.x, y: p.y }));
            setDragPos(null);
        } else {
            togglePanel();
        }
    };

    // 打开面板前算好位置：贴球所在侧，垂直跟着球走（clamp 防溢出）
    const togglePanel = () => {
        if (open) { setOpen(false); return; }
        const host = rootRef.current?.parentElement;
        const w = host?.clientWidth || window.innerWidth;
        const h = host?.clientHeight || window.innerHeight;
        const { x, y } = ballXY(w, h);
        const side: 'left' | 'right' = x + config.size / 2 < w / 2 ? 'left' : 'right';
        const top = Math.min(Math.max(y - 60, 56), Math.max(56, h - 300));
        setPanel({ side, top });
        setOpen(true);
    };

    if (!config.enabled || hidden) return null;

    const ballColor = config.color === 'auto'
        ? `hsla(var(--primary-hue), 68%, 58%, ${config.opacity})`
        : config.color;

    const positional: React.CSSProperties = dragPos
        ? { left: dragPos.x, top: dragPos.y, transition: 'none' }
        : (config.x != null && config.y != null)
            ? { left: config.x, top: config.y }
            : {
                top: `${config.yPct}%`,
                ...(config.side === 'left' ? { left: 8 } : { right: 8 }),
            };

    return (
        <div ref={rootRef} className="absolute inset-0 z-[58] pointer-events-none">
            {/* 球体 */}
            <button
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onContextMenu={e => e.preventDefault()}
                className="pointer-events-auto absolute rounded-full flex items-center justify-center backdrop-blur-md active:scale-95 transition-transform touch-none select-none"
                style={{
                    ...positional,
                    width: config.size,
                    height: config.size,
                    background: config.color === 'auto' ? ballColor : undefined,
                    backgroundColor: config.color === 'auto' ? undefined : config.color,
                    opacity: config.color === 'auto' ? undefined : config.opacity,
                    boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                    border: '1px solid rgba(255,255,255,0.35)',
                }}
                aria-label="切换 API（点击展开，拖动移位，长按隐藏）"
                title="点击展开 · 拖动移位 · 长按隐藏"
            >
                <Lightning size={Math.max(14, config.size * 0.42)} weight="fill" color="#fff" />
            </button>

            {/* 切换面板 — 窄卡片，贴球所在侧 */}
            {open && (
                <div className="pointer-events-auto absolute inset-0" onClick={() => setOpen(false)}>
                    <div
                        className="absolute rounded-3xl bg-white/95 backdrop-blur-xl shadow-2xl border border-white/60 p-3.5"
                        style={{
                            width: PANEL_W,
                            top: panel.top,
                            ...(panel.side === 'left' ? { left: 12 } : { right: 12 }),
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-2 mb-3">
                            <span className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0" style={{ background: `hsla(var(--primary-hue),68%,58%,0.15)` }}>
                                <Lightning size={14} weight="fill" style={{ color: `hsl(var(--primary-hue),68%,50%)` }} />
                            </span>
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold text-slate-700 leading-tight">快速切换 API</p>
                                <p className="text-[10px] text-slate-400 truncate">
                                    {active ? `${active.name} · ${active.models.find(m => m.model === apiConfig.model)?.label || apiConfig.model}` : '当前配置不在任何站点里'}
                                </p>
                            </div>
                        </div>

                        {stations.length === 0 ? (
                            <p className="text-[11px] text-slate-400 py-3 text-center">还没有站点 — 去「设置 → API 配置」添加</p>
                        ) : (
                            <div className="space-y-2.5">
                                <div>
                                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1 block">API 站</label>
                                    <GlassSelect
                                        compact
                                        value={active?.key || ''}
                                        placeholder="— 选择站点 —"
                                        options={stations.map(s => ({ value: s.key, label: s.name, sub: `${s.models.length} 个模型` }))}
                                        onChange={v => { const st = stations.find(s => s.key === v); if (st) applyStation(st); }}
                                    />
                                </div>
                                <div>
                                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1 block">模型</label>
                                    <GlassSelect
                                        compact
                                        disabled={!active}
                                        value={active?.models.find(m => m.model === apiConfig.model)?.presetId || ''}
                                        placeholder="— 选择模型 —"
                                        options={(active?.models || []).map(m => ({ value: m.presetId, label: m.label, sub: m.label !== m.model ? m.model : undefined }))}
                                        onChange={v => { if (active) applyStation(active, v); }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ApiFloatBall;
