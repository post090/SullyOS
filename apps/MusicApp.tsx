
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import { useBackGuard } from '../hooks/useBackGuard';
import { useMusic, musicApi, normalizeCookie, toHttps, Song } from '../context/MusicContext';
import { getProxyWorkerUrl } from '../utils/proxyWorker';
import { DB } from '../utils/db';
import { Gear, User as UserIcon, Crosshair, Play as PlayIcon, Pause as PauseIcon } from '@phosphor-icons/react';
import {
  C, Sparkle, CrossStar, MizuHeader, SearchBar, SongRow, MiniPlayer,
  VinylDisc, GlassProgress, PlayControls, BokehBg,
  MetaChip, SubActions, ArtistLinks, TogetherHeader,
} from './music/MusicUI';
import NeteaseProfilePage from './music/NeteaseProfilePage';
import CharVisitPage from './music/CharVisitPage';
import PlaylistDetailPage, { PlaylistSource } from './music/PlaylistDetailPage';
import SongCommentsPage from './music/SongCommentsPage';
import AlbumDetailPage, { AlbumSource } from './music/AlbumDetailPage';
import ArtistPage, { ArtistSource } from './music/ArtistPage';
import CharRecentPage from './music/CharRecentPage';
import SongActionsSheet from './music/SongActionsSheet';
import {
  MINIPLAYER_ENABLED_KEY, MINIPLAYER_CMD_EVENT, MiniPlayerCmd,
} from '../components/os/GlobalMiniPlayer';

// ------------------------- 工具 -------------------------
const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
};

type View = 'search' | 'settings' | 'player' | 'profile' | 'visit_char' | 'playlist_detail' | 'comments' | 'album_detail' | 'artist' | 'char_recent';

