import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, PhoneSimLog, CharacterBuff, UserProfile } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { safeResponseJson } from '../utils/safeApi';
import {
    CaretLeft, Play, Pause, FastForward, Lock, MagnifyingGlass, MusicNotes,
    BellRinging, ImageSquare, NotePencil, Globe, CloudSun, ArrowClockwise,
    HourglassMedium, Sparkle, ClockCounterClockwise, X, CaretRight, ArrowRight,
} from '@phosphor-icons/react';

// ============================================================
//  TYPES (runtime script model)
// ============================================================
type BeatKind = 'lock' | 'thought' | 'notification' | 'app' | 'flashback' | 'end';

interface Beat {
    time?: string;
    kind: BeatKind;
    monologue?: string;
    pace?: 1 | 2 | 3;
    vibe?: 'calm' | 'chaotic' | 'happy' | 'anxious' | 'numb' | 'tender';
    notif?: { app: string; title: string; body: string; tone?: 'push' | 'sms' | 'system' | 'flashback' };
    app?: {
        name: string;
        view: 'chat' | 'search' | 'photo' | 'music' | 'notes' | 'browser' | 'weather' | 'compose' | 'generic';
        chat?: { name: string; lines: { me: boolean; text: string }[] };
        search?: { engine?: string; queries: { q: string; deleted?: boolean }[] };
        photo?: { caption?: string; date?: string; tint?: string };
        music?: { song: string; artist: string; state?: string };
        notes?: { title?: string; items: string[] };
        browser?: { tabs: string[] };
        weather?: { city: string; temp: number; desc: string };
        compose?: { to?: string; drafts: string[]; sent?: string | null };
        text?: string;
    };
    flashback?: { label?: string; caption?: string; date?: string; tint?: string };
}

interface SimScript {
    title: string;
    ending?: string;
    beats: Beat[];
    summary: string;
    buff?: { name?: string; label: string; emoji?: string; color?: string; intensity?: 1 | 2 | 3; description?: string };
}

export interface SimApiConfig { apiKey: string; baseUrl: string; model: string; }
export type SimState =
    | { status: 'idle' }
    | { status: 'loading'; mode: 'daily' | 'event'; theme: string }
    | { status: 'ready'; mode: 'daily' | 'event'; theme: string; script: SimScript }
    | { status: 'error'; mode: 'daily' | 'event'; theme: string };

interface Props {
    targetChar: CharacterProfile;
    onExit: () => void;
    openLifeLog: () => void;
    sim: SimState;
    onStart: (mode: 'daily' | 'event', theme: string) => void;
    onConsumed: () => void;
}

const DAILY = ['平凡的周二', '周末宅家', '深夜失眠', '上班的一天', '放学后的傍晚'];
const EVENTS = ['第一次见到某人', '告白当天', '考试成绩公布', '离职那天', '医院检查结果出来的下午', '一场争吵之后'];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const ACCENT = '#b89bff';

// ============================================================
//  TYPEWRITER — the soul of screenlife (type → delete → retype)
// ============================================================
const Typewriter: React.FC<{ drafts: string[]; sent?: string | null; className?: string; placeholder?: string }> =
    ({ drafts, sent, className, placeholder }) => {
        const [text, setText] = useState('');
        const [blink, setBlink] = useState(true);
        useEffect(() => {
            let cancelled = false;
            const type = async (s: string) => {
                for (let k = 0; k <= s.length; k++) { if (cancelled) return; setText(s.slice(0, k)); await wait(48); }
            };
            const erase = async (s: string) => {
                for (let k = s.length; k >= 0; k--) { if (cancelled) return; setText(s.slice(0, k)); await wait(26); }
            };
            (async () => {
                for (const d of drafts) {
                    await type(d); if (cancelled) return;
                    await wait(750); if (cancelled) return;
                    await erase(d); if (cancelled) return;
                    await wait(280);
                }
                if (sent != null && sent !== '') { await type(sent); setBlink(false); }
                else setBlink(false);
            })();
            return () => { cancelled = true; };
        }, []);
        return (
            <span className={className}>
                {text || <span className="opacity-30">{placeholder}</span>}
                {blink && <span className="inline-block w-[2px] h-[1em] align-middle ml-0.5 bg-current animate-pulse" />}
            </span>
        );
    };

// ============================================================
//  BACKGROUND GENERATOR (runs at CheckPhone level so it survives navigation)
// ============================================================
export async function generatePersonaScript(opts: {
    char: CharacterProfile; userProfile: UserProfile; apiConfig: SimApiConfig;
    mode: 'daily' | 'event'; theme: string;
}): Promise<SimScript> {
    const { char, userProfile, apiConfig, mode, theme } = opts;
    await injectMemoryPalace(char, undefined, theme, userProfile.name);
    const context = ContextBuilder.buildCoreContext(char, userProfile, true, char.memoryPalaceInjection);
    const msgs = await DB.getMessagesByCharId(char.id);
    const recent = msgs.slice(-50).map(m => {
        const who = m.role === 'user' ? userProfile.name : char.name;
        const c = m.type === 'text' ? m.content : `[${m.type}]`;
        return `${who}: ${c}`;
    }).join('\n');
    const firstTs = msgs.find(m => typeof m.timestamp === 'number')?.timestamp;
    const acquaintance = describeAcquaintance(firstTs, userProfile.name, char.name);
    const prompt = buildDirectorPrompt(context, recent, mode, theme, char.name, acquaintance);
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.95, max_tokens: 16000 }),
    });
    if (!res.ok) throw new Error('API');
    const data = await safeResponseJson(res);
    const parsed = parseScript(data.choices[0].message.content);
    if (!parsed || !parsed.beats?.length) throw new Error('parse');
    if (parsed.beats[parsed.beats.length - 1].kind !== 'end') {
        parsed.beats.push({ kind: 'end', time: parsed.beats[parsed.beats.length - 1].time });
    }
    return parsed;
}

