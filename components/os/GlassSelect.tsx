/**
 * 玻璃拟态下拉选择器 — 替代原生 <select>（安卓原生弹窗太出戏）。
 * 按钮 + 就地弹出的圆角磨砂卡片列表，选中项主题色高亮。
 * Settings 的站点/模型下拉和 API 悬浮球面板共用。
 */
import React, { useState, useRef, useEffect } from 'react';

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

const GlassSelect: React.FC<GlassSelectProps> = ({ value, options, onChange, placeholder = '请选择…', disabled, compact }) => {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // 点组件外面 → 收起
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
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

            {open && (
                <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-2xl bg-white/95 backdrop-blur-xl shadow-xl border border-slate-200/60 py-1.5 overflow-hidden animate-[fadeIn_120ms_ease-out]">
                    <div className="max-h-52 overflow-y-auto no-scrollbar">
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
                </div>
            )}
        </div>
    );
};

export default GlassSelect;
