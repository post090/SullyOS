/**
 * Like520Event.tsx
 * 520 特别活动 (2026.5.20) — "如果 char 变得小小的"
 *
 * Phase 状态机：
 *   intro → char_creator → loading_a → opening → tucao_select → tucao_reply
 *   → anchors → reveal_transition → user_creator → uncovered_line → ending_screen
 *   → loading_b → wake_up → letter → puzzle → done
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, SpecialMomentRecord } from '../types';
import {
    runLike520CallA,
    runLike520CallB,
    Like520CallAResult,
    Like520CallBResult,
    Like520TucaoKey,
} from '../utils/like520/prompts';

// ============================================================
// 日期判定 / 持久化 key
// ============================================================

export const LIKE520_RECORD_KEY = 'like520_2026';
const LIKE520_DISMISSED_KEY = 'sullyos_like520_2026_dismissed';
const LIKE520_COMPLETED_KEY = 'sullyos_like520_2026_completed';

const isLike520Day = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 4 && now.getDate() === 20;
};

export const shouldShowLike520Popup = (): boolean => {
    if (!isLike520Day()) return false;
    try {
        if (localStorage.getItem(LIKE520_DISMISSED_KEY)) return false;
        if (localStorage.getItem(LIKE520_COMPLETED_KEY)) return false;
    } catch { /* ignore */ }
    return true;
};

export const isLike520EventAvailable = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 4;
};

export const isLike520Past = (): boolean => {
    const now = new Date();
    return now.getFullYear() > 2026 || (now.getFullYear() === 2026 && now.getMonth() > 4);
};

// ============================================================
// 类型
// ============================================================

type Phase =
    | 'intro' | 'char_creator' | 'loading_a' | 'opening'
    | 'tucao_select' | 'tucao_reply' | 'anchors' | 'reveal_transition'
    | 'user_creator' | 'uncovered_line' | 'ending_screen'
    | 'loading_b' | 'wake_up' | 'letter' | 'puzzle' | 'done' | 'error';

interface ChibiResult {
    dataUrl: string;
    frameDataUrl: string;
    transparentDataUrl: string;
    state?: any;
}

const TUCAO_OPTIONS: { key: Like520TucaoKey; label: string }[] = [
    { key: 'becamesmall', label: '你怎么变小了！' },
    { key: 'cute', label: '你今天好可爱！' },
    { key: 'yangcheng_meta', label: '这什么天杀的养成游戏' },
];

// ============================================================
// Sully 识别（专属预设）
// ============================================================

const isSullyChar = (char: CharacterProfile): boolean => {
    return (char.name || '').toLowerCase().includes('sully');
};

const sullyPresets = (): Record<string, string> => ({
    skin: 'skin_1',
    fronthair: 'fronthair_99',
    eyes: 'eyes_99',
});

// ============================================================
// iframe 捏脸 wrapper
// ============================================================

interface CreatorIframeProps {
    mode: 'char' | 'user';
    charName?: string;
    presets?: Record<string, string>;
    onConfirm: (result: ChibiResult) => void;
}

const CHAR_CREATOR_URL = (((import.meta as any).env?.BASE_URL ?? '/') + 'like520/character_creator.html').replace(/\/+/g, '/');

const CreatorIframe: React.FC<CreatorIframeProps> = ({ mode, charName, presets, onConfirm }) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        const handleMessage = (e: MessageEvent) => {
            if (!e.data || typeof e.data !== 'object') return;
            const iframeWin = iframeRef.current?.contentWindow;
            if (e.source !== iframeWin) return;

            if (e.data.type === 'like520_ready') {
                console.log(`[520][creator:${mode}] iframe ready, sending init`);
                iframeWin?.postMessage({
                    type: 'like520_init',
                    payload: { mode, charName, presets },
                }, '*');
            } else if (e.data.type === 'like520_result' && e.data.payload) {
                console.log(`[520][creator:${mode}] result received`);
                onConfirm({
                    dataUrl: e.data.payload.dataUrl,
                    frameDataUrl: e.data.payload.frameDataUrl,
                    transparentDataUrl: e.data.payload.transparentDataUrl,
                    state: e.data.payload.state,
                });
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [mode, charName, presets, onConfirm]);

    return (
        <iframe
            ref={iframeRef}
            src={CHAR_CREATOR_URL}
            title={mode === 'char' ? '捏 char chibi' : '捏 user chibi'}
            className="w-full h-full border-0"
            style={{ background: 'linear-gradient(180deg, #FFF1E6 0%, #FFE4EC 100%)' }}
        />
    );
};

