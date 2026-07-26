
import React, { useState, useEffect } from 'react';
import Modal from '../os/Modal';
import { CharacterProfile } from '../../types';

interface ProactiveSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    char: CharacterProfile;
    isProactiveActive: boolean;
    onSave: (config: NonNullable<CharacterProfile['proactiveConfig']>) => void;
    onStop: () => void;
}

const INTERVAL_OPTIONS = [
    { label: '30 分钟', value: 30 },
    { label: '1 小时', value: 60 },
    { label: '2 小时', value: 120 },
    { label: '4 小时', value: 240 },
    { label: '5 小时', value: 300 },
    { label: '6 小时', value: 360 },
    { label: '8 小时', value: 480 },
    { label: '12 小时', value: 720 },
    { label: '24 小时', value: 1440 },
];

// maxAttempts 选项：0=无限（不建议），1-10
const MAX_ATTEMPTS_OPTIONS = [
    { label: '无限', value: 0, warn: true },
    { label: '1 次', value: 1 },
    { label: '2 次', value: 2 },
    { label: '3 次', value: 3 },
    { label: '4 次', value: 4 },
    { label: '5 次', value: 5 },
    { label: '6 次', value: 6 },
    { label: '8 次', value: 8 },
    { label: '10 次', value: 10 },
];

/**
 * 默认 hint 参考文案（含占位符）。点"显示默认"按钮填入 textarea 供用户参考/修改。
 * 注意：默认运行时有两个分支——刚见面 / 常规。这里给的是常规分支的占位符版本。
 * 自定义后会完全替换默认（包括刚见面分支），用户需自行处理见面场景（如不需要可忽略）。
 */
const DEFAULT_HINT_REFERENCE = `[系统提示（非{{user_name}}发言）: 现在是 {{time}}。{{time_since_user}}这是系统给你的一次主动发消息机会——{{user_name}}并没有在跟你说话，是你想主动找{{user_name}}。像真人一样随意地发条消息吧，比如：随手拍了张照片想分享、刚看到个有趣的事想说、突然想到个冷知识、吐槽今天的天气/食物/见闻、或者就是单纯想找{{user_name}}聊几句。不要刻意，不要像在"汇报近况"，就像你真的拿起手机随手发了条消息。一两句话就好。]`;

