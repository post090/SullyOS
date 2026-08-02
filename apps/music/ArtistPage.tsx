/**
 * 歌手页 — 网易云风格：头像 + 名字 + 简介 + 歌曲/专辑页签。
 * 热门歌曲用 SongRow 统一样式；超 50 首底部有「播放全部」→ 全屏纯歌单。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, toHttps, Song } from '../../context/MusicContext';
import { C, Sparkle, MizuHeader, BokehBg, MiniPlayer, SongRow } from './MusicUI';
import { Play, ChatCircleDots } from '@phosphor-icons/react';
import type { AlbumSource } from './AlbumDetailPage';

/** 歌手入口（点击歌手名时带上 id + 名字即可） */
export interface ArtistSource {
  id: number;
  name: string;
}

interface Props {
  artistId: number;
  artistName: string;
  onBack: () => void;
  onOpenPlayer: () => void;
  onOpenAlbum: (album: AlbumSource) => void;
  onOpenArtist: (id: number, name: string) => void;
  onOpenComments?: (song: Song) => void;
  onMore?: (song: Song) => void;
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
  artistIds: (s.ar || []).map((a: any) => a.id),
  album: s.al?.name || '',
  albumId: s.al?.id,
  albumPic: toHttps(s.al?.picUrl || ''),
  duration: (s.dt || 0) / 1000,
  fee: s.fee ?? 0,
});

const mapAlbum = (a: any): AlbumSource => ({
  id: a.id,
  name: a.name,
  coverImgUrl: toHttps(a.picUrl || a.coverImgUrl || ''),
  artistName: a.artist?.name,
  artistId: a.artist?.id,
  trackCount: a.size,
});

