/**
 * 玻璃拟态下拉选择器 — 替代原生 <select>（安卓原生弹窗太出戏）。
 * 按钮 + 弹出的圆角磨砂卡片列表，选中项主题色高亮。
 * Settings 的站点/模型下拉、API 悬浮球面板、角色「API 配置」聚合面板共用。
 *
 * 弹出层用 portal 挂到 body（fixed 定位、按钮测距锚定）：
 * 老版本就地 absolute 弹出，在 Modal（overflow-hidden + 内容区 60vh 滚动）里
 * 会被弹窗框剪裁得看不完整。portal 版不受任何祖先 overflow/transform 裁剪，
 * 并且会算可用空间：下方不够就向上翻，高度跟着视口自适应（选项多也能滚完）。
 */
import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

export interface GlassSelectOption {
    value: string;
    label: string;
    sub?: string;       // 次要说明（小字灰色，如模型真实 id / 模型数）
}

interface GlassSelectProps {
    value: string;
    options: GlassSelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    compact?: boolean;  // 悬浮球面板用的小号样式
}

/** 弹层与按钮的间距 / 距视口边缘的安全距离 / 高度上限 */
const GAP = 6;
const EDGE = 12;
const MAX_MENU_H = 320;

interface MenuPos {
    left: number;
    width: number;
    top?: number;      // 向下展开时用
    bottom?: number;   // 向上翻时用（距视口底部）
    maxHeight: number;
}

const GlassSelect: React.FC<GlassSelectProps> = ({ value, options, onChange, placeholder = '请选择…', disabled, compact }) => {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<MenuPos | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    // 打开时按钮测距 → 决定朝向和高度（选项很多时吃满可用空间再内部滚动）
    useLayoutEffect(() => {
        if (!open) { setPos(null); return; }
        const btn = rootRef.current;
        if (!btn) return;
        const r = btn.getBoundingClientRect();
        const vh = window.innerHeight;
        const spaceBelow = vh - r.bottom - GAP - EDGE;
        const spaceAbove = r.top - GAP - EDGE;
        // 下方放得下（或下方比上方大）就向下，否则向上翻
        const downward = spaceBelow >= Math.min(MAX_MENU_H, 200) || spaceBelow >= spaceAbove;
        const avail = Math.max(120, downward ? spaceBelow : spaceAbove);
        setPos({
            left: r.left,
            width: r.width,
            ...(downward ? { top: r.bottom + GAP } : { bottom: vh - r.top + GAP }),
            maxHeight: Math.min(MAX_MENU_H, avail),
        });
    }, [open]);

    // 点弹层和按钮以外的地方 → 收起；页面滚动/尺寸变化 → 收起（锚点会漂移，重开最稳）
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node;
            if (rootRef.current?.contains(t)) return;
            if (menuRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onScroll = (e: Event) => {
            // 弹层内部列表自己滚不算——只有外层页面滚动才收起
            if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
            setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }, [open]);

    const selected = options.find(o => o.value === value);

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen(v => !v)}
                className={`w-full flex items-center justify-between gap-2 text-left transition-all active:scale-[0.99] disabled:opacity-40 ${
                    compact
                        ? 'bg-slate-100/80 rounded-xl px-3 py-2.5 text-sm'
                        : 'bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm shadow-sm'
                }`}
            >
                <span className={`min-w-0 flex-1 truncate font-medium ${selected ? 'text-slate-700' : 'text-slate-400'}`}>
                    {selected ? selected.label : placeholder}
                </span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                    <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                </svg>
            </button>

            {open && pos && createPortal(
                <div
                    ref={menuRef}
                    className="fixed z-[300] rounded-2xl bg-white/95 backdrop-blur-xl shadow-xl border border-slate-200/60 py-1.5 overflow-hidden animate-[fadeIn_120ms_ease-out]"
                    style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
                >
                    <div className="overflow-y-auto no-scrollbar overscroll-contain" style={{ maxHeight: pos.maxHeight }}>
                        {options.length === 0 && (
                            <p className="text-[11px] text-slate-400 text-center py-4">暂无可选项</p>
                        )}
                        {options.map(o => {
                            const isSel = o.value === value;
                            return (
                                <button
                                    key={o.value}
                                    type="button"
                                    onClick={() => { onChange(o.value); setOpen(false); }}
                                    className={`w-full text-left px-3.5 py-2.5 flex items-center gap-2 transition-colors ${
                                        isSel ? 'bg-primary/10' : 'active:bg-slate-100'
                                    }`}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className={`block text-sm truncate ${isSel ? 'font-bold text-primary' : 'font-medium text-slate-600'}`}>{o.label}</span>
                                        {o.sub && <span className="block text-[10px] text-slate-400 font-mono truncate">{o.sub}</span>}
                                    </span>
                                    {isSel && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                                </button>
                            );
                        })}
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};

export default GlassSelect;
