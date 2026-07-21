
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
    { label: '8 小时', value: 480 },
    { label: '12 小时', value: 720 },
    { label: '24 小时', value: 1440 },
];

// 把分钟数（0-1439）格式化成 "HH:MM"
const minutesToHHMM = (m: number): string => {
    const h = Math.floor(m / 60) % 24;
    const min = m % 60;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};
// 把 "HH:MM" 解析成分钟数；非法返回默认值
const hhmmToMinutes = (s: string | undefined, fallback: number): number => {
    if (!s) return fallback;
    const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return fallback;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
    return h * 60 + min;
};

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
    // 睡眠窗口（存分钟数 0-1439，每 30 分钟一档；默认 23:00 入睡 / 07:00 起床）
    const [sleepStartMin, setSleepStartMin] = useState(hhmmToMinutes(saved?.sleepStart, 23 * 60));
    const [sleepEndMin, setSleepEndMin] = useState(hhmmToMinutes(saved?.sleepEnd, 7 * 60));
    // 主动联系倾向 0-100，默认 50
    const [proactiveness, setProactiveness] = useState(saved?.proactiveness ?? 50);

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
            setSleepStartMin(hhmmToMinutes(s?.sleepStart, 23 * 60));
            setSleepEndMin(hhmmToMinutes(s?.sleepEnd, 7 * 60));
            setProactiveness(s?.proactiveness ?? 50);
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
            sleepStart: minutesToHHMM(sleepStartMin),
            sleepEnd: minutesToHHMM(sleepEndMin),
            proactiveness,
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
                    开启后，{char.name} 会按照设定的间隔主动给你发消息，就像真人一样随手发来一条。
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
                            <label className="text-sm font-bold text-slate-700 block mb-2">发送间隔</label>
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

                        {/* 睡眠窗口 */}
                        <div className="pt-2 border-t border-slate-100">
                            <label className="text-sm font-bold text-slate-700 block mb-1">睡眠窗口</label>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                                睡眠时段内 {char.name} 不会主动发消息（除非思念值攒满，思念优先）。
                                支持跨日，如入睡 23:00 / 起床 07:00。
                            </p>
                            <div className="space-y-3 bg-slate-50 rounded-2xl p-3">
                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="text-xs text-slate-500 font-medium">入睡时间</span>
                                        <span className="text-sm font-bold text-violet-600 tabular-nums">{minutesToHHMM(sleepStartMin)}</span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={1439}
                                        step={30}
                                        value={sleepStartMin}
                                        onChange={e => setSleepStartMin(parseInt(e.target.value, 10))}
                                        className="w-full accent-violet-500"
                                    />
                                </div>
                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="text-xs text-slate-500 font-medium">起床时间</span>
                                        <span className="text-sm font-bold text-violet-600 tabular-nums">{minutesToHHMM(sleepEndMin)}</span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={1439}
                                        step={30}
                                        value={sleepEndMin}
                                        onChange={e => setSleepEndMin(parseInt(e.target.value, 10))}
                                        className="w-full accent-violet-500"
                                    />
                                </div>
                                {sleepStartMin === sleepEndMin && (
                                    <p className="text-[11px] text-amber-600 leading-relaxed">
                                        入睡和起床时间相同，等于全天都在睡 — 这通常不是你想要的，请调整。
                                    </p>
                                )}
                            </div>
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
