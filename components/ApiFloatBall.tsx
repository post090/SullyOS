import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Lightning } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import {
    FloatBallConfig, loadFloatBallConfig, saveFloatBallConfig, FLOATBALL_EVENT,
    deriveStations, findActiveStation, Station,
} from '../utils/apiStations';

/**
 * 全局 API 切换悬浮球。
 *   - 挂在 PhoneShell 外壳层，所有 App 之上（toast 之下）
 *   - 点一下弹小面板：站点 / 模型两个下拉，选完即切（写 apiConfig），不用进设置
 *   - 可拖动，松手吸边，位置持久化
 *   - 默认跟随主题色（--primary-hue），可在设置里自定义颜色/大小/透明度
 */
const ApiFloatBall: React.FC = () => {
    const { apiPresets, apiConfig, updateApiConfig, addToast } = useOS();
    const [config, setConfig] = useState<FloatBallConfig>(() => loadFloatBallConfig());
    const [open, setOpen] = useState(false);
    // 拖动中的临时像素位（null = 没在拖，用 config 的吸边位置）
    const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
    const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    // 设置页改配置 → 事件同步过来
    useEffect(() => {
        const onCfg = (e: Event) => setConfig({ ...(e as CustomEvent).detail });
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

    // ─── 拖动 ───
    const onPointerDown = (e: React.PointerEvent) => {
        dragRef.current = { startX: e.clientX, startY: e.clientY, moved: false };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
        d.moved = true;
        setDragPos({ x: e.clientX, y: e.clientY });
    };
    const onPointerUp = (e: React.PointerEvent) => {
        const d = dragRef.current;
        dragRef.current = null;
        if (d?.moved) {
            // 吸边 + 存位置
            const host = rootRef.current?.parentElement;
            const rect = host?.getBoundingClientRect();
            const w = rect?.width || window.innerWidth;
            const h = rect?.height || window.innerHeight;
            const relX = e.clientX - (rect?.left || 0);
            const relY = e.clientY - (rect?.top || 0);
            const side: 'left' | 'right' = relX < w / 2 ? 'left' : 'right';
            const yPct = Math.min(88, Math.max(6, (relY / h) * 100));
            setConfig(saveFloatBallConfig({ side, yPct }));
            setDragPos(null);
        } else {
            setOpen(v => !v);
        }
    };

    if (!config.enabled) return null;

    const ballColor = config.color === 'auto'
        ? `hsla(var(--primary-hue), 68%, 58%, ${config.opacity})`
        : config.color;

    const ballStyle: React.CSSProperties = dragPos
        ? { position: 'absolute', left: dragPos.x - config.size / 2, top: dragPos.y - config.size / 2, transition: 'none' }
        : {
            position: 'absolute',
            top: `${config.yPct}%`,
            ...(config.side === 'left' ? { left: 6 } : { right: 6 }),
            transition: 'left 200ms ease, right 200ms ease, top 200ms ease',
        };

    return (
        <div ref={rootRef} className="absolute inset-0 z-[58] pointer-events-none">
            {/* 球体 */}
            <button
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className="pointer-events-auto rounded-full flex items-center justify-center backdrop-blur-md active:scale-95 touch-none select-none"
                style={{
                    ...ballStyle,
                    width: config.size,
                    height: config.size,
                    background: config.color === 'auto' ? ballColor : undefined,
                    backgroundColor: config.color === 'auto' ? undefined : config.color,
                    opacity: config.color === 'auto' ? undefined : config.opacity,
                    boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
                    border: '1px solid rgba(255,255,255,0.35)',
                }}
                aria-label="切换 API"
            >
                <Lightning size={Math.max(14, config.size * 0.42)} weight="fill" color="#fff" />
            </button>

            {/* 切换面板 */}
            {open && (
                <div className="pointer-events-auto absolute inset-0" onClick={() => setOpen(false)}>
                    <div className="absolute inset-0 bg-black/20" />
                    <div
                        className="absolute left-4 right-4 rounded-3xl bg-white/95 backdrop-blur-xl shadow-2xl border border-white/60 p-4"
                        style={{ top: `min(max(${config.yPct}% - 90px, 12%), 55%)` }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-2 mb-3">
                            <span className="w-7 h-7 rounded-xl flex items-center justify-center" style={{ background: `hsla(var(--primary-hue),68%,58%,0.15)` }}>
                                <Lightning size={14} weight="fill" style={{ color: `hsl(var(--primary-hue),68%,50%)` }} />
                            </span>
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold text-slate-700 leading-tight">快速切换 API</p>
                                <p className="text-[10px] text-slate-400 truncate">
                                    {active ? `当前：${active.name} · ${active.models.find(m => m.model === apiConfig.model)?.label || apiConfig.model}` : '当前配置不在任何站点里'}
                                </p>
                            </div>
                        </div>

                        {stations.length === 0 ? (
                            <p className="text-[11px] text-slate-400 py-3 text-center">还没有站点 — 去「设置 → API 配置」添加</p>
                        ) : (
                            <div className="space-y-2.5">
                                <div>
                                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest pl-1">API 站</label>
                                    <select
                                        value={active?.key || ''}
                                        onChange={e => {
                                            const st = stations.find(s => s.key === e.target.value);
                                            if (st) applyStation(st);
                                        }}
                                        className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 appearance-none"
                                    >
                                        {!active && <option value="">— 选择站点 —</option>}
                                        {stations.map(s => (
                                            <option key={s.key} value={s.key}>{s.name}（{s.models.length} 个模型）</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest pl-1">模型</label>
                                    <select
                                        value={active?.models.find(m => m.model === apiConfig.model)?.presetId || ''}
                                        onChange={e => { if (active) applyStation(active, e.target.value); }}
                                        disabled={!active}
                                        className="w-full mt-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 appearance-none disabled:opacity-40"
                                    >
                                        {!active?.models.some(m => m.model === apiConfig.model) && <option value="">— 选择模型 —</option>}
                                        {(active?.models || []).map(m => (
                                            <option key={m.presetId} value={m.presetId}>{m.label}{m.label !== m.model ? ` · ${m.model}` : ''}</option>
                                        ))}
                                    </select>
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
