/**
 * 统一歌单详情页 — 网易云歌单和角色本地歌单共用一套壳（shizuku 风格）。
 *
 * - 网易云歌单：只读。分页拉全曲目（每页 500、上限 10000，第一页先上屏），
 *   支持歌单内搜索、整单播放；不做收藏/加歌等写操作，不影响真实账号。
 * - 角色歌单：数据在角色卡里（IndexedDB），可以加歌（搜索选歌）、按品味追加、
 *   多选删歌、删除整个歌单。
 * - 大歌单按需渲染：先挂 80 行，滚近底部再补一批，千首歌单也不卡。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, toHttps, Song, MusicCfg } from '../../context/MusicContext';
import { CharPlaylist } from '../../types';
import { removeSongsFromPlaylist } from '../../utils/charPlaylistEdit';
import { pickSongsForPlaylist, songFromSearch, toCharPlaylistSong } from '../../utils/charPlaylistFill';
import { C, Sparkle, MizuHeader, BokehBg, MiniPlayer, gradientFor } from './MusicUI';
import { neteaseCacheGet, neteaseCacheSet } from '../../utils/neteaseCache';
import {
  Play, Plus, Trash, Check, X, MagnifyingGlass, ChatCircleDots, MusicNote,
} from '@phosphor-icons/react';

/** 网易云歌单的轻量元信息（NeteaseProfilePage 列表行已有的字段，进页即可先渲染头部） */
export interface NeteasePlaylistMeta {
  id: number;
  name: string;
  coverImgUrl: string;
  trackCount: number;
  subscribed?: boolean;
  creatorNickname?: string;
}

export type PlaylistSource =
  | { kind: 'netease'; playlist: NeteasePlaylistMeta }
  | { kind: 'char'; charId: string; playlistId: string };

interface Props {
  source: PlaylistSource;
  onBack: () => void;
  onOpenPlayer: () => void;
  onOpenComments: (song: Song) => void;
}

const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};

const mapTrack = (s: any): Song => ({
  id: s.id,
  name: s.name,
  artists: (s.ar || []).map((a: any) => a.name).join(' / '),
  album: s.al?.name || '',
  albumPic: toHttps(s.al?.picUrl || ''),
  duration: (s.dt || 0) / 1000,
  fee: s.fee ?? 0,
});

const PAGE_RENDER = 120;   // 每次向下滚追加渲染的行数