// ============================================================
// 小工具：fade-in 显示一段对白
// ============================================================

const DialogueLine: React.FC<{ text: string; onNext?: () => void; nextLabel?: string }> = ({ text, onNext, nextLabel }) => (
    <div className="flex flex-col items-center justify-center px-8 py-12 max-w-md mx-auto animate-fade-in">
        <div className="bg-white/85 backdrop-blur-md rounded-3xl px-7 py-6 shadow-xl text-[#5C3A4A] text-base leading-relaxed whitespace-pre-wrap">
            {text}
        </div>
        {onNext && (
            <button
                onClick={onNext}
                className="mt-8 px-8 py-3 rounded-full bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] text-white font-bold shadow-lg active:scale-95 transition-transform"
            >
                {nextLabel ?? '继续 ♥'}
            </button>
        )}
    </div>
);

// ============================================================
// 锚点翻弄视图
// ============================================================

const AnchorsView: React.FC<{
    anchors: Like520CallAResult['anchors'];
    onComplete: () => void;
}> = ({ anchors, onComplete }) => {
    const [idx, setIdx] = useState(0);
    const last = idx >= anchors.length - 1;
    const current = anchors[idx];

    return (
        <div className="flex flex-col items-center justify-center min-h-full px-6 py-10 max-w-md mx-auto">
            <div className="text-[10px] tracking-[4px] text-[#C76182] mb-2">线索 {idx + 1} / {anchors.length}</div>
            <div
                key={idx}
                className="w-full bg-white/90 backdrop-blur-md rounded-2xl border border-[#FCEDD9] shadow-lg px-6 py-7 animate-fade-in"
                style={{
                    boxShadow: '0 8px 24px rgba(199, 97, 130, 0.12), inset 0 0 0 1px rgba(212, 165, 116, 0.15)',
                }}
            >
                <div className="text-[11px] tracking-wider text-[#9D7585] mb-4 italic">
                    {current.scene}
                </div>
                <div className="text-[#5C3A4A] text-[15px] leading-[1.9] whitespace-pre-wrap">
                    {current.dialogue}
                </div>
            </div>
            <button
                onClick={() => last ? onComplete() : setIdx(i => i + 1)}
                className="mt-8 px-7 py-2.5 rounded-full bg-white/90 backdrop-blur text-[#C76182] text-sm font-bold border border-[#FFB6C8] active:scale-95 transition-transform"
            >
                {last ? '翻完了 →' : '翻下一条'}
            </button>
        </div>
    );
};

// ============================================================
// 结局画面（黑屏 → 合照 → 标题 → TRUE HAPPY END → description）
// ============================================================

const EndingScreen: React.FC<{
    title: string;
    description: string;
    charChibi: string;
    userChibi: string;
    onNext: () => void;
}> = ({ title, description, charChibi, userChibi, onNext }) => {
    const [step, setStep] = useState(0);

    useEffect(() => {
        const seq = [600, 1400, 1100, 1600, 1300];
        if (step >= seq.length) return;
        const t = setTimeout(() => setStep(s => s + 1), seq[step]);
        return () => clearTimeout(t);
    }, [step]);

    return (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center px-6">
            {step >= 1 && (
                <div className="flex items-end justify-center gap-2 mb-8 animate-fade-in">
                    <img src={charChibi} alt="char" className="h-40 object-contain" />
                    <img src={userChibi} alt="user" className="h-40 object-contain" />
                </div>
            )}
            {step >= 2 && (
                <div className="text-white/85 text-base tracking-wider mb-3 animate-fade-in text-center">
                    {title}
                </div>
            )}
            {step >= 3 && (
                <div className="text-white text-2xl tracking-[6px] font-light mt-2 mb-6 animate-fade-in">
                    TRUE HAPPY END
                </div>
            )}
            {step >= 4 && (
                <div className="text-white/65 text-sm leading-relaxed mt-4 px-4 text-center animate-fade-in whitespace-pre-wrap">
                    {description}
                </div>
            )}
            {step >= 5 && (
                <button
                    onClick={onNext}
                    className="mt-10 px-8 py-2.5 rounded-full bg-white/15 backdrop-blur text-white text-sm tracking-widest border border-white/30 active:scale-95 transition-transform animate-fade-in"
                >
                    继 续
                </button>
            )}
        </div>
    );
};

// ============================================================
// 信
// ============================================================

