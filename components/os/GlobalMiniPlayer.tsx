/**
 * 全局悬浮 Mini 播放器
 * 仅在 非 Music / 非 Launcher 应用里 显示，表示「后台正在放歌」。
 * Launcher 页让位给已有的 Dock，Music 页让位给页面内自带的 MiniPlayer。
 *
 * 默认折叠：只显示一个带封面的小圆球，点开才展开完整控制条；
 * 小球可拖动、可长按隐藏；切到新歌时会自动再出现。
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, SkipForward, SkipBack, CaretDown, X } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { useMusic } from '../../context/MusicContext';
import { AppID } from '../../types';
import { isIOSStandaloneWebApp, readSafeAreaInsets } from '../../utils/iosStandalone';
import {
  clampBubblePos,
  clampExpandedBottom,
  resolveInsets,
  resolveSafeTopInset,
} from '../../utils/floatingBallBounds';

const STORAGE_KEY = 'globalMiniPlayer.bubblePos.v1';
const HIDDEN_KEY = 'globalMiniPlayer.hidden.v1';
const EXPANDED_BOTTOM_KEY = 'globalMiniPlayer.expandedBottom.v1';
const DRAG_THRESHOLD = 4; // 像素：超过这个位移算拖动，不触发点击

// —— 对外接口：音乐 App 设置页控制悬浮球 ——
// localStorage 总开关（'0' = 关，缺省 = 开）+ 同窗口 CustomEvent 即时通知
// （storage 事件只在跨窗口才触发，同窗口改 localStorage 得自己吆喝一声）。
export const MINIPLAYER_ENABLED_KEY = 'globalMiniPlayer.enabled.v1';
export const MINIPLAYER_CMD_EVENT = 'sully-miniplayer-cmd';
export type MiniPlayerCmd =
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'reset-pos' };

type Pos = { x: number; y: number } | null;

const readPos = (): Pos => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
  } catch {}
  return null;
};

const readExpandedBottom = (): number | null => {
  try {
    const raw = localStorage.getItem(EXPANDED_BOTTOM_KEY);
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
};

const parsePx = (value: string): number => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readSafeTopInset = (): number => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;

  // 优先复用 iosStandalone.ts 写到 :root 的值：iOS standalone 冷启动时 raw env/probe
  // 可能先给 0，但 --standalone-safe-area-top 已经有 44px 兜底。
  const standaloneSafeTop = parsePx(
    window.getComputedStyle(document.documentElement).getPropertyValue('--standalone-safe-area-top'),
  );
  if (standaloneSafeTop > 0) return standaloneSafeTop;

  return resolveSafeTopInset({
    standaloneSafeTop,
    probedSafeTop: readSafeAreaInsets().top || 0,
    isIOSStandalone: isIOSStandaloneWebApp(),
  });
};

// 把父容器（PhoneShell 外壳）的 padding 与安全区合成球要让出的高度。
// 只在每次拖拽手势开始（pointerdown）时调一次并缓存进 dragState：
// safe-area 读取可能触发样式计算 / 探针读取，放进高频 pointermove 会抖。
const computeInsets = (parent: HTMLElement): { insetTop: number; insetBottom: number } => {
  const cs = window.getComputedStyle(parent);
  return resolveInsets({
    padTop: parseFloat(cs.paddingTop) || 0,
    padBottom: parseFloat(cs.paddingBottom) || 0,
    safeTop: readSafeTopInset(),
  });
};

const GlobalMiniPlayer: React.FC = () => {
  const { activeApp } = useOS();
  const { current, playing, togglePlay, nextSong, prevSong, progress, duration } = useMusic();

  const [expanded, setExpanded] = useState(false); // 默认折叠
  const [pos, setPos] = useState<Pos>(() => readPos()); // null = 默认右下
  const [expandedBottom, setExpandedBottom] = useState<number | null>(() => readExpandedBottom()); // 展开态距底部像素
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return sessionStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
  });
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem(MINIPLAYER_ENABLED_KEY) !== '0'; } catch { return true; }
  });

  const expandedRef = useRef<HTMLDivElement | null>(null);
  const expandedDragState = useRef<{
    startY: number;
    startBottom: number;
    parentH: number;
    selfH: number;
    insetTop: number;
    insetBottom: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{
    startX: number; startY: number;
    offX: number; offY: number;
    parentW: number; parentH: number;
    insetTop: number; insetBottom: number;
    moved: boolean;
    pointerId: number | null;
  } | null>(null);
  const longPressTimer = useRef<number | null>(null);

  // 只有用户真正"重新按下播放"（playing 从 false → true）才自动取消隐藏。
  // 仅靠 current.id 判断会让组件每次挂载（比如打开聊天 App）就把上一首歌"复活"显示出来——
  // 即使用户上次已经手动关掉了球、并且当下并没有在听歌。
  // ref 初始化为当前 playing 值：避免挂载瞬间被误判为 false→true 跳变。
  const prevPlayingRef = useRef(playing);
  // 本次会话是否真正播放过。冷启动/重新进入项目时，MusicContext 会从 localStorage
  // 恢复 queue+idx（于是 current 非空），但新建的 <audio> 尚未播放（playing=false）。
  // 这种"恢复出来但没在放"的暂停态不应该弹出悬浮球——只有真正播放过之后，
  // 会话内的手动暂停才保留显示。
  const [everPlayed, setEverPlayed] = useState(playing);
  useEffect(() => {
    if (playing) {
      setEverPlayed(true);
      if (!prevPlayingRef.current) {
        setHidden(false);
        try { sessionStorage.removeItem(HIDDEN_KEY); } catch {}
      }
    }
    prevPlayingRef.current = playing;
  }, [playing]);

  // 持久化位置
  useEffect(() => {
    if (!pos) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch {}
  }, [pos]);

  useEffect(() => {
    if (expandedBottom == null) return;
    try { localStorage.setItem(EXPANDED_BOTTOM_KEY, String(expandedBottom)); } catch {}
  }, [expandedBottom]);

  // 展开态：拖把手垂直拖动；点击则收起
  const onExpandedHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = expandedRef.current;
    if (!el) return;
    const parent = el.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const selfRect = el.getBoundingClientRect();
    const currentBottom = parentRect.bottom - selfRect.bottom;
    const { insetTop, insetBottom } = computeInsets(parent);
    expandedDragState.current = {
      startY: e.clientY,
      startBottom: currentBottom,
      parentH: parentRect.height,
      selfH: selfRect.height,
      insetTop,
      insetBottom,
      moved: false,
      pointerId: e.pointerId,
    };
    try { (e.currentTarget as any).setPointerCapture?.(e.pointerId); } catch {}
  }, []);

  const onExpandedHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = expandedDragState.current;
    if (!ds) return;
    const dy = e.clientY - ds.startY;
    if (!ds.moved && Math.abs(dy) > DRAG_THRESHOLD) ds.moved = true;
    if (!ds.moved) return;
    const nextBottom = clampExpandedBottom(ds.startBottom - dy, {
      parentH: ds.parentH,
      selfH: ds.selfH,
      insetTop: ds.insetTop,
      insetBottom: ds.insetBottom,
    });
    setExpandedBottom(nextBottom);
  }, []);

  const onExpandedHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = expandedDragState.current;
    expandedDragState.current = null;
    try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
    if (ds && !ds.moved) {
      // 当作"收起到小球"
      setExpanded(false);
    }
  }, []);

  const hide = useCallback(() => {
    setHidden(true);
    setExpanded(false);
    try { sessionStorage.setItem(HIDDEN_KEY, '1'); } catch {}
  }, []);

  const bubbleVisible =
    !!current &&
    // 重新进入项目时音乐是暂停的（从未真正播放过本次会话）→ 不显示悬浮球
    (everPlayed || playing) &&
    activeApp !== AppID.Music &&
    activeApp !== AppID.Launcher && // Launcher 的 dock 够用了
    activeApp !== AppID.Call &&     // 通话中不打扰
    !hidden &&
    enabled;

  // 音乐 App 设置页发来的指令：开关显隐 / 一键回默认位置
  useEffect(() => {
    const onCmd = (e: Event) => {
      const cmd = (e as CustomEvent).detail as MiniPlayerCmd | undefined;
      if (!cmd) return;
      if (cmd.type === 'set-enabled') {
        setEnabled(cmd.enabled);
        if (cmd.enabled) {
          // 用户明确说"我要看到球" → 顺带解除长按误触留下的隐藏态
          setHidden(false);
          try { sessionStorage.removeItem(HIDDEN_KEY); } catch {}
        }
      } else if (cmd.type === 'reset-pos') {
        setPos(null);
        setExpandedBottom(null);
        setExpanded(false);
        setHidden(false);
        try {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(EXPANDED_BOTTOM_KEY);
          sessionStorage.removeItem(HIDDEN_KEY);
        } catch {}
      }
    };
    window.addEventListener(MINIPLAYER_CMD_EVENT, onCmd);
    return () => window.removeEventListener(MINIPLAYER_CMD_EVENT, onCmd);
  }, []);

  // 越界自愈：保存的坐标是绝对像素，可能来自另一个视口（网页 ↔ APK，
  // 或横竖屏切换）——直接拿来用可能整颗球落在屏幕外，看起来就像"球消失了"。
  // 挂载/尺寸变化/重新可见时 clamp 一把拉回屏内；拖动中不插手（拖动自己会 clamp）。
  useEffect(() => {
    if (expanded || !bubbleVisible) return;
    const ensureInBounds = () => {
      if (dragState.current) return;
      const el = wrapRef.current;
      const parent = el?.parentElement as HTMLElement | null;
      if (!el || !parent) return;
      const parentRect = parent.getBoundingClientRect();
      if (parentRect.width < 60 || parentRect.height < 60) return; // 布局还没站稳，别乱改
      const { insetTop, insetBottom } = computeInsets(parent);
      setPos(prev => {
        if (!prev) return prev; // 默认右下角（right/bottom 定位）永远在屏内，不用管
        const next = clampBubblePos(prev.x, prev.y, {
          parentW: parentRect.width,
          parentH: parentRect.height,
          insetTop,
          insetBottom,
        });
        return Math.abs(next.x - prev.x) > 1 || Math.abs(next.y - prev.y) > 1 ? next : prev;
      });
    };
    ensureInBounds();
    window.addEventListener('resize', ensureInBounds);
    return () => window.removeEventListener('resize', ensureInBounds);
  }, [expanded, bubbleVisible]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const parent = el.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const bubbleRect = el.getBoundingClientRect();
    const { insetTop, insetBottom } = computeInsets(parent);

    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - bubbleRect.left,
      offY: e.clientY - bubbleRect.top,
      parentW: parentRect.width,
      parentH: parentRect.height,
      insetTop,
      insetBottom,
      moved: false,
      pointerId: e.pointerId,
    };

    // 长按隐藏
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      if (dragState.current && !dragState.current.moved) {
        hide();
        dragState.current = null;
      }
    }, 600);

    try { (e.currentTarget as any).setPointerCapture?.(e.pointerId); } catch {}
  }, [hide]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const ds = dragState.current;
    const el = wrapRef.current;
    if (!ds || !el) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (!ds.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      ds.moved = true;
      if (longPressTimer.current) {
        window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    }
    if (!ds.moved) return;

    const parent = el.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const next = clampBubblePos(
      e.clientX - parentRect.left - ds.offX,
      e.clientY - parentRect.top - ds.offY,
      {
        parentW: ds.parentW,
        parentH: ds.parentH,
        insetTop: ds.insetTop,
        insetBottom: ds.insetBottom,
      },
    );
    setPos(next);
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const ds = dragState.current;
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (ds && !ds.moved) {
      // 算作点击 → 展开
      setExpanded(true);
    }
    dragState.current = null;
    try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
  }, []);

  if (!bubbleVisible || !current) return null;

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  // 折叠态：小圆球（可拖动、长按隐藏、单击展开）
  if (!expanded) {
    const positional: React.CSSProperties = pos
      ? { left: pos.x, top: pos.y }
      : { right: 12, bottom: 12 };
    return (
      <div
        ref={wrapRef}
        data-floating-bubble="music"
        className="absolute z-[55] pointer-events-none"
        style={positional}
      >
        <button
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onContextMenu={(e) => e.preventDefault()}
          className="pointer-events-auto relative w-10 h-10 rounded-full overflow-hidden active:scale-95 transition-transform touch-none select-none"
          style={{
            boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
            border: '1px solid rgba(255,255,255,0.25)',
          }}
          aria-label="音乐播放器（点击展开，拖动移位，长按隐藏）"
          title="点击展开 · 拖动移位 · 长按隐藏"
        >
          <img
            src={current.albumPic}
            alt=""
            draggable={false}
            className="w-full h-full object-cover pointer-events-none"
          />
          {/* 播放/暂停小指示 */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ background: 'rgba(0,0,0,0.25)' }}
          >
            {playing
              ? <Pause size={14} weight="fill" color="#fff" />
              : <Play size={14} weight="fill" color="#fff" />}
          </div>
          {/* 进度细条 */}
          <div className="absolute left-0 bottom-0 w-full h-[2px] bg-white/20 pointer-events-none">
            <div
              className="h-full bg-gradient-to-r from-sky-400 to-indigo-400 transition-all duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
        </button>
      </div>
    );
  }

  // 展开态：原来的完整 Mini 播放器
  // 刻意不给外层 wrapper 绑 onClick —— 在别的 App 里点它不应该跳到 Music App
  // （会把用户正在做的事情弄丢），只有里面的按钮生效。
  return (
    <div
      ref={expandedRef}
      className="absolute left-3 right-3 z-[55] pointer-events-none"
      style={{ bottom: expandedBottom != null ? expandedBottom : 12 }}
    >
      <div
        className="pointer-events-auto flex items-center gap-2.5 rounded-2xl pl-1.5 pr-2.5 py-2 relative overflow-hidden animate-fade-in"
        style={{
          background: 'rgba(20, 24, 35, 0.65)',
          backdropFilter: 'blur(24px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
          border: '1px solid rgba(255,255,255,0.15)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        }}
      >
        {/* 拖动把手 — 垂直拖动整个条；点击则收起 */}
        <div
          onPointerDown={onExpandedHandleDown}
          onPointerMove={onExpandedHandleMove}
          onPointerUp={onExpandedHandleUp}
          onPointerCancel={onExpandedHandleUp}
          className="shrink-0 flex items-center justify-center px-1 cursor-grab active:cursor-grabbing touch-none select-none"
          style={{ alignSelf: 'stretch' }}
          aria-label="拖动调整位置（点击收起）"
          title="上下拖动 · 点击收起"
        >
          <div className="w-1 h-7 rounded-full" style={{ background: 'rgba(255,255,255,0.25)' }} />
        </div>
        {/* 封面 */}
        <img
          src={current.albumPic}
          alt=""
          className="w-9 h-9 rounded-lg object-cover shrink-0"
          style={{ border: '1px solid rgba(255,255,255,0.2)' }}
        />

        {/* 文字 */}
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[11px] font-medium truncate text-white">{current.name}</div>
          <div className="text-[9px] truncate text-white/60">{current.artists}</div>
        </div>

        {/* 控制 */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); prevSong(); }}
            className="p-1.5 rounded-full text-white/80 active:scale-95 transition-transform"
          >
            <SkipBack size={14} weight="fill" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
            className="p-1.5 rounded-full text-white active:scale-95 transition-transform"
            style={{ background: 'rgba(255,255,255,0.15)' }}
          >
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); nextSong(); }}
            className="p-1.5 rounded-full text-white/80 active:scale-95 transition-transform"
          >
            <SkipForward size={14} weight="fill" />
          </button>
          {/* 折叠按钮 */}
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
            className="p-1.5 rounded-full text-white/70 active:scale-95 transition-transform ml-0.5"
            aria-label="收起播放器"
            title="收起成小球"
          >
            <CaretDown size={14} weight="bold" />
          </button>
          {/* 隐藏按钮 */}
          <button
            onClick={(e) => { e.stopPropagation(); hide(); }}
            className="p-1.5 rounded-full text-white/70 active:scale-95 transition-transform"
            aria-label="隐藏播放器（切到下一首时会再出现）"
            title="隐藏（下一首会再出现）"
          >
            <X size={14} weight="bold" />
          </button>
        </div>

        {/* 底部细进度条 */}
        <div className="absolute left-0 bottom-0 h-[2px] bg-gradient-to-r from-sky-400 to-indigo-400 transition-all duration-150"
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

export default GlobalMiniPlayer;