const PlaylistDetailPage: React.FC<Props> = ({ source, onBack, onOpenPlayer, onOpenComments }) => {
  const { characters, updateCharacter, addToast } = useOS();
  const {
    cfg, playSong,
    current, playing, togglePlay, nextSong, prevSong,
  } = useMusic();

  // 不稳定引用收进 ref，避免拉整单的 effect 反复触发
  const toastRef = useRef(addToast);
  toastRef.current = addToast;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const isChar = source.kind === 'char';
  const char = useMemo(
    () => (source.kind === 'char' ? characters.find(c => c.id === source.charId) : undefined),
    [source, characters],
  );
  const charProfile = char?.musicProfile;
  const charPl: CharPlaylist | undefined = useMemo(
    () => (source.kind === 'char' ? charProfile?.playlists.find(p => p.id === source.playlistId) : undefined),
    [source, charProfile],
  );

  // ── 网易云：整单曲目 + 描述 ──
  const [neteaseTracks, setNeteaseTracks] = useState<Song[]>([]);
  const [neteaseDesc, setNeteaseDesc] = useState('');
  const [fetching, setFetching] = useState(false);
  // 当前上屏的是离线快照（后台还在静默同步最新）
  const [fromCache, setFromCache] = useState(false);

  // ── 通用 UI 状态 ──
  const [descExpanded, setDescExpanded] = useState(false);
  const [filter, setFilter] = useState('');
  const [visibleCount, setVisibleCount] = useState(80);

  // ── 角色歌单专属 ──
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showAddSong, setShowAddSong] = useState(false);
  const [filling, setFilling] = useState(false);

  const neteaseId = source.kind === 'netease' ? source.playlist.id : null;

  // 网易云：进页先上离线快照（秒开），后台照常分页拉最新，拉完整单覆盖 + 落缓存
  useEffect(() => {
    if (neteaseId == null) return;
    const meta = source.kind === 'netease' ? source.playlist : null;
    if (!meta) return;
    let cancelled = false;
    setNeteaseTracks([]);
    setNeteaseDesc('');
    setFromCache(false);
    setFetching(true);
    // 描述等元信息独立拉，不阻塞曲目；同样先快照后网络
    neteaseCacheGet<string>(`pld:${meta.id}`)
      .then(hit => { if (!cancelled && hit) setNeteaseDesc(prev => prev || hit.data || ''); });
    musicApi.playlistDetail(cfgRef.current, meta.id)
      .then(r => {
        if (cancelled) return;
        const d = r?.playlist?.description || '';
        setNeteaseDesc(d);
        neteaseCacheSet(`pld:${meta.id}`, d);
      })
      .catch(() => {});
    (async () => {
      // IDB 读只要几毫秒，先 await 它再开网络循环，免得两边赛跑互相覆盖
      const hit = await neteaseCacheGet<Song[]>(`pl:${meta.id}`);
      if (cancelled) return;
      const hadCache = !!(hit && Array.isArray(hit.data) && hit.data.length);
      if (hadCache) {
        setNeteaseTracks(hit!.data);
        setFromCache(true);
      }
      try {
        const MAX_TRACKS = 10000;
        const PAGE = 500;
        const total = Math.min(meta.trackCount || MAX_TRACKS, MAX_TRACKS);
        const all: Song[] = [];
        for (let offset = 0; offset < total; offset += PAGE) {
          const r = await musicApi.playlistTrackAll(cfgRef.current, meta.id, PAGE, offset);
          if (cancelled) return;
          const page: Song[] = (r?.songs || []).map(mapTrack);
          if (!page.length) break;
          all.push(...page);
          // 有快照在屏上就静默积攒，避免整单先缩成第一页再慢慢长回来的闪烁
          if (!hadCache) setNeteaseTracks([...all]);
          if (page.length < PAGE) break;
        }
        if (!cancelled && all.length) {
          setNeteaseTracks(all);
          setFromCache(false);
          neteaseCacheSet(`pl:${meta.id}`, all);
        }
      } catch (e: any) {
        // 快照在屏上时同步失败就静默留着旧数据，别弹错吓人
        if (!cancelled && !hadCache) toastRef.current(`加载歌单失败：${e.message}`, 'error');
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [neteaseId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 统一后的曲目列表（角色歌单快照直接铺开成 Song）──
  const songs: Song[] = useMemo(() => {
    if (source.kind === 'netease') return neteaseTracks;
    return (charPl?.songs || []).map(s => ({ ...s }));
  }, [source.kind, neteaseTracks, charPl]);

  const filtered = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    if (!kw) return songs;
    return songs.filter(s =>
      s.name.toLowerCase().includes(kw)
      || s.artists.toLowerCase().includes(kw)
      || s.album.toLowerCase().includes(kw));
  }, [songs, filter]);

  useEffect(() => { setVisibleCount(80); }, [filter]);
  // 切换歌单时重置按需渲染计数，避免带着上一个千首大歌单的满屏值进新歌单
  useEffect(() => { setVisibleCount(80); }, [source.kind, neteaseId, charPl?.id]);

  // 滚近底部再多挂一批（大歌单渲染保护）
  const onListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) {
      setVisibleCount(c => (c < filtered.length ? Math.min(c + PAGE_RENDER, filtered.length) : c));
    }
  }, [filtered.length]);

  // ── 头部信息（两种数据源统一）──
  const meta = useMemo(() => {
    if (source.kind === 'netease') {
      const p = source.playlist;
      return {
        title: p.name,
        coverUrl: p.coverImgUrl,
        coverStyle: undefined as string | undefined,
        count: neteaseTracks.length || p.trackCount,
        byline: p.creatorNickname
          ? `by ${p.creatorNickname} · ${p.subscribed ? '收藏' : '创建'}`
          : (p.subscribed ? '收藏的歌单' : '我创建的歌单'),
        desc: neteaseDesc,
      };
    }
    return {
      title: charPl?.title || '',
      coverUrl: charPl?.songs[0]?.albumPic || '',
      coverStyle: charPl?.coverStyle,
      count: charPl?.songs.length || 0,
      byline: `${char?.name || ''} 的歌单${charPl?.mood ? ` · ${charPl.mood}` : ''}`,
      desc: charPl?.description || '',
    };
  }, [source, neteaseTracks.length, neteaseDesc, charPl, char]);

  // ── 播放 ──
  const playAt = useCallback((song: Song) => {
    const startIdx = songs.findIndex(s => s.id === song.id);
    playSong(song, { replaceQueue: songs, startIdx: startIdx >= 0 ? startIdx : 0 });
    onOpenPlayer();
  }, [songs, playSong, onOpenPlayer]);

  const playAll = useCallback(() => {
    if (!songs.length) return;
    playSong(songs[0], { replaceQueue: songs, startIdx: 0 });
    onOpenPlayer();
  }, [songs, playSong, onOpenPlayer]);

  // ── 角色歌单写操作（全部走 updateCharacter 落回角色卡）──
  const persistPlaylists = useCallback((nextPlaylists: CharPlaylist[]) => {
    if (!char || !charProfile) return;
    updateCharacter(char.id, {
      musicProfile: { ...charProfile, playlists: nextPlaylists, updatedAt: Date.now() },
    });
  }, [char, charProfile, updateCharacter]);

  const addSongToPl = useCallback((s: Song) => {
    if (!charPl || !charProfile) return;
    if (charPl.songs.some(x => x.id === s.id)) { addToast('已经在这个歌单里了', 'info'); return; }
    const nextPl: CharPlaylist = {
      ...charPl,
      songs: [...charPl.songs, toCharPlaylistSong(s, 'user')],
      updatedAt: Date.now(),
    };
    persistPlaylists(charProfile.playlists.map(p => (p.id === charPl.id ? nextPl : p)));
    addToast(`已加入《${charPl.title}》`, 'success');
  }, [charPl, charProfile, persistPlaylists, addToast]);

  const fillFromTaste = useCallback(async () => {
    if (!charPl || !charProfile || filling) return;
    setFilling(true);
    try {
      const picked = await pickSongsForPlaylist(charProfile, charPl, cfgRef.current);
      if (picked.length === 0) {
        addToast(charPl.songs.length > 0 ? '没搜到新歌（已有的都重复了）' : '没搜到合适的歌', 'error');
        return;
      }
      const nextPl: CharPlaylist = { ...charPl, songs: [...charPl.songs, ...picked], updatedAt: Date.now() };
      persistPlaylists(charProfile.playlists.map(p => (p.id === charPl.id ? nextPl : p)));
      addToast(`已为《${charPl.title}》新增 ${picked.length} 首（共 ${nextPl.songs.length}）`, 'success');
    } catch (e: any) {
      addToast(`填充失败：${e.message}`, 'error');
    } finally {
      setFilling(false);
    }
  }, [charPl, charProfile, filling, persistPlaylists, addToast]);

  const toggleSelected = (songId: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(songId)) next.delete(songId); else next.add(songId);
      return next;
    });
  };
  const exitSelectMode = () => { setSelecting(false); setSelectedIds(new Set()); };

  const deleteSelected = () => {
    if (!charPl || !charProfile || selectedIds.size === 0) return;
    const n = selectedIds.size;
    const ok = typeof window !== 'undefined'
      ? window.confirm(`从《${charPl.title}》移除选中的 ${n} 首歌？`)
      : true;
    if (!ok) return;
    persistPlaylists(removeSongsFromPlaylist(charProfile.playlists, charPl.id, selectedIds, Date.now()));
    addToast(`已移除 ${n} 首`, 'success');
    exitSelectMode();
  };

  const deletePlaylist = () => {
    if (!charPl || !charProfile) return;
    const ok = typeof window !== 'undefined'
      ? window.confirm(`删除歌单《${charPl.title}》？\n里面的 ${charPl.songs.length} 首歌也会一起移除，不可恢复。`)
      : true;
    if (!ok) return;
    persistPlaylists(charProfile.playlists.filter(p => p.id !== charPl.id));
    addToast(`已删除歌单《${charPl.title}》`, 'success');
    onBack();
  };

  // 角色歌单被删 / 角色不存在的兜底
  if (isChar && (!char || !charPl)) {
    return (
      <div className="flex flex-col h-full relative" style={{ background: C.bg }}>
        <MizuHeader title="歌单" onBack={onBack} />
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: C.muted }}>
          这个歌单不在了。
        </div>
      </div>
    );
  }

  const descLimit = 48;
  const descLong = meta.desc.length > descLimit;

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader
        title={isChar ? '歌单' : 'Playlist'}
        onBack={onBack}
        right={isChar ? (
          <button
            onClick={deletePlaylist}
            className="p-1.5 rounded-full transition-all active:scale-90"
            style={{ color: C.muted }}
            title="删除这个歌单"
          >
            <Trash size={15} weight="bold" />
          </button>
        ) : undefined}
      />

      <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar pb-24" onScroll={onListScroll}>
        {/* 头部：模糊封面打底 + 信息卡 */}
        <div className="relative overflow-hidden">
          {meta.coverUrl && (
            <img src={meta.coverUrl} alt="" aria-hidden
              className="absolute inset-0 w-full h-full object-cover"
              style={{ filter: 'blur(26px) saturate(1.2)', transform: 'scale(1.4)', opacity: 0.3 }} />
          )}
          <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, rgba(255,255,255,0.2) 0%, ${C.bg}E8 100%)` }} />
          <div className="relative px-4 pt-4 pb-3.5">
            <div className="flex gap-3.5">
              <div className="w-[88px] h-[88px] rounded-2xl shrink-0 overflow-hidden flex items-center justify-center relative"
                style={{
                  background: meta.coverUrl ? undefined : gradientFor(meta.coverStyle),
                  border: `1.5px solid rgba(255,255,255,0.6)`,
                  boxShadow: `0 6px 24px ${C.glow}35`,
                }}>
                {meta.coverUrl ? (
                  <img src={meta.coverUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <MusicNote size={30} weight="bold" color="white" />
                )}
                <div className="absolute -top-0.5 -right-0.5"><Sparkle size={9} color={C.glow} delay={0.3} /></div>
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-center">
                <div className="text-[15px] font-semibold leading-snug"
                  style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
                  {meta.title}
                </div>
                <div className="text-[10px] mt-1 truncate" style={{ color: C.muted }}>{meta.byline}</div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className="text-[9px] px-2 py-0.5 rounded-full shizuku-glass" style={{ color: C.primary }}>
                    {meta.count} 首
                  </span>
                  {!isChar && (
                    <span className="text-[9px] px-2 py-0.5 rounded-full" style={{ color: C.faint, border: `1px solid ${C.faint}30` }}>
                      只读
                    </span>
                  )}
                </div>
              </div>
            </div>

            {meta.desc && (
              <button
                onClick={() => descLong && setDescExpanded(v => !v)}
                className="mt-2.5 w-full text-left text-[10px] leading-relaxed"
                style={{ color: C.muted, cursor: descLong ? 'pointer' : 'default' }}
              >
                <span style={{ whiteSpace: 'pre-wrap' }}>
                  {descExpanded || !descLong ? meta.desc : `${meta.desc.slice(0, descLimit)}…`}
                </span>
                {descLong && <span className="ml-1" style={{ color: C.accent }}>{descExpanded ? '收起' : '展开'}</span>}
              </button>
            )}

            {/* 操作行 */}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <button
                onClick={playAll}
                disabled={!songs.length}
                className="px-3.5 py-1.5 rounded-full text-[11px] text-white flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-40"
                style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 2px 12px ${C.glow}40` }}
              >
                <Play size={11} weight="fill" /> 播放全部
              </button>
              {isChar && (
                <>
                  <button
                    onClick={() => setShowAddSong(true)}
                    className="px-3 py-1.5 rounded-full text-[11px] flex items-center gap-1 shizuku-glass transition-all active:scale-95"
                    style={{ color: C.primary, border: `1px solid ${C.primary}30` }}
                  >
                    <Plus size={11} weight="bold" /> 加歌
                  </button>
                  <button
                    onClick={fillFromTaste}
                    disabled={filling}
                    className="px-3 py-1.5 rounded-full text-[11px] flex items-center gap-1 shizuku-glass transition-all active:scale-95 disabled:opacity-60"
                    style={{ color: C.accent, border: `1px solid ${C.accent}30` }}
                    title={`让 ${char?.name} 按自己的品味追加几首`}
                  >
                    <Sparkle size={9} color={C.accent} delay={0} /> {filling ? '挑歌中…' : `${char?.name} 来挑`}
                  </button>
                  {songs.length > 0 && (
                    <button
                      onClick={() => (selecting ? exitSelectMode() : setSelecting(true))}
                      className="px-3 py-1.5 rounded-full text-[11px] shizuku-glass transition-all active:scale-95"
                      style={{ color: selecting ? C.vip : C.muted, border: `1px solid ${selecting ? C.vip : C.faint}30` }}
                    >
                      {selecting ? '取消选择' : '选择'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* 歌单内搜索 */}
        {songs.length > 8 && (
          <div className="px-4 mt-2">
            <div className="flex items-center gap-2 rounded-xl px-3 py-1.5 shizuku-glass">
              <MagnifyingGlass size={12} color={C.muted} weight="bold" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="在歌单内搜索…"
                className="flex-1 bg-transparent outline-none text-[11px]"
                style={{ color: C.text }}
              />
              {filter && (
                <button onClick={() => setFilter('')} className="p-0.5" style={{ color: C.faint }}>
                  <X size={11} weight="bold" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* 选择模式操作条 */}
        {selecting && (
          <div className="mx-4 mt-2 px-3 py-1.5 rounded-xl shizuku-glass-strong flex items-center justify-between">
            <span className="text-[10px]" style={{ color: C.muted }}>已选 {selectedIds.size} 首</span>
            <button
              onClick={deleteSelected}
              disabled={selectedIds.size === 0}
              className="text-[11px] flex items-center gap-1 disabled:opacity-40"
              style={{ color: C.vip }}
            >
              <Trash size={12} weight="bold" /> 删除
            </button>
          </div>
        )}

        {/* 曲目列表 */}
        <div className="px-3 mt-2">
          {filtered.slice(0, visibleCount).map((s, i) => {
            const active = current?.id === s.id;
            const checked = selectedIds.has(s.id);
            return (
              <div key={`${s.id}-${i}`}
                className="flex items-center gap-1 rounded-xl transition-colors"
                style={{ background: active ? 'rgba(255,255,255,0.55)' : undefined }}>
                <button
                  onClick={() => (selecting ? toggleSelected(s.id) : playAt(s))}
                  className="flex-1 flex items-center gap-2.5 min-w-0 text-left px-2 py-1.5"
                >
                  {selecting ? (
                    <span className="w-4 h-4 shrink-0 rounded-full border flex items-center justify-center"
                      style={{ borderColor: checked ? C.primary : C.faint, background: checked ? C.primary : 'transparent' }}>
                      {checked && <Check size={10} weight="bold" color="white" />}
                    </span>
                  ) : (
                    <span className="text-[9px] w-6 text-center shrink-0 tabular-nums"
                      style={{ color: active ? C.primary : C.faint }}>
                      {active ? '▶' : i + 1}
                    </span>
                  )}
                  <img src={s.albumPic} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0"
                    style={{ border: `1px solid ${C.faint}25` }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] truncate"
                        style={{ color: active ? C.primary : C.text, fontWeight: active ? 600 : 400 }}>
                        {s.name}
                      </span>
                      {s.fee === 1 && (
                        <span className="text-[8px] px-1 rounded shrink-0" style={{ color: C.vip, border: `1px solid ${C.vip}50` }}>VIP</span>
                      )}
                    </div>
                    <div className="text-[9.5px] truncate mt-0.5" style={{ color: C.muted }}>
                      {s.artists}{s.album ? ` · ${s.album}` : ''}
                    </div>
                  </div>
                  <span className="text-[9px] shrink-0 tabular-nums" style={{ color: C.faint }}>{fmtTime(s.duration)}</span>
                </button>
                {!selecting && (
                  <button
                    onClick={() => onOpenComments(s)}
                    className="p-2 shrink-0 transition-transform active:scale-90"
                    style={{ color: C.faint }}
                    title="看这首歌的评论区"
                  >
                    <ChatCircleDots size={15} />
                  </button>
                )}
              </div>
            );
          })}

          {fetching && (
            <div className="text-center text-[10px] py-3" style={{ color: C.faint }}>
              <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin align-middle"
                style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
              <span className="ml-2 align-middle">
                {fromCache
                  ? '已显示上次的曲目 · 正在同步最新…'
                  : neteaseTracks.length > 0 ? `已加载 ${neteaseTracks.length} 首，还在继续…` : '加载歌单中…'}
              </span>
            </div>
          )}
          {!fetching && filtered.length === 0 && (
            <div className="text-center text-[11px] py-10 italic" style={{ color: C.faint }}>
              {filter
                ? '歌单里没搜到这首'
                : isChar
                  ? `还空着 · 加几首，或者让 ${char?.name} 来挑`
                  : '这个歌单是空的'}
            </div>
          )}
          {visibleCount < filtered.length && (
            <div className="text-center text-[9px] py-2" style={{ color: C.faint }}>
              已显示 {visibleCount} / {filtered.length} 首 · 继续下滑加载
            </div>
          )}
        </div>
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

      {/* 加歌浮层（仅角色歌单） */}
      {showAddSong && charPl && (
        <AddSongPanel
          cfg={cfg}
          playlistTitle={charPl.title}
          existingIds={new Set(charPl.songs.map(s => s.id))}
          onAdd={addSongToPl}
          onClose={() => setShowAddSong(false)}
        />
      )}
    </div>
  );
};

/**
 * 加歌浮层 — 搜索网易云曲库，点 + 加进角色歌单。
 * 面板不自动关闭，方便连续加多首；已在歌单里的显示 ✓。
 */
const AddSongPanel: React.FC<{
  cfg: MusicCfg;
  playlistTitle: string;
  existingIds: Set<number>;
  onAdd: (s: Song) => void;
  onClose: () => void;
}> = ({ cfg, playlistTitle, existingIds, onAdd, onClose }) => {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Song[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw || searching) return;
    setSearching(true);
    try {
      const r = await musicApi.search(cfg, kw);
      setResults(((r?.result?.songs || []) as any[]).map(songFromSearch));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 60%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      {/* 顶栏 */}
      <div className="relative z-10 shizuku-glass-strong"
        style={{ borderBottom: `1px solid rgba(255,255,255,0.3)`, paddingTop: 'var(--safe-top)' }}>
        <div className="flex items-center justify-between h-12 px-4">
          <div className="flex items-center gap-1.5 min-w-0">
            <Plus size={13} weight="bold" color={C.primary} />
            <span className="text-[12px] truncate" style={{ color: C.primary, fontFamily: 'Georgia, serif' }}>
              加歌到《{playlistTitle}》
            </span>
          </div>
          <button onClick={onClose} className="text-[11px] font-bold px-3 py-1 rounded-full"
            style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, color: 'white', boxShadow: `0 2px 10px ${C.glow}50` }}>
            完成
          </button>
        </div>
      </div>

      {/* 搜索行 */}
      <div className="relative z-10 flex gap-2 px-4 py-3">
        <div className="flex-1 flex items-center gap-2 rounded-2xl px-3.5 py-2 shizuku-glass">
          <MagnifyingGlass size={14} color={C.muted} weight="bold" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: C.text }}
            placeholder="搜歌名 / 歌手…"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doSearch(); }}
          />
        </div>
        <button
          onClick={doSearch}
          disabled={searching}
          className="px-4 py-2 rounded-2xl text-xs text-white disabled:opacity-50"
          style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 15px ${C.primary}30` }}
        >
          {searching ? '…' : '搜索'}
        </button>
      </div>

      {/* 结果列表 */}
      <div className="relative z-10 flex-1 overflow-y-auto px-3 pb-6 shizuku-scrollbar">
        {results.length === 0 && !searching && (
          <div className="text-center text-[11px] italic mt-14" style={{ color: C.faint }}>
            搜点什么，把喜欢的塞进歌单里
          </div>
        )}
        {results.map(s => {
          const added = existingIds.has(s.id);
          return (
            <div key={s.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-xl hover:bg-white/40 transition-colors">
              <img src={s.albumPic} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0"
                style={{ border: `1px solid ${C.faint}25` }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] truncate" style={{ color: C.text }}>{s.name}</span>
                  {s.fee === 1 && (
                    <span className="text-[8px] px-1 rounded shrink-0" style={{ color: C.vip, border: `1px solid ${C.vip}50` }}>VIP</span>
                  )}
                </div>
                <div className="text-[9.5px] truncate mt-0.5" style={{ color: C.muted }}>
                  {s.artists}{s.album ? ` · ${s.album}` : ''}
                </div>
              </div>
              <button
                onClick={() => { if (!added) onAdd(s); }}
                disabled={added}
                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-90"
                style={{
                  background: added ? `${C.faint}25` : `linear-gradient(135deg, ${C.primary}, ${C.accent})`,
                  color: added ? C.muted : 'white',
                  boxShadow: added ? 'none' : `0 2px 8px ${C.glow}40`,
                }}
                title={added ? '已在歌单里' : '加入歌单'}
              >
                {added ? <Check size={12} weight="bold" /> : <Plus size={12} weight="bold" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PlaylistDetailPage;
