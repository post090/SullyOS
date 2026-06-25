import React, { useState } from 'react';
import { DateObservation } from '../../types';

/**
 * 「观测协议 OBSERVE」全息观测面板。
 * 不是土味状态栏——做成中二一点的全息 HUD：暗色玻璃 + 青紫描边 + 四角括号 + 扫描线。
 * 把 char 此刻的 时间 / 地点 / 状态 / 细节 全方位摊开给用户看。
 *
 * variant:
 *   - 'hud'  : 立绘模式下悬浮在左上角，可折叠；右上角有"放大"键展开独立全屏查看
 *   - 'card' : 阅读（小说）模式下内嵌在每条回复正文上方
 */

interface ObserveHUDProps {
    observation: DateObservation;
    variant?: 'hud' | 'card';
    charName?: string;
}

const FIELDS: { key: keyof DateObservation; glyph: string; en: string; cn: string }[] = [
    { key: 'time', glyph: '◷', en: 'TIME', cn: '时间' },
    { key: 'place', glyph: '⌖', en: 'SITE', cn: '地点' },
    { key: 'state', glyph: '❖', en: 'STATE', cn: '状态' },
    { key: 'detail', glyph: '✶', en: 'TRACE', cn: '细节' },
];

// 青紫渐变描边 + 微光，靠内联 style 实现（Tailwind 不方便表达渐变 border + glow）
const GLOW_BORDER: React.CSSProperties = {
    border: '1px solid transparent',
    backgroundImage:
        'linear-gradient(rgba(8,12,20,0.72),rgba(8,12,20,0.72)),linear-gradient(135deg,#7dd3fc55,#a78bfa66 45%,#f472b655)',
    backgroundOrigin: 'border-box',
    backgroundClip: 'padding-box, border-box',
    boxShadow: '0 0 18px rgba(125,211,252,0.10), inset 0 0 24px rgba(167,139,250,0.06)',
};

/** 四角的科技感括号 */
const CornerBrackets: React.FC = () => (
    <>
        <span className="absolute top-0 left-0 w-3 h-3 border-t border-l border-cyan-300/60 rounded-tl-sm" />
        <span className="absolute top-0 right-0 w-3 h-3 border-t border-r border-fuchsia-300/50 rounded-tr-sm" />
        <span className="absolute bottom-0 left-0 w-3 h-3 border-b border-l border-violet-300/50 rounded-bl-sm" />
        <span className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-cyan-300/60 rounded-br-sm" />
    </>
);

const ObserveRow: React.FC<{ glyph: string; en: string; cn: string; value: string }> = ({ glyph, en, cn, value }) => (
    <div className="flex items-start gap-2.5 py-1.5">
        <span className="mt-0.5 text-cyan-300/90 text-sm leading-none w-4 text-center shrink-0 drop-shadow-[0_0_4px_rgba(125,211,252,0.5)]">{glyph}</span>
        <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
                <span className="text-[8px] font-bold tracking-[0.25em] text-cyan-200/60">{en}</span>
                <span className="text-[9px] text-violet-200/40">{cn}</span>
            </div>
            <p className="text-[12px] leading-snug text-slate-100/90 tracking-wide whitespace-pre-wrap break-words">{value}</p>
        </div>
    </div>
);

const PanelHeader: React.FC<{ charName?: string; right?: React.ReactNode }> = ({ charName, right }) => (
    <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-300 opacity-70 animate-ping" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-300" />
            </span>
            <span className="text-[10px] font-bold tracking-[0.34em] text-cyan-100/90">OBSERVE</span>
            <span className="text-[9px] tracking-[0.2em] text-violet-200/40 truncate">观测协议{charName ? ` · ${charName}` : ''}</span>
        </div>
        {right}
    </div>
);

const ObserveHUD: React.FC<ObserveHUDProps> = ({ observation, variant = 'hud', charName }) => {
    const rows = FIELDS.filter(f => (observation[f.key] || '').trim());
    if (rows.length === 0) return null;

    const [collapsed, setCollapsed] = useState(false);
    const [expanded, setExpanded] = useState(false); // 独立全屏查看
    const stop = (e: React.MouseEvent) => e.stopPropagation();

    const body = (dense: boolean) => (
        <div className={dense ? 'px-3 py-1' : 'px-4 py-2'}>
            {rows.map(f => (
                <ObserveRow key={f.key} glyph={f.glyph} en={f.en} cn={f.cn} value={(observation[f.key] || '').trim()} />
            ))}
        </div>
    );

    // ── 阅读模式内嵌卡片 ──
    if (variant === 'card') {
        return (
            <div onClick={stop} className="relative rounded-xl overflow-hidden mb-3 animate-fade-in" style={GLOW_BORDER}>
                <CornerBrackets />
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/40 to-transparent" />
                <PanelHeader charName={charName} />
                {body(false)}
            </div>
        );
    }

    // ── 立绘模式悬浮 HUD ──
    return (
        <>
            <div
                onClick={stop}
                className="control-panel relative w-[208px] rounded-xl overflow-hidden animate-fade-in"
                style={GLOW_BORDER}
            >
                <CornerBrackets />
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/50 to-transparent" />
                <PanelHeader
                    charName={charName}
                    right={
                        <div className="flex items-center gap-1 shrink-0">
                            <button
                                onClick={() => setExpanded(true)}
                                aria-label="放大查看"
                                className="w-5 h-5 rounded-md flex items-center justify-center text-cyan-200/70 hover:text-cyan-100 hover:bg-white/10 transition-colors active:scale-90"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M20.25 20.25v-4.5m0 4.5h-4.5m4.5 0L15 15M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75v4.5m0-4.5h-4.5m4.5 0L15 9" /></svg>
                            </button>
                            <button
                                onClick={() => setCollapsed(c => !c)}
                                aria-label={collapsed ? '展开' : '折叠'}
                                className="w-5 h-5 rounded-md flex items-center justify-center text-cyan-200/70 hover:text-cyan-100 hover:bg-white/10 transition-colors active:scale-90"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={`w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-180'}`}><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
                            </button>
                        </div>
                    }
                />
                {!collapsed && (
                    <>
                        {body(true)}
                        {/* 扫描线 */}
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-cyan-300/5 to-transparent" />
                    </>
                )}
            </div>

            {/* 独立全屏查看空间 */}
            {expanded && (
                <div
                    onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
                    className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm animate-fade-in"
                >
                    <div onClick={stop} className="relative w-full max-w-sm rounded-2xl overflow-hidden" style={GLOW_BORDER}>
                        <CornerBrackets />
                        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
                        <PanelHeader
                            charName={charName}
                            right={
                                <button
                                    onClick={() => setExpanded(false)}
                                    aria-label="关闭"
                                    className="w-6 h-6 rounded-md flex items-center justify-center text-cyan-200/70 hover:text-cyan-100 hover:bg-white/10 transition-colors active:scale-90"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                </button>
                            }
                        />
                        <div className="px-5 py-3">
                            {rows.map(f => (
                                <div key={f.key} className="py-2.5 border-b border-white/5 last:border-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-cyan-300/90 text-base leading-none drop-shadow-[0_0_5px_rgba(125,211,252,0.5)]">{f.glyph}</span>
                                        <span className="text-[9px] font-bold tracking-[0.3em] text-cyan-200/70">{f.en}</span>
                                        <span className="text-[10px] text-violet-200/50">{f.cn}</span>
                                    </div>
                                    <p className="text-[14px] leading-relaxed text-slate-100/95 tracking-wide whitespace-pre-wrap break-words pl-6">{(observation[f.key] || '').trim()}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

export default ObserveHUD;