const ProactiveSettingsModal: React.FC<ProactiveSettingsModalProps> = ({
    isOpen, onClose, char, isProactiveActive, onSave, onStop
}) => {
    const saved = char.proactiveConfig;
    const [enabled, setEnabled] = useState(saved?.enabled ?? false);
    const [interval, setInterval_] = useState(saved?.intervalMinutes ?? 60);
    const [useSecondaryApi, setUseSecondaryApi] = useState(saved?.useSecondaryApi ?? false);
    const [secUrl, setSecUrl] = useState(saved?.secondaryApi?.baseUrl ?? '');
    const [secKey, setSecKey] = useState(saved?.secondaryApi?.apiKey ?? '');
    const [secModel, setSecModel] = useState(saved?.secondaryApi?.model ?? '');
    const [showApiSection, setShowApiSection] = useState(saved?.useSecondaryApi ?? false);
    // 睡眠窗口已迁至神经链接 → 角色设定页「睡眠时间」，这里不再编辑（见下方指路提示）
    // 主动联系倾向 0-100，默认 50
    const [proactiveness, setProactiveness] = useState(saved?.proactiveness ?? 50);
    // 节制模式：无回应最多找几次。0=无限（不建议）。默认 3。
    const [maxAttempts, setMaxAttempts] = useState(saved?.maxAttempts ?? 3);
    // hint 自定义
    const [hintCustom, setHintCustom] = useState(saved?.hintCustom ?? '');
    const [showHintEditor, setShowHintEditor] = useState(false);

    // Reset form when modal opens with new char data
    useEffect(() => {
        if (isOpen) {
            const s = char.proactiveConfig;
            setEnabled(s?.enabled ?? false);
            setInterval_(s?.intervalMinutes ?? 60);
            setUseSecondaryApi(s?.useSecondaryApi ?? false);
            setSecUrl(s?.secondaryApi?.baseUrl ?? '');
            setSecKey(s?.secondaryApi?.apiKey ?? '');
            setSecModel(s?.secondaryApi?.model ?? '');
            setShowApiSection(s?.useSecondaryApi ?? false);
            setProactiveness(s?.proactiveness ?? 50);
            setMaxAttempts(s?.maxAttempts ?? 3);
            setHintCustom(s?.hintCustom ?? '');
            setShowHintEditor(false);
        }
    }, [isOpen, char.id]);

    const handleSave = () => {
        onSave({
            enabled,
            intervalMinutes: interval,
            useSecondaryApi: useSecondaryApi && !!secUrl,
            secondaryApi: useSecondaryApi && secUrl ? {
                baseUrl: secUrl,
                apiKey: secKey,
                model: secModel,
            } : undefined,
            // 睡眠字段原样回传：这两个旧字段是神经链接新字段的 fallback 数据源，
            // 整体替换 proactiveConfig 时不带上会把旧用户的睡眠设置顺手抹掉
            sleepStart: char.proactiveConfig?.sleepStart,
            sleepEnd: char.proactiveConfig?.sleepEnd,
            proactiveness,
            maxAttempts,
            hintCustom: hintCustom.trim() || undefined,
        });
        onClose();
    };

    const handleStop = () => {
        onStop();
        setEnabled(false);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} title="主动消息" onClose={onClose} footer={
            <>
                <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
                    取消
                </button>
                {isProactiveActive ? (
                    <button onClick={handleStop} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                        停止
                    </button>
                ) : null}
                <button onClick={handleSave} className="flex-1 py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                    {enabled ? '启动' : '保存'}
                </button>
            </>
        }>
            <div className="space-y-5">
                {/* Description */}
                <p className="text-xs text-slate-400 leading-relaxed">
                    开启后，如果你一段时间没主动联系 {char.name}，TA 会按设定间隔主动找你，
                    就像真人随手发来一条。你回消息后间隔重新计时。
                </p>

                {/* Enable Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-700">启用主动消息</span>
                    <button
                        onClick={() => setEnabled(!enabled)}
                        className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                </div>

                {/* Status indicator */}
                {isProactiveActive && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-violet-50 rounded-xl border border-violet-100">
                        <span className="w-2 h-2 bg-violet-500 rounded-full animate-pulse" />
                        <span className="text-xs text-violet-600 font-medium">主动消息进行中</span>
                    </div>
                )}

                {/* Interval Selection */}
                {enabled && (
                    <>
                        <div>
                            <label className="text-sm font-bold text-slate-700 block mb-1">触发间隔</label>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-2">
                                你多久没联系 {char.name}，TA 才会开始主动找你。你回消息后重新计时。
                            </p>
                            <div className="grid grid-cols-3 gap-2">
                                {INTERVAL_OPTIONS.map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setInterval_(opt.value)}
                                        className={`py-2 px-3 rounded-xl text-xs font-bold transition-all ${interval === opt.value
                                            ? 'bg-violet-500 text-white shadow-md'
                                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* 睡眠窗口 —— 已迁至神经链接，这里只留指路牌（解耦：不开主动消息也能设睡眠） */}
                        <div className="pt-2 border-t border-slate-100">
                            <label className="text-sm font-bold text-slate-700 block mb-1">睡眠窗口</label>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                睡眠时间已搬到 <b className="text-violet-500">神经链接 → 角色设定 → 时间感知 & 时区 → 睡眠时间</b>。
                                它现在是角色的全局生物钟：主动消息和彼方自主登入都读那里，不开主动消息也能设。
                                {char.sleepSchedule?.enabled
                                    ? ` 当前：${char.sleepSchedule.start} ~ ${char.sleepSchedule.end}。`
                                    : (char.sleepSchedule
                                        ? ' 当前：未启用。'
                                        : (char.proactiveConfig?.sleepStart && char.proactiveConfig?.sleepEnd
                                            ? ` 当前（沿用旧设置）：${char.proactiveConfig.sleepStart} ~ ${char.proactiveConfig.sleepEnd}。`
                                            : ' 当前：未设置。'))}
                            </p>
                        </div>

                        {/* 主动联系倾向 */}
                        <div className="pt-2 border-t border-slate-100">
                            <label className="text-sm font-bold text-slate-700 block mb-1">主动联系倾向</label>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                                每次到点 {char.name} 会"扔骰子"决定要不要找你。滑块越高，越爱主动找你。
                                连续 5 次没找你 → 思念值攒满，下次必定找你（保底）。
                            </p>
                            <div className="bg-slate-50 rounded-2xl p-3">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-slate-500 font-medium">高冷 ←</span>
                                    <span className="text-sm font-bold text-violet-600 tabular-nums">{proactiveness}%</span>
                                    <span className="text-xs text-slate-500 font-medium">→ 黏人</span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={proactiveness}
                                    onChange={e => setProactiveness(parseInt(e.target.value, 10))}
                                    className="w-full accent-violet-500"
                                />
                                <div className="flex justify-between mt-1 text-[10px] text-slate-400">
                                    <span>几乎不主动</span>
                                    <span>平均 2 次到点发 1 次</span>
                                    <span>每次都主动</span>
                                </div>
                            </div>
                        </div>

                        {/* 节制模式：无回应最多找几次 */}
                        <div className="pt-2 border-t border-slate-100">
                            <label className="text-sm font-bold text-slate-700 block mb-1">无回应节制</label>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                                间隔 = 用户多久没联系{char.name}才会主动找你。如果{char.name}主动找你后你没回，
                                会按相同间隔再找，最多找这么多次；找满后停止，直到你再说话才会重新开始（计数清零）。
                                选「无限」会一直找（不建议，容易刷屏）。
                            </p>
                            <div className="grid grid-cols-3 gap-2">
                                {MAX_ATTEMPTS_OPTIONS.map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setMaxAttempts(opt.value)}
                                        className={`py-2 px-3 rounded-xl text-xs font-bold transition-all ${maxAttempts === opt.value
                                            ? opt.warn
                                                ? 'bg-amber-500 text-white shadow-md'
                                                : 'bg-violet-500 text-white shadow-md'
                                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                        }`}
                                    >
                                        {opt.label}{opt.warn ? ' ⚠' : ''}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* hint 自定义 */}
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-sm font-bold text-slate-700">主动消息提示词</span>
                                <button
                                    onClick={() => setShowHintEditor(!showHintEditor)}
                                    className="text-[10px] text-slate-400"
                                >
                                    {showHintEditor ? '收起 ▲' : '展开 ▼'}
                                </button>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                                自定义后完全替换默认提示词（包括刚见面特殊分支）。留空=用默认。
                                支持占位符：<code className="text-violet-500">{'{{char_name}}'}</code>、<code className="text-violet-500">{'{{user_name}}'}</code>、<code className="text-violet-500">{'{{time}}'}</code>、<code className="text-violet-500">{'{{time_since_user}}'}</code>。
                            </p>

                            {showHintEditor && (
                                <div className="space-y-2 bg-slate-50 rounded-2xl p-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] text-slate-500 font-medium">
                                            {hintCustom.trim() ? '已自定义' : '使用默认'}
                                        </span>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setHintCustom(DEFAULT_HINT_REFERENCE)}
                                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-white text-violet-600 border border-violet-200 active:scale-95 transition-transform"
                                            >
                                                显示默认
                                            </button>
                                            {hintCustom.trim() && (
                                                <button
                                                    onClick={() => setHintCustom('')}
                                                    className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-white text-slate-400 border border-slate-200 active:scale-95 transition-transform"
                                                >
                                                    清空（用默认）
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <textarea
                                        value={hintCustom}
                                        onChange={e => setHintCustom(e.target.value)}
                                        rows={8}
                                        placeholder={DEFAULT_HINT_REFERENCE}
                                        className="w-full px-3 py-2 bg-white rounded-xl text-xs text-slate-700 border border-slate-200 focus:border-violet-300 focus:outline-none transition-colors resize-y font-mono leading-relaxed"
                                    />
                                    <p className="text-[10px] text-slate-400 leading-relaxed">
                                        提示：{'{{time_since_user}}'} 在用户从未联系时会替换为空字符串。
                                        默认提示词里还有"刚见面"特殊分支（见面后 3 小时内换语境），
                                        自定义后会丢失这个分支——如需保留见面场景，请在文案里自行处理。
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Secondary API Toggle */}
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-sm font-bold text-slate-700">使用副 API</span>
                                <button
                                    onClick={() => { setUseSecondaryApi(!useSecondaryApi); setShowApiSection(!useSecondaryApi); }}
                                    className={`w-12 h-7 rounded-full transition-colors relative ${useSecondaryApi ? 'bg-violet-500' : 'bg-slate-200'}`}
                                >
                                    <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${useSecondaryApi ? 'translate-x-5' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                                使用单独的 API 发送主动消息，避免消耗主 API 额度。不开启则使用主 API。
                            </p>

                            {showApiSection && (
                                <div className="space-y-3 bg-slate-50 rounded-2xl p-3">
                                    <div>
                                        <label className="text-xs text-slate-500 font-medium block mb-1">API URL</label>
                                        <input
                                            type="text"
                                            value={secUrl}
                                            onChange={e => setSecUrl(e.target.value)}
                                            placeholder="https://api.example.com/v1"
                                            className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200 focus:border-violet-300 focus:outline-none transition-colors"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 font-medium block mb-1">API Key</label>
                                        <input
                                            type="password"
                                            value={secKey}
                                            onChange={e => setSecKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200 focus:border-violet-300 focus:outline-none transition-colors"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 font-medium block mb-1">Model</label>
                                        <input
                                            type="text"
                                            value={secModel}
                                            onChange={e => setSecModel(e.target.value)}
                                            placeholder="gpt-4o-mini"
                                            className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200 focus:border-violet-300 focus:outline-none transition-colors"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
};

export default React.memo(ProactiveSettingsModal);
