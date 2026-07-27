/**
 * ChatSearchModal — 当前角色聊天记录搜索 + 快速跳转（聊天加号菜单「搜索记录」入口）。
 *
 * 高楼层不卡的三板斧：
 *  1. 打开时一次性从 IndexedDB 全量拉该角色消息（charId 索引，非渲染路径），只存在内存里；
 *  2. 关键词 200ms 防抖 + 单趟线性过滤（万条量级 <10ms），命中列表只渲染前 60 条，
 *     「显示更多」增量放行，不会一次挂几千个 DOM 节点；
 *  3. 点结果走 Chat.tsx 的 handleJumpToMessageInChat：全量加载后用 windowedFocusMsgId
 *     把 displayMessages 收窄到目标 ±25 条再 scrollIntoView，楼再高也只渲染 51 条。
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MagnifyingGlass, X, CircleNotch } from '@phosphor-icons/react';
import { Message } from '../../types';
import { DB } from '../../utils/db';

interface ChatSearchModalProps {
    isOpen: boolean;
    onClose: () => void;
    charId: string;
    charName: string;
    userName: string;
    onJump: (messageId: number) => void;
}

const PAGE = 60;

/** 命中片段：关键词前后各截一段，配合 <mark> 高亮 */
const makeSnippet = (content: string, kw: string): { before: string; hit: string; after: string } => {
    const idx = content.toLowerCase().indexOf(kw.toLowerCase());
    if (idx < 0) return { before: content.slice(0, 60), hit: '', after: '' };
    const start = Math.max(0, idx - 24);
    return {
        before: (start > 0 ? '…' : '') + content.slice(start, idx),
        hit: content.slice(idx, idx + kw.length),
        after: content.slice(idx + kw.length, idx + kw.length + 42) + (idx + kw.length + 42 < content.length ? '…' : ''),
    };
};

/** 表情/图片/base64 等非文字内容不参与搜索 */
const isSearchable = (m: Message): boolean => {
    if (typeof m.content !== 'string' || !m.content.trim()) return false;
    if (m.type === 'emoji' || m.type === 'image') return false;
    if (m.content.startsWith('data:')) return false;
    return true;
};