const LetterView: React.FC<{ text: string; onNext: () => void; charName: string }> = ({ text, onNext, charName }) => (
    <div className="flex flex-col items-center min-h-full px-6 py-10 max-w-md mx-auto overflow-y-auto">
        <div className="text-[10px] tracking-[6px] text-[#C76182] mb-4">从 {charName} 的信</div>
        <div
            className="w-full bg-[#FFF8F1] rounded-2xl px-7 py-8 shadow-lg text-[#5C3A4A] text-[15px] leading-[2.05] whitespace-pre-wrap"
            style={{
                fontFamily: '"Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif',
                backgroundImage: 'repeating-linear-gradient(transparent, transparent 31px, rgba(199, 97, 130, 0.05) 31px, rgba(199, 97, 130, 0.05) 32px)',
                boxShadow: '0 12px 32px rgba(199, 97, 130, 0.15), inset 0 0 0 1px rgba(212, 165, 116, 0.2)',
            }}
        >
            {text}
        </div>
        <button
            onClick={onNext}
            className="mt-8 px-8 py-3 rounded-full bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] text-white font-bold shadow-lg active:scale-95 transition-transform"
        >
            收下 ♥
        </button>
    </div>
);

// ============================================================
// 拼图（char chibi + user chibi 并列在背景上）
// ============================================================

const PuzzleView: React.FC<{
    charChibi: string;
    userChibi: string;
    title: string;
    onDone: () => void;
}> = ({ charChibi, userChibi, title, onDone }) => (
    <div className="flex flex-col items-center min-h-full px-6 py-8 max-w-md mx-auto">
        <div className="text-[#C76182] text-sm tracking-widest mb-1">♥ 拼图卡片 ♥</div>
        <div className="text-[10px] text-[#9D7585] mb-5">{title}</div>
        <div
            className="w-full aspect-[4/5] rounded-3xl relative overflow-hidden flex items-end justify-center"
            style={{
                background: 'linear-gradient(180deg, #FFE8DC 0%, #FFD3DC 60%, #FFBFCB 100%)',
                boxShadow: '0 12px 32px rgba(199, 97, 130, 0.18), inset 0 0 0 2px rgba(255,255,255,0.6)',
            }}
        >
            <div className="absolute inset-0 flex items-center justify-center text-[10px] tracking-[8px] text-white/40">
                BG · TO BE DRAWN
            </div>
            <div className="relative flex items-end justify-center gap-2 pb-8 px-4">
                <img src={charChibi} alt="char chibi" className="h-44 object-contain drop-shadow-md" />
                <img src={userChibi} alt="user chibi" className="h-44 object-contain drop-shadow-md" />
            </div>
        </div>
        <div className="text-[#5C3A4A] text-sm italic mt-5 text-center">「这很像我们耶。」</div>
        <button
            onClick={onDone}
            className="mt-8 px-8 py-3 rounded-full bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] text-white font-bold shadow-lg active:scale-95 transition-transform"
        >
            完成 ♥
        </button>
    </div>
);

// ============================================================
// Loading 视图
// ============================================================

const LoadingView: React.FC<{ hint?: string }> = ({ hint }) => (
    <div className="flex flex-col items-center justify-center min-h-full px-6 py-12 max-w-md mx-auto">
        <div className="text-2xl mb-4 animate-pulse">♥</div>
        <div className="text-[#9D7585] text-xs tracking-widest">{hint ?? '正在准备这个下午…'}</div>
    </div>
);

// ============================================================
// Like520Session — 主状态机
// ============================================================

interface SessionProps {
    charId: string;
    onClose: () => void;
}

