/**
 * 备忘录 App — 用户视角。
 *
 * 每个角色有独立的备忘录（最多 10 条），用户在这里可看可改可删。
 * AI 在单聊里自己也能改，这里就是用户视角的同步面板。
 *
 * 数据随角色走（CharacterProfile.memos），不单独建 store —— 落库通过 updateCharacter
 * 触发 OSContext 内的 DB.saveCharacter，IndexedDB 同步更新。
 */

import React, { useState, useMemo, useEffect } from 'react';
import { useOS } from '../context/OSContext';
import {
    ArrowLeft,
    Plus,
    NotePencil,
    CheckCircle,
    Circle,
    Trash,
    PencilSimple,
    Notebook,
    Tag,
    Clock,
} from '@phosphor-icons/react';
import { CharacterProfile, CharacterMemo } from '../types';
import {
    MEMO_MAX_COUNT,
    MEMO_MAX_CONTENT_LEN,
    MEMO_MAX_TAGS,
    MEMO_MAX_TAG_LEN,
    userAddMemo,
    userEditMemo,
    userDeleteMemo,
} from '../utils/memos';
import {
    CharacterGroupFilterBar,
    filterCharactersByGroup,
    GROUP_FILTER_ALL,
} from '../components/character/CharacterGroupFilter';
import Modal from '../components/os/Modal';

// ─── 时间格式化 ──────────────────────────────────────────────
const fmtTime = (ts: number): string =>
    new Date(ts).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

const fmtRelative = (ts: number): string => {
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    return fmtTime(ts);
};

// ─── 类型 / 状态标签 ─────────────────────────────────────────
const TypeBadge: React.FC<{ memo: CharacterMemo }> = ({ memo }) => {
    const isTodo = memo.type === 'todo';
    const isDone = memo.status === 'done';
    if (isTodo) {
        return (
            <span
                className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                    isDone
                        ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                }`}
            >
                {isDone ? <CheckCircle size={11} weight="fill" /> : <Circle size={11} />}
                {isDone ? '已完成' : '待办'}
            </span>
        );
    }
    return (
        <span
            className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                isDone
                    ? 'bg-slate-100 text-slate-400 border-slate-200 line-through'
                    : 'bg-sky-50 text-sky-600 border-sky-200'
            }`}
        >
            <NotePencil size={11} weight="fill" />
            备忘
        </span>
    );
};

// ─── 编辑 / 新建 Modal 内部表单 ─────────────────────────────
interface EditorState {
    id?: string; // 有 id = 编辑，无 = 新建
    content: string;
    type: 'note' | 'todo';
    status: 'active' | 'done';
    tags: string[]; // 已解析的 tag 数组
    tagsInput: string; // 输入框里的逗号分隔串
}

const emptyEditor = (): EditorState => ({
    content: '',
    type: 'note',
    status: 'active',
    tags: [],
    tagsInput: '',
});

const editorFromMemo = (m: CharacterMemo): EditorState => ({
    id: m.id,
    content: m.content,
    type: m.type,
    status: m.status,
    tags: [...(m.tags || [])],
    tagsInput: (m.tags || []).join(', '),
});

