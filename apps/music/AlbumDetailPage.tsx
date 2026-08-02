/**
 * 专辑详情页 — 网易云风格：模糊封面打底 + 信息卡 + 整单播放 + 曲目列表。
 * 曲目里歌手名可点击 → 歌手页；多歌手按 ' / ' 逐个可点。
 * 数据走 /album，进页先上离线快照再静默同步最新（与歌单详情页同款 SWR）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, toHttps, Song } from '../../context/MusicContext';
import { C, Sparkle, MizuHeader, BokehBg, MiniPlayer, ArtistLinks } from './MusicUI';
import { Play, MusicNote, ChatCircleDots } from '@phosphor-icons/react';
import { neteaseCacheGet, neteaseCacheSet } from '../../utils/neteaseCache';

/** 专辑入口的轻量元信息（主页「专辑」/ 歌手页专辑墙传进来即可先渲染头部） */
export interface AlbumSource {
  id: number;
  name: string;
  coverImgUrl: string;
  artistName?: string;
  artistId?: number;
  trackCount?: number;
}

interface Props {
  album: AlbumSource;
  onBack: () => void;
  onOpenPlayer: () => void;
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

const AlbumDetailPage: React.FC<Props> = ({ album, onBack, onOpenPlayer, onOpenArtist, onOpenComments }) => {
  const { addToast } = useOS();
  const { cfg, playSong, current, playing, togglePlay, nextSong, prevSong } = useMusic();
  const toastRef = useRef(addToast);
  toastRef.current = addToast;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const [songs, setSongs] = useState<Song[]>([]);
  const [desc, setDesc] = useState('');
  const [publishTime, setPublishTime] = useState<number | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSongs([]);
    setDesc('');
    setFetching(true);
    setFromCache(false);
    const meta = album;
    // 元信息：描述 + 发行时间（不阻塞曲目，先快照后网络）
    neteaseCacheGet<{ desc: string; publishTime: number | null }>(`albmeta:${meta.id}`)
      .then(hit => { if (!cancelled && hit) setDesc(prev => prev || hit.data.desc); });
    (async () => {
      const hit = await neteaseCacheGet<Song[]>(`alb:${meta.id}`);
      if (cancelled) return;
      const hadCache = !!(hit && Array.isArray(hit.data) && hit.data.length);
      if (hadCache) {
        setSongs(hit!.data);
        setFromCache(true);
      }
      try {
        const r = await musicApi.album(cfgRef.current, meta.id);
        if (cancelled) return;
        const d = r?.album?.description || '';
        const pt = r?.album?.publishTime ? Number(r.album.publishTime) : null;
        setDesc(d);
        setPublishTime(pt);
        neteaseCacheSet(`albmeta:${meta.id}`, { desc: d, publishTime: pt });
        const list: Song[] = (r?.songs || []).map(mapTrack);
        if (list.length) {
          setSongs(list);
          setFromCache(false);
          neteaseCacheSet(`alb:${meta.id}`, list);
        }
      } catch (e: any) {
        if (!cancelled && !hadCache) toastRef.current(`加载专辑失败：${e.message}`, 'error');
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [album.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const year = useMemo(() => {
    if (!publishTime) return '';
    const d = new Date(publishTime);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }, [publishTime]);

  const descLimit = 48;
  const descLong = desc.length > descLimit;

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader title="Album" onBack={onBack} />

      <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar pb-24">
        {/* 头部：模糊封面打底 + 信息卡 */}
        <div className="relative overflow-hidden">
          {album.coverImgUrl && (
            <img src={album.coverImgUrl} alt="" aria-hidden
              className="absolute inset-0 w-full h-full object-cover"
              style={{ filter: 'blur(26px) saturate(1.2)', transform: 'scale(1.4)', opacity: 0.3 }} />
          )}
          <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, rgba(255,255,255,0.2) 0%, ${C.bg}E8 100%)` }} />
          <div className="relative px-4 pt-4 pb-3.5">
            <div className="flex gap-3.5">
              <div className="w-[88px] h-[88px] rounded-2xl shrink-0 overflow-hidden flex items-center justify-center relative"
                style={{ border: `1.5px solid rgba(255,255,255,0.6)`, boxShadow: `0 6px 24px ${C.glow}35` }}>
                {album.coverImgUrl ? (
                  <img src={album.coverImgUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <MusicNote size={30} weight="bold" color="white" />
                )}
                <div className="absolute -top-0.5 -right-0.5"><Sparkle size={9} color={C.glow} delay={0.3} /></div>
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-center">
                <div className="text-[15px] font-semibold leading-snug"
                  style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
                  {album.name}
                </div>
                <div className="text-[10px] mt-1 truncate" style={{ color: C.muted }}>
                  {album.artistName ? (
                    <ArtistLinks
                      artists={album.artistName}
                      artistIds={album.artistId != null ? [album.artistId] : undefined}
                      onOpenArtist={onOpenArtist}
                    />
                  ) : '未知歌手'}
                  {year ? ` · ${year}` : ''}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className="text-[9px] px-2 py-0.5 rounded-full shizuku-glass" style={{ color: C.primary }}>
                    {songs.length || album.trackCount || 0} 首
                  </span>
                  <span className="text-[9px] px-2 py-0.5 rounded-full" style={{ color: C.faint, border: `1px solid ${C.faint}30` }}>
                    专辑
                  </span>
                </div>
              </div>
            </div>

            {desc && (
              <button
                onClick={() => descLong && setDescExpanded(v => !v)}
                className="mt-2.5 w-full text-left text-[10px] leading-relaxed"
                style={{ color: C.muted, cursor: descLong ? 'pointer' : 'default' }}
              >
                <span style={{ whiteSpace: 'pre-wrap' }}>
                  {descExpanded || !descLong ? desc : `${desc.slice(0, descLimit)}…`}
                </span>
                {descLong && <span className="ml-1" style={{ color: C.accent }}>{descExpanded ? '收起' : '展开'}</span>}
              </button>
            )}

            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={playAll}
                disabled={!songs.length}
                className="px-3.5 py-1.5 rounded-full text-[11px] text-white flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-40"
                style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 2px 12px ${C.glow}40` }}
              >
                <Play size={11} weight="fill" /> 播放全部
              </button>
            </div>
          </div>
        </div>

        {/* 曲目列表 */}
        <div className="px-3 mt-2">
          {songs.map((s, i) => {
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
                    <img src={s.albumPic || album.coverImgUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0"
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

          {fetching && (
            <div className="text-center text-[10px] py-3" style={{ color: C.faint }}>
              <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin align-middle"
                style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
              <span className="ml-2 align-middle">
                {fromCache ? '已显示上次的曲目 · 正在同步最新…' : '加载专辑中…'}
              </span>
            </div>
          )}
          {!fetching && songs.length === 0 && (
            <div className="text-center text-[11px] py-10 italic" style={{ color: C.faint }}>这个专辑是空的</div>
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
};

export default AlbumDetailPage;