const ArtistPage: React.FC<Props> = ({ artistId, artistName, onBack, onOpenPlayer, onOpenAlbum, onOpenArtist, onOpenComments, onMore }) => {
  const { addToast } = useOS();
  const { cfg, playSong, current, playing, togglePlay, nextSong, prevSong } = useMusic();
  const toastRef = useRef(addToast);
  toastRef.current = addToast;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const [avatar, setAvatar] = useState('');
  const [briefDesc, setBriefDesc] = useState('');
  const [musicSize, setMusicSize] = useState<number | null>(null);
  const [albumSize, setAlbumSize] = useState<number | null>(null);
  const [hotSongs, setHotSongs] = useState<Song[]>([]);
  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [albums, setAlbums] = useState<AlbumSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [descExpanded, setDescExpanded] = useState(false);
  const [tab, setTab] = useState<'songs' | 'albums'>('songs');
  const [showAllSongs, setShowAllSongs] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHotSongs([]);
    setAllSongs([]);
    setAlbums([]);
    setAvatar('');
    setBriefDesc('');
    setShowAllSongs(false);
    setTab('songs');
    (async () => {
      const [infoR, songsR, albumsR] = await Promise.allSettled([
        musicApi.artist(cfgRef.current, artistId),
        musicApi.artistSongs(cfgRef.current, artistId, 50),
        musicApi.artistAlbums(cfgRef.current, artistId, 30),
      ]);
      if (cancelled) return;
      if (infoR.status === 'fulfilled') {
        const ar = infoR.value?.artist || {};
        setAvatar(toHttps(ar.picUrl || ar.img1v1Url || ar.avatarUrl || ''));
        setBriefDesc(ar.briefDesc || ar.description || '');
        setMusicSize(ar.musicSize ?? null);
        setAlbumSize(ar.albumSize ?? null);
      }
      if (songsR.status === 'fulfilled') {
        // /artist/songs 或 /artist 都可能带热门曲目，兼容两种形状
        const list = songsR.value?.songs || songsR.value?.hotSongs || [];
        if (Array.isArray(list)) setHotSongs(list.map(mapTrack));
      }
      if (albumsR.status === 'fulfilled') {
        const list = albumsR.value?.hotAlbums || albumsR.value?.albums || [];
        if (Array.isArray(list)) setAlbums(list.map(mapAlbum));
      }
      if (cancelled) return;
      if (infoR.status === 'rejected' && songsR.status === 'rejected' && albumsR.status === 'rejected') {
        toastRef.current(`加载歌手失败：${infoR.reason?.message || ''}`, 'error');
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [artistId]); // eslint-disable-line react-hooks/exhaustive-deps

  const playAt = useCallback((song: Song) => {
    const startIdx = hotSongs.findIndex(s => s.id === song.id);
    playSong(song, { replaceQueue: hotSongs, startIdx: startIdx >= 0 ? startIdx : 0 });
    onOpenPlayer();
  }, [hotSongs, playSong, onOpenPlayer]);

  const playAll = useCallback(() => {
    if (!hotSongs.length) return;
    playSong(hotSongs[0], { replaceQueue: hotSongs, startIdx: 0 });
    onOpenPlayer();
  }, [hotSongs, playSong, onOpenPlayer]);

  // 加载全部歌曲（分页拉取直到拉完或到 10000 上限）
  const loadAllSongs = useCallback(async () => {
    if (allSongs.length > 0) { setShowAllSongs(true); return; }
    setLoadingAll(true);
    try {
      const PAGE = 100;
      const HARD_CAP = 10000;
      const collected: Song[] = [];
      let offset = 0;
      // 分页循环：每页 100，直到某页不满（到尾）或达上限
      while (offset < HARD_CAP) {
        const r = await musicApi.artistSongs(cfgRef.current, artistId, PAGE, offset);
        const list = r?.songs || r?.hotSongs || [];
        if (!Array.isArray(list) || list.length === 0) break;
        collected.push(...list.map(mapTrack));
        offset += list.length;
        if (list.length < PAGE) break; // 最后一页
      }
      // 硬上限截断（防止异常接口返回过多）
      setAllSongs(collected.slice(0, HARD_CAP));
      setShowAllSongs(true);
    } catch (e: any) {
      toastRef.current(`加载全部歌曲失败：${e?.message || ''}`, 'error');
    } finally {
      setLoadingAll(false);
    }
  }, [artistId, allSongs.length]);

  // 全屏歌单页：播放全部
  const playAllFromFull = useCallback(() => {
    if (!allSongs.length) return;
    playSong(allSongs[0], { replaceQueue: allSongs, startIdx: 0 });
    onOpenPlayer();
  }, [allSongs, playSong, onOpenPlayer]);

  const descLimit = 60;
  const descLong = briefDesc.length > descLimit;
  const sizeLabel = useMemo(() => {
    if (musicSize == null) return null;
    return `${musicSize} 首歌${albumSize != null ? ` · ${albumSize} 张专辑` : ''}`;
  }, [musicSize, albumSize]);

  // ── 全屏纯歌单页（类似网易云，点「播放全部」进入） ──
  if (showAllSongs) {
    return (
      <div className="flex flex-col h-full relative"
        style={{ background: `linear-gradient(180deg, ${C.bg} 0%, ${C.bgDeep} 100%)` }}>
        <BokehBg />
        <MizuHeader title="All Songs" onBack={() => setShowAllSongs(false)} />
        <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar pb-24">
          {/* 播放全部条 */}
          <div className="px-4 py-3 flex items-center gap-3">
            <button
              onClick={playAllFromFull}
              className="px-4 py-2 rounded-2xl text-xs text-white flex items-center gap-1.5 transition-all active:scale-95"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 15px ${C.primary}30` }}
            >
              <Play size={11} weight="fill" /> 播放全部
            </button>
            <span className="text-[10px]" style={{ color: C.muted }}>共 {allSongs.length} 首</span>
            {loadingAll && (
              <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin ml-auto"
                style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
            )}
          </div>
          {/* 歌曲列表（SongRow 统一样式 + 序号） */}
          <div className="px-1">
            {allSongs.map((s, i) => (
              <SongRow
                key={s.id}
                index={i + 1}
                name={s.name}
                artists={s.artists}
                album={s.album}
                albumPic={s.albumPic}
                duration={fmtTime(s.duration)}
                isVip={s.fee === 1}
                isActive={current?.id === s.id}
                onClick={() => {
                  const startIdx = allSongs.findIndex(x => x.id === s.id);
                  playSong(s, { replaceQueue: allSongs, startIdx: startIdx >= 0 ? startIdx : 0 });
                  onOpenPlayer();
                }}
                onMore={onMore ? () => onMore(s) : undefined}
              />
            ))}
            {allSongs.length === 0 && !loadingAll && (
              <div className="text-center text-[10px] py-8" style={{ color: C.faint }}>暂无歌曲</div>
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
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader title="Artist" onBack={onBack} />

      <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar pb-24">
        {/* 头部 */}
        <div className="relative overflow-hidden">
          <div className="absolute inset-0"
            style={{ background: `linear-gradient(135deg, ${C.accent}30, ${C.sakura}25, ${C.lavender}30)` }} />
          <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, transparent 0%, ${C.bg}E8 100%)` }} />
          <div className="relative px-4 pt-6 pb-3.5 flex items-center gap-3.5">
            <div className="relative shrink-0">
              {avatar ? (
                <img src={avatar} alt=""
                  className="w-20 h-20 rounded-full object-cover"
                  style={{ border: `2px solid rgba(255,255,255,0.7)`, boxShadow: `0 6px 24px ${C.glow}40` }} />
              ) : (
                <div className="w-20 h-20 rounded-full flex items-center justify-center text-white text-2xl font-semibold"
                  style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, fontFamily: `'Noto Serif', serif` }}>
                  {artistName.slice(0, 1)}
                </div>
              )}
              <div className="absolute -bottom-1 -right-1"><Sparkle size={10} color={C.sakura} delay={0.3} /></div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-lg font-semibold truncate"
                style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
                {artistName}
              </div>
              <div className="text-[10px] mt-0.5 truncate" style={{ color: C.muted }}>
                {sizeLabel || '歌手'}
              </div>
            </div>
          </div>
        </div>

        {/* 简介 */}
        {briefDesc && (
          <div className="px-4 mt-2">
            <button
              onClick={() => descLong && setDescExpanded(v => !v)}
              className="w-full text-left text-[10px] leading-relaxed"
              style={{ color: C.muted, cursor: descLong ? 'pointer' : 'default' }}
            >
              <span style={{ whiteSpace: 'pre-wrap' }}>
                {descExpanded || !descLong ? briefDesc : `${briefDesc.slice(0, descLimit)}…`}
              </span>
              {descLong && <span className="ml-1" style={{ color: C.accent }}>{descExpanded ? '收起' : '展开'}</span>}
            </button>
          </div>
        )}

        {/* 页签：歌曲 / 专辑 */}
        <div className="px-4 mt-3 flex gap-2">
          <button
            onClick={() => setTab('songs')}
            className="px-3 py-1.5 rounded-full text-[11px] font-bold transition-all active:scale-95"
            style={tab === 'songs'
              ? { background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, color: 'white', boxShadow: `0 2px 8px ${C.glow}30` }
              : { background: 'rgba(255,255,255,0.4)', color: C.muted }}
          >
            歌曲{hotSongs.length > 0 ? ` ${hotSongs.length}` : ''}
          </button>
          <button
            onClick={() => setTab('albums')}
            className="px-3 py-1.5 rounded-full text-[11px] font-bold transition-all active:scale-95"
            style={tab === 'albums'
              ? { background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, color: 'white', boxShadow: `0 2px 8px ${C.glow}30` }
              : { background: 'rgba(255,255,255,0.4)', color: C.muted }}
          >
            专辑{albumSize != null ? ` ${albumSize}` : (albums.length > 0 ? ` ${albums.length}` : '')}
          </button>
        </div>

        {/* 歌曲 tab */}
        {tab === 'songs' && (
          <div className="mt-3">
            {/* 播放热门条 */}
            {hotSongs.length > 0 && (
              <div className="px-4 pb-2 flex items-center gap-2">
                <button
                  onClick={playAll}
                  className="px-3 py-1.5 rounded-2xl text-[11px] text-white flex items-center gap-1 transition-all active:scale-95"
                  style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 2px 8px ${C.glow}30` }}
                >
                  <Play size={10} weight="fill" /> 播放热门
                </button>
                <span className="text-[10px]" style={{ color: C.faint }}>前 {hotSongs.length} 首</span>
              </div>
            )}
            {/* 歌曲列表（SongRow 统一样式 + 序号） */}
            <div className="px-1">
              {hotSongs.map((s, i) => (
                <SongRow
                  key={s.id}
                  index={i + 1}
                  name={s.name}
                  artists={s.artists}
                  album={s.album}
                  albumPic={s.albumPic}
                  duration={fmtTime(s.duration)}
                  isVip={s.fee === 1}
                  isActive={current?.id === s.id}
                  onClick={() => playAt(s)}
                  onMore={onMore ? () => onMore(s) : undefined}
                />
              ))}
              {loading && (
                <div className="text-center text-[10px] py-4" style={{ color: C.faint }}>
                  <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin align-middle"
                    style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
                  <span className="ml-2 align-middle">加载歌手资料中…</span>
                </div>
              )}
            </div>
            {/* 超 50 首时底部「播放全部」按钮 → 全屏歌单页 */}
            {musicSize != null && musicSize > 50 && (
              <div className="px-4 mt-3 pb-4">
                <button
                  onClick={loadAllSongs}
                  disabled={loadingAll}
                  className="w-full py-2.5 rounded-2xl text-xs font-bold text-white flex items-center justify-center gap-1.5 transition-all active:scale-[0.98] disabled:opacity-50"
                  style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 15px ${C.primary}30` }}
                >
                  {loadingAll ? (
                    <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.3)', borderTopColor: 'white' }} />
                  ) : (
                    <><Play size={11} weight="fill" /> 播放全部 {musicSize} 首</>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 专辑 tab */}
        {tab === 'albums' && (
          <div className="px-4 mt-3">
            {albums.length > 0 ? (
              <div className="grid grid-cols-3 gap-2.5">
                {albums.map(a => (
                  <button
                    key={a.id}
                    onClick={() => onOpenAlbum(a)}
                    className="text-left group"
                  >
                    <div className="relative rounded-xl overflow-hidden"
                      style={{ boxShadow: `0 2px 12px ${C.glow}25` }}>
                      {a.coverImgUrl ? (
                        <img src={a.coverImgUrl} alt=""
                          className="w-full aspect-square object-cover transition-transform group-active:scale-95" />
                      ) : (
                        <div className="w-full aspect-square flex items-center justify-center"
                          style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}>
                          <Play size={18} weight="fill" color="white" />
                        </div>
                      )}
                      <div className="absolute -top-0.5 -right-0.5"><Sparkle size={7} color={C.glow} delay={0.4} /></div>
                    </div>
                    <div className="text-[10px] mt-1 leading-snug line-clamp-2" style={{ color: C.text }}>
                      {a.name}
                    </div>
                    <div className="text-[9px]" style={{ color: C.faint }}>{a.trackCount ?? ''}首</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center text-[10px] py-8" style={{ color: C.faint }}>
                {loading ? '加载专辑中…' : '暂无专辑'}
              </div>
            )}
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
    </div>
  );
};

export default ArtistPage;
