/**
 * Char 拜访页 — 访问某个角色的网易云风格"小号主页"
 *
 * 思路：完全仿网易云个人主页排版，但数据全来自本地 CharMusicProfile。
 * 用户体验上就像 "去别人主页逛一圈"，不是 "切换账号"。
 *
 * 交互：
 * - 未初始化 → 显示"敲敲门"按钮，点一下调 LLM 生成 musicProfile。
 * - 已初始化 → 展示 bio / 曲风徽章 / 偏爱艺人 / 歌单 / 最近在听 / 评论。
 * - 点歌单进详情（若歌单空，可以一键让 char 搜歌填充）。
 * - 点任一首歌 → 用全局 MusicContext 播放 (沿用 user 的 cookie / 配额)。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, toHttps, Song } from '../../context/MusicContext';
import { CharacterProfile, CharPlaylist, CharPlaylistSong } from '../../types';
import { CharMusicPersona } from '../../utils/charMusicPersona';
import { computeCurrentListening } from '../../utils/charMusicSchedule';
import { removeSongsFromPlaylist } from '../../utils/charPlaylistEdit';
import { DB } from '../../utils/db';
import { C, Sparkle, MizuHeader, BokehBg, MiniPlayer } from './MusicUI';
import { ArrowLeft, MusicNote, Heart, Plus, MagnifyingGlass, Trash, Check, Star, FilmSlate, GameController, Popcorn, MonitorPlay, ArrowClockwise, PencilSimple, X } from '@phosphor-icons/react';
import { getLocalDailySchedule } from '../../utils/dailySchedule';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';

interface Props {
  charId: string;
  onBack: () => void;
  onOpenPlayer: () => void;
}

const gradientMap: Record<string, string> = {
  'gradient-01': `linear-gradient(135deg, ${C.primary}, ${C.accent})`,
  'gradient-02': `linear-gradient(135deg, ${C.sakura}, ${C.lavender})`,
  'gradient-03': `linear-gradient(135deg, ${C.accent}, ${C.glow})`,
  'gradient-04': `linear-gradient(135deg, ${C.lavender}, ${C.primary})`,
  'gradient-05': `linear-gradient(135deg, ${C.vip}, ${C.sakura})`,
  'gradient-06': `linear-gradient(135deg, ${C.glow}, ${C.lavender})`,
};
const gradientFor = (key?: string) => gradientMap[key || 'gradient-01'] || gradientMap['gradient-01'];

const songFromSearch = (s: any): Song => ({
  id: s.id,
  name: s.name,
  artists: (s.ar || s.artists || []).map((a: any) => a.name).join(' / '),
  album: s.al?.name || s.album?.name || '',
  albumPic: toHttps(s.al?.picUrl || s.album?.picUrl || ''),
  duration: (s.dt || s.duration || 0) / 1000,
  fee: s.fee ?? 0,
});

const toPlaylistSong = (s: Song): CharPlaylistSong => ({
  id: s.id, name: s.name, artists: s.artists, album: s.album,
  albumPic: s.albumPic, duration: s.duration, fee: s.fee,
});

const CharVisitPage: React.FC<Props> = ({ charId, onBack, onOpenPlayer }) => {
  const { characters, updateCharacter, userProfile, apiConfig, addToast } = useOS();
  const {
    cfg, playSong,
    current, playing, togglePlay, nextSong, prevSong,
  } = useMusic();
  const char = useMemo(() => characters.find(c => c.id === charId), [characters, charId]);
  const localDateKey = useLocalDateKey();

  const [initializing, setInitializing] = useState(false);
  const [expandedPl, setExpandedPl] = useState<string | null>(null);
  const [fillingPl, setFillingPl] = useState<string | null>(null);

  // 编辑艺人/OST 名字弹窗：null=关闭，否则记录正在编辑哪一项
  const [editingEntry, setEditingEntry] = useState<{ kind: 'artist' | 'soundtrack'; index: number } | null>(null);
  // 顶栏批量匹配图片（艺人头像 + OST 封面）
  const [refreshingArt, setRefreshingArt] = useState(false);

  // 选择模式：长按或点「选择」进入，可勾选多首歌一起删
  const [selectingPl, setSelectingPl] = useState<string | null>(null);
  const [selectedSongIds, setSelectedSongIds] = useState<Set<number>>(new Set());

  const enterSelectMode = (plId: string, songId?: number) => {
    setExpandedPl(plId);
    setSelectingPl(plId);
    setSelectedSongIds(songId != null ? new Set([songId]) : new Set());
  };
  const exitSelectMode = () => {
    setSelectingPl(null);
    setSelectedSongIds(new Set());
  };
  const toggleSelected = (songId: number) => {
    setSelectedSongIds(prev => {
      const next = new Set(prev);
      if (next.has(songId)) next.delete(songId); else next.add(songId);
      return next;
    });
  };

  // 长按检测：按住约 0.5s 触发；手指/鼠标移动超过阈值视为滚动，取消长按
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpFired = useRef(false);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const clearLongPress = () => {
    if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }
    lpStart.current = null;
  };
  // 组件卸载时清掉可能还挂着的长按定时器，别让 setTimeout 落到已卸载的组件上
  useEffect(() => () => { if (lpTimer.current) clearTimeout(lpTimer.current); }, []);
  const songPressHandlers = (pl: CharPlaylist, song: CharPlaylistSong) => ({
    onPointerDown: (e: React.PointerEvent) => {
      lpFired.current = false; // 每次按下先清零：上次长按若没收到 click，别让 true 卡住吞掉这次点击
      clearLongPress();        // 清掉上一次残留的定时器和起点坐标
      if (selectingPl) return; // 已在选择模式，不需要长按
      lpStart.current = { x: e.clientX, y: e.clientY };
      lpTimer.current = setTimeout(() => {
        lpFired.current = true;
        enterSelectMode(pl.id, song.id);
      }, 500);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!lpStart.current) return;
      if (Math.abs(e.clientX - lpStart.current.x) > 10 || Math.abs(e.clientY - lpStart.current.y) > 10) {
        clearLongPress();
      }
    },
    onPointerUp: clearLongPress,
    onPointerLeave: clearLongPress,
    onPointerCancel: clearLongPress,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); }, // 移动端长按不弹系统菜单
  });

  const profile = char?.musicProfile;
  const initialized = !!(char && CharMusicPersona.isInitialized(char));

  // 拜访时刷新 char 此刻在听的歌（纯本地计算，零网络）
  // 只在 char.id / initialized 变化时刷新一次，避免每秒 tick
  useEffect(() => {
    if (!char || !initialized || !char.musicProfile) return;
    let cancelled = false;
    (async () => {
      try {
        const schedule = await getLocalDailySchedule(char.id);
        if (cancelled) return;
        const cur = computeCurrentListening(char, schedule);
        const prev = char.musicProfile!.currentListening;
        const differ = (prev?.songId !== cur?.songId) || (prev?.startedAt !== cur?.startedAt);
        if (differ) {
          updateCharacter(char.id, {
            musicProfile: {
              ...char.musicProfile!,
              currentListening: cur || undefined,
              updatedAt: Date.now(),
            },
          });
        }
      } catch (e) {
        console.warn('[CharVisitPage] refresh currentListening failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [char?.id, initialized, localDateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const doInitialize = useCallback(async () => {
    if (!char || initializing) return;
    setInitializing(true);
    try {
      const newProfile = await CharMusicPersona.initialize(char, userProfile, apiConfig);
      updateCharacter(char.id, { musicProfile: newProfile });
      addToast(`${char.name} 的音乐角落已开启`, 'success');
    } catch (e: any) {
      addToast(`初始化失败：${e.message || '未知错误'}`, 'error');
    } finally {
      setInitializing(false);
    }
  }, [char, initializing, userProfile, apiConfig, updateCharacter, addToast]);

  /** 清掉旧档案重新走一次 LLM —— 给旧版保底生成的"告五人"账号用。 */
  const doRegenerate = useCallback(async () => {
    if (!char || initializing) return;
    const ok = typeof window !== 'undefined'
      ? window.confirm(`清空 ${char.name} 现有的音乐人格，重新让 LLM 生成？\n（歌单里已填的歌也会丢）`)
      : true;
    if (!ok) return;
    setInitializing(true);
    try {
      const newProfile = await CharMusicPersona.initialize(char, userProfile, apiConfig);
      updateCharacter(char.id, { musicProfile: newProfile });
      addToast(`${char.name} 的音乐人格已重新生成`, 'success');
    } catch (e: any) {
      addToast(`重新生成失败：${e.message || '未知错误'}`, 'error');
    } finally {
      setInitializing(false);
    }
  }, [char, initializing, userProfile, apiConfig, updateCharacter, addToast]);

  /**
   * 顶栏刷新按钮：根据艺人名搜艺人、OST 标题搜专辑，匹配头像/封面并写回 profile 持久化。
   * - 艺人走 /search type=100，取 result.artists[0].img1v1Url（1:1 头像）
   * - OST 走 /search type=10，取 result.albums[0].picUrl（专辑封面）
   * - 单个失败不阻塞，最后统一 toast 统计
   */
  const refreshArtImages = useCallback(async () => {
    if (!char || !profile || refreshingArt) return;
    setRefreshingArt(true);
    let artistHits = 0, artistMiss = 0, ostHits = 0, ostMiss = 0;
    try {
      // 拷贝一份避免中间态错乱
      const nextArtists = [...profile.signatureArtists];
      const nextOsts = [...(profile.favoriteSoundtracks || [])];

      // 艺人：搜艺人（type=100），取 img1v1Url
      for (let i = 0; i < nextArtists.length; i++) {
        const a = nextArtists[i];
        if (!a?.name) continue;
        try {
          const r: any = await musicApi.call(cfg, '/search', { keyword: a.name, limit: 5, offset: 0, type: 100 });
          const hit = r?.result?.artists?.[0];
          if (hit?.img1v1Url) {
            nextArtists[i] = { ...a, artistId: hit.id, picUrl: hit.img1v1Url };
            artistHits++;
          } else {
            artistMiss++;
          }
        } catch {
          artistMiss++;
        }
      }

      // OST：搜专辑（type=10），取 picUrl
      for (let i = 0; i < nextOsts.length; i++) {
        const s = nextOsts[i];
        if (!s?.title) continue;
        try {
          const r: any = await musicApi.call(cfg, '/search', { keyword: s.title, limit: 5, offset: 0, type: 10 });
          const hit = r?.result?.albums?.[0];
          if (hit?.picUrl) {
            nextOsts[i] = { ...s, coverUrl: hit.picUrl };
            ostHits++;
          } else {
            ostMiss++;
          }
        } catch {
          ostMiss++;
        }
      }

      updateCharacter(char.id, {
        musicProfile: {
          ...profile,
          signatureArtists: nextArtists,
          favoriteSoundtracks: nextOsts,
          updatedAt: Date.now(),
        },
      });
      const total = artistHits + artistMiss + ostHits + ostMiss;
      const hits = artistHits + ostHits;
      addToast(hits > 0 ? `已匹配 ${hits}/${total}（艺人 ${artistHits} · OST ${ostHits}）` : '没匹配到图片，改改名字再试？', hits > 0 ? 'success' : 'info');
    } catch (e: any) {
      addToast(`匹配失败：${e.message || '未知错误'}`, 'error');
    } finally {
      setRefreshingArt(false);
    }
  }, [char, profile, cfg, refreshingArt, updateCharacter, addToast]);

  /**
   * 编辑弹窗保存：改艺人名或 OST 标题，同时清掉旧的 picUrl/coverUrl（名字变了旧图失效）。
   */
  const saveEntryName = useCallback((newName: string) => {
    if (!char || !profile || !editingEntry) return;
    const clean = newName.trim();
    if (!clean) return;
    if (editingEntry.kind === 'artist') {
      const next = [...profile.signatureArtists];
      const old = next[editingEntry.index];
      if (!old) return;
      // 名字变了才清 picUrl（没图也不重复写）
      const nameChanged = old.name !== clean;
      next[editingEntry.index] = { ...old, name: clean, picUrl: nameChanged ? undefined : old.picUrl };
      updateCharacter(char.id, {
        musicProfile: { ...profile, signatureArtists: next, updatedAt: Date.now() },
      });
    } else {
      const next = [...(profile.favoriteSoundtracks || [])];
      const old = next[editingEntry.index];
      if (!old) return;
      const nameChanged = old.title !== clean;
      next[editingEntry.index] = { ...old, title: clean, coverUrl: nameChanged ? undefined : old.coverUrl };
      updateCharacter(char.id, {
        musicProfile: { ...profile, favoriteSoundtracks: next, updatedAt: Date.now() },
      });
    }
    setEditingEntry(null);
  }, [char, profile, editingEntry, updateCharacter]);

  const togglePlaylist = (plId: string) => {
    setExpandedPl(prev => (prev === plId ? null : plId));
    exitSelectMode(); // 收起或切到别的歌单时，退出选择模式
  };

  /** 把当前选中的歌从歌单里一起删掉（弹一次确认） */
  const deleteSelected = (pl: CharPlaylist) => {
    if (!char || !profile || selectedSongIds.size === 0) return;
    const n = selectedSongIds.size;
    const ok = typeof window !== 'undefined'
      ? window.confirm(`从《${pl.title}》移除选中的 ${n} 首歌？`)
      : true;
    if (!ok) return;
    const nextPlaylists = removeSongsFromPlaylist(profile.playlists, pl.id, selectedSongIds, Date.now());
    updateCharacter(char.id, {
      musicProfile: { ...profile, playlists: nextPlaylists, updatedAt: Date.now() },
    });
    addToast(`已移除 ${n} 首`, 'success');
    exitSelectMode();
  };

  /** 让 char 用偏爱艺人 + OST 标题作为关键词去搜歌 → 自动填充空歌单
   *  关键：每个歌单走一组**不同**的关键词，否则三个歌单会搜出一模一样的歌。
   *  - searchHints 优先（LLM 产出的艺人名+曲风词 / OST 标题）
   *  - 兜底：歌单 title + mood 中文词 + signatureArtists 轮换
   *  - OST 标题按 type 加搜索后缀（game→OST、musical→选段…），搜出来的是原声而非翻唱
   *  - starred 的关键词搜出来取更多条（灵魂艺人/最爱 OST 占比更高），非 starred 取少
   *  - 去掉本角色其它歌单已经有的歌，避免跨歌单撞曲
   */
  const fillPlaylistFromTaste = useCallback(async (pl: CharPlaylist) => {
    if (!char || !profile || fillingPl) return;
    setFillingPl(pl.id);
    try {
      const moodKeywordMap: Record<string, string> = {
        happy: '快乐', sad: '悲伤', romantic: '浪漫', angry: '发泄',
        chill: '放松', epic: '史诗', nostalgic: '怀旧', dreamy: '氛围',
      };

      const plIndex = Math.max(0, profile.playlists.findIndex(p => p.id === pl.id));
      const allArtists = profile.signatureArtists.map(a => ({ name: a.name, starred: a.starred === true })).filter(a => !!a.name);
      const allGenres = profile.genreTags.filter(Boolean);

      // OST/影视标题表：title 归一化 → { type, starred }，用于识别 searchHints 里的 OST 关键词
      const ostMap = new Map<string, { type: string; starred: boolean }>();
      (profile.favoriteSoundtracks || []).forEach(s => {
        if (s?.title) ostMap.set(s.title.trim().toLowerCase(), { type: s.type, starred: s.starred === true });
      });

      // 按 type 给 OST 标题加搜索后缀，确保搜到原声带而非翻唱
      const ostSuffix = (type: string): string => {
        switch (type) {
          case 'game': return ' OST';
          case 'musical': return ' 选段';
          case 'film': return ' 原声';
          case 'anime': return ' 原声';
          case 'ost': return ' OST';
          default: return ' OST';
        }
      };

      // 关键词带元信息：是否 starred（决定取条数）
      type Kw = { kw: string; starred: boolean };
      const pushKw = (list: Kw[], raw: string, starred = false) => {
        const k = raw.trim();
        if (!k) return;
        // 如果命中 OST 表，加后缀 + 继承 starred
        const ost = ostMap.get(k.toLowerCase());
        if (ost) {
          list.push({ kw: k + ostSuffix(ost.type), starred: ost.starred || starred });
        } else {
          list.push({ kw: k, starred });
        }
      };

      // 按歌单序号轮换艺人/曲风，让 A/B/C 三个歌单永远拿到不同切片
      const rotate = <T,>(arr: T[], offset: number, take: number): T[] => {
        if (arr.length === 0) return [];
        const out: T[] = [];
        for (let i = 0; i < take && i < arr.length; i++) {
          out.push(arr[(offset + i) % arr.length]);
        }
        return out;
      };

      const kws: Kw[] = [];
      // 1) LLM 给的 searchHints 优先 — 艺人名+曲风词组合 / OST 标题，能搜到更对味的歌
      if (pl.searchHints && pl.searchHints.length > 0) {
          pl.searchHints.forEach(h => pushKw(kws, h));
      }
      // 2) 兜底：旧逻辑（歌单 title + mood 中文词 + 艺人轮换）
      //    searchHints 缺失或不足时补足，保证老角色也能填
      if (kws.length < 2) {
          // 歌单自己的 title 直接当关键词 — 这是最能拉开差异的一项
          const cleanTitle = (pl.title || '').trim();
          if (cleanTitle && !/^歌单\s*\d*$/.test(cleanTitle)) pushKw(kws, cleanTitle);
          // mood → 中文搜索词
          if (pl.mood && moodKeywordMap[pl.mood]) pushKw(kws, moodKeywordMap[pl.mood]);
          // 旋转后的艺人（每歌单 2 个，错开起点），继承 starred
          rotate(allArtists, plIndex * 2, 2).forEach(a => pushKw(kws, a.name, a.starred));
          // 没艺人就用旋转后的曲风兜底
          if (allArtists.length === 0) rotate(allGenres, plIndex, 2).forEach(g => pushKw(kws, g));
      }

      // 去重（按 kw 字符串）+ 去空，保留 starred
      const seenKw = new Set<string>();
      const uniqKws: Kw[] = [];
      for (const k of kws) {
        if (!seenKw.has(k.kw)) { seenKw.add(k.kw); uniqKws.push(k); }
      }
      if (uniqKws.length === 0) {
        addToast('还没有足够的品味数据，先初始化一下吧', 'info');
        return;
      }

      // 跨歌单去重 + 本歌单已有歌去重（追加模式不能塞已有的回来）
      const existingIds = new Set(pl.songs.map(s => s.id));
      const usedInOthers = new Set<number>();
      for (const other of profile.playlists) {
        if (other.id === pl.id) continue;
        for (const s of other.songs) usedInOthers.add(s.id);
      }

      const picked: CharPlaylistSong[] = [];
      const seen = new Set<number>();
      for (const { kw, starred } of uniqKws) {
        if (picked.length >= 8) break;
        try {
          const r = await musicApi.search(cfg, kw);
          // starred 关键词取前 6 条（灵魂艺人/最爱 OST 占比高），非 starred 取前 3 条
          const take = starred ? 6 : 3;
          const songs: Song[] = (r?.result?.songs || []).slice(0, take).map(songFromSearch);
          for (const s of songs) {
            if (existingIds.has(s.id) || seen.has(s.id) || usedInOthers.has(s.id)) continue;
            seen.add(s.id);
            picked.push(toPlaylistSong(s));
            if (picked.length >= 8) break;
          }
        } catch { /* 单个关键词失败不阻塞 */ }
      }

      if (picked.length === 0) {
        addToast(pl.songs.length > 0 ? '没搜到新歌（已有的都重复了）' : '没搜到合适的歌', 'error');
        return;
      }
      // 追加到末尾，不覆盖原有歌曲
      const updatedPl: CharPlaylist = {
        ...pl,
        songs: [...pl.songs, ...picked],
        coverStyle: pl.coverStyle,
        updatedAt: Date.now(),
      };
      const updatedProfile = {
        ...profile,
        playlists: profile.playlists.map(p => p.id === pl.id ? updatedPl : p),
        updatedAt: Date.now(),
      };
      updateCharacter(char.id, { musicProfile: updatedProfile });
      addToast(`已为《${pl.title}》新增 ${picked.length} 首（共 ${updatedPl.songs.length}）`, 'success');
    } catch (e: any) {
      addToast(`填充失败：${e.message}`, 'error');
    } finally {
      setFillingPl(null);
    }
  }, [char, profile, cfg, fillingPl, updateCharacter, addToast]);

  const playPlaylistSong = (pl: CharPlaylist, song: CharPlaylistSong) => {
    // 用 char 歌单作为队列，点击的歌作为起点
    const queue: Song[] = pl.songs.map(s => ({ ...s }));
    const startIdx = queue.findIndex(s => s.id === song.id);
    playSong(queue[startIdx], { replaceQueue: queue, startIdx });
    onOpenPlayer();
  };

  if (!char) {
    return (
      <div className="flex flex-col h-full relative" style={{ background: C.bg }}>
        <MizuHeader title="拜访" onBack={onBack} />
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: C.muted }}>
          找不到这个角色。
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader
        title={`拜访 · ${char.name}`}
        onBack={onBack}
        right={
          <button
            onClick={refreshArtImages}
            disabled={refreshingArt || !initialized}
            title="根据名字匹配艺人头像 / OST 封面"
            className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform disabled:opacity-40"
          >
            <ArrowClockwise size={18} weight="bold" style={{ color: C.muted }} className={refreshingArt ? 'animate-spin' : ''} />
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar pb-20">
        {/* Banner + 拜访徽标 */}
        <div className="relative h-32 overflow-hidden">
          <div className="absolute inset-0"
            style={{ background: `linear-gradient(135deg, ${C.lavender}50, ${C.sakura}40, ${C.accent}40)` }} />
          <div className="absolute top-3 left-4 text-[10px] tracking-[0.35em] uppercase font-semibold"
            style={{ color: 'rgba(255,255,255,0.9)', textShadow: '0 1px 4px rgba(0,0,0,0.2)' }}>
            Visiting Another Soul
          </div>
          <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, transparent 0%, ${C.bg}CC 100%)` }} />
        </div>

        {/* 角色卡 */}
        <div className="-mt-12 mx-4 rounded-3xl p-4 shizuku-glass-strong relative z-10"
          style={{ boxShadow: `0 10px 40px ${C.glow}15` }}>
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              {char.avatar && char.avatar.startsWith('data:') || char.avatar?.startsWith('http') ? (
                <img src={char.avatar} alt="" className="w-16 h-16 rounded-2xl object-cover"
                  style={{ border: `2px solid ${C.glow}60`, boxShadow: `0 4px 20px ${C.glow}30` }} />
              ) : (
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl"
                  style={{ background: gradientFor('gradient-04'), color: 'white' }}>
                  {char.avatar || char.name.slice(0, 1)}
                </div>
              )}
              <div className="absolute -bottom-1 -right-1">
                <Sparkle size={10} color={C.sakura} delay={0.3} />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold truncate"
                style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
                {char.name}
              </div>
              <div className="text-[10px] mt-0.5 truncate" style={{ color: C.muted }}>
                {profile?.bio || '还没写音乐简介'}
              </div>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {(profile?.genreTags || []).slice(0, 4).map(tag => (
                  <span key={tag} className="text-[9px] px-2 py-0.5 rounded-full"
                    style={{ background: `${C.accent}22`, color: C.primary, border: `1px solid ${C.accent}30` }}>
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* 统计行 */}
          <div className="grid grid-cols-3 gap-2 mt-3 text-center">
            <StatCell label="歌单" value={profile?.playlists.length || 0} />
            <StatCell label="喜欢" value={profile?.likedSongIds.length || 0} />
            <StatCell label="最近听" value={profile?.recentPlays.length || 0} />
          </div>
        </div>

        {/* 未初始化 CTA */}
        {!initialized && (
          <div className="mx-4 mt-4 rounded-2xl p-4 shizuku-glass text-center">
            <div className="text-xs mb-2" style={{ color: C.muted, fontFamily: `'Noto Serif', serif` }}>
              {char.name} 的音乐角落还是一片空白
            </div>
            <div className="text-[10px] mb-3 italic" style={{ color: C.faint }}>
              点开后会生成 ta 的曲风偏好、偏爱艺人和 3 个概念歌单（仅一次 LLM 调用）
            </div>
            <button
              onClick={doInitialize}
              disabled={initializing}
              className="w-full py-2.5 rounded-xl text-xs text-white tracking-wider transition-all disabled:opacity-60"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
            >
              {initializing ? '敲门中…' : '敲敲门 · 生成音乐人格'}
            </button>
          </div>
        )}

        {/* 正在听 */}
        {initialized && profile?.currentListening && (
          <div className="mx-4 mt-4 rounded-2xl p-4 shizuku-glass"
            style={{ boxShadow: `0 4px 20px ${C.glow}15` }}>
            <div className="flex items-center gap-2 mb-2">
              <Sparkle size={8} color={C.sakura} delay={0} />
              <span className="text-[10px] tracking-[0.25em] uppercase" style={{ color: C.muted }}>此刻在听</span>
            </div>
            <div className="flex items-center gap-3">
              {profile.currentListening.albumPic ? (
                <img src={profile.currentListening.albumPic} className="w-12 h-12 rounded-xl object-cover" alt="" />
              ) : (
                <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{ background: gradientFor('gradient-03'), color: 'white' }}>
                  <MusicNote size={20} weight="bold" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: C.text }}>
                  {profile.currentListening.songName}
                </div>
                <div className="text-[10px] truncate" style={{ color: C.muted }}>
                  {profile.currentListening.artists}
                </div>
              </div>
            </div>
            {profile.currentListening.vibe && (
              <div className="text-[10px] mt-2 italic" style={{ color: C.faint }}>
                {profile.currentListening.vibe}
              </div>
            )}
          </div>
        )}

        {/* 偏爱艺人（starred=灵魂艺人，头像底部金星勋章；有 picUrl 显示真人头像） */}
        {initialized && (profile?.signatureArtists?.length || 0) > 0 && (
          <div className="mx-4 mt-4">
            <SectionTitle>钟爱的人</SectionTitle>
            <div className="flex items-center gap-2 overflow-x-auto pb-2 shizuku-scrollbar">
              {profile!.signatureArtists.map((a, i) => (
                <div key={i} className="shrink-0 text-center relative pt-1">
                  {/* 头像 + 星星：星星是 button 外的兄弟元素，绝对定位贴头像底边中央，
                      不受 button 的 overflow-hidden 裁切，也不跟底下名字抢位置 */}
                  <div className="relative w-14 h-14 mx-auto">
                    <button
                      onClick={() => setEditingEntry({ kind: 'artist', index: i })}
                      className="w-full h-full rounded-full flex items-center justify-center text-white relative overflow-hidden active:scale-95 transition-transform"
                      style={{ background: gradientFor(`gradient-0${(i % 6) + 1}`) }}
                    >
                      {a.picUrl ? (
                        <img src={toHttps(a.picUrl)} alt={a.name} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-lg font-semibold" style={{ fontFamily: `'Noto Serif', serif` }}>
                          {a.name.slice(0, 1)}
                        </span>
                      )}
                    </button>
                    {a.starred && (
                      <div className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 z-20 pointer-events-none">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center bg-amber-400">
                          <Star size={12} weight="fill" className="text-white" />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="text-[10px] mt-2 max-w-[60px] truncate" style={{ color: C.muted }}>{a.name}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 钟爱的原声（影视 / 音乐剧 / 游戏 OST / 动画原声，独立于纯音乐艺人） */}
        {initialized && (profile?.favoriteSoundtracks?.length || 0) > 0 && (() => {
          const typeIcon = (t: string) => {
            switch (t) {
              case 'game': return <GameController size={22} weight="fill" />;
              case 'musical': return <Popcorn size={22} weight="fill" />;
              case 'film': return <FilmSlate size={22} weight="fill" />;
              case 'anime': return <MonitorPlay size={22} weight="fill" />;
              default: return <MusicNote size={22} weight="fill" />;
            }
          };
          const typeLabel = (t: string) => {
            switch (t) {
              case 'game': return '游戏';
              case 'musical': return '音乐剧';
              case 'film': return '电影';
              case 'anime': return '动画';
              default: return 'OST';
            }
          };
          return (
            <div className="mx-4 mt-4">
              <SectionTitle>钟爱的原声</SectionTitle>
              <div className="flex items-center gap-2 overflow-x-auto pb-2 shizuku-scrollbar">
                {profile!.favoriteSoundtracks!.map((s, i) => (
                  <div key={i} className="shrink-0 text-center relative pt-1">
                    {/* 封面 + 星星：星星是 button 外的兄弟元素，绝对定位贴封面底边中央，
                        不受 button 的 overflow-hidden 裁切，也不跟底下名字抢位置 */}
                    <div className="relative w-14 h-14 mx-auto">
                      <button
                        onClick={() => setEditingEntry({ kind: 'soundtrack', index: i })}
                        className="w-full h-full rounded-2xl flex items-center justify-center text-white relative overflow-hidden active:scale-95 transition-transform"
                        style={{ background: gradientFor(`gradient-0${(i % 6) + 1}`) }}
                      >
                        {s.coverUrl ? (
                          <img src={toHttps(s.coverUrl)} alt={s.title} className="w-full h-full object-cover" />
                        ) : (
                          <span>{typeIcon(s.type)}</span>
                        )}
                      </button>
                      {s.starred && (
                        <div className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 z-20 pointer-events-none">
                          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-amber-400">
                            <Star size={12} weight="fill" className="text-white" />
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="text-[10px] mt-2 max-w-[72px] truncate" style={{ color: C.muted }}>{s.title}</div>
                    <div className="text-[8px] tracking-wider" style={{ color: C.muted, opacity: 0.6 }}>{typeLabel(s.type)}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* 歌单 */}
        {initialized && (profile?.playlists?.length || 0) > 0 && (
          <div className="mx-4 mt-4">
            <SectionTitle>歌单 · {profile!.playlists.length}</SectionTitle>
            <div className="space-y-2">
              {profile!.playlists.map(pl => {
                const isExpanded = expandedPl === pl.id;
                const isFilling = fillingPl === pl.id;
                return (
                  <div key={pl.id} className="rounded-2xl shizuku-glass overflow-hidden">
                    <button
                      onClick={() => togglePlaylist(pl.id)}
                      className="w-full flex items-center gap-3 p-3 text-left"
                    >
                      <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center overflow-hidden"
                        style={{ background: gradientFor(pl.coverStyle) }}>
                        {pl.songs[0]?.albumPic ? (
                          <img src={pl.songs[0].albumPic} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <MusicNote size={20} weight="bold" color="white" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: C.text }}>{pl.title}</div>
                        <div className="text-[10px] truncate mt-0.5" style={{ color: C.muted }}>
                          {pl.description || '—'}
                        </div>
                        <div className="text-[9px] mt-0.5 flex items-center gap-1" style={{ color: C.faint }}>
                          <span>{pl.songs.length > 0 ? `${pl.songs.length} 首` : '（空歌单）'}</span>
                          {pl.mood && <span>· {pl.mood}</span>}
                          {pl.language && <LangBadge lang={pl.language} />}
                        </div>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="px-3 pb-3 border-t" style={{ borderColor: `${C.faint}30` }}>
                        <div className="pt-2">
                          {/* 操作条：平时显示「选择」+「挑几首」；选择模式下变成 取消 · 已选 N · 删除 */}
                          <div className="flex items-center justify-between px-2 pb-1.5">
                            {selectingPl === pl.id ? (
                              <>
                                <button
                                  onClick={exitSelectMode}
                                  className="text-[11px] px-1 py-0.5"
                                  style={{ color: C.muted }}
                                >
                                  取消
                                </button>
                                <span className="text-[10px]" style={{ color: C.faint }}>
                                  已选 {selectedSongIds.size} 首
                                </span>
                                <button
                                  onClick={() => deleteSelected(pl)}
                                  disabled={selectedSongIds.size === 0}
                                  className="text-[11px] px-1 py-0.5 flex items-center gap-1 disabled:opacity-40"
                                  style={{ color: C.vip }}
                                >
                                  <Trash size={12} weight="bold" />
                                  删除
                                </button>
                              </>
                            ) : (
                              <>
                                <span className="text-[10px]" style={{ color: C.faint }}>
                                  {pl.songs.length > 0 ? `${pl.songs.length} 首` : '还空着'}
                                </span>
                                <div className="flex items-center gap-2">
                                  {pl.songs.length > 0 && (
                                    <button
                                      onClick={() => enterSelectMode(pl.id)}
                                      className="text-[11px] px-1 py-0.5"
                                      style={{ color: C.primary }}
                                    >
                                      选择
                                    </button>
                                  )}
                                  <button
                                    onClick={() => fillPlaylistFromTaste(pl)}
                                    disabled={isFilling}
                                    className="text-[11px] px-2 py-0.5 rounded-full disabled:opacity-60 flex items-center gap-1"
                                    style={{ color: C.primary, border: `1px solid ${C.primary}30` }}
                                    title={pl.songs.length > 0 ? '根据品味再挑几首新的（追加）' : '根据品味挑几首'}
                                  >
                                    <Plus size={10} weight="bold" />
                                    {isFilling ? '挑歌中…' : (pl.songs.length > 0 ? '追加' : '挑几首')}
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                          {/* 歌曲列表（空歌单不渲染，只显示一行提示） */}
                          {pl.songs.length === 0 ? (
                            <div className="text-center text-[10px] italic py-3" style={{ color: C.faint }}>
                              让 {char.name} 根据品味挑几首？
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {pl.songs.map((s, i) => {
                                const selecting = selectingPl === pl.id;
                                const checked = selectedSongIds.has(s.id);
                                return (
                                  <button
                                    key={s.id}
                                    onClick={() => {
                                      if (lpFired.current) { lpFired.current = false; return; } // 长按已触发，吞掉这次 click
                                      if (selecting) { toggleSelected(s.id); return; }
                                      playPlaylistSong(pl, s);
                                    }}
                                    {...songPressHandlers(pl, s)}
                                    className="w-full flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-white/40 transition-colors text-left select-none"
                                    style={{ WebkitTouchCallout: 'none' }}
                                  >
                                    {selecting ? (
                                      <span
                                        className="w-4 h-4 shrink-0 rounded-full border flex items-center justify-center"
                                        style={{
                                          borderColor: checked ? C.primary : C.faint,
                                          background: checked ? C.primary : 'transparent',
                                        }}
                                      >
                                        {checked && <Check size={10} weight="bold" color="white" />}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] w-4 shrink-0" style={{ color: C.faint }}>{i + 1}</span>
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <div className="text-xs truncate" style={{ color: C.text }}>{s.name}</div>
                                      <div className="text-[9px] truncate" style={{ color: C.muted }}>{s.artists}</div>
                                    </div>
                                    {s.fee === 1 && !selecting && (
                                      <span className="text-[8px] px-1 rounded" style={{ color: C.vip, border: `1px solid ${C.vip}50` }}>VIP</span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 最近在听 */}
        {initialized && (profile?.recentPlays?.length || 0) > 0 && (
          <div className="mx-4 mt-4">
            <SectionTitle>最近常听</SectionTitle>
            <div className="space-y-1">
              {profile!.recentPlays.slice(0, 10).map((r, i) => (
                <div key={`${r.song.id}-${r.at}-${i}`} className="flex items-center gap-2 p-2 rounded-lg">
                  {r.song.albumPic ? (
                    <img src={r.song.albumPic} alt="" className="w-9 h-9 rounded-md object-cover" />
                  ) : (
                    <div className="w-9 h-9 rounded-md flex items-center justify-center"
                      style={{ background: gradientFor('gradient-02') }}>
                      <MusicNote size={14} weight="bold" color="white" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{ color: C.text }}>{r.song.name}</div>
                    <div className="text-[9px] truncate" style={{ color: C.muted }}>
                      {r.song.artists} · {new Date(r.at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  {r.context && (
                    <div className="text-[9px] italic max-w-[40%] truncate" style={{ color: C.faint }}>
                      "{r.context}"
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 评论 */}
        {initialized && (profile?.reviews?.length || 0) > 0 && (
          <div className="mx-4 mt-4">
            <SectionTitle>写过的话</SectionTitle>
            <div className="space-y-2">
              {profile!.reviews!.slice(0, 10).map(rv => (
                <div key={rv.id} className="rounded-xl shizuku-glass p-3">
                  <div className="text-[10px] mb-1" style={{ color: C.muted }}>
                    对 <span className="font-medium" style={{ color: C.primary }}>{rv.targetTitle}</span>
                  </div>
                  <div className="text-xs leading-relaxed" style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
                    {rv.content}
                  </div>
                  <div className="text-[9px] mt-1" style={{ color: C.faint }}>
                    {new Date(rv.createdAt).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 隐私开关 + 重新生成 */}
        {initialized && (
          <div className="mx-4 mt-6 mb-2 text-[10px] text-center space-y-2" style={{ color: C.faint }}>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={profile?.canReadUserMusic ?? true}
                onChange={e => {
                  if (!profile) return;
                  updateCharacter(char.id, {
                    musicProfile: { ...profile, canReadUserMusic: e.target.checked, updatedAt: Date.now() },
                  });
                }}
                className="w-3 h-3"
              />
              允许 {char.name} 翻阅你的网易云数据（最近在听 / 歌单）
            </label>
            <div>
              <button
                onClick={doRegenerate}
                disabled={initializing}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full transition-all disabled:opacity-50"
                style={{
                  color: C.primary,
                  background: `${C.sakura}14`,
                  border: `1px solid ${C.sakura}35`,
                }}
                title="清空后重新生成。"
              >
                {initializing ? '重新敲门中…' : '重新生成音乐人格'}
              </button>
            </div>
          </div>
        )}
      </div>

      {current && (
        <MiniPlayer
          name={current.name}
          artists={current.artists}
          albumPic={current.albumPic}
          playing={playing}
          onTap={onOpenPlayer}
          onPrev={prevSong}
          onToggle={togglePlay}
          onNext={nextSong}
        />
      )}

      {/* 编辑艺人/OST 名字弹窗 */}
      {editingEntry && (() => {
        const isArtist = editingEntry.kind === 'artist';
        const entry = isArtist
          ? profile?.signatureArtists?.[editingEntry.index]
          : profile?.favoriteSoundtracks?.[editingEntry.index];
        const original = isArtist ? (entry as any)?.name : (entry as any)?.title;
        return (
          <EditNameModal
            title={isArtist ? '编辑艺人名' : '编辑 OST 名'}
            original={original || ''}
            onCancel={() => setEditingEntry(null)}
            onSave={saveEntryName}
            onMatchImage={refreshArtImages}
            matching={refreshingArt}
          />
        );
      })()}
    </div>
  );
};

const StatCell: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
  <div className="flex flex-col items-center py-1">
    <div className="text-sm font-semibold" style={{ color: C.primary, fontFamily: `'Noto Serif', serif` }}>{value}</div>
    <div className="text-[9px] mt-0.5" style={{ color: C.muted }}>{label}</div>
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-2 mb-2 px-1">
    <div className="w-1 h-3 rounded-full" style={{ background: `linear-gradient(180deg, ${C.primary}, ${C.accent})` }} />
    <span className="text-[11px] tracking-wider font-medium"
      style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
      {children}
    </span>
  </div>
);

/**
 * 编辑艺人/OST 名字弹窗。
 * - 改完名字保存会清掉旧 picUrl/coverUrl（名字变了旧图失效）
 * - 「匹配图片」按钮直接调顶栏的批量匹配（先保存当前编辑内容更顺手，但用户可能只改名不刷新，
 *   所以这个按钮只在名字没改时才可用 —— 改了名字先存再刷新）
 * 弹窗内部用独立 input state，关闭时丢弃未保存内容。
 */
const EditNameModal: React.FC<{
  title: string;
  original: string;
  onCancel: () => void;
  onSave: (newName: string) => void;
  onMatchImage: () => void;
  matching: boolean;
}> = ({ title, original, onCancel, onSave, onMatchImage, matching }) => {
  const [value, setValue] = useState(original);
  const trimmed = value.trim();
  const changed = trimmed !== original.trim() && trimmed.length > 0;
  // 自动聚焦 + 选中
  const inputRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-4 shizuku-glass-strong"
        style={{ background: '#fffcf5' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
            <PencilSimple size={14} weight="bold" className="inline mr-1.5" style={{ color: C.primary }} />
            {title}
          </h3>
          <button onClick={onCancel} className="p-1 rounded-full hover:bg-black/5">
            <X size={16} weight="bold" style={{ color: C.muted }} />
          </button>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && changed) onSave(trimmed);
            if (e.key === 'Escape') onCancel();
          }}
          className="w-full px-3 py-2 rounded-lg text-sm outline-none"
          style={{ background: '#fff', border: `1px solid ${C.faint}40`, color: C.text }}
          placeholder="输入名字"
        />
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={() => onSave(trimmed)}
            disabled={!changed}
            className="flex-1 py-2 rounded-lg text-xs font-medium disabled:opacity-40"
            style={{ background: C.primary, color: '#fff' }}
          >
            <Check size={12} weight="bold" className="inline mr-1" />
            保存
          </button>
          <button
            // 名字没改时才允许直接匹配图片（改了名字要先存再匹配，否则匹配的还是旧名）
            onClick={onMatchImage}
            disabled={changed || matching}
            title={changed ? '先保存改名再匹配' : '根据当前名字匹配图片'}
            className="px-3 py-2 rounded-lg text-xs disabled:opacity-40"
            style={{ background: `${C.primary}18`, color: C.primary }}
          >
            <ArrowClockwise size={12} weight="bold" className={`inline mr-1 ${matching ? 'animate-spin' : ''}`} />
            {matching ? '匹配中' : '匹配图片'}
          </button>
        </div>
        <p className="text-[9px] mt-2 leading-relaxed" style={{ color: C.faint }}>
          改名保存后旧的匹配图片会清掉。点「匹配图片」会根据当前名字去网易云搜头像/封面。
        </p>
      </div>
    </div>
  );
};

/** 语言小标签 —— 贴在歌单信息行末尾，低饱和药丸，不破坏 shizuku 美感。 */
const LANG_LABELS: Record<string, string> = {
  jp: '日语', cn: '华语', en: '英语', kr: '韩语', mixed: '混合',
};
const LangBadge: React.FC<{ lang: string }> = ({ lang }) => {
  const label = LANG_LABELS[lang] || lang;
  return (
    <span
      className="px-1 py-0 rounded-full text-[8px] font-medium leading-[1.4]"
      style={{
        background: `${C.primary}18`,
        color: C.primary,
        border: `0.5px solid ${C.primary}30`,
      }}
    >
      {label}
    </span>
  );
};

export default CharVisitPage;