// ========================= 主组件 =========================
const MusicApp: React.FC = () => {
  const { closeApp, addToast, characters, userProfile } = useOS();
  const {
    cfg, setCfg,
    current, playing, progress, duration, loadingSong,
    lyric, tlyric, activeLyricIdx,
    profile, playSong, togglePlay, nextSong, prevSong, seek,
    liked, toggleLike, setToastHandler,
    listeningTogetherWith, removeListeningPartner,
    addLocalSong, removeLocalSong, localAlbumSongs,
    playMode, setPlayMode,
    queue, idx,
    regeneratingId, regeneratingStatus,
  } = useMusic();
  const [showQueue, setShowQueue] = useState(false);
  // 全局音乐悬浮球开关（状态存 localStorage，改动时用 CustomEvent 即时通知球本体）
  const [miniBallOn, setMiniBallOn] = useState<boolean>(() => {
    try { return localStorage.getItem(MINIPLAYER_ENABLED_KEY) !== '0'; } catch { return true; }
  });
  const sendMiniBallCmd = (cmd: MiniPlayerCmd) => {
    window.dispatchEvent(new CustomEvent(MINIPLAYER_CMD_EVENT, { detail: cmd }));
  };
  const isCurrentRegenerating = !!current && current.id === regeneratingId;
  // 把对轴入口和单曲循环按钮移到 SubActions 里，避免散乱
  // 下载本地生成的歌曲到本地文件系统
  const downloadCurrentLocal = useCallback(async () => {
    if (!current?.local || !current.localAssetKey) return;
    try {
      const entry = await DB.getAssetRaw(current.localAssetKey).catch(() => null) as
        | { blob?: Blob; mimeType?: string }
        | Blob
        | null;
      const blob: Blob | null = entry instanceof Blob
        ? entry
        : (entry?.blob instanceof Blob ? entry.blob : null);
      if (!blob) { addToast('音频文件丢失', 'error'); return; }
      const mime = current.localMimeType || (entry && !(entry instanceof Blob) ? entry.mimeType : '') || blob.type || 'audio/mpeg';
      const ext = /wav/i.test(mime) ? 'wav' : /ogg/i.test(mime) ? 'ogg' : /flac/i.test(mime) ? 'flac' : /m4a|aac|mp4/i.test(mime) ? 'm4a' : 'mp3';
      const safe = (current.name || 'song').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${safe}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      addToast('已下载', 'success');
    } catch {
      addToast('下载失败', 'error');
    }
  }, [current, addToast]);

  const cyclePlayMode = useCallback(() => {
    const order: ('loop' | 'single' | 'shuffle')[] = ['loop', 'single', 'shuffle'];
    const next = order[(order.indexOf(playMode) + 1) % order.length];
    setPlayMode(next);
    addToast(next === 'loop' ? '列表循环' : next === 'single' ? '单曲循环' : '随机播放', 'info');
  }, [playMode, setPlayMode, addToast]);

  // 伴听 char 名单（用于 MiniPlayer / 播放页徽章）—— 带头像，给"小情侣"头像块用
  const companions = useMemo(() => {
    return listeningTogetherWith
      .map(id => characters.find(c => c.id === id))
      .filter((c): c is typeof characters[number] => !!c)
      .map(c => ({ id: c.id, name: c.name, avatar: c.avatar }));
  }, [listeningTogetherWith, characters]);

  // 当前歌在哪些 char 的歌单里（用于 MiniPlayer 的"也收藏"提示）
  const charsWithSong = useMemo(() => {
    if (!current) return [];
    return characters
      .map(c => {
        const pl = c.musicProfile?.playlists.find(p => p.songs.some(s => s.id === current.id));
        return pl ? { id: c.id, name: c.name, playlistTitle: pl.title } : null;
      })
      .filter((x): x is { id: string; name: string; playlistTitle: string } => !!x);
  }, [current, characters]);

  // 把 OS toast 注入到 Music Context（这样全局播放报错也能弹 toast）
  useEffect(() => { setToastHandler(addToast); }, [addToast, setToastHandler]);

  const [view, setView] = useState<View>('profile');
  // ── 手动对轴 modal state ──
  const [showLyricSync, setShowLyricSync] = useState(false);
  const [syncDraft, setSyncDraft] = useState<number[]>([]);
  const [visitCharId, setVisitCharId] = useState<string | null>(null);
  const [recentCharId, setRecentCharId] = useState<string | null>(null);
  // 歌单详情页 / 评论区页的路由状态
  const [plDetail, setPlDetail] = useState<PlaylistSource | null>(null);
  const [commentSong, setCommentSong] = useState<Song | null>(null);
  const [commentsFrom, setCommentsFrom] = useState<View>('player'); // 评论区返回哪一页
  // 专辑详情页 / 歌手页的路由状态（记住来源页，返回时回到来的地方）
  const [albumDetail, setAlbumDetail] = useState<AlbumSource | null>(null);
  const [albumFrom, setAlbumFrom] = useState<View>('profile');
  const [artist, setArtist] = useState<ArtistSource | null>(null);
  const [artistFrom, setArtistFrom] = useState<View>('profile');
  // 播放页来源 —— 系统返回手势要从播放页回到进播放器前停留的界面，而不是直接回主页
  const [playerFrom, setPlayerFrom] = useState<View>('profile');
  // 播放页歌曲操作半屏菜单（跟歌单行三点按钮同一个 Sheet）
  const [playerSheetSong, setPlayerSheetSong] = useState<Song | null>(null);
  // 搜索结果曲目操作半屏菜单
  const [searchSheetSong, setSearchSheetSong] = useState<Song | null>(null);
  // 歌手页曲目操作半屏菜单
  const [artistSheetSong, setArtistSheetSong] = useState<Song | null>(null);
  // 歌词选择模式（长按歌词进全屏选择界面，可多选，底部复制/分享）
  const [lyricSelectMode, setLyricSelectMode] = useState(false);
  const [selectedLyricIndices, setSelectedLyricIndices] = useState<Set<number>>(new Set());
  const [lyricShareOpen, setLyricShareOpen] = useState(false);
  // 歌词显示模式：bilingual 双语（默认）/ mono 单语
  const [lyricDisplayMode, setLyricDisplayMode] = useState<'bilingual' | 'mono'>('bilingual');
  // 歌词分享 · 角色选择 + 附言
  const [lyricShareCharId, setLyricShareCharId] = useState<string | null>(null);
  const [lyricShareNote, setLyricShareNote] = useState('');
  // 打开歌词分享弹窗时默认选第一个角色
  useEffect(() => {
    if (lyricShareOpen && !lyricShareCharId) {
      const first = characters[0];
      if (first) setLyricShareCharId(first.id);
    }
  }, [lyricShareOpen, lyricShareCharId, characters]);
  const longPressTimer = useRef<number | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const clearLongPress = () => {
    if (longPressTimer.current) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    longPressStart.current = null;
  };
  // 长按歌词 → 进全屏选择界面（移动端振动反馈）
  const onLyricPointerDown = (e: React.PointerEvent) => {
    longPressStart.current = { x: e.clientX, y: e.clientY };
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      setLyricSelectMode(true);
      setSelectedLyricIndices(new Set());
      if (navigator.vibrate) navigator.vibrate(15);
    }, 500);
  };
  const onLyricPointerMove = (e: React.PointerEvent) => {
    if (!longPressStart.current) return;
    const dx = e.clientX - longPressStart.current.x;
    const dy = e.clientY - longPressStart.current.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearLongPress();
  };
  // 全屏选择界面：切换单行选中
  const toggleLyricSelect = (i: number) => {
    setSelectedLyricIndices(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
    if (navigator.vibrate) navigator.vibrate(8);
  };
  // 已选歌词拼接文本（按时间顺序，双语模式下带翻译）
  const selectedLyricText = useMemo(() => {
    if (selectedLyricIndices.size === 0) return '';
    const lines: string[] = [];
    lyric.forEach((l, i) => {
      if (!selectedLyricIndices.has(i) || !l.text) return;
      lines.push(l.text);
      if (lyricDisplayMode === 'bilingual') {
        const tr = tlyric.find(t => Math.abs(t.t - l.t) < 0.2);
        if (tr?.text) lines.push(tr.text);
      }
    });
    return lines.join('\n');
  }, [selectedLyricIndices, lyric, tlyric, lyricDisplayMode]);
  // 歌词分享给角色（落 music_card，intent=share_lyric，复用分享卡片但中间显示歌词）
  const shareLyricToChar = async () => {
    if (!lyricShareCharId || !selectedLyricText) return;
    const c = characters.find(x => x.id === lyricShareCharId);
    if (!c) return;
    const songName = current?.name || '这首歌';
    const artist = current?.artists || '';
    const note = lyricShareNote.trim();
    // content 给 AI 看：歌曲名+歌手+附言+歌词全文，让角色知道分享的是什么
    const songLabel = artist ? `《${songName}》— ${artist}` : `《${songName}》`;
    const contentParts = [note ? `${note}\n` : '', `分享${songLabel}的歌词：\n${selectedLyricText}`].join('');
    try {
      await DB.saveMessage({
        charId: lyricShareCharId,
        role: 'user',
        type: 'music_card',
        content: contentParts,
        metadata: {
          song: {
            id: current?.id || 0, name: songName,
            artists: artist, album: current?.album || '',
            albumPic: current?.albumPic || '', duration: current?.duration || 0,
          },
          intent: 'share_lyric',
          lyricText: selectedLyricText,
        },
      });
      window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId: lyricShareCharId } }));
      addToast(`已把歌词分享给 ${c.name}`, 'success');
    } catch { addToast('分享失败', 'error'); }
    setLyricShareOpen(false); setLyricSelectMode(false); setSelectedLyricIndices(new Set());
    setLyricShareCharId(null); setLyricShareNote('');
  };
  const openPlayer = () => {
    setPlayerFrom(view);
    setView('player');
  };
  const openAlbum = (album: AlbumSource) => {
    setAlbumFrom(view);
    setAlbumDetail(album);
    setView('album_detail');
  };
  const openArtist = (id: number, name: string) => {
    setArtistFrom(view);
    setArtist({ id, name });
    setView('artist');
  };

  // 系统返回手势：先关弹层，再按页面栈回退（评论→来处，播放页→来处，歌单详情→角色主页/我的主页…），最后才关 App
  useBackGuard([
      [lyricShareOpen, () => setLyricShareOpen(false)],
      [lyricSelectMode, () => { setLyricSelectMode(false); setSelectedLyricIndices(new Set()); }],
      [showLyricSync, () => setShowLyricSync(false)],
      [showQueue, () => setShowQueue(false)],
      [view === 'comments', () => setView(commentsFrom)],
      [view === 'player', () => setView(playerFrom)],
      [view === 'playlist_detail', () => setView(plDetail?.kind === 'char' ? 'visit_char' : 'profile')],
      [view === 'visit_char', () => { setView('profile'); setVisitCharId(null); }],
      [view === 'char_recent', () => { setView('visit_char'); setRecentCharId(null); }],
      [view === 'album_detail', () => setView(albumFrom)],
      [view === 'artist', () => setView(artistFrom)],
      [view !== 'profile', () => setView('profile')],
  ]);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Song[]>([]);
  const [searching, setSearching] = useState(false);
  const lyricBoxRef = useRef<HTMLDivElement | null>(null);

  // 歌词自动滚动：把 current line 对齐到滚动容器视觉中心
  // 注意 offsetTop 依赖 offsetParent，容器没 position:relative 时会跨到祖先节点、值偏大，
  // 导致 current line 被推到中心上方。改用 getBoundingClientRect 对齐，和 DOM 嵌套解耦。
  useEffect(() => {
    if (view !== 'player') return;
    const box = lyricBoxRef.current; if (!box || activeLyricIdx < 0) return;
    const el = box.querySelector<HTMLDivElement>(`[data-lyric-idx="${activeLyricIdx}"]`);
    if (!el) return;
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elTopInBox = elRect.top - boxRect.top + box.scrollTop;
    box.scrollTo({ top: elTopInBox - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
  }, [activeLyricIdx, view]);

  // ── 搜索 ──
  const doSearch = useCallback(async (kwArg?: string) => {
    const kw = (kwArg ?? keyword).trim(); if (!kw) return;
    setSearching(true);
    try {
      const r = await musicApi.search(cfg, kw);
      const songs: Song[] = (r?.result?.songs || []).map((s: any) => ({
        id: s.id, name: s.name,
        artists: (s.ar || s.artists || []).map((a: any) => a.name).join(' / '),
        artistIds: (s.ar || s.artists || []).map((a: any) => a.id),
        album: s.al?.name || s.album?.name || '',
        albumPic: toHttps(s.al?.picUrl || s.album?.picUrl || ''),
        duration: (s.dt || s.duration || 0) / 1000,
        fee: s.fee ?? 0,
      }));
      setResults(songs);
      if (!songs.length) {
        const hint = r?.msg || r?.message || (r?.code != null ? `code=${r.code}` : '') || '无数据';
        addToast(`没找到: ${hint}`, 'info');
      }
    } catch (e: any) {
      addToast(`搜索失败：${e.message}`, 'error');
    } finally {
      setSearching(false);
    }
  }, [keyword, cfg, addToast]);

  /** 用指定关键词跳搜索页并自动搜索（角色钟爱的原声等场景） */
  const openSearchWithKeyword = useCallback((kw: string) => {
    const clean = kw.trim();
    setKeyword(clean);
    setResults([]);
    setView('search');
    if (clean) doSearch(clean);
  }, [doSearch]);

  // ════════════════ 搜索页 ════════════════
  const renderSearch = () => (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader
        title="未来音楽"
        onClose={closeApp}
        right={
          <div className="flex items-center gap-1">
            <button
              onClick={() => setView('profile')}
              className="p-1.5 rounded-full transition-all"
              style={{ color: C.primary }}
              title="我的"
            >
              <UserIcon size={16} weight="bold" />
            </button>
            <button
              onClick={() => setView('settings')}
              className="p-1.5 rounded-full transition-all"
              style={{ color: C.primary }}
            >
              <Gear size={16} weight="bold" />
            </button>
          </div>
        }
      />
      <SearchBar value={keyword} onChange={setKeyword} onSearch={() => doSearch()} searching={searching} />

      {/* 用户状态 — 玻璃标签 */}
      {profile && (
        <div className="px-5 -mt-1 mb-1.5 flex items-center gap-1.5 relative z-10">
          <button
            onClick={() => setView('profile')}
            className="inline-flex items-center gap-2 pl-0.5 pr-3 py-0.5 rounded-full text-[10px] shizuku-glass cursor-pointer"
            style={{ color: C.muted }}
          >
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" className="w-5 h-5 rounded-full object-cover" />
            ) : <Sparkle size={6} color={C.sakura} delay={0.3} />}
            {profile.nickname} · {cfg.quality}
          </button>
        </div>
      )}
      {!cfg.cookie && (
        <div className="px-5 -mt-1 mb-1.5 relative z-10">
          <button
            onClick={() => setView('profile')}
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] cursor-pointer"
            style={{ background: `${C.vip}18`, color: C.vip, border: `1px solid ${C.vip}30` }}
          >
            未登录 — 点击登录网易云
          </button>
        </div>
      )}

      {/* 歌曲列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-24 relative z-10 shizuku-scrollbar">
        {results.length === 0 && !searching && (
          <div className="text-center mt-16 space-y-4">
            <div className="relative inline-block">
              <Sparkle size={24} className="mx-auto" color={C.glow} delay={0} />
              <Sparkle size={12} className="absolute -top-1 -right-3" color={C.sakura} delay={0.8} />
              <Sparkle size={8} className="absolute -bottom-2 -left-2" color={C.lavender} delay={1.5} />
            </div>
            <div className="text-xs italic" style={{ color: C.faint, fontFamily: `'Georgia', serif` }}>
              搜一首想听的歌吧
            </div>
          </div>
        )}
        {results.map(s => (
          <SongRow
            key={s.id}
            name={s.name}
            artists={s.artists}
            album={s.album}
            albumPic={s.albumPic}
            duration={fmtTime(s.duration)}
            isVip={s.fee === 1}
            isActive={current?.id === s.id}
            onClick={() => playSong(s)}
            onMore={() => setSearchSheetSong(s)}
          />
        ))}
      </div>

      {current && (
        <MiniPlayer
          name={current.name}
          artists={current.artists}
          albumPic={current.albumPic}
          playing={playing}
          onTap={() => setView('player')}
          onPrev={prevSong}
          onToggle={togglePlay}
          onNext={nextSong}
          userAvatar={userProfile?.avatar}
          userName={userProfile?.name}
          companions={companions}
          onKickCompanion={removeListeningPartner}
          charsWithSong={charsWithSong}
          regenStatus={isCurrentRegenerating ? regeneratingStatus : undefined}
        />
      )}
    </div>
  );

  // ════════════════ 播放页 ════════════════
  const bitrateMap: Record<string, string> = {
    standard: '128 kbps',
    higher:   '192 kbps',
    exhigh:   '320 kbps',
    lossless: '1411 kbps',
    hires:    '24bit · Hi-Res',
  };

  const renderPlayer = () => {
    if (!current) return null;
    const isTogether = companions.length > 0;
    return (
      <div className="flex flex-col h-full relative"
        style={{ background: isTogether
          ? `linear-gradient(180deg, #fff5f8 0%, ${C.bg} 55%, ${C.bgDeep} 100%)`
          : `linear-gradient(180deg, #ffffff 0%, ${C.bg} 60%, ${C.bgDeep} 100%)` }}>
        <BokehBg />
        <MizuHeader title="Now Playing" onBack={() => setView('search')} />

        <div className="flex-1 flex flex-col items-center px-5 pt-4 pb-3 relative z-10 overflow-hidden">
          {/* 一起听徽章 —— 进入特殊外观 */}
          {isTogether && (
            <div className="w-full max-w-xs mb-2">
              <TogetherHeader
                userAvatar={userProfile?.avatar}
                userName={userProfile?.name}
                companions={companions}
                onKick={removeListeningPartner}
              />
            </div>
          )}
          <div className="shrink-0 mt-1 relative" style={isTogether ? { filter: `drop-shadow(0 0 22px ${C.sakura}66)` } : undefined}>
            <VinylDisc albumPic={current.albumPic} playing={playing} size={150} bitrate={bitrateMap[cfg.quality]} />
            {/* 重录中覆盖层 — 只在本地歌且 regeneratingId 匹配时显示 */}
            {isCurrentRegenerating && (
              <div className="absolute inset-0 rounded-full flex items-center justify-center pointer-events-none"
                style={{
                  background: `radial-gradient(circle, rgba(0,0,0,0.55) 30%, rgba(0,0,0,0.35) 70%)`,
                  backdropFilter: 'blur(6px)',
                  WebkitBackdropFilter: 'blur(6px)',
                  boxShadow: `0 0 30px ${C.glow}80`,
                  animation: 'shizuku-glow 2s ease-in-out infinite',
                }}
              >
                <div className="text-center space-y-1.5 px-3">
                  <div className="w-7 h-7 mx-auto border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <div className="text-[10px] tracking-[0.2em] text-white font-semibold" style={{ fontFamily: 'Georgia, serif' }}>
                    正在重录
                  </div>
                  <div className="text-[9px] text-white/80 truncate max-w-[120px]" style={{ fontFamily: 'monospace' }}>
                    {regeneratingStatus || '处理中…'}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 横幅形式的重录提示 — 进入播放页第一时间看到状态 */}
          {isCurrentRegenerating && (
            <div className="mt-3 px-3 py-1.5 rounded-full flex items-center gap-2 text-[10px] tracking-wider"
              style={{
                background: `linear-gradient(135deg, ${C.primary}15, ${C.lavender}25)`,
                border: `1px solid ${C.glow}60`,
                color: C.primary,
              }}
            >
              <Sparkle size={9} color={C.sakura} delay={0} />
              <span>新版本即将到来 · {regeneratingStatus || '处理中'}</span>
              <Sparkle size={9} color={C.lavender} delay={0.5} />
            </div>
          )}

          <section className="mt-5 text-center space-y-1.5 shrink-0 px-2">
            <h2 className="font-light tracking-tight leading-tight"
              style={{ color: C.primary, fontFamily: `'Noto Serif','Georgia',serif`, fontSize: '22px' }}>
              {current.name}
            </h2>
            <p className="text-[10px] uppercase opacity-70"
              style={{ color: C.muted, fontFamily: `'Space Grotesk','SF Mono',monospace`, letterSpacing: '0.2em' }}>
              <ArtistLinks
                artists={current.artists}
                artistIds={current.artistIds}
                onOpenArtist={openArtist}
              />
            </p>
          </section>

          <div
            ref={lyricBoxRef}
            className="flex-1 w-full my-3 min-h-0 overflow-y-auto text-center scroll-smooth shizuku-scrollbar px-2"
            style={{
              maskImage: 'linear-gradient(to bottom, transparent, black 18%, black 82%, transparent)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 18%, black 82%, transparent)',
            }}
          >
            {lyric.length === 0 ? (
              <div className="pt-6 flex flex-col items-center gap-2" style={{ color: C.faint }}>
                <Sparkle size={12} color={C.glow} />
                <span className="text-[11px] italic tracking-wider" style={{ fontFamily: `'Noto Serif','Georgia',serif` }}>
                  {loadingSong ? 'loading...' : 'no lyrics'}
                </span>
              </div>
            ) : (
              <div className="space-y-4 py-8">
                {lyric.map((l, i) => {
                  const tr = tlyric.find(t => Math.abs(t.t - l.t) < 0.2);
                  const active = i === activeLyricIdx;
                  // 关键：字号 / 字重不随 active 变 —— 变了会触发重排换行。
                  //     只让外层盒子用 transform:scale 视觉放大，不动内部文字度量。
                  return (
                    <div key={i} data-lyric-idx={i}
                      className="transition-transform duration-300 will-change-transform"
                      style={{
                        transform: active ? 'scale(1.05)' : 'scale(1)',
                        transformOrigin: 'center center',
                        opacity: active ? 1 : 0.45,
                      }}
                      onPointerDown={(e) => { if (l.text) onLyricPointerDown(e); }}
                      onPointerMove={onLyricPointerMove}
                      onPointerUp={clearLongPress}
                      onPointerCancel={clearLongPress}
                    >
                      <div className="flex items-center justify-center gap-2 px-3">
                        <CrossStar
                          size={12}
                          color={C.sakura}
                          delay={0}
                          solid={active}
                          className={active ? '' : 'opacity-0'}
                        />
                        <div
                          className="text-[16px] leading-[1.4]"
                          style={{
                            fontFamily: `'Noto Serif','Georgia',serif`,
                            fontWeight: 400,
                            maxWidth: '100%',
                            wordBreak: 'break-word',
                            color: active ? undefined : C.faint,
                            ...(active
                              ? {
                                  background: `linear-gradient(135deg, ${C.primary} 0%, ${C.accent} 50%, #9a6bc5 100%)`,
                                  WebkitBackgroundClip: 'text',
                                  WebkitTextFillColor: 'transparent',
                                  backgroundClip: 'text',
                                  filter: `drop-shadow(0 0 14px ${C.glow}a0) drop-shadow(0 0 4px ${C.sakura}80)`,
                                }
                              : {}),
                          }}
                        >
                          {l.text}
                        </div>
                        <CrossStar
                          size={12}
                          color={C.lavender}
                          delay={0.9}
                          solid={active}
                          className={active ? '' : 'opacity-0'}
                        />
                      </div>
                      {tr && (
                        <div
                          className="text-[12px] leading-[1.4] mt-1 px-3"
                          style={{
                            fontWeight: 400,
                            maxWidth: '100%',
                            wordBreak: 'break-word',
                            opacity: active ? 0.78 : 0.4,
                            color: active ? C.accent : C.faint,
                          }}
                        >
                          {tr.text}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="w-full shrink-0 max-w-sm">
            <div className="flex justify-between items-center mb-2 px-0.5">
              <MetaChip>{fmtTime(progress)}</MetaChip>
              <MetaChip>{fmtTime(duration)}</MetaChip>
            </div>
            <GlassProgress progress={progress} duration={duration} fmtTime={fmtTime} onSeek={seek} />
          </div>

          <div className="shrink-0 relative">
            <Sparkle size={9} className="absolute top-1 left-[30%]" color={C.sakura} delay={0} />
            <Sparkle size={7} className="absolute top-3 right-[28%]" color={C.lavender} delay={1.2} />
            <PlayControls playing={playing} loading={loadingSong} onPrev={prevSong} onToggle={togglePlay} onNext={nextSong} />
          </div>

          <div className="shrink-0 mt-2 w-full flex items-center justify-center gap-2">
            <button
              onClick={() => setShowQueue(v => !v)}
              className="text-[11px] px-3 py-1.5 rounded-full flex items-center gap-1.5 active:scale-95 transition-transform"
              style={{ background: showQueue ? C.primary : 'rgba(255,255,255,0.6)', color: showQueue ? 'white' : C.muted, border: `1px solid ${showQueue ? 'transparent' : 'rgba(255,255,255,0.4)'}` }}
            >
              <span className="text-[13px]">☰</span> 播放列表 {queue.length > 0 ? `(${queue.length})` : ''}
            </button>
            {queue.length > 0 && (
              <span className="text-[10px]" style={{ color: C.faint }}>
                {idx >= 0 ? `${idx + 1}/${queue.length}` : ''} {playMode === 'shuffle' ? '· 随机' : playMode === 'single' ? '· 单曲循环' : '· 列表'}
              </span>
            )}
          </div>

          {showQueue && (
            <div className="mt-3 w-full max-h-[32vh] overflow-y-auto rounded-2xl shizuku-glass p-2 space-y-1 shizuku-scrollbar">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-[11px] font-bold" style={{ color: C.muted }}>播放队列 · {queue.length} 首</span>
                <button onClick={() => setShowQueue(false)} className="text-[11px] px-2 py-0.5 rounded-full" style={{ color: C.faint, border: `1px solid ${C.faint}30` }}>收起</button>
              </div>
              {queue.map((s, i) => {
                const active = i === idx;
                return (
                  <button
                    key={`${s.id}-${i}`}
                    onClick={() => { playSong(s, { replaceQueue: queue, startIdx: i }); }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-left transition-colors ${active ? 'bg-white/60' : 'hover:bg-white/30'}`}
                  >
                    <span className="text-[10px] w-5 shrink-0" style={{ color: active ? C.primary : C.faint }}>{active ? '▶' : i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] truncate" style={{ color: active ? C.primary : C.text, fontWeight: active ? 600 : 400 }}>{s.name}</div>
                      <div className="text-[10px] truncate" style={{ color: C.muted }}>{s.artists}</div>
                    </div>
                    {active && playing && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />}
                  </button>
                );
              })}
              {queue.length === 0 && <div className="text-[11px] text-center py-4" style={{ color: C.faint }}>队列是空的，去搜几首吧</div>}
            </div>
          )}

          <div className="shrink-0 mt-3 w-full">
            <SubActions
              liked={liked}
              onLike={toggleLike}
              showSync={!!(current.local && current.localLyrics && lyric.length > 0)}
              onSync={() => {
                setSyncDraft(lyric.map(l => l.t));
                setShowLyricSync(true);
              }}
              showDownload={!!(current.local && current.localAssetKey)}
              onDownload={downloadCurrentLocal}
              playMode={playMode}
              onCyclePlayMode={cyclePlayMode}
              showComments={!current.local}
              onComments={() => { setCommentSong(current); setCommentsFrom('player'); setView('comments'); }}
              onMore={() => setPlayerSheetSong(current)}
            />
          </div>
        </div>
      </div>
    );
  };

  // ════════════════ 设置页 ════════════════
  const renderSettings = () => {
    const setDraft = (updates: Partial<typeof cfg>) => setCfg({ ...cfg, ...updates });
    // 音乐的 worker 地址是独立持久化的，中心设置里的「恢复默认」管不到它——
    // 这里必须自己兜底：地址清空就保存 = 跟随中心 worker，立即生效（不然存进空串，
    // 请求会打相对路径直接挂，要等下次刷新 loadCfg 迁移才恢复）。
    const commit = () => {
      if (!cfg.workerUrl.trim()) setCfg({ ...cfg, workerUrl: getProxyWorkerUrl() });
      addToast('已保存', 'success');
      setView('search');
    };
    return (
      <div className="flex flex-col h-full relative"
        style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
        <BokehBg />
        <MizuHeader title="设置" onBack={() => setView('search')} />
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 text-sm relative z-10 shizuku-scrollbar">
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center justify-between" style={{ color: C.muted }}>
              <span className="flex items-center gap-1.5"><Sparkle size={6} color={C.glow} delay={0} /> 服务地址</span>
              {cfg.workerUrl.trim() !== getProxyWorkerUrl() && (
                <button onClick={() => setDraft({ workerUrl: getProxyWorkerUrl() })}
                  className="text-[9px] underline" style={{ color: C.muted }}>恢复默认</button>
              )}
            </div>
            <input className="w-full rounded-xl px-3 py-2 outline-none text-xs shizuku-glass" value={cfg.workerUrl}
              onChange={e => setDraft({ workerUrl: e.target.value })} placeholder={getProxyWorkerUrl()}
              style={{ color: C.text }} />
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
              留空保存 = 跟随「设置 → 自定义网络代理」的地址
            </div>
          </div>
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={6} color={C.sakura} delay={0.5} /> 会员 Cookie
            </div>
            <textarea className="w-full rounded-xl px-3 py-2 outline-none text-[10px] shizuku-glass" rows={3} value={cfg.cookie}
              onChange={e => setDraft({ cookie: e.target.value })} placeholder="MUSIC_U=xxx 或直接粘贴值..."
              style={{ color: C.text, fontFamily: 'monospace', resize: 'none' }} />
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
              也可以在「我的」页面里扫码 / 手机号登录，自动填入 cookie
            </div>
          </div>
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={6} color={C.lavender} delay={1} /> 音质
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {(['standard', 'higher', 'exhigh', 'lossless', 'hires'] as const).map(q => (
                <button key={q} onClick={() => setDraft({ quality: q })}
                  className="py-2 rounded-xl text-[10px] transition-all"
                  style={{
                    background: cfg.quality === q ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : C.glass,
                    color: cfg.quality === q ? 'white' : C.muted,
                    border: cfg.quality === q ? '1px solid transparent' : `1px solid rgba(255,255,255,0.3)`,
                    boxShadow: cfg.quality === q ? `0 2px 12px ${C.glow}30` : 'none',
                    backdropFilter: 'blur(8px)',
                  }}
                >{q}</button>
              ))}
            </div>
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>lossless / hires 需要黑胶 SVIP</div>
          </div>
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={6} color={C.primary} delay={1.5} /> 音乐悬浮球
            </div>
            <div className="flex items-center justify-between">
              <div className="min-w-0 pr-3">
                <div className="text-[11px]" style={{ color: C.text }}>在音乐 App 外显示悬浮球</div>
                <div className="text-[9px] mt-0.5 italic" style={{ color: C.faint }}>含桌面；后台放歌时可快捷控制播放</div>
              </div>
              <button
                onClick={() => {
                  const next = !miniBallOn;
                  setMiniBallOn(next);
                  try {
                    if (next) localStorage.removeItem(MINIPLAYER_ENABLED_KEY);
                    else localStorage.setItem(MINIPLAYER_ENABLED_KEY, '0');
                  } catch {}
                  sendMiniBallCmd({ type: 'set-enabled', enabled: next });
                }}
                className="shrink-0 w-11 h-6 rounded-full relative transition-all"
                style={{
                  background: miniBallOn ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : 'rgba(0,0,0,0.12)',
                  boxShadow: miniBallOn ? `0 2px 10px ${C.glow}40` : 'none',
                }}
                aria-label="开关音乐悬浮球"
              >
                <div
                  className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
                  style={{ left: miniBallOn ? 'calc(100% - 22px)' : '2px', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }}
                />
              </button>
            </div>
            <button
              onClick={() => {
                sendMiniBallCmd({ type: 'reset-pos' });
                addToast('悬浮球已回到默认位置（右下角）', 'success');
              }}
              className="w-full mt-2.5 py-2 rounded-xl text-[10px] tracking-wider shizuku-glass transition-all"
              style={{ color: C.muted, border: '1px solid rgba(255,255,255,0.3)' }}
            >恢复默认位置（球不见了点这里）</button>
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
              会把球拉回右下角，并解除长按隐藏。拖到屏幕外、长按误触都能用它救回来
            </div>
          </div>
          <div className="space-y-3 pt-1">
            <button
              onClick={async () => {
                const lines: string[] = [];
                const ck = normalizeCookie(cfg.cookie);
                lines.push(`Worker: ${cfg.workerUrl}`);
                lines.push(`Cookie: ${ck ? ck.slice(0, 18) + '...(' + ck.length + 'c)' : '(未填)'}`);
                try {
                  const res = await fetch(`${cfg.workerUrl.replace(/\/+$/, '')}/netease/search`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', ...(ck ? { 'X-Netease-Cookie': ck } : {}) },
                    body: JSON.stringify({ keyword: '晴天', limit: 3 }),
                  });
                  lines.push(`HTTP ${res.status}`);
                  const txt = await res.text(); lines.push(txt.slice(0, 800));
                  try { const j = JSON.parse(txt); lines.push(`---\ncode=${j.code}  songs=${j?.result?.songs?.length ?? 'N/A'}`); } catch {}
                } catch (e: any) { lines.push(`异常: ${e.message}`); }
                alert(lines.join('\n'));
              }}
              className="w-full py-2.5 rounded-2xl text-[10px] tracking-wider shizuku-glass transition-all"
              style={{ color: C.vip, border: `1px solid ${C.vip}30` }}
            >诊断（搜索晴天）</button>
            <button onClick={commit}
              className="w-full py-3 rounded-2xl text-xs text-white tracking-wider transition-all relative overflow-hidden"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}>
              <span className="relative z-10">保存</span>
              <div className="absolute inset-0 pointer-events-none" style={{
                background: `linear-gradient(90deg, transparent 30%, rgba(255,255,255,0.25) 50%, transparent 70%)`,
                backgroundSize: '200% 100%', animation: 'shizuku-shimmer 3s ease-in-out infinite',
              }} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="absolute inset-0 overflow-hidden">
      {view === 'search' && renderSearch()}
      {view === 'player' && renderPlayer()}
      {view === 'settings' && renderSettings()}
      {view === 'profile' && (
        <NeteaseProfilePage
          onBack={closeApp}
          onOpenPlayer={openPlayer}
          onOpenSearch={() => setView('search')}
          onOpenSettings={() => setView('settings')}
          onVisitChar={id => { setVisitCharId(id); setView('visit_char'); }}
          onOpenPlaylist={pl => { setPlDetail({ kind: 'netease', playlist: pl }); setView('playlist_detail'); }}
        />
      )}
      {/* 手动对轴 modal — 全屏覆盖，不开新 view */}
      {showLyricSync && current && current.local && (() => {
        const fmt = (s: number) => {
          if (!isFinite(s)) return '0:00.0';
          const m = Math.floor(s / 60);
          const sec = (s % 60).toFixed(1).padStart(4, '0');
          return `${m}:${sec}`;
        };
        const setLineTime = (idx: number, t: number) => {
          setSyncDraft(prev => {
            const next = [...prev];
            next[idx] = Math.max(0, t);
            return next;
          });
        };
        const tapCurrent = (idx: number) => setLineTime(idx, progress);
        const resetAuto = () => {
          if (!duration || duration <= 0) return;
          const intro = Math.min(2, duration * 0.05);
          const outro = Math.min(3, duration * 0.05);
          const usable = Math.max(duration - intro - outro, duration * 0.6);
          const step = usable / lyric.length;
          setSyncDraft(lyric.map((_, i) => intro + i * step));
        };
        const saveSync = () => {
          if (!current) return;
          // 把 draft 写到 song.lyricLineTimings 里 → addLocalSong 上行覆盖
          const updated: Song = { ...current, lyricLineTimings: syncDraft };
          addLocalSong(updated);
          // 重新 playSong 让 LyricLine 立即用新时间
          playSong(updated, { alsoSetQueue: false });
          setShowLyricSync(false);
          addToast('对轴已保存 ✦', 'success');
        };

        return (
          <div className="absolute inset-0 z-50 flex flex-col"
            style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 60%, ${C.bgDeep} 100%)` }}>
            <BokehBg />
            {/* Header */}
            <div className="relative z-10 shizuku-glass-strong"
              style={{ borderBottom: `1px solid rgba(255,255,255,0.3)`, paddingTop: 'var(--safe-top)' }}>
              <div className="flex items-center justify-between h-12 px-4">
                <button onClick={() => setShowLyricSync(false)} className="text-[11px] px-2 py-1 rounded-full" style={{ color: C.muted }}>取消</button>
                <div className="flex items-center gap-1.5">
                  <Crosshair size={13} weight="duotone" color={C.primary} />
                  <span className="text-[12px] tracking-[0.25em]" style={{ color: C.primary, fontFamily: 'Georgia, serif' }}>歌词对轴</span>
                </div>
                <button onClick={saveSync} className="text-[11px] font-bold px-3 py-1 rounded-full"
                  style={{
                    background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`,
                    color: 'white',
                    boxShadow: `0 2px 10px ${C.glow}50`,
                  }}>保存</button>
              </div>
            </div>

            {/* Live progress + transport */}
            <div className="relative z-10 px-4 pt-3 pb-2 shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <button onClick={togglePlay}
                  className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 active:scale-95 transition-transform"
                  style={{
                    background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`,
                    color: 'white',
                    boxShadow: `0 3px 12px ${C.glow}50`,
                  }}
                >
                  {playing ? <PauseIcon size={14} weight="fill" /> : <PlayIcon size={14} weight="fill" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: C.muted, fontFamily: 'monospace' }}>
                    <span style={{ color: C.primary, fontWeight: 600 }}>{fmt(progress)}</span>
                    <span>{fmt(duration)}</span>
                  </div>
                  <div className="h-1 rounded-full shizuku-glass cursor-pointer relative"
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                      seek((e.clientX - rect.left) / rect.width);
                    }}
                  >
                    <div className="absolute top-0 left-0 h-full rounded-full"
                      style={{
                        width: `${duration > 0 ? (progress / duration) * 100 : 0}%`,
                        background: `linear-gradient(90deg, ${C.primary}, ${C.glow})`,
                      }} />
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <button onClick={resetAuto} className="text-[10px] underline" style={{ color: C.muted }}>
                  重置为均匀分布
                </button>
                <p className="text-[10px] flex-1 text-right" style={{ color: C.muted }}>
                  播放时点 ⊙ 把当前时间设给那一句
                </p>
              </div>
            </div>

            {/* Lyric list with tap-to-set */}
            <div className="flex-1 overflow-y-auto px-3 pb-6 shizuku-scrollbar relative z-10 pt-1">
              {lyric.length === 0 ? (
                <div className="text-center text-[11px] py-12" style={{ color: C.faint }}>没有歌词可对轴</div>
              ) : (
                <div className="space-y-1.5">
                  {lyric.map((l, i) => {
                    const t = syncDraft[i] ?? l.t;
                    const isActive = i === activeLyricIdx;
                    return (
                      <div key={i}
                        className="flex items-center gap-2 rounded-xl px-2.5 py-2 transition-all"
                        style={{
                          background: isActive
                            ? `linear-gradient(135deg, ${C.glow}25, ${C.lavender}18)`
                            : 'rgba(255,255,255,0.5)',
                          border: `1px solid ${isActive ? C.glow + '60' : C.faint + '30'}`,
                          boxShadow: isActive ? `0 2px 12px ${C.glow}30` : 'none',
                        }}
                      >
                        <span className="text-[9px] tabular-nums w-5 text-center shrink-0" style={{ color: C.faint }}>{i + 1}</span>
                        <button
                          onClick={() => tapCurrent(i)}
                          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 active:scale-90 transition-all"
                          style={{
                            background: `${C.primary}15`,
                            border: `1px solid ${C.primary}30`,
                            color: C.primary,
                          }}
                          title="把这一句设到当前播放时间"
                        >
                          ⊙
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] truncate" style={{ color: isActive ? C.primary : C.text, fontWeight: isActive ? 600 : 400 }}>
                            {l.text}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[9px] tabular-nums" style={{ color: C.muted, fontFamily: 'monospace' }}>{fmt(t)}</span>
                            <button
                              onClick={() => setLineTime(i, t - 0.2)}
                              className="text-[9px] px-1 rounded"
                              style={{ color: C.faint }}
                            >−.2s</button>
                            <button
                              onClick={() => setLineTime(i, t + 0.2)}
                              className="text-[9px] px-1 rounded"
                              style={{ color: C.faint }}
                            >+.2s</button>
                            <button
                              onClick={() => seek(duration > 0 ? t / duration : 0)}
                              className="text-[9px] px-1 rounded ml-auto"
                              style={{ color: C.accent }}
                            >跳到此处</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {view === 'visit_char' && visitCharId && (
        <CharVisitPage
          charId={visitCharId}
          onBack={() => { setView('profile'); setVisitCharId(null); }}
          onOpenPlayer={openPlayer}
          onOpenArtist={openArtist}
          onOpenSearch={openSearchWithKeyword}
          onOpenRecent={id => { setRecentCharId(id); setView('char_recent'); }}
          onOpenPlaylist={plId => { setPlDetail({ kind: 'char', charId: visitCharId, playlistId: plId }); setView('playlist_detail'); }}
        />
      )}

      {view === 'char_recent' && recentCharId && (
        <CharRecentPage
          charId={recentCharId}
          charName={characters.find(c => c.id === recentCharId)?.name || '角色'}
          onBack={() => { setView('visit_char'); setRecentCharId(null); }}
          onOpenPlayer={openPlayer}
          onOpenComments={s => { setCommentSong(s); setCommentsFrom('char_recent'); setView('comments'); }}
        />
      )}

      {view === 'playlist_detail' && plDetail && (
        <PlaylistDetailPage
          source={plDetail}
          onBack={() => setView(plDetail.kind === 'char' ? 'visit_char' : 'profile')}
          onOpenPlayer={openPlayer}
          onOpenComments={s => { setCommentSong(s); setCommentsFrom('playlist_detail'); setView('comments'); }}
          onOpenArtist={openArtist}
          onOpenAlbum={openAlbum}
        />
      )}

      {view === 'album_detail' && albumDetail && (
        <AlbumDetailPage
          album={albumDetail}
          onBack={() => setView(albumFrom)}
          onOpenPlayer={openPlayer}
          onOpenArtist={openArtist}
          onOpenComments={s => { setCommentSong(s); setCommentsFrom('album_detail'); setView('comments'); }}
        />
      )}

      {view === 'artist' && artist && (
        <ArtistPage
          artistId={artist.id}
          artistName={artist.name}
          onBack={() => setView(artistFrom)}
          onOpenPlayer={openPlayer}
          onOpenAlbum={openAlbum}
          onOpenArtist={openArtist}
          onOpenComments={s => { setCommentSong(s); setCommentsFrom('artist'); setView('comments'); }}
          onMore={s => setArtistSheetSong(s)}
        />
      )}

      {view === 'comments' && commentSong && (
        <SongCommentsPage song={commentSong} onBack={() => setView(commentsFrom)} />
      )}

      {/* 播放页歌曲操作半屏菜单（跟歌单行三点按钮同款） */}
      {playerSheetSong && (
        <SongActionsSheet
          song={playerSheetSong}
          onClose={() => setPlayerSheetSong(null)}
          onOpenComments={s => { setPlayerSheetSong(null); setCommentSong(s); setCommentsFrom('player'); setView('comments'); }}
          onOpenArtist={openArtist}
          onOpenAlbum={openAlbum}
        />
      )}

      {/* 搜索结果曲目操作半屏菜单（跟歌单行三点按钮同款） */}
      {searchSheetSong && (
        <SongActionsSheet
          song={searchSheetSong}
          onClose={() => setSearchSheetSong(null)}
          onOpenComments={s => { setSearchSheetSong(null); setCommentSong(s); setCommentsFrom('search'); setView('comments'); }}
          onOpenArtist={openArtist}
          onOpenAlbum={openAlbum}
        />
      )}

      {/* 歌手页曲目操作半屏菜单（跟歌单行三点按钮同款） */}
      {artistSheetSong && (
        <SongActionsSheet
          song={artistSheetSong}
          onClose={() => setArtistSheetSong(null)}
          onOpenComments={s => { setArtistSheetSong(null); setCommentSong(s); setCommentsFrom('artist'); setView('comments'); }}
          onOpenArtist={openArtist}
          onOpenAlbum={openAlbum}
        />
      )}

      {/* 全屏歌词选择界面（长按歌词进入，可多选，底部复制/分享） */}
      {lyricSelectMode && (
        <div className="fixed inset-0 z-[60] flex flex-col"
          style={{ background: `linear-gradient(180deg, ${C.bg} 0%, ${C.bgDeep} 100%)` }}>
          <BokehBg />
          <MizuHeader
            title="选择歌词"
            onBack={() => { setLyricSelectMode(false); setSelectedLyricIndices(new Set()); }}
          />
          {/* 控件行 —— 从 header 挪到内容区顶部，避免被挤成竖排 */}
          <div className="flex items-center justify-between px-4 py-2 shrink-0 relative z-10"
            style={{ borderBottom: `1px solid ${C.faint}20` }}>
            <button
              onClick={() => setLyricDisplayMode(m => m === 'bilingual' ? 'mono' : 'bilingual')}
              className="px-2.5 py-1 rounded-full text-[10px] font-bold transition-colors"
              style={{
                background: lyricDisplayMode === 'bilingual' ? `${C.primary}20` : 'rgba(255,255,255,0.4)',
                color: lyricDisplayMode === 'bilingual' ? C.primary : C.muted,
              }}
            >
              {lyricDisplayMode === 'bilingual' ? '双语' : '单语'}
            </button>
            <span className="text-[10px]" style={{ color: C.muted }}>
              已选 {selectedLyricIndices.size}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar px-2 pb-28">
            <div className="space-y-3 py-6">
              {lyric.length === 0 ? (
                <div className="text-center text-[11px] py-10" style={{ color: C.faint }}>暂无歌词</div>
              ) : lyric.map((l, i) => {
                if (!l.text) return null;
                const selected = selectedLyricIndices.has(i);
                const isActive = i === activeLyricIdx;
                const tr = lyricDisplayMode === 'bilingual' ? tlyric.find(t => Math.abs(t.t - l.t) < 0.2) : null;
                return (
                  <div
                    key={i}
                    onClick={() => toggleLyricSelect(i)}
                    className="w-full text-left px-4 py-2 rounded-xl flex items-start gap-3 cursor-pointer"
                    style={{
                      background: selected ? `${C.primary}18` : 'transparent',
                      border: selected ? `1px solid ${C.primary}50` : '1px solid transparent',
                    }}
                  >
                    <div className="shrink-0 mt-0.5 w-4 h-4 rounded-full flex items-center justify-center"
                      style={{
                        background: selected ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : 'rgba(255,255,255,0.4)',
                        border: selected ? 'none' : `1px solid ${C.faint}60`,
                        boxShadow: selected ? `0 2px 8px ${C.primary}40` : 'none',
                      }}>
                      {selected && (
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={4}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="block text-[14px] leading-[1.5]"
                        style={{
                          color: selected ? C.text : (isActive ? C.text : C.muted),
                          fontFamily: `'Noto Serif','Georgia',serif`,
                          fontWeight: selected || isActive ? 500 : 400,
                        }}>
                        {l.text}
                      </span>
                      {/* 双语：翻译行 */}
                      {tr?.text && (
                        <span className="block text-[11px] leading-[1.4] mt-0.5"
                          style={{
                            color: selected ? C.muted : `${C.faint}`,
                            fontFamily: `'Noto Serif','Georgia',serif`,
                          }}>
                          {tr.text}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {/* 底部固定操作栏 */}
          <div className="relative z-20 px-4 pt-3 pb-5 shizuku-glass-strong"
            style={{ borderTop: `1px solid ${C.faint}30` }}>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={async () => {
                  if (!selectedLyricText) return;
                  try { await navigator.clipboard.writeText(selectedLyricText); addToast('已复制', 'success'); }
                  catch { addToast('复制失败', 'error'); }
                }}
                disabled={selectedLyricIndices.size === 0}
                className="py-2.5 rounded-2xl text-[11px] font-bold flex items-center justify-center gap-1.5 active:scale-95 transition-transform disabled:opacity-40"
                style={{ background: 'rgba(255,255,255,0.6)', color: C.primary, border: `1px solid ${C.faint}40` }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" /></svg>
                复制 {selectedLyricIndices.size > 0 ? `(${selectedLyricIndices.size})` : ''}
              </button>
              <button
                onClick={() => setLyricShareOpen(true)}
                disabled={selectedLyricIndices.size === 0}
                className="py-2.5 rounded-2xl text-[11px] font-bold flex items-center justify-center gap-1.5 active:scale-95 transition-transform text-white disabled:opacity-40"
                style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-8-5.3-8-11.5C4 6 6.5 3.5 9.5 3.5c1.6 0 3 .8 2.5 2.2C11.5 4.3 12.9 3.5 14.5 3.5 17.5 3.5 20 6 20 9.5 20 15.7 12 21 12 21z" /></svg>
                分享给角色
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 歌词分享 · 角色选择 + 附言（仿分享歌曲界面） */}
      {lyricShareOpen && selectedLyricText && (
        <div className="fixed inset-0 z-[61] flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => setLyricShareOpen(false)} />
          <div className="relative w-full rounded-t-3xl px-4 pt-3 pb-6 animate-slide-up shizuku-glass-strong"
            style={{ background: C.bg, maxHeight: '75vh' }} onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full mx-auto mb-3" style={{ background: C.faint }} />
            <div className="text-[10px] tracking-[0.2em] uppercase mb-2" style={{ color: C.muted }}>分享歌词给角色</div>
            {/* 歌词预览（小卡片，让用户确认分享内容） */}
            <div className="rounded-2xl p-2.5 mb-3 max-h-24 overflow-y-auto shizuku-scrollbar"
              style={{ background: 'rgba(255,255,255,0.5)', fontFamily: `'Noto Serif','Georgia',serif` }}>
              <div className="text-[9px] tracking-wider mb-1" style={{ color: C.muted }}>
                {current?.name || '这首歌'}{current?.artists ? ` · ${current.artists}` : ''}
              </div>
              <p className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: C.text }}>{selectedLyricText}</p>
            </div>
            {/* 选角色 —— 头像横排（跟分享歌曲同一个样式） */}
            {characters.length === 0 ? (
              <div className="text-center text-[11px] py-4" style={{ color: C.faint }}>还没有角色，先去创建一个吧</div>
            ) : (
              <div className="flex items-center gap-2 overflow-x-auto pb-2 shizuku-scrollbar">
                {characters.map(c => {
                  const selected = lyricShareCharId === c.id;
                  return (
                    <button key={c.id}
                      onClick={() => setLyricShareCharId(c.id)}
                      className="shrink-0 text-center"
                    >
                      <div className="w-12 h-12 mx-auto rounded-full flex items-center justify-center text-white text-sm font-semibold transition-all"
                        style={{
                          background: selected ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : `linear-gradient(135deg, ${C.faint}, ${C.muted})`,
                          border: selected ? `2px solid ${C.glow}` : '2px solid transparent',
                          boxShadow: selected ? `0 2px 12px ${C.glow}40` : 'none',
                        }}>
                        {c.avatar?.startsWith('data:') || c.avatar?.startsWith('http')
                          ? <img src={c.avatar} alt="" className="w-full h-full rounded-full object-cover" />
                          : c.name.slice(0, 1)}
                      </div>
                      <div className="text-[9px] mt-1 max-w-[52px] truncate" style={{ color: selected ? C.primary : C.muted }}>{c.name}</div>
                    </button>
                  );
                })}
              </div>
            )}
            {/* 附言 */}
            <textarea
              value={lyricShareNote}
              onChange={e => setLyricShareNote(e.target.value)}
              placeholder="写一句想说的话（可选）…"
              rows={2}
              className="w-full px-3 py-2 rounded-xl text-[12px] outline-none resize-none mt-2"
              style={{ background: '#fff', border: `1px solid ${C.faint}40`, color: C.text }}
            />
            <button
              onClick={shareLyricToChar}
              disabled={!lyricShareCharId}
              className="w-full py-2.5 rounded-xl text-xs text-white flex items-center justify-center gap-1.5 disabled:opacity-40 transition-all active:scale-[0.99] mt-2"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-8-5.3-8-11.5C4 6 6.5 3.5 9.5 3.5c1.6 0 3 .8 2.5 2.2C11.5 4.3 12.9 3.5 14.5 3.5 17.5 3.5 20 6 20 9.5 20 15.7 12 21 12 21z" /></svg>
              分享给 {lyricShareCharId ? characters.find(x => x.id === lyricShareCharId)?.name || '' : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MusicApp;