const parseTagsInput = (s: string): string[] =>
    s
        .split(/[,，]/)
        .map(t => t.trim().replace(/^#/, '').slice(0, MEMO_MAX_TAG_LEN))
        .filter(Boolean)
        .slice(0, MEMO_MAX_TAGS);

// ─── App 主体 ───────────────────────────────────────────────
const MemoApp: React.FC = () => {
    const {
        closeApp,
        characters,
        activeCharacterId,
        characterGroups,
        updateCharacter,
        addToast,
    } = useOS();

    const [mode, setMode] = useState<'list' | 'detail'>('list');
    const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
    const [groupFilter, setGroupFilter] = useState<string>(GROUP_FILTER_ALL);

    // 编辑 / 新建 Modal 状态
    const [editorOpen, setEditorOpen] = useState(false);
    const [editor, setEditor] = useState<EditorState>(emptyEditor());

    // 删除确认 Modal
    const [deletingId, setDeletingId] = useState<string | null>(null);

    // 打开时如果有当前角色，直接进该角色的备忘录视图（从聊天/通话里跳过来的常见路径）
    useEffect(() => {
        if (activeCharacterId && characters.some(c => c.id === activeCharacterId)) {
            setSelectedCharId(activeCharacterId);
            setMode('detail');
        }
        // 仅初始挂载时跑一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ─── 派生 ────────────────────────────────────
    const selectedChar = useMemo(
        () => characters.find(c => c.id === selectedCharId) || null,
        [characters, selectedCharId],
    );

    const filteredChars = useMemo(
        () => filterCharactersByGroup(characters, characterGroups, groupFilter),
        [characters, characterGroups, groupFilter],
    );

    // ─── 操作 ────────────────────────────────────
    const handleSelectChar = (c: CharacterProfile) => {
        setSelectedCharId(c.id);
        setMode('detail');
    };

    const handleBack = () => {
        setMode('list');
        setSelectedCharId(null);
    };

    const openNewEditor = () => {
        if (!selectedChar) return;
        if ((selectedChar.memos || []).length >= MEMO_MAX_COUNT) {
            addToast(`备忘录已满 ${MEMO_MAX_COUNT} 条上限，先删一条再新建`, 'info');
            return;
        }
        setEditor(emptyEditor());
        setEditorOpen(true);
    };

    const openEditEditor = (m: CharacterMemo) => {
        setEditor(editorFromMemo(m));
        setEditorOpen(true);
    };

    const handleSaveEditor = async () => {
        if (!selectedChar) return;
        const content = editor.content.trim();
        if (!content) {
            addToast('内容不能为空', 'error');
            return;
        }
        const tags = parseTagsInput(editor.tagsInput);

        if (editor.id) {
            // 编辑
            updateCharacter(selectedChar.id, prev => ({
                memos: userEditMemo(prev, editor.id!, {
                    content,
                    type: editor.type,
                    status: editor.status,
                    tags,
                }),
            }));
            addToast('备忘录已更新', 'success');
        } else {
            // 新建
            const result = userAddMemo(selectedChar, content, editor.type, tags);
            if (!result.added) {
                addToast('备忘录已满，无法新增', 'error');
                return;
            }
            updateCharacter(selectedChar.id, { memos: result.newMemos });
            addToast('已添加备忘录', 'success');
        }
        setEditorOpen(false);
    };

    const handleToggleDone = (m: CharacterMemo) => {
        if (!selectedChar) return;
        updateCharacter(selectedChar.id, prev => ({
            memos: userEditMemo(prev, m.id, {
                status: m.status === 'done' ? 'active' : 'done',
            }),
        }));
    };

    const handleConfirmDelete = () => {
        if (!selectedChar || !deletingId) return;
        updateCharacter(selectedChar.id, prev => ({
            memos: userDeleteMemo(prev, deletingId),
        }));
        setDeletingId(null);
        addToast('已删除', 'success');
    };

    // ─── 渲染：角色列表 ──────────────────────────
    const renderList = () => (
        <div className="flex-1 overflow-y-auto">
            <div className="px-4 pt-3 pb-2">
                <CharacterGroupFilterBar
                    characters={characters}
                    groups={characterGroups}
                    value={groupFilter}
                    onChange={setGroupFilter}
                />
            </div>
            <div className="px-4 pb-6 space-y-2.5">
                {filteredChars.length === 0 && (
                    <div className="text-center text-stone-400 text-sm py-12 font-serif">
                        没有角色
                    </div>
                )}
                {filteredChars.map(c => {
                    const memos = c.memos || [];
                    const lastUpdate = memos.length > 0
                        ? Math.max(...memos.map(m => m.updatedAt))
                        : 0;
                    const pendingTodo = memos.filter(m => m.type === 'todo' && m.status === 'active').length;
                    return (
                        <button
                            key={c.id}
                            onClick={() => handleSelectChar(c)}
                            className="w-full bg-[#fbf7ec] hover:bg-[#f7f0df] active:scale-[0.98] transition-all rounded-2xl border border-stone-300/60 shadow-sm px-4 py-3 text-left"
                        >
                            <div className="flex items-center gap-3">
                                {c.avatar ? (
                                    <img
                                        src={c.avatar}
                                        alt={c.name}
                                        className="w-11 h-11 rounded-full object-cover border border-stone-300 shrink-0"
                                    />
                                ) : (
                                    <div className="w-11 h-11 rounded-full bg-stone-300 flex items-center justify-center text-stone-600 font-bold text-lg shrink-0">
                                        {c.name?.[0] || '?'}
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="font-bold text-stone-800 truncate">{c.name}</span>
                                        <span className="shrink-0 text-[11px] font-mono text-stone-500 bg-stone-200/70 rounded-full px-2 py-0.5">
                                            {memos.length}/{MEMO_MAX_COUNT}
                                        </span>
                                    </div>
                                    <div className="text-xs text-stone-500 mt-0.5 truncate">
                                        {memos.length === 0
                                            ? '还没有备忘录'
                                            : pendingTodo > 0
                                                ? `${pendingTodo} 个待办未完成 · 最后修改 ${fmtRelative(lastUpdate)}`
                                                : `最后修改 ${fmtRelative(lastUpdate)}`}
                                    </div>
                                </div>
                                <ArrowLeft
                                    size={16}
                                    weight="bold"
                                    className="text-stone-400 rotate-180 shrink-0"
                                />
                            </div>
                        </button>
                    );
                })}
            </div>
            <div className="px-4 pb-6 text-center text-[11px] text-stone-400 font-serif">
                每个角色独立备忘录 · 上限 {MEMO_MAX_COUNT} 条 · AI 在单聊里可读写
            </div>
        </div>
    );

    // ─── 渲染：角色详情 ──────────────────────────
    const renderDetail = () => {
        if (!selectedChar) return null;
        const memos = (selectedChar.memos || []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
        const isFull = memos.length >= MEMO_MAX_COUNT;

        return (
            <div className="flex-1 overflow-y-auto">
                {/* 角色头部 */}
                <div className="px-4 pt-3 pb-3 bg-[#f4efe4] border-b border-stone-300/50">
                    <div className="flex items-center gap-3">
                        {selectedChar.avatar ? (
                            <img
                                src={selectedChar.avatar}
                                alt={selectedChar.name}
                                className="w-10 h-10 rounded-full object-cover border border-stone-300"
                            />
                        ) : (
                            <div className="w-10 h-10 rounded-full bg-stone-300 flex items-center justify-center text-stone-600 font-bold">
                                {selectedChar.name?.[0] || '?'}
                            </div>
                        )}
                        <div className="flex-1 min-w-0">
                            <div className="font-bold text-stone-800">{selectedChar.name} 的备忘录</div>
                            <div className="text-xs text-stone-500">
                                {memos.length}/{MEMO_MAX_COUNT} 条
                                {isFull && <span className="text-amber-600 ml-1">· 已满</span>}
                            </div>
                        </div>
                        <button
                            onClick={openNewEditor}
                            disabled={isFull}
                            className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-full bg-stone-800 text-white text-xs font-bold active:scale-95 transition-transform disabled:bg-stone-300 disabled:text-stone-500"
                            title={isFull ? '已满 10 条上限' : '新建备忘录'}
                        >
                            <Plus size={14} weight="bold" /> 新建
                        </button>
                    </div>
                </div>

                {/* 备忘录列表 */}
                <div className="px-4 pt-4 pb-6 space-y-2.5">
                    {memos.length === 0 && (
                        <div className="text-center text-stone-400 py-12 font-serif">
                            <Notebook size={40} weight="thin" className="mx-auto mb-2 opacity-50" />
                            还没有任何备忘录
                            <div className="text-[11px] mt-1 text-stone-400">
                                点右上角「新建」添加，或让 AI 在单聊里自己写
                            </div>
                        </div>
                    )}
                    {memos.map((m, idx) => (
                        <div
                            key={m.id}
                            className="bg-[#fbf7ec] rounded-2xl border border-stone-300/60 shadow-sm p-3.5"
                        >
                            <div className="flex items-start gap-2.5">
                                {/* 待办勾选圆点 */}
                                {m.type === 'todo' ? (
                                    <button
                                        onClick={() => handleToggleDone(m)}
                                        className="shrink-0 mt-0.5 active:scale-90 transition-transform"
                                        title={m.status === 'done' ? '标记为未完成' : '标记为已完成'}
                                    >
                                        {m.status === 'done'
                                            ? <CheckCircle size={18} weight="fill" className="text-emerald-500" />
                                            : <Circle size={18} weight="regular" className="text-stone-400" />}
                                    </button>
                                ) : (
                                    <span className="shrink-0 mt-0.5 w-[18px] h-[18px] flex items-center justify-center">
                                        <NotePencil size={14} weight="fill" className="text-sky-400" />
                                    </span>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] font-mono text-stone-400">#{idx + 1}</span>
                                        <TypeBadge memo={m} />
                                    </div>
                                    <div
                                        className={`text-sm text-stone-800 whitespace-pre-wrap break-words leading-relaxed ${
                                            m.status === 'done' ? 'line-through text-stone-400' : ''
                                        }`}
                                    >
                                        {m.content}
                                    </div>
                                    {m.tags && m.tags.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-2">
                                            {m.tags.map(t => (
                                                <span
                                                    key={t}
                                                    className="inline-flex items-center text-[10px] text-stone-500 bg-stone-200/60 rounded-full px-1.5 py-0.5"
                                                >
                                                    <Tag size={8} className="mr-0.5" />{t}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    <div className="flex items-center gap-1 mt-2 text-[10px] text-stone-400">
                                        <Clock size={10} />
                                        <span>创建 {fmtTime(m.createdAt)}</span>
                                        {m.updatedAt !== m.createdAt && (
                                            <span className="ml-1">· 修改 {fmtRelative(m.updatedAt)}</span>
                                        )}
                                    </div>
                                </div>
                                {/* 操作按钮 */}
                                <div className="flex flex-col gap-1 shrink-0">
                                    <button
                                        onClick={() => openEditEditor(m)}
                                        className="p-1.5 rounded-full hover:bg-stone-200/60 active:scale-90 transition-transform"
                                        title="编辑"
                                    >
                                        <PencilSimple size={14} weight="bold" className="text-stone-500" />
                                    </button>
                                    <button
                                        onClick={() => setDeletingId(m.id)}
                                        className="p-1.5 rounded-full hover:bg-red-50 active:scale-90 transition-transform"
                                        title="删除"
                                    >
                                        <Trash size={14} weight="bold" className="text-stone-400 hover:text-red-500" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    // ─── 渲染：编辑 / 新建 Modal ──────────────────
    const renderEditor = () => {
        if (!editorOpen) return null;
        const isEdit = !!editor.id;
        const tagPreview = parseTagsInput(editor.tagsInput);
        return (
            <Modal
                isOpen={editorOpen}
                title={isEdit ? '编辑备忘' : '新建备忘'}
                onClose={() => setEditorOpen(false)}
                footer={
                    <>
                        <button
                            onClick={() => setEditorOpen(false)}
                            className="flex-1 py-2.5 bg-stone-100 text-stone-500 font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            取消
                        </button>
                        <button
                            onClick={handleSaveEditor}
                            className="flex-1 py-2.5 bg-stone-800 text-white font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            保存
                        </button>
                    </>
                }
            >
                <div className="space-y-3">
                    {/* 类型切换 */}
                    <div className="flex gap-2">
                        <button
                            onClick={() => setEditor(s => ({ ...s, type: 'note' }))}
                            className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
                                editor.type === 'note'
                                    ? 'bg-sky-50 text-sky-700 border-sky-300'
                                    : 'bg-white text-stone-500 border-stone-200'
                            }`}
                        >
                            <NotePencil size={14} weight="fill" className="inline mr-1" />
                            备忘
                        </button>
                        <button
                            onClick={() => setEditor(s => ({ ...s, type: 'todo' }))}
                            className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
                                editor.type === 'todo'
                                    ? 'bg-amber-50 text-amber-700 border-amber-300'
                                    : 'bg-white text-stone-500 border-stone-200'
                            }`}
                        >
                            <CheckCircle size={14} weight="fill" className="inline mr-1" />
                            待办
                        </button>
                        {editor.type === 'todo' && (
                            <button
                                onClick={() => setEditor(s => ({ ...s, status: s.status === 'done' ? 'active' : 'done' }))}
                                className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
                                    editor.status === 'done'
                                        ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                                        : 'bg-white text-stone-500 border-stone-200'
                                }`}
                            >
                                {editor.status === 'done' ? <CheckCircle size={14} weight="fill" className="inline mr-1" /> : <Circle size={14} className="inline mr-1" />}
                                {editor.status === 'done' ? '已完成' : '未完成'}
                            </button>
                        )}
                    </div>

                    {/* 内容 */}
                    <div>
                        <textarea
                            value={editor.content}
                            onChange={e => setEditor(s => ({ ...s, content: e.target.value.slice(0, MEMO_MAX_CONTENT_LEN) }))}
                            placeholder="写点什么…（短句随手记，AI 在单聊里也能看到这条）"
                            rows={4}
                            className="w-full px-3 py-2.5 rounded-xl border border-stone-200 bg-white text-sm text-stone-800 resize-none focus:outline-none focus:border-stone-400 placeholder:text-stone-300"
                        />
                        <div className="text-right text-[10px] text-stone-400 mt-1">
                            {editor.content.length}/{MEMO_MAX_CONTENT_LEN}
                        </div>
                    </div>

                    {/* 标签 */}
                    <div>
                        <input
                            type="text"
                            value={editor.tagsInput}
                            onChange={e => setEditor(s => ({ ...s, tagsInput: e.target.value }))}
                            placeholder="标签，逗号分隔（如：生活,用户,灵感）"
                            className="w-full px-3 py-2 rounded-xl border border-stone-200 bg-white text-sm text-stone-800 focus:outline-none focus:border-stone-400 placeholder:text-stone-300"
                        />
                        {tagPreview.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                                {tagPreview.map(t => (
                                    <span
                                        key={t}
                                        className="inline-flex items-center text-[10px] text-stone-500 bg-stone-100 rounded-full px-1.5 py-0.5"
                                    >
                                        <Tag size={8} className="mr-0.5" />{t}
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="text-[10px] text-stone-400 mt-1">
                            最多 {MEMO_MAX_TAGS} 个，每个不超过 {MEMO_MAX_TAG_LEN} 字
                        </div>
                    </div>
                </div>
            </Modal>
        );
    };

    // ─── 渲染：删除确认 Modal ──────────────────────
    const renderDeleteConfirm = () => (
        <Modal
            isOpen={!!deletingId}
            title="删除这条备忘？"
            onClose={() => setDeletingId(null)}
            footer={
                <>
                    <button
                        onClick={() => setDeletingId(null)}
                        className="flex-1 py-2.5 bg-stone-100 text-stone-500 font-bold rounded-2xl active:scale-95 transition-transform"
                    >
                        取消
                    </button>
                    <button
                        onClick={handleConfirmDelete}
                        className="flex-1 py-2.5 bg-red-500 text-white font-bold rounded-2xl active:scale-95 transition-transform"
                    >
                        删除
                    </button>
                </>
            }
        >
            <div className="text-sm text-stone-600 text-center py-2">
                删除后不可恢复。AI 在下一轮对话里就看不到这条了。
            </div>
        </Modal>
    );

    // ─── 顶栏 ──────────────────────────────────
    const renderHeader = () => (
        <div
            className="bg-[#f4efe4] border-b-2 border-stone-800 shrink-0 sticky top-0 z-10"
            style={{ paddingTop: 'var(--safe-top)' }}
        >
            <div className="flex items-center px-4 py-2">
                <div className="flex items-center gap-2 w-full">
                    {mode === 'detail' ? (
                        <button
                            onClick={handleBack}
                            className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform"
                        >
                            <ArrowLeft size={22} weight="bold" className="text-stone-700" />
                        </button>
                    ) : (
                        <button
                            onClick={closeApp}
                            className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform"
                        >
                            <ArrowLeft size={22} weight="bold" className="text-stone-700" />
                        </button>
                    )}
                    <h1 className="text-xl font-bold tracking-wide text-stone-800 flex items-center gap-2">
                        <Notebook size={22} weight="fill" className="text-amber-700" />
                        {mode === 'detail' && selectedChar ? `${selectedChar.name} · 备忘录` : '备忘录'}
                    </h1>
                </div>
            </div>
        </div>
    );

    return (
        <div className="h-full w-full bg-[#f4efe4] flex flex-col font-serif text-stone-900">
            {renderHeader()}
            {mode === 'list' ? renderList() : renderDetail()}
            {renderEditor()}
            {renderDeleteConfirm()}
        </div>
    );
};

export default MemoApp;
