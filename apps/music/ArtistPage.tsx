/**
 * 歌手页 — 网易云风格：头像 + 名字 + 简介 + 热门歌曲 + 专辑墙。
 * 按歌手 id 进入（一首歌多个歌手时各自成页），数据 /artists + /artist/songs + /artist/album 并发拉取。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, toHttps, Song } from '../../context/MusicContext';
import { C, Sparkle, MizuHeader, BokehBg, MiniPlayer, ArtistLinks } from './MusicUI';
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

const ArtistPage: React.FC<Props> = ({ artistId, artistName, onBack, onOpenPlayer, onOpenAlbum, onOpenArtist, onOpenComments }) => {
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
  const [albums, setAlbums] = useState<AlbumSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [descExpanded, setDescExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHotSongs([]);
    setAlbums([]);
    setAvatar('');
    setBriefDesc('');
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

  const descLimit = 60;
  const descLong = briefDesc.length > descLimit;
  const sizeLabel = useMemo(() => {
    if (musicSize == null) return null;
    return `${musicSize} 首歌${albumSize != null ? ` · ${albumSize} 张专辑` : ''}`;
  }, [musicSize, albumSize]);

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
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className="text-[9px] px-2 py-0.5 rounded-full shizuku-glass" style={{ color: C.primary }}>
                  {hotSongs.length} 首热门
                </span>
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

        {/* 热门歌曲 */}
        <div className="px-4 mt-4">
          <div className="flex items-center gap-2 mb-1.5 px-1">
            <span className="text-[10px] tracking-[0.2em] uppercase font-semibold" style={{ color: C.muted }}>
              热门歌曲
            </span>
            {hotSongs.length > 0 && (
              <button
                onClick={playAll}
                className="ml-auto px-2.5 py-1 rounded-full text-[10px] text-white flex items-center gap-1 transition-all active:scale-95"
                style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 2px 8px ${C.glow}30` }}
              >
                <Play size={9} weight="fill" /> 播放
              </button>
            )}
          </div>
          <div className="space-y-0.5">
            {hotSongs.map((s, i) => {
              const active = current?.id === s.id;
              return (
                <div key={s.id} className="rounded-xl"
                  style={{ background: active ? 'rgba(255,255,255,0.55)' : undefined }}>
                  <div className="flex items-center gap-1 px-2 pt-1.5">
                    <button
                      onClick={() => playAt(s)}
                      className="flex-1 flex items-center gap-2.5 min-w-0 text-left"
                    >
                      <span className="text-[9px] w-6 text-center shrink-0 tabular-nums"
                        style={{ color: active ? C.primary : C.faint }}>
                        {active ? '▶' : i + 1}
                      </span>
                      <img src={s.albumPic} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0"
                        style={{ border: `1px solid ${C.faint}25` }} />
                      <span className="text-[12px] truncate"
                        style={{ color: active ? C.primary : C.text, fontWeight: active ? 600 : 400 }}>
                        {s.name}
                      </span>
                      {s.fee === 1 && (
                        <span className="text-[8px] px-1 rounded shrink-0" style={{ color: C.vip, border: `1px solid ${C.vip}50` }}>VIP</span>
                      )}
                      <span className="text-[9px] shrink-0 tabular-nums ml-auto" style={{ color: C.faint }}>{fmtTime(s.duration)}</span>
                    </button>
                    {onOpenComments && (
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
                  <div className="pl-[88px] pr-2 pb-1.5 -mt-0.5">
                    <ArtistLinks
                      artists={s.artists}
                      artistIds={s.artistIds}
                      onOpenArtist={onOpenArtist}
                      style={{ fontSize: '9.5px' }}
                    />
                  </div>
                </div>
              );
            })}
            {loading && (
              <div className="text-center text-[10px] py-4" style={{ color: C.faint }}>
                <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin align-middle"
                  style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
                <span className="ml-2 align-middle">加载歌手资料中…</span>
              </div>
            )}
          </div>
        </div>

        {/* 专辑墙 */}
        {albums.length > 0 && (
          <div className="px-4 mt-4">
            <div className="flex items-center gap-2 mb-1.5 px-1">
              <span className="text-[10px] tracking-[0.2em] uppercase font-semibold" style={{ color: C.muted }}>
                专辑
              </span>
            </div>
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
