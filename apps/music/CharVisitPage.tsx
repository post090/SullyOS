/**
 * Char 拜访页 — 访问某个角色的网易云风格"小号主页"
 *
 * 思路：完全仿网易云个人主页排版，但数据全来自本地 CharMusicProfile。
 * 用户体验上就像 "去别人主页逛一圈"，不是 "切换账号"。
 *
 * 交互：
 * - 未初始化 → 显示"敲敲门"按钮，点一下调 LLM 生成 musicProfile。
 * - 已初始化 → 展示 bio / 曲风徽章 / 偏爱艺人 / 歌单 / 最近在听 / 评论。
 * - 点歌单 → 统一歌单详情页（加歌 / 按品味填充 / 删歌 / 删歌单都在那边），这里还能新建歌单。
 * - 点任一首歌 → 用全局 MusicContext 播放 (沿用 user 的 cookie / 配额)。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, toHttps } from '../../context/MusicContext';
import { CharPlaylist } from '../../types';
import { CharMusicPersona } from '../../utils/charMusicPersona';
import { computeCurrentListening } from '../../utils/charMusicSchedule';
import { C, Sparkle, MizuHeader, BokehBg, MiniPlayer, gradientFor } from './MusicUI';
import { MusicNote, Plus, Check, Star, FilmSlate, GameController, Popcorn, MonitorPlay, ArrowClockwise, PencilSimple, Trash, X, Play as PlayIcon } from '@phosphor-icons/react';
import { getDailyScheduleForChar } from '../../utils/dailySchedule';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../../utils/timezone';

interface Props {
  charId: string;
  onBack: () => void;
  onOpenPlayer: () => void;
  /** 点歌单行 / 新建完歌单 → 进统一歌单详情页 */
  onOpenPlaylist: (playlistId: string) => void;
  /** 点「钟爱的人」头像 → 歌手页（无 artistId 时先搜，查不到 toast） */
  onOpenArtist?: (id: number, name: string) => void;
  /** 点「钟爱的原声」封面 → 用标题搜歌（跳搜索页自动搜） */
  onOpenSearch?: (keyword: string) => void;
  /** 最近常听「播放全部」→ 全屏歌单页 */
  onOpenRecent?: (charId: string) => void;
}