export const Like520Session: React.FC<SessionProps> = ({ charId, onClose }) => {
    const { characters, userProfile, apiConfig, updateCharacter, addToast } = useOS();
    const char = characters.find(c => c.id === charId);

    const [phase, setPhase] = useState<Phase>('intro');
    const [errorMsg, setErrorMsg] = useState<string>('');

    const [charChibi, setCharChibi] = useState<ChibiResult | null>(null);
    const [userChibi, setUserChibi] = useState<ChibiResult | null>(null);
    const [callA, setCallA] = useState<Like520CallAResult | null>(null);
    const [callB, setCallB] = useState<Like520CallBResult | null>(null);
    const [chosenTucao, setChosenTucao] = useState<Like520TucaoKey | null>(null);

    // 启动 Call A：char 捏脸开始时
    const callAStartedRef = useRef(false);
    const callBStartedRef = useRef(false);

    const startCallA = useCallback(async () => {
        if (callAStartedRef.current || !char || !apiConfig) return;
        callAStartedRef.current = true;
        try {
            const recent = await DB.getMessagesByCharId(char.id);
            const result = await runLike520CallA(char, userProfile, apiConfig, recent || []);
            setCallA(result);
        } catch (err: any) {
            console.error('[520] Call A failed:', err);
            setErrorMsg(`生成剧本失败：${err?.message || '请重试'}`);
            setPhase('error');
        }
    }, [char, userProfile, apiConfig]);

    const startCallB = useCallback((aResult: Like520CallAResult, tucao: Like520TucaoKey) => {
        if (callBStartedRef.current || !char || !apiConfig) return;
        callBStartedRef.current = true;
        runLike520CallB(char, userProfile, apiConfig, aResult, tucao).then(r => {
            setCallB(r);
        }).catch(err => {
            console.error('[520] Call B failed:', err);
            // 兜底：让用户在 wake_up/letter 阶段看到降级文案
            setCallB({
                wake_up: '……我们好像一起做了一个梦呀。',
                letter: '（信生成出了点小问题。这是一段属于你的、未完成的话——但它一直在。）',
            });
        });
    }, [char, userProfile, apiConfig]);

    // === Phase 导航 ===

    const handleCharChibiConfirm = useCallback((r: ChibiResult) => {
        setCharChibi(r);
        // 等 Call A 结果决定下一步
        if (callA) setPhase('opening');
        else setPhase('loading_a');
    }, [callA]);

    const handleUserChibiConfirm = useCallback((r: ChibiResult) => {
        setUserChibi(r);
        setPhase('uncovered_line');
    }, []);

    // 当 callA 在 loading_a 阶段返回时，自动推进到 opening
    useEffect(() => {
        if (phase === 'loading_a' && callA) {
            setPhase('opening');
        }
    }, [phase, callA]);

    // 当用户选了吐槽 → 开始 Call B
    useEffect(() => {
        if (callA && chosenTucao && !callBStartedRef.current) {
            startCallB(callA, chosenTucao);
        }
    }, [callA, chosenTucao, startCallB]);

    // loading_b 阶段，Call B 一就绪自动推进
    useEffect(() => {
        if (phase === 'loading_b' && callB) {
            setPhase('wake_up');
        }
    }, [phase, callB]);

    // === 保存结果到 char.specialMomentRecords ===
    const saveRecord = useCallback(async () => {
        if (!char || !callA || !callB || !charChibi || !userChibi || !chosenTucao) return;
        const previousRecords = char.specialMomentRecords || {};
        const record: SpecialMomentRecord = {
            content: callB.letter,
            image: charChibi.frameDataUrl,
            timestamp: Date.now(),
            source: 'generated',
            customData: {
                callA,
                callB,
                chosenTucao,
                charChibi: { dataUrl: charChibi.transparentDataUrl, state: charChibi.state },
                userChibi: { dataUrl: userChibi.transparentDataUrl, state: userChibi.state },
            },
        };
        updateCharacter(char.id, {
            specialMomentRecords: { ...previousRecords, [LIKE520_RECORD_KEY]: record },
        });
        try {
            localStorage.setItem(LIKE520_COMPLETED_KEY, '1');
        } catch { /* ignore */ }
        // 写一条 chat 消息留痕
        try {
            await DB.saveMessage({
                charId: char.id,
                role: 'assistant',
                type: 'text',
                content: callB.letter,
                timestamp: Date.now(),
                metadata: { source: 'like520_event', like520Event: true },
            });
        } catch (e) {
            console.warn('[520] save chat message failed', e);
        }
    }, [char, callA, callB, charChibi, userChibi, chosenTucao, updateCharacter]);

    // === 错误页 ===
    if (!char) {
        return (
            <div className="fixed inset-0 z-[9997] flex items-center justify-center bg-[#FFF1E6]">
                <div className="text-[#9D7585]">角色不存在</div>
            </div>
        );
    }

    if (phase === 'error') {
        return (
            <div className="fixed inset-0 z-[9997] flex flex-col items-center justify-center bg-[#FFF1E6] px-8">
                <div className="text-[#C76182] mb-3">⚠</div>
                <div className="text-[#5C3A4A] text-sm text-center mb-6">{errorMsg}</div>
                <button onClick={onClose} className="px-7 py-2.5 rounded-full bg-white text-[#C76182] text-sm font-bold border border-[#FFB6C8] active:scale-95 transition-transform">
                    关闭
                </button>
            </div>
        );
    }

    // === Phase 渲染 ===
    const background = 'linear-gradient(180deg, #FFF1E6 0%, #FFE4EC 100%)';

    return (
        <div className="fixed inset-0 z-[9997] overflow-y-auto" style={{ background }}>
            {phase === 'intro' && (
                <div className="flex flex-col items-center justify-center min-h-full px-8 py-16 max-w-md mx-auto">
                    <div className="text-[10px] tracking-[8px] text-[#C76182] mb-3">5 · 2 · 0</div>
                    <div className="text-[#C76182] text-xl font-bold mb-1 tracking-widest">特别活动</div>
                    <div className="text-[#5C3A4A] text-lg leading-relaxed text-center my-8">
                        如果<span className="mx-1 text-[#C76182]">{char.name}</span>变得小小的，<br />
                        那ta会是——？
                    </div>
                    <button
                        onClick={() => { startCallA(); setPhase('char_creator'); }}
                        className="mt-6 px-10 py-3 rounded-full bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] text-white font-bold shadow-lg active:scale-95 transition-transform"
                    >
                        开始装扮 ♥
                    </button>
                    <button
                        onClick={onClose}
                        className="mt-4 text-xs text-[#9D7585]"
                    >
                        以后再说
                    </button>
                </div>
            )}

            {phase === 'char_creator' && (
                <div className="absolute inset-0">
                    <CreatorIframe
                        mode="char"
                        charName={char.name}
                        presets={isSullyChar(char) ? sullyPresets() : undefined}
                        onConfirm={handleCharChibiConfirm}
                    />
                </div>
            )}

            {phase === 'loading_a' && <LoadingView hint="ta 在准备这个下午…" />}

            {phase === 'opening' && callA && (
                <DialogueLine
                    text={callA.opening}
                    onNext={() => setPhase('tucao_select')}
                />
            )}

            {phase === 'tucao_select' && callA && (
                <div className="flex flex-col items-center justify-center min-h-full px-8 py-12 max-w-md mx-auto">
                    <div className="text-[11px] tracking-widest text-[#C76182] mb-4">你的反应是——</div>
                    <div className="flex flex-col gap-3 w-full">
                        {TUCAO_OPTIONS.map(opt => (
                            <button
                                key={opt.key}
                                onClick={() => { setChosenTucao(opt.key); setPhase('tucao_reply'); }}
                                className="px-5 py-4 rounded-2xl bg-white/85 backdrop-blur border border-[#FCEDD9] text-[#5C3A4A] text-sm leading-relaxed shadow active:scale-95 active:bg-[#FFF1E6] transition-all"
                            >
                                「{opt.label}」
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {phase === 'tucao_reply' && callA && chosenTucao && (
                <DialogueLine
                    text={callA.tucao_responses[chosenTucao]}
                    onNext={() => setPhase('anchors')}
                />
            )}

            {phase === 'anchors' && callA && (
                <AnchorsView
                    anchors={callA.anchors}
                    onComplete={() => setPhase('reveal_transition')}
                />
            )}

            {phase === 'reveal_transition' && callA && (
                <DialogueLine
                    text={callA.reveal_transition}
                    onNext={() => setPhase('user_creator')}
                />
            )}

            {phase === 'user_creator' && (
                <div className="absolute inset-0">
                    <CreatorIframe
                        mode="user"
                        charName={char.name}
                        onConfirm={handleUserChibiConfirm}
                    />
                </div>
            )}

            {phase === 'uncovered_line' && callA && (
                <DialogueLine
                    text={callA.uncovered_line}
                    onNext={() => setPhase('ending_screen')}
                />
            )}

            {phase === 'ending_screen' && callA && charChibi && userChibi && (
                <EndingScreen
                    title={callA.ending.title}
                    description={callA.ending.description}
                    charChibi={charChibi.transparentDataUrl}
                    userChibi={userChibi.transparentDataUrl}
                    onNext={() => {
                        if (callB) setPhase('wake_up');
                        else setPhase('loading_b');
                    }}
                />
            )}

            {phase === 'loading_b' && <LoadingView hint="醒过来之前…" />}

            {phase === 'wake_up' && callB && (
                <DialogueLine
                    text={callB.wake_up}
                    onNext={() => setPhase('letter')}
                />
            )}

            {phase === 'letter' && callB && (
                <LetterView
                    text={callB.letter}
                    charName={char.name}
                    onNext={() => {
                        saveRecord();
                        setPhase('puzzle');
                    }}
                />
            )}

            {phase === 'puzzle' && callA && charChibi && userChibi && (
                <PuzzleView
                    charChibi={charChibi.transparentDataUrl}
                    userChibi={userChibi.transparentDataUrl}
                    title={callA.ending.title}
                    onDone={() => setPhase('done')}
                />
            )}

            {phase === 'done' && (
                <div className="flex flex-col items-center justify-center min-h-full px-8 py-12 max-w-md mx-auto">
                    <div className="text-2xl mb-3">♥</div>
                    <div className="text-[#5C3A4A] text-base mb-1">这个下午存好了。</div>
                    <div className="text-[10px] tracking-widest text-[#9D7585] mb-8">TRUE HAPPY END</div>
                    <button
                        onClick={onClose}
                        className="px-10 py-3 rounded-full bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] text-white font-bold shadow-lg active:scale-95 transition-transform"
                    >
                        关闭
                    </button>
                </div>
            )}
        </div>
    );
};

// ============================================================
// Controller — 弹窗 → 角色选择 → Session
// ============================================================

interface Like520ControllerProps {
    onClose: () => void;
    initialCharId?: string;
}

export const Like520Controller: React.FC<Like520ControllerProps> = ({ onClose, initialCharId }) => {
    const { characters } = useOS();
    const [stage, setStage] = useState<'popup' | 'select' | 'session'>(initialCharId ? 'session' : 'popup');
    const [charId, setCharId] = useState<string>(initialCharId || '');

    const dismiss = () => {
        try { localStorage.setItem(LIKE520_DISMISSED_KEY, '1'); } catch { /* ignore */ }
        onClose();
    };

    if (stage === 'popup') {
        return (
            <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
                <div className="absolute inset-0 bg-black/40 backdrop-blur" onClick={dismiss} />
                <div className="relative w-full max-w-sm bg-gradient-to-br from-[#FFF8F1] to-[#FFE4EC] rounded-[2rem] shadow-2xl border border-white/40 overflow-hidden animate-slide-up">
                    <div className="px-6 pt-8 pb-3 text-center">
                        <div className="text-[10px] tracking-[8px] text-[#C76182] mb-2">5 · 2 · 0</div>
                        <h3 className="text-xl font-bold text-[#5C3A4A] mb-1">特别活动</h3>
                        <p className="text-[12px] text-[#9D7585] leading-relaxed mt-3">
                            ta 突然变得小小的——<br/>
                            要不要去看看？
                        </p>
                    </div>
                    <div className="px-6 pb-6 pt-3 flex flex-col gap-2">
                        <button onClick={() => setStage('select')} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] active:scale-95 transition-transform">
                            进入活动 ♥
                        </button>
                        <button onClick={dismiss} className="w-full py-2.5 text-[#9D7585] text-sm">
                            以后再说
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (stage === 'select') {
        return (
            <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
                <div className="absolute inset-0 bg-black/40 backdrop-blur" onClick={onClose} />
                <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2rem] shadow-2xl border border-white/40 overflow-hidden max-h-[80vh] flex flex-col">
                    <div className="px-6 pt-6 pb-3 text-center shrink-0">
                        <h3 className="text-lg font-bold text-[#5C3A4A]">选一个 ta</h3>
                        <p className="text-[11px] text-[#9D7585] mt-1">一起度过这个下午</p>
                    </div>
                    <div className="px-4 pb-4 overflow-y-auto flex-1">
                        {characters.length === 0 ? (
                            <div className="text-center text-sm text-[#9D7585] py-8">还没有角色呢</div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                {characters.map(c => (
                                    <button
                                        key={c.id}
                                        onClick={() => { setCharId(c.id); setStage('session'); }}
                                        className="flex flex-col items-center gap-2 p-3 bg-[#FFF8F1] rounded-2xl border border-[#FCEDD9] active:scale-95 transition-transform"
                                    >
                                        {c.avatar?.startsWith('http') || c.avatar?.startsWith('data:') ? (
                                            <img src={c.avatar} alt={c.name} className="w-12 h-12 rounded-full object-cover" />
                                        ) : (
                                            <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center text-2xl">
                                                {c.avatar || '🌸'}
                                            </div>
                                        )}
                                        <div className="text-[12px] font-bold text-[#5C3A4A] truncate w-full">{c.name}</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[9998]">
            <Like520Session charId={charId} onClose={onClose} />
        </div>
    );
};
