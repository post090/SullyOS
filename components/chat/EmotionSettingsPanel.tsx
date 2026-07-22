
import React, { useState, useEffect } from 'react';
import { CharacterProfile, ApiPreset, APIConfig, CharacterBuff, PromptTemplate } from '../../types';
import { isScheduleFeatureOn } from '../../utils/scheduleGenerator';
import {
    EMOTION_PROMPT_PLACEHOLDERS,
    SCHEDULE_PROMPT_PLACEHOLDERS,
    EMOTION_PROMPT_RULES_SUMMARY,
    SCHEDULE_PROMPT_RULES_SUMMARY,
} from './ChatConstants';

interface EmotionSettingsPanelProps {
    char: CharacterProfile;
    apiPresets: ApiPreset[];
    addApiPreset: (name: string, config: APIConfig) => void;
    onSave: (config: NonNullable<CharacterProfile['emotionConfig']>) => void;
    onClearBuffs: () => void;
    /** 保存角色字段（用于 prompt 自定义） */
    onUpdateCharacter?: (patch: Partial<CharacterProfile>) => void;
}

const normalizeIntensity = (n: number | undefined | null): 1 | 2 | 3 => {
    const parsed = Number.isFinite(n) ? Math.round(Number(n)) : 2;
    if (parsed <= 1) return 1;
    if (parsed >= 3) return 3;
    return 2;
};

const INTENSITY_DOTS = (n: number | undefined | null) => {
    const safe = normalizeIntensity(n);
    return '●'.repeat(safe) + '○'.repeat(3 - safe);
};

// ── Prompt 模板 localStorage CRUD（全局共通） ──
const TEMPLATE_KEY = 'os_prompt_templates';
function loadTemplates(): PromptTemplate[] {
    try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '[]'); } catch { return []; }
}
function saveTemplates(list: PromptTemplate[]) {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(list));
}
function addTemplate(t: Omit<PromptTemplate, 'id'>): PromptTemplate {
    const list = loadTemplates();
    const item: PromptTemplate = { ...t, id: `tpl-${Date.now()}` };
    list.push(item);
    saveTemplates(list);
    return item;
}
function deleteTemplate(id: string) {
    saveTemplates(loadTemplates().filter(t => t.id !== id));
}