const CharVisitPage: React.FC<Props> = ({ charId, onBack, onOpenPlayer, onOpenPlaylist, onOpenArtist, onOpenSearch, onOpenRecent }) => {
  const { characters, updateCharacter, userProfile, apiConfig, addToast } = useOS();
  const {
    cfg,
    current, playing, togglePlay, nextSong, prevSong,
  } = useMusic();
  const char = useMemo(() => characters.find(c => c.id === charId), [characters, charId]);
  const charDateKey = useLocalDateKey(resolveCharTimeZone(char));

  const [initializing, setInitializing] = useState(false);
  // 新建歌单弹窗
  const [showNewPl, setShowNewPl] = useState(false);

  // 编辑艺人/OST 名字弹窗：null=关闭，否则记录正在编辑哪一项
  const [editingEntry, setEditingEntry] = useState<{ kind: 'artist' | 'soundtrack'; index: number } | null>(null);
  // 顶栏批量匹配图片（艺人头像 + OST 封面）
  const [refreshingArt, setRefreshingArt] = useState(false);

  const profile = char?.musicProfile;
  const initialized = !!(char && CharMusicPersona.isInitialized(char));

  // 拜访时刷新 char 此刻在听的歌（纯本地计算，零网络）
  // 只在 char.id / initialized 变化时刷新一次，避免每秒 tick
  useEffect(() => {
    if (!char || !initialized || !char.musicProfile) return;
    let cancelled = false;
    (async () => {
      try {
        const schedule = await getDailyScheduleForChar(char);
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
  }, [char?.id, char?.customTimezoneEnabled, char?.customTimezone, initialized, charDateKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /** 删除艺人 / OST 条目 */
  const deleteEntry = useCallback(() => {
    if (!char || !profile || !editingEntry) return;
    if (editingEntry.kind === 'artist') {
      const next = [...profile.signatureArtists];
      next.splice(editingEntry.index, 1);
      updateCharacter(char.id, {
        musicProfile: { ...profile, signatureArtists: next, updatedAt: Date.now() },
      });
    } else {
      const next = [...(profile.favoriteSoundtracks || [])];
      next.splice(editingEntry.index, 1);
      updateCharacter(char.id, {
        musicProfile: { ...profile, favoriteSoundtracks: next, updatedAt: Date.now() },
      });
    }
    setEditingEntry(null);
    addToast('已删除', 'success');
  }, [char, profile, editingEntry, updateCharacter, addToast]);

  /** 点「钟爱的人」→ 歌手页：有 artistId 直接用；没有先搜，查不到给提示 */
  const jumpToArtist = useCallback(async (a: { name: string; artistId?: number }) => {
    if (!onOpenArtist) return;
    if (a.artistId != null) { onOpenArtist(a.artistId, a.name); return; }
    try {
      const r: any = await musicApi.call(cfg, '/search', { keyword: a.name, limit: 3, offset: 0, type: 100 });
      const hit = r?.result?.artists?.[0];
      if (hit?.id) { onOpenArtist(hit.id, hit.name || a.name); return; }
    } catch { /* 走下方提示 */ }
    addToast(`查不到「${a.name}」的歌手页`, 'info');
  }, [cfg, onOpenArtist, addToast]);

  /** 点「钟爱的原声」→ 用标题搜歌（跳搜索页自动搜） */
  const jumpToOst = useCallback((s: { title: string; coverUrl?: string; type?: string }) => {
    if (!onOpenSearch) return;
    const kw = (s.title || '').trim();
    if (!kw) { addToast('这个原声没有标题，没法搜', 'info'); return; }
    onOpenSearch(kw);
  }, [onOpenSearch, addToast]);

  /** 新建一个空歌单，建完直接跳进详情页加歌 */
  const createPlaylist = useCallback((title: string) => {
    if (!char || !profile) return;
    const clean = title.trim();
    if (!clean) return;
    const now = Date.now();
    const pl: CharPlaylist = {
      id: `pl_${now.toString(36)}`,
      title: clean,
      description: '',
      coverStyle: `gradient-0${Math.floor(Math.random() * 6) + 1}`,
      songs: [],
      createdAt: now,
      updatedAt: now,
    };
    updateCharacter(char.id, {
      musicProfile: { ...profile, playlists: [...profile.playlists, pl], updatedAt: now },
    });
    setShowNewPl(false);
    addToast(`歌单《${clean}》已创建`, 'success');
    onOpenPlaylist(pl.id);
  }, [char, profile, updateCharacter, addToast, onOpenPlaylist]);

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
                    <TapOrHoldButton
                      onTap={() => jumpToArtist(a)}
                      onHold={() => setEditingEntry({ kind: 'artist', index: i })}
                      title="点击进歌手页 · 长按编辑/删除"
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
                    </TapOrHoldButton>
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
                      <TapOrHoldButton
                        onTap={() => jumpToOst(s)}
                        onHold={() => setEditingEntry({ kind: 'soundtrack', index: i })}
                        title="点击进专辑页 · 长按编辑/删除"
                        className="w-full h-full rounded-2xl flex items-center justify-center text-white relative overflow-hidden active:scale-95 transition-transform"
                        style={{ background: gradientFor(`gradient-0${(i % 6) + 1}`) }}
                      >
                        {s.coverUrl ? (
                          <img src={toHttps(s.coverUrl)} alt={s.title} className="w-full h-full object-cover" />
                        ) : (
                          <span>{typeIcon(s.type)}</span>
                        )}
                      </TapOrHoldButton>
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

        {/* 歌单（点行进统一详情页；删光了也能在这里新建） */}
        {initialized && (
          <div className="mx-4 mt-4">
            <SectionTitle>歌单 · {profile?.playlists.length || 0}</SectionTitle>
            <div className="space-y-2">
              {(profile?.playlists || []).map(pl => (
                <button
                  key={pl.id}
                  onClick={() => onOpenPlaylist(pl.id)}
                  className="w-full rounded-2xl shizuku-glass flex items-center gap-3 p-3 text-left transition-all active:scale-[0.99]"
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
                  <div className="text-[10px] shrink-0" style={{ color: C.accent }}>›</div>
                </button>
              ))}
              <button
                onClick={() => setShowNewPl(true)}
                className="w-full rounded-2xl py-3 flex items-center justify-center gap-1.5 text-[11px] transition-all active:scale-[0.99]"
                style={{ color: C.primary, border: `1.5px dashed ${C.primary}40`, background: 'rgba(255,255,255,0.35)' }}
              >
                <Plus size={12} weight="bold" /> 新建歌单
              </button>
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
            {/* 网易云式「播放全部」→ 全屏歌单页，列出所有常听 */}
            {onOpenRecent && profile!.recentPlays.length > 0 && (
              <button
                onClick={() => onOpenRecent(char.id)}
                className="w-full mt-1 py-2 rounded-xl flex items-center justify-center gap-1.5 text-[11px] transition-all active:scale-[0.99]"
                style={{ color: C.primary, border: `1.5px dashed ${C.primary}40`, background: 'rgba(255,255,255,0.35)' }}
              >
                <PlayIcon size={12} weight="fill" />
                播放全部 · {profile!.recentPlays.length} 首
              </button>
            )}
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
            onDelete={deleteEntry}
            onMatchImage={refreshArtImages}
            matching={refreshingArt}
          />
        );
      })()}

      {/* 新建歌单弹窗 */}
      {showNewPl && (
        <NewPlaylistModal onCancel={() => setShowNewPl(false)} onCreate={createPlaylist} />
      )}
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

/** 点按 = onTap，按住 500ms = onHold（长按编辑用）；移动超过 8px 取消，避免滚动误触发 */
const TapOrHoldButton: React.FC<{
  onTap: () => void;
  onHold: () => void;
  holdDelay?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  children: React.ReactNode;
}> = ({ onTap, onHold, holdDelay = 500, className = '', style, title, children }) => {
  const timer = useRef<number | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const heldRef = useRef(false);

  const cancel = () => {
    if (timer.current != null) { clearTimeout(timer.current); timer.current = null; }
    startPos.current = null;
  };

  return (
    <button
      title={title}
      className={className}
      style={style}
      onPointerDown={(e) => {
        startPos.current = { x: e.clientX, y: e.clientY };
        heldRef.current = false;
        timer.current = window.setTimeout(() => {
          heldRef.current = true;
          onHold();
        }, holdDelay);
      }}
      onPointerMove={(e) => {
        if (!startPos.current) return;
        const dx = Math.abs(e.clientX - startPos.current.x);
        const dy = Math.abs(e.clientY - startPos.current.y);
        if (dx > 8 || dy > 8) cancel();
      }}
      onPointerUp={() => {
        cancel();
        if (!heldRef.current) onTap();
      }}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => { e.preventDefault(); cancel(); onHold(); }}
    >
      {children}
    </button>
  );
};

/** 编辑艺人/OST 名字弹窗。
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
  onDelete?: () => void;
  onMatchImage: () => void;
  matching: boolean;
}> = ({ title, original, onCancel, onSave, onDelete, onMatchImage, matching }) => {
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
        style={{ background: C.bg }}
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
          {onDelete && (
            <button
              onClick={() => {
                if (typeof window !== 'undefined' && !window.confirm('删除这一项？')) return;
                onDelete();
              }}
              title="删除这一项"
              className="px-3 py-2 rounded-lg text-xs"
              style={{ background: `${C.sakura}18`, color: '#c14d5d' }}
            >
              <Trash size={12} weight="bold" className="inline mr-1" />
              删除
            </button>
          )}
        </div>
        <p className="text-[9px] mt-2 leading-relaxed" style={{ color: C.faint }}>
          改名保存后旧的匹配图片会清掉。点「匹配图片」会根据当前名字去网易云搜头像/封面。
        </p>
      </div>
    </div>
  );
};

/** 新建歌单弹窗 — 只要一个标题，建完直接进详情页加歌。 */
const NewPlaylistModal: React.FC<{
  onCancel: () => void;
  onCreate: (title: string) => void;
}> = ({ onCancel, onCreate }) => {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const inputRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-4 shizuku-glass-strong"
        style={{ background: C.bg }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
            <Plus size={14} weight="bold" className="inline mr-1.5" style={{ color: C.primary }} />
            新建歌单
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
            if (e.key === 'Enter' && trimmed) onCreate(trimmed);
            if (e.key === 'Escape') onCancel();
          }}
          className="w-full px-3 py-2 rounded-lg text-sm outline-none"
          style={{ background: '#fff', border: `1px solid ${C.faint}40`, color: C.text }}
          placeholder="歌单名，比如「深夜公路」"
        />
        <button
          onClick={() => onCreate(trimmed)}
          disabled={!trimmed}
          className="w-full mt-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40"
          style={{ background: C.primary, color: '#fff' }}
        >
          <Check size={12} weight="bold" className="inline mr-1" />
          创建并去加歌
        </button>
        <p className="text-[9px] mt-2 leading-relaxed" style={{ color: C.faint }}>
          建好后会直接打开歌单详情页，在那里搜歌加进去。
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