const ChatSearchModal: React.FC<ChatSearchModalProps> = ({ isOpen, onClose, charId, charName, userName, onJump }) => {
    const [input, setInput] = useState('');
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(false);
    const [visibleN, setVisibleN] = useState(PAGE);
    const allRef = useRef<Message[]>([]);
    const [loadedAt, setLoadedAt] = useState(0); // 触发 useMemo 重算的信号
    const inputRef = useRef<HTMLInputElement>(null);

    // 打开时全量拉一次该角色消息（含已归档处理的），关掉即弃
    useEffect(() => {
        if (!isOpen) return;
        setInput(''); setQuery(''); setVisibleN(PAGE);
        setLoading(true);
        let dead = false;
        void (async () => {
            try {
                const all = await DB.getMessagesByCharId(charId, true);
                if (!dead) { allRef.current = all; setLoadedAt(Date.now()); }
            } catch { if (!dead) allRef.current = []; }
            finally { if (!dead) setLoading(false); }
        })();
        // 弹出后自动聚焦输入框
        window.setTimeout(() => inputRef.current?.focus(), 250);
        return () => { dead = true; };
    }, [isOpen, charId]);

    // 200ms 防抖
    useEffect(() => {
        const t = window.setTimeout(() => { setQuery(input.trim()); setVisibleN(PAGE); }, 200);
        return () => window.clearTimeout(t);
    }, [input]);

    // 单趟过滤（新→旧），记录楼层号（1-based，旧→新方向）
    const results = useMemo(() => {
        if (!query) return [] as Array<{ m: Message; floor: number }>;
        const kw = query.toLowerCase();
        const all = allRef.current;
        const out: Array<{ m: Message; floor: number }> = [];
        for (let i = all.length - 1; i >= 0; i--) {
            const m = all[i];
            if (!isSearchable(m)) continue;
            if (m.content.toLowerCase().includes(kw)) out.push({ m, floor: i + 1 });
        }
        return out;
    }, [query, loadedAt]);

    if (!isOpen) return null;

    const shown = results.slice(0, visibleN);

    return (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center animate-fade-in">
            <div className="absolute inset-0 bg-black/40" onClick={onClose} />
            <div className="relative w-full max-w-md h-[82vh] bg-white rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl flex flex-col overflow-hidden animate-slide-up">
                {/* 头部 + 搜索框 */}
                <div className="px-5 pt-5 pb-3 border-b border-slate-100">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-base font-black text-slate-800">搜索聊天记录</h3>
                        <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 active:scale-90 transition-transform">
                            <X className="w-4 h-4" weight="bold" />
                        </button>
                    </div>
                    <div className="flex items-center gap-2 bg-slate-100 rounded-2xl px-3.5 py-2.5">
                        <MagnifyingGlass className="w-4 h-4 text-slate-400 flex-shrink-0" weight="bold" />
                        <input
                            ref={inputRef}
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            placeholder={`搜「${charName}」的聊天记录…`}
                            className="flex-1 bg-transparent text-sm text-slate-700 placeholder:text-slate-400 outline-none"
                        />
                        {input && (
                            <button onClick={() => setInput('')} className="text-slate-400 active:scale-90">
                                <X className="w-3.5 h-3.5" weight="bold" />
                            </button>
                        )}
                    </div>
                    {query && !loading && (
                        <p className="text-[10px] text-slate-400 mt-2 pl-1">
                            共 {results.length} 条命中 · 全部 {allRef.current.length} 条消息
                        </p>
                    )}
                </div>

                {/* 结果列表 */}
                <div className="flex-1 overflow-y-auto no-scrollbar">
                    {loading && (
                        <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
                            <CircleNotch className="w-6 h-6 animate-spin" weight="bold" />
                            <span className="text-xs">正在载入聊天记录…</span>
                        </div>
                    )}
                    {!loading && !query && (
                        <div className="flex flex-col items-center justify-center py-16 text-slate-300 gap-2">
                            <MagnifyingGlass className="w-8 h-8" weight="light" />
                            <span className="text-xs text-slate-400">输入关键词，点结果直接跳到那层楼</span>
                        </div>
                    )}
                    {!loading && query && results.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-16 text-slate-300 gap-2">
                            <span className="text-2xl">🫥</span>
                            <span className="text-xs text-slate-400">没搜到「{query}」</span>
                        </div>
                    )}
                    {!loading && shown.map(({ m, floor }) => {
                        const snip = makeSnippet(m.content, query);
                        const who = m.role === 'user' ? userName : (m.role === 'assistant' ? charName : '系统');
                        const time = new Date(m.timestamp).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                        return (
                            <button
                                key={m.id}
                                onClick={() => onJump(m.id)}
                                className="w-full text-left px-5 py-3 border-b border-slate-50 active:bg-slate-50 transition-colors"
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <span className={`text-[10px] font-bold ${m.role === 'user' ? 'text-blue-500' : 'text-violet-500'}`}>{who}</span>
                                    <span className="text-[9px] text-slate-400">{time} · 第 {floor} 层</span>
                                </div>
                                <p className="text-xs text-slate-600 leading-relaxed break-all">
                                    {snip.before}
                                    {snip.hit && <mark className="bg-amber-200 text-slate-800 rounded px-0.5">{snip.hit}</mark>}
                                    {snip.after}
                                </p>
                            </button>
                        );
                    })}
                    {!loading && results.length > visibleN && (
                        <button
                            onClick={() => setVisibleN(n => n + PAGE)}
                            className="w-full py-3.5 text-xs font-bold text-blue-500 active:bg-slate-50"
                        >
                            显示更多（还有 {results.length - visibleN} 条）
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ChatSearchModal;