const EmotionSettingsPanel: React.FC<EmotionSettingsPanelProps> = ({
    char, apiPresets, addApiPreset, onSave, onClearBuffs, onUpdateCharacter
}) => {
    const [url, setUrl] = useState('');
    const [key, setKey] = useState('');
    const [model, setModel] = useState('');
    const [showSavePreset, setShowSavePreset] = useState(false);
    const [newPresetName, setNewPresetName] = useState('');
    const [dirty, setDirty] = useState(false);

    // ── Prompt 自定义 state ──
    const [promptTab, setPromptTab] = useState<'emotion' | 'schedule'>('emotion');
    const [showPromptEditor, setShowPromptEditor] = useState(false);
    const [showRules, setShowRules] = useState(false);
    const [emotionMode, setEmotionMode] = useState<'append' | 'replace'>(char.emotionPromptMode || 'append');
    const [emotionText, setEmotionText] = useState(char.emotionPromptCustom || '');
    const [scheduleMode, setScheduleMode] = useState<'append' | 'replace'>(char.schedulePromptMode || 'append');
    const [scheduleText, setScheduleText] = useState(char.schedulePromptCustom || '');
    const [templates, setTemplates] = useState<PromptTemplate[]>([]);
    const [showSaveTpl, setShowSaveTpl] = useState(false);
    const [newTplName, setNewTplName] = useState('');

    // Sync form state from character
    useEffect(() => {
        const s = char.emotionConfig;
        setUrl(s?.api?.baseUrl ?? '');
        setKey(s?.api?.apiKey ?? '');
        setModel(s?.api?.model ?? '');
        setShowSavePreset(false);
        setNewPresetName('');
        setDirty(false);
        setEmotionMode(char.emotionPromptMode || 'append');
        setEmotionText(char.emotionPromptCustom || '');
        setScheduleMode(char.schedulePromptMode || 'append');
        setScheduleText(char.schedulePromptCustom || '');
    }, [char.id]);

    // 加载模板列表
    useEffect(() => { setTemplates(loadTemplates()); }, [showPromptEditor]);

    const loadPreset = (preset: ApiPreset) => {
        setUrl(preset.config.baseUrl);
        setKey(preset.config.apiKey);
        setModel(preset.config.model);
        setDirty(true);
    };

    const handleSavePreset = () => {
        if (!newPresetName.trim()) return;
        addApiPreset(newPresetName.trim(), { baseUrl: url, apiKey: key, model });
        setNewPresetName('');
        setShowSavePreset(false);
    };

    const handleSave = () => {
        const api = url ? { baseUrl: url, apiKey: key, model } : undefined;
        // 与日程强制同步：日程/情绪总开关开启时情绪必跑。
        // 注意 scheduleFeatureEnabled=true 时即使还没选 scheduleStyle，也应保持情绪开启。
        onSave({ enabled: isScheduleFeatureOn(char), api });
        setDirty(false);
    };

    // ── Prompt 自定义操作 ──
    const isEmotionTab = promptTab === 'emotion';
    const curMode = isEmotionTab ? emotionMode : scheduleMode;
    const curText = isEmotionTab ? emotionText : scheduleText;
    const curPlaceholders = isEmotionTab ? EMOTION_PROMPT_PLACEHOLDERS : SCHEDULE_PROMPT_PLACEHOLDERS;
    const curRules = isEmotionTab ? EMOTION_PROMPT_RULES_SUMMARY : SCHEDULE_PROMPT_RULES_SUMMARY;
    const curSavedCustom = isEmotionTab ? char.emotionPromptCustom : char.schedulePromptCustom;
    const hasCustom = !!(curSavedCustom?.trim());

    const handleSavePrompt = () => {
        if (!onUpdateCharacter) return;
        if (isEmotionTab) {
            onUpdateCharacter({
                emotionPromptMode: emotionMode,
                emotionPromptCustom: emotionText.trim() || undefined,
            });
        } else {
            onUpdateCharacter({
                schedulePromptMode: scheduleMode,
                schedulePromptCustom: scheduleText.trim() || undefined,
            });
        }
    };

    const handleResetPrompt = () => {
        if (!onUpdateCharacter) return;
        if (isEmotionTab) {
            setEmotionText('');
            setEmotionMode('append');
            onUpdateCharacter({ emotionPromptMode: undefined, emotionPromptCustom: undefined });
        } else {
            setScheduleText('');
            setScheduleMode('append');
            onUpdateCharacter({ schedulePromptMode: undefined, schedulePromptCustom: undefined });
        }
    };

    const handleSaveAsTemplate = () => {
        if (!newTplName.trim() || !curText.trim()) return;
        addTemplate({ name: newTplName.trim(), type: promptTab, mode: curMode, content: curText });
        setNewTplName('');
        setShowSaveTpl(false);
        setTemplates(loadTemplates());
    };

    const handleLoadTemplate = (tpl: PromptTemplate) => {
        if (tpl.type !== promptTab) return;
        if (isEmotionTab) {
            setEmotionMode(tpl.mode);
            setEmotionText(tpl.content);
        } else {
            setScheduleMode(tpl.mode);
            setScheduleText(tpl.content);
        }
    };

    const handleDeleteTemplate = (id: string) => {
        deleteTemplate(id);
        setTemplates(loadTemplates());
    };

    const curTemplates = templates.filter(t => t.type === promptTab);

    const buffs: CharacterBuff[] = char.activeBuffs || [];
    const scheduleOn = isScheduleFeatureOn(char);

    return (
        <div className="space-y-4 pt-4 border-t border-slate-100">
            {/* ── 提示词自定义区块（API 设置上方） ── */}
            {onUpdateCharacter && (
                <div className="rounded-xl bg-slate-50 border border-slate-200/60 p-3 space-y-2.5">
                    <button
                        onClick={() => setShowPromptEditor(!showPromptEditor)}
                        className="w-full flex items-center justify-between text-left"
                    >
                        <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                            📝 提示词自定义
                            {hasCustom && <span className="text-[9px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full">已自定义</span>}
                        </span>
                        <span className="text-[10px] text-slate-400">{showPromptEditor ? '收起 ▲' : '展开 ▼'}</span>
                    </button>

                    {showPromptEditor && (
                        <div className="space-y-3">
                            {/* Tab 切换 */}
                            <div className="flex gap-2">
                                {(['emotion', 'schedule'] as const).map(t => (
                                    <button
                                        key={t}
                                        onClick={() => setPromptTab(t)}
                                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all ${promptTab === t ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400'}`}
                                    >
                                        {t === 'emotion' ? '🎭 情绪' : '📅 日程'}
                                        {(t === 'emotion' ? char.emotionPromptCustom : char.schedulePromptCustom) && (
                                            <span className="ml-1 text-[8px]">●</span>
                                        )}
                                    </button>
                                ))}
                            </div>

                            {/* 模式 toggle */}
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-400 w-10">模式</span>
                                <button
                                    onClick={() => isEmotionTab ? setEmotionMode('append') : setScheduleMode('append')}
                                    className={`px-3 py-1 rounded-md text-[10px] font-bold ${curMode === 'append' ? 'bg-indigo-100 text-indigo-600' : 'bg-white text-slate-400'}`}
                                >
                                    追加（推荐）
                                </button>
                                <button
                                    onClick={() => isEmotionTab ? setEmotionMode('replace') : setScheduleMode('replace')}
                                    className={`px-3 py-1 rounded-md text-[10px] font-bold ${curMode === 'replace' ? 'bg-rose-100 text-rose-600' : 'bg-white text-slate-400'}`}
                                >
                                    完全替换
                                </button>
                            </div>

                            {/* 模式说明 */}
                            <div className="text-[10px] text-slate-400 leading-relaxed">
                                {curMode === 'append'
                                    ? '在内置 prompt 末尾追加你的补充要求，不破坏内置规则。'
                                    : '⚠️ 完全替换内置 prompt，用占位符注入动态变量。内置规则全部丢失，风险自负。'}
                            </div>

                            {/* 默认规则参考 / 占位符列表（折叠） */}
                            <button
                                onClick={() => setShowRules(!showRules)}
                                className="text-[10px] text-slate-500 underline"
                            >
                                {showRules ? '隐藏' : '查看'}{curMode === 'append' ? '默认规则概要' : '占位符列表'}
                            </button>
                            {showRules && (
                                <div className="text-[10px] text-slate-500 bg-white/70 rounded-lg p-2.5 border border-slate-100 whitespace-pre-line leading-relaxed max-h-40 overflow-y-auto">
                                    {curMode === 'append' ? curRules : curPlaceholders.map(p => `${p.key} — ${p.desc}`).join('\n')}
                                </div>
                            )}

                            {/* textarea */}
                            <textarea
                                value={curText}
                                onChange={e => isEmotionTab ? setEmotionText(e.target.value) : setScheduleText(e.target.value)}
                                placeholder={curMode === 'append'
                                    ? '在这里写追加的补充要求……\n例如：请额外关注角色的睡眠状态对情绪的影响'
                                    : '在这里写完整的 prompt 模板，用 {{char_name}} {{user_name}} 等占位符……'}
                                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-[11px] font-mono focus:outline-none focus:border-indigo-300 min-h-[100px] resize-y"
                            />

                            {/* 模板管理 */}
                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-slate-400">模板（全局共通）</span>
                                    <button
                                        onClick={() => setShowSaveTpl(!showSaveTpl)}
                                        disabled={!curText.trim()}
                                        className={`text-[10px] px-2 py-1 rounded-md font-bold ${curText.trim() ? 'bg-slate-100 text-slate-600' : 'bg-slate-50 text-slate-300'}`}
                                    >
                                        存为模板
                                    </button>
                                </div>
                                {showSaveTpl && (
                                    <div className="flex gap-1.5">
                                        <input
                                            type="text"
                                            value={newTplName}
                                            onChange={e => setNewTplName(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && handleSaveAsTemplate()}
                                            placeholder="模板名…"
                                            className="flex-1 bg-white border border-slate-200 rounded-md px-2 py-1 text-[11px]"
                                            autoFocus
                                        />
                                        <button onClick={handleSaveAsTemplate} className="px-2 py-1 bg-indigo-500 text-white text-[10px] font-bold rounded-md">保存</button>
                                    </div>
                                )}
                                {curTemplates.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {curTemplates.map(tpl => (
                                            <div key={tpl.id} className="flex items-center bg-white border border-slate-200 rounded-md pl-2 pr-1 py-1 text-[10px]">
                                                <button onClick={() => handleLoadTemplate(tpl)} className="text-slate-600 hover:text-indigo-600">
                                                    {tpl.name}
                                                    <span className="text-slate-300 ml-1">{tpl.mode === 'append' ? '⊕' : '⟲'}</span>
                                                </button>
                                                <button onClick={() => handleDeleteTemplate(tpl.id)} className="ml-1 text-slate-300 hover:text-rose-400">×</button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* 操作按钮 */}
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleSavePrompt}
                                    disabled={!onUpdateCharacter}
                                    className="flex-1 py-2 bg-indigo-500 text-white text-[11px] font-bold rounded-lg disabled:opacity-50"
                                >
                                    保存到角色
                                </button>
                                <button
                                    onClick={handleResetPrompt}
                                    disabled={!hasCustom}
                                    className={`px-3 py-2 text-[11px] font-bold rounded-lg ${hasCustom ? 'text-rose-500 bg-rose-50' : 'text-slate-300 bg-slate-50'}`}
                                >
                                    回退默认
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── 原 API 设置 ── */}
            <div>
                <div className="text-xs font-bold text-slate-700 mb-1">🎭 情绪 / 意识流 API</div>
                <div className="text-[11px] text-slate-500 leading-relaxed space-y-1">
                    <p>
                        原版情绪 buff 就在这里。与日程<b>强制同步</b>：日程开 → 自动启用；日程关 → 一起停。
                    </p>
                    <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                        ⚙️ 下方不填 = 自动用主 API。想细腻点就填个 <b>Claude 系列</b>模型。
                    </p>
                </div>
            </div>

            {!scheduleOn && (
                <div className="text-[11px] text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                    尚未选择日程风格。选择「生活系」或「意识系」后，情绪/意识流会自动启用。
                </div>
            )}

            {/* Preset chips */}
            {apiPresets.length > 0 && (
                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">我的预设</label>
                    <div className="flex gap-2 flex-wrap">
                        {apiPresets.map(preset => (
                            <button
                                key={preset.id}
                                onClick={() => loadPreset(preset)}
                                className="flex items-center bg-white border border-slate-200 rounded-lg px-3 py-1 shadow-sm text-xs font-medium text-slate-600 hover:text-pink-500 hover:border-pink-200 active:scale-95 transition-all"
                            >
                                {preset.name}
                                <span className="ml-1.5 text-slate-300">{preset.config.model}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* API fields */}
            <div className="space-y-3">
                <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">副 API 配置</label>
                    <button
                        onClick={() => setShowSavePreset(!showSavePreset)}
                        className="text-[10px] bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                    >
                        保存为预设
                    </button>
                </div>

                {showSavePreset && (
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newPresetName}
                            onChange={e => setNewPresetName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleSavePreset()}
                            placeholder="预设名称..."
                            className="flex-1 bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2 text-sm focus:bg-white transition-all"
                            autoFocus
                        />
                        <button
                            onClick={handleSavePreset}
                            className="px-4 py-2 bg-pink-500 text-white text-sm font-bold rounded-xl active:scale-95 transition-transform"
                        >
                            保存
                        </button>
                    </div>
                )}

                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                    <input
                        type="text"
                        value={url}
                        onChange={e => { setUrl(e.target.value); setDirty(true); }}
                        placeholder="留空 = 使用主 API"
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                    <input
                        type="password"
                        value={key}
                        onChange={e => { setKey(e.target.value); setDirty(true); }}
                        placeholder="sk-..."
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Model</label>
                    <input
                        type="text"
                        value={model}
                        onChange={e => { setModel(e.target.value); setDirty(true); }}
                        placeholder="claude-haiku-4-5 / gpt-4o-mini / ..."
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                </div>

                <button
                    onClick={handleSave}
                    disabled={!dirty}
                    className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all ${
                        dirty
                            ? 'bg-pink-500 text-white shadow-md active:scale-95'
                            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    }`}
                >
                    {dirty ? '保存副 API 配置' : '✓ 已保存'}
                </button>
            </div>

            {/* Current buffs */}
            {buffs.length > 0 ? (
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">当前情绪状态</label>
                        <button onClick={onClearBuffs} className="text-xs text-slate-400 hover:text-red-400 transition-colors">清除</button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {buffs.map(buff => (
                            <div
                                key={buff.id}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold"
                                style={{
                                    backgroundColor: buff.color ? buff.color + '22' : '#fdf2f8',
                                    color: buff.color || '#db2777',
                                    border: `1px solid ${buff.color ? buff.color + '55' : '#fbcfe8'}`
                                }}
                            >
                                {buff.emoji && <span>{buff.emoji}</span>}
                                <span>{buff.label}</span>
                                <span className="opacity-60">{INTENSITY_DOTS(buff.intensity)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : scheduleOn ? (
                <div className="text-xs text-slate-400 text-center py-2">
                    暂无情绪状态 — 发几条消息后会自动生成
                </div>
            ) : null}
        </div>
    );
};

export default React.memo(EmotionSettingsPanel);