// ============================================================
//  COMPONENT
// ============================================================
const PersonaSim: React.FC<Props> = ({ targetChar, onExit, openLifeLog, sim, onStart, onConsumed }) => {
    const { updateCharacter, addToast } = useOS();

    const [phase, setPhase] = useState<'idle' | 'play' | 'end'>('idle');
    const [mode, setMode] = useState<'daily' | 'event'>('daily');
    const [theme, setTheme] = useState('');
    const [script, setScript] = useState<SimScript | null>(null);
    const [idx, setIdx] = useState(0);
    const [autoplay, setAutoplay] = useState(false);
    const savedRef = useRef(false);
    const ffTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const beats = script?.beats || [];
    const beat = beats[idx];

    // 图层化：找出「当前可见的屏幕」(lock/app/flashback)，通知/独白叠在它上面弹出，
    // 背景屏幕只在真正切屏时才重新进场 —— 这是去掉「PPT 翻页感」的关键。
    const screenIdx = (() => {
        for (let i = idx; i >= 0; i--) {
            const k = beats[i]?.kind;
            if (k === 'lock' || k === 'app' || k === 'flashback') return i;
        }
        return -1;
    })();
    const screenBeat = screenIdx >= 0 ? beats[screenIdx] : undefined;
    const isOverlay = beat?.kind === 'notification' || beat?.kind === 'thought';

    // ----- kick off background generation (runs in CheckPhone) -----
    const requestStart = (m: 'daily' | 'event', t: string) => {
        const trimmed = t.trim();
        if (!trimmed) { addToast('请选择或输入体验内容', 'error'); return; }
        setMode(m); setTheme(trimmed);
        onStart(m, trimmed);
    };

    // ----- consume a ready script (generated in background) and start playing -----
    useEffect(() => {
        if (phase === 'idle' && sim.status === 'ready') {
            setMode(sim.mode); setTheme(sim.theme);
            setScript(sim.script); setIdx(0); savedRef.current = false; setPhase('play');
            onConsumed();
        }
    }, [sim, phase, onConsumed]);

    // ----- persistence on reaching the end -----
    const persist = useCallback(async () => {
        if (savedRef.current || !script) return;
        savedRef.current = true;

        const log: PhoneSimLog = {
            id: `sim-${Date.now()}`,
            mode,
            theme,
            title: script.title || theme,
            summary: script.summary || '',
            ending: script.ending,
            beatsCount: beats.length,
            timestamp: Date.now(),
        };

        // emotion buff — only if the schedule feature is on for this character
        const scheduleOn = isScheduleFeatureOn(targetChar);
        if (scheduleOn && script.buff?.label) {
            const newBuff: CharacterBuff = {
                id: `buff_${Date.now()}`,
                name: script.buff.name || `sim_${Date.now()}`,
                label: script.buff.label,
                intensity: (script.buff.intensity && [1, 2, 3].includes(script.buff.intensity) ? script.buff.intensity : 2) as 1 | 2 | 3,
                emoji: script.buff.emoji,
                color: script.buff.color || ACCENT,
                description: script.buff.description,
            };
            log.buff = { label: newBuff.label, emoji: newBuff.emoji, color: newBuff.color };
            const existing = (targetChar.activeBuffs || []).filter(b => b.id !== newBuff.id);
            const nextBuffs = [newBuff, ...existing].slice(0, 4);
            updateCharacter(targetChar.id, {
                activeBuffs: nextBuffs,
                buffInjection: script.buff.description ? `（${newBuff.emoji || ''}${newBuff.label}）${script.buff.description}` : '',
                phoneState: {
                    records: targetChar.phoneState?.records || [],
                    customApps: targetChar.phoneState?.customApps,
                    simLogs: [log, ...(targetChar.phoneState?.simLogs || [])],
                },
            });
            window.dispatchEvent(new CustomEvent('emotion-updated', {
                detail: { charId: targetChar.id, buffs: nextBuffs, buffInjection: '' },
            }));
        } else {
            updateCharacter(targetChar.id, {
                phoneState: {
                    records: targetChar.phoneState?.records || [],
                    customApps: targetChar.phoneState?.customApps,
                    simLogs: [log, ...(targetChar.phoneState?.simLogs || [])],
                },
            });
        }
    }, [script, mode, theme, beats.length, targetChar, updateCharacter]);

    // ----- advance -----
    const advance = useCallback(() => {
        setIdx(i => {
            if (i >= beats.length - 1) return i;
            return i + 1;
        });
    }, [beats.length]);

    useEffect(() => {
        if (phase === 'play' && beat?.kind === 'end') {
            setPhase('end');
            setAutoplay(false);
            persist();
        }
    }, [idx, phase, beat, persist]);

    // ----- autoplay -----
    useEffect(() => {
        if (phase !== 'play' || !autoplay || !beat) return;
        const base = beat.kind === 'flashback' ? 6500 : beat.kind === 'thought' ? 3600 : 3000;
        const delay = base + (beat.pace === 3 ? 3500 : beat.pace === 2 ? 1600 : 0);
        const t = setTimeout(advance, delay);
        return () => clearTimeout(t);
    }, [phase, autoplay, idx, beat, advance]);

    // ----- long-press fast-forward -----
    const startFF = () => {
        if (ffTimer.current) return;
        ffTimer.current = setInterval(advance, 320);
    };
    const stopFF = () => { if (ffTimer.current) { clearInterval(ffTimer.current); ffTimer.current = null; } };
    useEffect(() => () => stopFF(), []);

    const restart = () => {
        // 重看同一场演出不再重复写入「生活记录」(savedRef 保持已保存)
        setIdx(0);
        setPhase('play');
    };

    const wallpaper = targetChar.dateBackground;

    // ========================================================
    //  RENDER: SELECT
    // ========================================================
    if (phase === 'idle' && (sim.status === 'idle' || sim.status === 'error')) {
        return (
            <Shell wallpaper={wallpaper}>
                <TopBar onBack={onExit} right={
                    <button onClick={openLifeLog} className="flex items-center gap-1 text-[11px] text-white/60 active:scale-95 transition">
                        <ClockCounterClockwise size={15} /> 生活记录
                    </button>
                } />
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 pt-2 pb-10">
                    <div className="mb-6">
                        <div className="text-[10px] tracking-[0.35em] uppercase" style={{ color: ACCENT }}>Persona Simulation</div>
                        <h1 className="text-[26px] font-light text-white mt-2 leading-tight" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                            成为 {targetChar.name} 的<br />一段人生
                        </h1>
                        <p className="text-[12px] text-white/45 mt-3 leading-relaxed">
                            你不是在查看 TA 的手机。<br />接下来这段时间，你就是 TA。
                        </p>
                    </div>

                    {/* mode tabs */}
                    <div className="flex gap-2 mb-4 p-1 rounded-2xl bg-white/[0.04] border border-white/[0.06]">
                        {(['daily', 'event'] as const).map(m => (
                            <button key={m} onClick={() => setMode(m)}
                                className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold transition"
                                style={mode === m ? { background: ACCENT, color: '#1a1530' } : { color: 'rgba(255,255,255,0.5)' }}>
                                {m === 'daily' ? '日常模拟' : '事件模拟'}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-white/35 mb-3 px-1">
                        {mode === 'daily' ? '体验 TA 某个普通日子的生活 · 生活感与陪伴' : '体验 TA 人生中的某个特殊事件 · 情绪张力'}
                    </p>

                    <div className="space-y-2 mb-5">
                        {(mode === 'daily' ? DAILY : EVENTS).map(s => (
                            <button key={s} onClick={() => requestStart(mode, s)}
                                className="w-full text-left rounded-2xl px-4 py-3.5 bg-white/[0.035] border border-white/[0.06] active:scale-[0.99] transition flex items-center justify-between group">
                                <span className="text-[13.5px] text-white/85">{s}</span>
                                <ArrowRight size={15} className="text-white/25 group-active:translate-x-0.5 transition-transform" />
                            </button>
                        ))}
                    </div>

                    <div className="rounded-2xl p-3 bg-white/[0.025] border border-white/[0.06]">
                        <label className="text-[10px] uppercase tracking-wider text-white/40 px-1">自定义体验</label>
                        <div className="flex gap-2 mt-2">
                            <input value={theme} onChange={e => setTheme(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') requestStart(mode, theme); }}
                                placeholder="例如：搬家前最后一晚 / 收到那条消息的清晨"
                                className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[12.5px] text-white placeholder-white/25 outline-none" />
                            <button onClick={() => requestStart(mode, theme)} className="px-4 rounded-xl text-[12px] font-semibold text-[#1a1530]" style={{ background: ACCENT }}>开始</button>
                        </div>
                    </div>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: LOADING (background generation in progress / about to play)
    // ========================================================
    if (phase === 'idle') {
        const t = sim.status === 'loading' ? sim.theme : theme;
        return (
            <Shell wallpaper={wallpaper}>
                <TopBar onBack={onExit} />
                <div className="flex-1 flex flex-col items-center justify-center gap-5 px-10 text-center">
                    <div className="relative">
                        <HourglassMedium size={40} weight="light" style={{ color: ACCENT }} className="animate-pulse" />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: `${ACCENT}55` }} />
                    </div>
                    <div className="text-[13px] text-white/75">正在编排「{t}」…</div>
                    <div className="text-[11px] text-white/35 leading-relaxed">把记忆、对话与情绪编排成 TA 的一天，<br />可能要十几秒。</div>
                    <button onClick={onExit} className="mt-3 px-5 py-2.5 rounded-xl text-[12px] text-white/75 bg-white/[0.06] border border-white/[0.08] active:scale-95 transition">
                        先去别处逛逛 · 好了通知我
                    </button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: END
    // ========================================================
    if (phase === 'end') {
        return (
            <Shell wallpaper={wallpaper}>
                <div className="flex-1 flex flex-col items-center justify-center px-8 text-center animate-fade-in">
                    <Lock size={26} weight="light" className="text-white/30 mb-5" />
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35 mb-3">演出结束</div>
                    <h2 className="text-[20px] font-light text-white mb-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{script?.title}</h2>
                    {script?.ending && <div className="text-[11px] mb-4 px-3 py-1 rounded-full" style={{ color: ACCENT, background: `${ACCENT}1f` }}>{script.ending}</div>}
                    <p className="text-[13.5px] text-white/65 leading-loose max-w-[280px]" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{script?.summary}</p>

                    {script?.buff?.label && isScheduleFeatureOn(targetChar) && (
                        <div className="mt-7 flex items-center gap-2 px-4 py-2 rounded-2xl border" style={{ borderColor: `${script.buff.color || ACCENT}55`, background: `${script.buff.color || ACCENT}14` }}>
                            <span className="text-base">{script.buff.emoji || '✨'}</span>
                            <div className="text-left">
                                <div className="text-[12px] font-semibold text-white">{script.buff.label}</div>
                                <div className="text-[9px] text-white/45">情绪状态已写入 TA</div>
                            </div>
                        </div>
                    )}

                    <div className="flex gap-3 mt-9">
                        <button onClick={restart} className="px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] flex items-center gap-1.5 active:scale-95 transition">
                            <ArrowClockwise size={14} /> 再看一次
                        </button>
                        <button onClick={() => { openLifeLog(); }} className="px-5 py-2.5 rounded-xl text-[12px] font-semibold text-[#1a1530] flex items-center gap-1.5 active:scale-95 transition" style={{ background: ACCENT }}>
                            <ClockCounterClockwise size={14} weight="bold" /> 生活记录
                        </button>
                    </div>
                    <button onClick={onExit} className="mt-4 text-[11px] text-white/30">退出演出</button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: PLAY
    // ========================================================
    return (
        <Shell wallpaper={wallpaper}>
            {/* phone status time */}
            <div className="h-8 flex justify-between items-center px-6 pt-2 text-white/55 text-[11px] z-30 relative shrink-0">
                <span className="font-semibold tabular-nums">{beat?.time || ''}</span>
                <div className="flex items-center gap-1">
                    <Lock size={11} weight="fill" className="opacity-50" />
                    <span className="opacity-50">{targetChar.name}</span>
                </div>
            </div>

            {/* beat stage + tap to advance */}
            <div
                className="flex-1 relative z-10 overflow-hidden select-none"
                onClick={advance}
                onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); const t = setTimeout(startFF, 420); (e.currentTarget as any)._ff = t; }}
                onPointerUp={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
                onPointerLeave={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
            >
                {/* background screen — re-enters ONLY when the underlying screen changes */}
                {screenBeat && (
                    <div key={`s${screenIdx}`} className={`absolute inset-0 ${screenEntrance(screenBeat.kind)}`}>
                        <ScreenContent beat={screenBeat} char={targetChar} showMono={!isOverlay} dimmed={isOverlay} />
                    </div>
                )}
                {/* overlay — notification drops / thought fades, on top of the live screen */}
                {beat && isOverlay && (
                    <div key={`o${idx}`} className="absolute inset-0">
                        <Overlay beat={beat} />
                    </div>
                )}
            </div>

            {/* progress + controls */}
            <div className="shrink-0 z-30 px-5 pb-6 pt-2">
                <div className="h-[3px] rounded-full bg-white/10 overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${((idx + 1) / beats.length) * 100}%`, background: ACCENT }} />
                </div>
                <div className="flex items-center justify-between">
                    <button onClick={(e) => { e.stopPropagation(); onExit(); }} className="text-[11px] text-white/35">退出</button>
                    <span className="text-[10px] text-white/30">轻触继续 · 长按快进</span>
                    <button onClick={(e) => { e.stopPropagation(); setAutoplay(a => !a); }}
                        className="w-9 h-9 rounded-full flex items-center justify-center border border-white/[0.1] text-white/70 active:scale-90 transition"
                        style={autoplay ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' } : undefined}>
                        {autoplay ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
                    </button>
                </div>
            </div>
        </Shell>
    );
};

// ============================================================
//  ENTRANCE + MONOLOGUE
// ============================================================
// 每种屏幕的进场动作 —— App 从底部弹起(像真的启动)、锁屏淡入、闪回淡入
const screenEntrance = (kind: BeatKind): string =>
    kind === 'app' ? 'animate-app-open' : 'animate-fade-in';

type Vibe = NonNullable<Beat['vibe']>;
// 确定性伪随机（按种子），保证同一 beat 每次渲染散布一致
const rnd = (n: number) => { const x = Math.sin(n * 99.73) * 43758.545; return x - Math.floor(x); };

const vibeTint: Record<Vibe, string> = {
    calm: 'rgba(255,255,255,0.9)',
    chaotic: 'rgba(255,255,255,0.85)',
    happy: '#ffb3d9',
    anxious: '#ff9a9a',
    numb: 'rgba(255,255,255,0.45)',
    tender: '#e6c9ff',
};

// 逐字敲出的内心独白（底部），按情绪微调色调
const MonoLine: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => (
    <div className="absolute left-0 right-0 bottom-6 px-8 text-center pointer-events-none z-20">
        <span className="inline-block px-3 py-1 rounded-2xl bg-black/30 backdrop-blur-sm">
            <Typewriter drafts={[]} sent={text} placeholder=""
                className={`text-[15px] leading-relaxed ${vibe === 'anxious' ? 'tracking-tight' : ''}`} />
        </span>
    </div>
);

// 情绪化的「内心独白」全屏演出：混乱铺满 / 开心粉色飘飘 / 麻木冷淡 / 焦虑紧绷
const MoodThought: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => {
    if (vibe === 'chaotic') {
        const frags = text.split(/[，。、！？!?,.\s]+/).filter(Boolean);
        const pool = frags.length >= 4 ? frags : [...frags, ...frags, ...frags].slice(0, Math.max(6, frags.length));
        return (
            <div className="absolute inset-0 overflow-hidden">
                {pool.map((f, i) => (
                    <span key={i} className="absolute whitespace-nowrap animate-fade-in"
                        style={{
                            top: `${8 + rnd(i + 1) * 78}%`, left: `${4 + rnd(i + 7) * 64}%`,
                            transform: `rotate(${(rnd(i + 3) - 0.5) * 46}deg)`,
                            fontSize: `${13 + rnd(i + 5) * 17}px`,
                            opacity: 0.35 + rnd(i + 9) * 0.6,
                            color: 'white', fontFamily: "'Shippori Mincho','Noto Sans SC',serif",
                            animationDelay: `${i * 90}ms`, animationFillMode: 'backwards',
                            textShadow: '0 1px 8px rgba(0,0,0,0.5)',
                        }}>
                        {f}
                    </span>
                ))}
            </div>
        );
    }
    if (vibe === 'happy') {
        const deco = ['✿', '♡', '❀', '✦', '♥', '✧'];
        return (
            <div className="absolute inset-0 overflow-hidden flex items-center justify-center px-10">
                {deco.map((d, i) => (
                    <span key={i} className="absolute animate-float" style={{
                        bottom: `${10 + rnd(i + 2) * 20}%`, left: `${8 + rnd(i + 4) * 80}%`,
                        fontSize: `${14 + rnd(i + 6) * 14}px`, color: '#ffc2e0',
                        animationDelay: `${i * 350}ms`, opacity: 0.8,
                    }}>{d}</span>
                ))}
                <p className="text-[20px] text-center leading-relaxed animate-fade-in font-semibold"
                    style={{ background: 'linear-gradient(90deg,#ffd6ec,#ffb3d9,#ffc2e0)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                    {text}
                </p>
            </div>
        );
    }
    if (vibe === 'anxious') {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-10">
                <p className="text-[18px] text-center leading-relaxed tracking-tight animate-pulse"
                    style={{ color: vibeTint.anxious, fontFamily: "'Shippori Mincho','Noto Sans SC',serif", textShadow: '0 0 12px rgba(255,80,80,0.3)' }}>
                    {text}
                </p>
            </div>
        );
    }
    if (vibe === 'numb') {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-12">
                <p className="text-[14px] text-center leading-loose animate-fade-in" style={{ color: vibeTint.numb, animationDuration: '2s' }}>
                    {text}
                </p>
            </div>
        );
    }
    // calm / tender → typed, soft
    return (
        <div className="absolute inset-0 flex items-center justify-center px-10">
            <Typewriter drafts={[]} sent={text} placeholder=""
                className="text-[19px] text-center leading-relaxed"
                />
            {vibe === 'tender' && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at 50% 50%, rgba(230,201,255,0.12), transparent 60%)' }} />}
        </div>
    );
};

// ============================================================
//  SCREEN CONTENT — lock / app / flashback (the persistent layer)
// ============================================================
const ScreenContent: React.FC<{ beat: Beat; char: CharacterProfile; showMono: boolean; dimmed?: boolean }> =
    ({ beat, char, showMono, dimmed }) => {
        const mono = showMono && beat.monologue ? <MonoLine text={beat.monologue} vibe={beat.vibe} /> : null;
        const dim = dimmed ? <div className="absolute inset-0 bg-black/25 backdrop-blur-[1px] z-10 pointer-events-none" /> : null;

        if (beat.kind === 'lock') {
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <div className="text-[64px] font-extralight text-white tracking-tight tabular-nums leading-none animate-fade-in" style={{ textShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>{beat.time || ''}</div>
                    {beat.notif && (
                        <div className="mt-10 w-[78%] rounded-2xl px-4 py-3 bg-white/[0.1] backdrop-blur-xl border border-white/[0.12] animate-slide-up">
                            <div className="text-[10px] text-white/50 uppercase tracking-wide mb-0.5">{beat.notif.app}</div>
                            <div className="text-[12.5px] text-white/90 font-medium">{beat.notif.title}</div>
                            <div className="text-[11px] text-white/55 mt-0.5">{beat.notif.body}</div>
                        </div>
                    )}
                    {dim}{mono}
                </div>
            );
        }

        if (beat.kind === 'flashback') {
            const f = beat.flashback;
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center"
                    style={{ background: `radial-gradient(circle at 50% 45%, ${f?.tint || '#3a2a4a'} 0%, #07080c 78%)` }}>
                    <div className="absolute top-4 left-4 right-4 rounded-2xl px-4 py-2.5 bg-black/50 backdrop-blur-xl border border-white/[0.12] flex items-center gap-2 animate-slide-down">
                        <ImageSquare size={16} className="text-pink-300" />
                        <span className="text-[12px] text-white/85 font-medium">{f?.label || f?.date || '过去的某天'}</span>
                    </div>
                    <div className="w-[68%] aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.1] shadow-2xl relative grayscale-[35%] animate-fade-in"
                        style={{ background: `linear-gradient(160deg, ${f?.tint || '#5a4a6a'}, #1a1520)`, animationDuration: '1.4s' }}>
                        <div className="absolute inset-0 flex items-center justify-center opacity-40">
                            <ImageSquare size={48} weight="thin" className="text-white" />
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
                            {f?.date && <div className="text-[9px] text-white/50 tabular-nums">{f.date}</div>}
                            {f?.caption && <div className="text-[12px] text-white/85">{f.caption}</div>}
                        </div>
                    </div>
                    {beat.monologue
                        ? <div className="mt-6 px-10 text-center"><Typewriter drafts={[]} sent={beat.monologue} placeholder="" className="text-[14px] text-white/80" /></div>
                        : <p className="mt-6 text-[12px] text-white/30 tracking-[0.3em]">· · ·</p>}
                </div>
            );
        }

        // kind === 'app'
        const a = beat.app;
        if (!a) return <>{dim}{mono}</>;
        return (
            <div className="absolute inset-0 flex flex-col">
                <div className="h-11 flex items-center gap-2 px-5 shrink-0 text-white/70 border-b border-white/[0.06]">
                    {appIcon(a.view)}
                    <span className="text-[12.5px] font-medium">{a.name}</span>
                </div>
                <div className="flex-1 overflow-hidden relative">
                    <AppView app={a} char={char} />
                </div>
                {dim}{mono}
            </div>
        );
    };

// ============================================================
//  OVERLAY — notification (drops) / thought (fades over the live screen)
// ============================================================
const Overlay: React.FC<{ beat: Beat }> = ({ beat }) => {
    if (beat.kind === 'thought') {
        const scrim = beat.vibe === 'happy' ? 'bg-black/30' : beat.vibe === 'chaotic' ? 'bg-black/60' : 'bg-black/45 backdrop-blur-sm';
        return (
            <div className={`absolute inset-0 ${scrim}`}>
                <MoodThought text={beat.monologue || '……'} vibe={beat.vibe} />
            </div>
        );
    }
    // notification
    const n = beat.notif;
    const toneColor = n?.tone === 'sms' ? '#4ade80' : n?.tone === 'flashback' ? '#ff5fb0' : ACCENT;
    return (
        <div className="absolute inset-0">
            <div className="absolute top-4 left-4 right-4 rounded-2xl px-4 py-3 bg-black/60 backdrop-blur-2xl border border-white/[0.14] animate-notif-pop shadow-2xl">
                <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: toneColor, boxShadow: `0 0 8px ${toneColor}` }} />
                    <span className="text-[10px] text-white/55 uppercase tracking-wide">{n?.app}</span>
                </div>
                <div className="text-[13px] text-white font-semibold">{n?.title}</div>
                <div className="text-[11.5px] text-white/65 mt-0.5">{n?.body}</div>
            </div>
            {beat.monologue && <MonoLine text={beat.monologue} vibe={beat.vibe} />}
        </div>
    );
};

const appIcon = (v: string) => {
    const p: any = { size: 15, weight: 'fill' as const, style: { color: ACCENT } };
    switch (v) {
        case 'search': return <MagnifyingGlass {...p} />;
        case 'music': return <MusicNotes {...p} />;
        case 'photo': return <ImageSquare {...p} />;
        case 'notes': return <NotePencil {...p} />;
        case 'browser': return <Globe {...p} />;
        case 'weather': return <CloudSun {...p} />;
        case 'chat': return <BellRinging {...p} />;
        default: return <Sparkle {...p} />;
    }
};

// ============================================================
//  APP VIEWS
// ============================================================
const AppView: React.FC<{ app: NonNullable<Beat['app']>; char: CharacterProfile }> = ({ app, char }) => {
    if (app.view === 'chat' && app.chat) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar px-4 py-4 space-y-2.5">
                <div className="text-center text-[10px] text-white/30 mb-2">{app.chat.name}</div>
                {app.chat.lines.map((l, i) => (
                    <div key={i} className={`flex ${l.me ? 'justify-end' : 'justify-start'} animate-fade-in`}
                        style={{ animationDelay: `${i * 320}ms`, animationFillMode: 'backwards' }}>
                        <div className={`px-3.5 py-2 rounded-2xl max-w-[74%] text-[13px] leading-relaxed ${l.me ? 'text-[#1a1530] rounded-br-md' : 'bg-white/[0.08] text-white/90 border border-white/[0.06] rounded-bl-md'}`}
                            style={l.me ? { background: ACCENT } : undefined}>
                            {l.text}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (app.view === 'compose' && app.compose) {
        const c = app.compose;
        return (
            <div className="h-full flex flex-col justify-end p-4">
                {c.to && <div className="text-[10px] text-white/30 mb-2 px-1">To: {c.to}</div>}
                <div className="rounded-2xl bg-white/[0.05] border border-white/[0.1] px-4 py-3 min-h-[52px] flex items-center">
                    <Typewriter drafts={c.drafts || []} sent={c.sent} placeholder="输入消息…"
                        className="text-[14px] text-white/90 leading-relaxed" />
                </div>
                <div className="text-[10px] text-white/25 mt-2 px-1">
                    {c.sent ? '已发送' : '草稿已清空'}
                </div>
            </div>
        );
    }

    if (app.view === 'search' && app.search) {
        const qs = app.search.queries || [];
        const last = qs[qs.length - 1];
        const sent = last && !last.deleted ? last.q : null;
        const drafts = qs.slice(0, sent != null ? -1 : qs.length).map(x => x.q);
        return (
            <div className="h-full flex flex-col p-4">
                <div className="rounded-full bg-white/[0.06] border border-white/[0.1] px-4 py-2.5 flex items-center gap-2">
                    <MagnifyingGlass size={15} className="text-white/40" />
                    <Typewriter drafts={drafts} sent={sent} placeholder="搜索" className="text-[13.5px] text-white/85" />
                </div>
                <div className="text-[10px] text-white/25 mt-3 px-1">{app.search.engine || '搜索'}</div>
                <div className="flex-1 flex items-center justify-center">
                    {sent
                        ? <span className="text-[11px] text-white/30">为你找到相关结果…</span>
                        : <span className="text-[11px] text-white/25">— 没有搜索 —</span>}
                </div>
            </div>
        );
    }

    if (app.view === 'photo' && app.photo) {
        const f = app.photo;
        return (
            <div className="h-full flex items-center justify-center p-6">
                <div className="w-full aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.08] relative"
                    style={{ background: `linear-gradient(155deg, ${f.tint || '#3a4a5a'}, #14161c)` }}>
                    <div className="absolute inset-0 flex items-center justify-center opacity-30"><ImageSquare size={44} weight="thin" className="text-white" /></div>
                    <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/65 to-transparent">
                        {f.date && <div className="text-[9px] text-white/45 tabular-nums">{f.date}</div>}
                        {f.caption && <div className="text-[12px] text-white/85">{f.caption}</div>}
                    </div>
                </div>
            </div>
        );
    }

    if (app.view === 'music' && app.music) {
        const m = app.music;
        return (
            <div className="h-full flex flex-col items-center justify-center gap-5 px-10">
                <div className="w-36 h-36 rounded-3xl flex items-center justify-center animate-bounce-slow" style={{ background: `linear-gradient(135deg, ${ACCENT}55, ${ACCENT}10)` }}>
                    <MusicNotes size={46} weight="fill" style={{ color: ACCENT }} />
                </div>
                <div className="text-center">
                    <div className="text-[15px] text-white font-medium">{m.song}</div>
                    <div className="text-[12px] text-white/45 mt-1">{m.artist}</div>
                </div>
                <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden"><div className="h-full w-1/3 rounded-full" style={{ background: ACCENT }} /></div>
                {m.state && <div className="text-[10px] text-white/30">{m.state}</div>}
            </div>
        );
    }

    if (app.view === 'notes' && app.notes) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar p-5">
                {app.notes.title && <div className="text-[15px] text-white font-medium mb-3">{app.notes.title}</div>}
                <div className="space-y-2.5">
                    {app.notes.items.map((it, i) => (
                        <div key={i} className="flex items-start gap-2.5 text-[13px] text-white/75">
                            <span className="w-4 h-4 rounded border border-white/20 mt-0.5 shrink-0" />
                            <span>{it}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (app.view === 'browser' && app.browser) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar p-4 space-y-2">
                <div className="text-[10px] text-white/30 px-1 mb-1">{app.browser.tabs.length} 个标签页</div>
                {app.browser.tabs.map((t, i) => (
                    <div key={i} className="rounded-xl bg-white/[0.04] border border-white/[0.07] px-3.5 py-3 flex items-center gap-2.5">
                        <Globe size={15} className="text-white/35 shrink-0" />
                        <span className="text-[12.5px] text-white/75 truncate">{t}</span>
                    </div>
                ))}
            </div>
        );
    }

    if (app.view === 'weather' && app.weather) {
        const w = app.weather;
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3">
                <CloudSun size={56} weight="thin" className="text-white/70" />
                <div className="text-[52px] font-extralight text-white leading-none tabular-nums">{w.temp}°</div>
                <div className="text-[13px] text-white/55">{w.city} · {w.desc}</div>
            </div>
        );
    }

    return (
        <div className="h-full flex items-center justify-center px-8 text-center">
            <p className="text-[13.5px] text-white/70 leading-relaxed">{app.text || '…'}</p>
        </div>
    );
};

// ============================================================
//  SHARED CHROME
// ============================================================
const Shell: React.FC<{ children: React.ReactNode; wallpaper?: string }> = ({ children, wallpaper }) => (
    <div className="absolute inset-0 z-[80] flex flex-col overflow-hidden text-white" style={{ background: '#07080c' }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(130% 80% at 50% 0%, #1a1726 0%, #0a0b12 60%, #07080c 100%)' }} />
        {wallpaper && <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: `url(${wallpaper})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to bottom, rgba(7,8,12,0.4), rgba(7,8,12,0.2) 40%, rgba(7,8,12,0.9))' }} />
        <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
);

const TopBar: React.FC<{ onBack: () => void; right?: React.ReactNode; title?: string }> = ({ onBack, right, title }) => (
    <div className="h-14 flex items-center justify-between px-4 shrink-0 pt-2">
        <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
            <CaretLeft size={18} weight="bold" />
        </button>
        {title && <span className="text-[14px] font-semibold text-white">{title}</span>}
        <div className="flex justify-end min-w-[80px]">{right}</div>
    </div>
);

// ============================================================
//  LIFE LOG (生活记录) — sub-app
// ============================================================
export const LifeLog: React.FC<{ targetChar: CharacterProfile; onBack: () => void }> = ({ targetChar, onBack }) => {
    const logs = targetChar.phoneState?.simLogs || [];
    const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (
        <Shell wallpaper={targetChar.dateBackground}>
            <TopBar onBack={onBack} title="生活记录" />
            <div className="px-6 pb-3 shrink-0">
                <p className="text-[11px] text-white/40 leading-relaxed">那些你以 TA 的身份活过的片段。TA 不会记得，但你会。</p>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-10 space-y-3">
                {logs.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-64 text-white/30 gap-3">
                        <ClockCounterClockwise size={42} weight="light" />
                        <span className="text-xs">还没有体验记录</span>
                    </div>
                )}
                {logs.map(log => (
                    <div key={log.id} className="rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[9px] px-2 py-0.5 rounded-full tracking-wider" style={{ color: ACCENT, background: `${ACCENT}1f` }}>
                                {log.mode === 'daily' ? '日常' : '事件'} · {log.theme}
                            </span>
                            <span className="text-[9px] text-white/30 tabular-nums">{fmt(log.timestamp)}</span>
                        </div>
                        <div className="text-[15px] font-light text-white mb-1.5" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{log.title}</div>
                        {log.ending && <div className="text-[10px] text-white/40 mb-1.5">结局 · {log.ending}</div>}
                        <p className="text-[12.5px] text-white/60 leading-relaxed" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{log.summary}</p>
                        {log.buff?.label && (
                            <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px]" style={{ borderColor: `${log.buff.color || ACCENT}55`, color: 'rgba(255,255,255,0.8)', background: `${log.buff.color || ACCENT}14` }}>
                                <span>{log.buff.emoji || '✨'}</span>{log.buff.label}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </Shell>
    );
};

// ============================================================
//  DIRECTOR PROMPT + PARSER
// ============================================================
// 把「最早一条消息距今多久」翻译成给导演看的认识时长描述（闪回时间口径护栏）
function describeAcquaintance(firstTs: number | undefined, userName: string, charName: string): string {
    if (!firstTs) {
        return `${charName} 与 ${userName} 还没有可考的相处记录（可能是初次接触）。`;
    }
    const days = Math.floor((Date.now() - firstTs) / 86400000);
    let span: string;
    if (days <= 1) span = '不到一天';
    else if (days < 30) span = `约 ${days} 天`;
    else if (days < 365) span = `约 ${Math.floor(days / 30)} 个月`;
    else span = `约 ${(days / 365).toFixed(1)} 年`;
    return `${charName} 与 ${userName} 自首次接触至今${span}（${days} 天）。`;
}

function buildDirectorPrompt(context: string, recent: string, mode: 'daily' | 'event', theme: string, name: string, acquaintance: string): string {
    return `${context}

### [最近的聊天上下文]
${recent || '（暂无最近对话）'}

### [导演任务：手机人生演出 Screenlife]
你现在是一位沉浸式叙事导演。请把「${name}」的一段人生，编排成一场**以手机为载体的第一人称演出**。
体验类型：${mode === 'daily' ? '日常模拟（普通日子，重生活感与陪伴）' : '事件模拟（特殊事件，重情绪张力）'}
体验内容：「${theme}」
关系时间线（重要护栏）：${acquaintance}

观众（用户）将**成为 ${name}**，通过 TA 使用手机的行为，亲身经历这段时间。

【铁律】
1. 不要把故事讲出来，不要解释人物，不要分析情绪，不要总结意义。一切通过**手机行为 / 数字痕迹 / 内心独白 / 环境碎片**自然呈现。
2. 内心独白（monologue）要**大量出现**，但**极其口语、简短、真实**，像真实人脑活动。例如：「不想起床。」「算了。」「她怎么还没回我。」「应该没事吧。」「其实有点在意。」禁止文学腔、禁止解释剧情。
3. **非可靠叙事**：TA 说的/想的不一定是真相，允许自我安慰、自我欺骗、逃避、美化记忆、误解他人。让行为去拆穿独白（例如嘴上说「我根本不在意」，却反复打开同一个聊天窗口）。
4. **数字行为优先**：多用「打字后删除(compose)」「搜索后删除再搜(search)」「翻看旧照片」「反复打开同一页面」「消息撤回」来表达，而不是直接说出情绪。
5. **真实手机感**：可穿插与主线无关的真实手机事件——来电、电量不足、验证码、快递通知、垃圾短信、天气预警、自动续费、各种推送。它们不一定推动剧情，但增强真实。
6. **环境碎片**：可出现与主线无关的痕迹——没做完的待办、半年前的截图、忘记删的照片、一堆浏览器标签、购物车、旧闹钟、收藏夹。这些共同拼出 TA 的人格。
7. **情绪高潮放慢节奏**：关键节点用「打开→关闭→重新打开→停顿→锁屏→再打开→输入→删除→输入→删除→最终发送(或不发)」这种反复的 beat 序列制造张力，并把这些 beat 的 pace 设为 3。
8. 【记忆闪回 · 务必先判断是否合理，宁可不插也不要 OOC】闪回是 ${name} **自己的一段过去突然闯进现在**（相册自动弹出一张旧照片→沉默→什么都不说→继续今天，杀伤力来自“过去闯进现在”）。但是否插入、用什么时间口径，必须严格符合人设与世界观：
   - 时间标签(label)由你决定，必须与上面的「关系时间线」以及角色自身的人生阶段/世界观自洽。例如真的相识一年以上才用「去年今日」；几个月就用「三个月前的今天」「那天」；刚认识或时间线不支持，**绝不要**用「去年」。
   - 照片不一定与用户有关，可以是 ${name} 自己更早的人生片段（地方、人、物）。
   - 如果该角色的设定/世界观里根本没有「拍照片 / 现代时间感 / 可追溯的过去」，或任何闪回都会显得突兀 OOC，就**完全不要**加 flashback beat。
   - ${mode === 'event' ? '事件模拟下，若合理，优先安排一次闪回来强化情绪；若不合理则跳过。' : '日常模拟下，仅在某个安静且合理的时刻择机插入，可有可无。'}

【输出格式】严格输出**一个 JSON 对象**（不要任何额外文字、不要 markdown 代码块），结构如下：
{
  "title": "演出标题（如：普通的周二）",
  "ending": "可选，这次的结局版本标签（如：最终没有发送）",
  "summary": "1-2 句收尾，客观留白，不解释",
  "buff": { "name": "英文key", "label": "中文情绪标签(4-8字)", "emoji": "1个emoji", "color": "#hex", "intensity": 1|2|3, "description": "一句给AI看的情绪底色" },
  "beats": [ ... 20~36 个 beat ... ]
}

每个 beat 是一个对象，必含 "kind"，按需含 "time"(HH:MM)、"monologue"、"pace"(1普通/2稍慢/3高潮)、"vibe"。
**"vibe" 决定这段文字的视觉演出**，请根据 TA 此刻的情绪状态给 thought / 关键 monologue 标注，取值：
  - "calm" 平静（默认，文字居中缓缓敲出）
  - "chaotic" 混乱崩溃（文字会铺天盖地散落满屏——情绪越乱越适合）
  - "happy" 开心（粉色字 + 飘飘上浮的小装饰）
  - "anxious" 焦虑（文字紧绷、发红、轻微脉动）
  - "numb" 麻木空洞（文字冷淡、缩小、大片留白）
  - "tender" 温柔/眷恋（柔光）
kind 取值与字段：
- {"kind":"lock","time":"07:12","notif":{"app":"闹钟","title":"...","body":"..."},"monologue":"不想起床。"}  // 锁屏/亮屏
- {"kind":"thought","monologue":"算了。","vibe":"numb"}  // 纯内心独白；情绪强烈时务必给 vibe（如崩溃→"chaotic"、雀跃→"happy"）
- {"kind":"notification","notif":{"app":"微信","title":"...","body":"...","tone":"push|sms|system|flashback"},"monologue":"..."}  // 横幅通知
- {"kind":"app","app":{"name":"微信","view":"chat","chat":{"name":"妈","lines":[{"me":false,"text":"吃饭了吗"},{"me":true,"text":"吃了"}]}}}
- {"kind":"app","app":{"name":"微信","view":"compose","compose":{"to":"她","drafts":["在吗","你最近还好吗"],"sent":null}}}  // 打字后删除；sent=null表示最终没发，sent填字符串表示最终发送
- {"kind":"app","app":{"name":"搜索","view":"search","search":{"engine":"百度","queries":[{"q":"失眠怎么办","deleted":true},{"q":"长期睡不好会死吗","deleted":true},{"q":"猫为什么半夜叫"}]}}}
- {"kind":"app","app":{"name":"相册","view":"photo","photo":{"caption":"...","date":"2024-06-19","tint":"#5a6a7a"}}}
- {"kind":"app","app":{"name":"音乐","view":"music","music":{"song":"...","artist":"...","state":"单曲循环"}}}
- {"kind":"app","app":{"name":"备忘录","view":"notes","notes":{"title":"待办","items":["...","..."]}}}
- {"kind":"app","app":{"name":"浏览器","view":"browser","browser":{"tabs":["...","..."]}}}
- {"kind":"app","app":{"name":"天气","view":"weather","weather":{"city":"...","temp":22,"desc":"多云"}}}
- {"kind":"flashback","time":"15:00","flashback":{"label":"三个月前的今天","caption":"...","date":"...","tint":"#4a3a5a"},"monologue":""}  // 记忆闪回(可选)，label=自洽的时间口径，monologue留空=沉默
- {"kind":"end","time":"23:40"}  // 最后一个 beat 必须是 end

请确保 beats 有清晰的时间推进、节奏起伏、至少一处 compose 或 search 的“打字/删除”行为、至少一处环境碎片、一处情绪高潮(pace=3 的连续 beats)。直接输出 JSON 对象。`;
}

function parseScript(raw: string): SimScript | null {
    if (!raw) return null;
    let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    s = s.slice(first, last + 1);
    const repair = (str: string) => {
        let inStr = false, esc = false, out = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (esc) { out += ch; esc = false; continue; }
            if (ch === '\\') { out += ch; esc = true; continue; }
            if (ch === '"') { inStr = !inStr; out += ch; continue; }
            if (inStr && ch === '\n') { out += '\\n'; continue; }
            if (inStr && ch === '\r') { out += '\\r'; continue; }
            if (inStr && ch === '\t') { out += '\\t'; continue; }
            out += ch;
        }
        return out;
    };
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(repair(s)); } catch (e) { console.warn('persona parse failed', e); return null; }
}

export default PersonaSim;
