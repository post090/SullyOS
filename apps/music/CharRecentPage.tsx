/**
 * 角色「最近常听」全屏歌单页 — 网易云式：拜访页只露前 10 条，
 * 底部「播放全部」进到这里，看全量 + 一键整单播放。
 */
import React, { useMemo } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, Song } from '../../context/MusicContext';
import { CharMusicProfile } from '../../types';
import { C, Sparkle, MizuHeader, BokehBg, MiniPlayer, gradientFor } from './MusicUI';
import { MusicNote, Play as PlayIcon, ChatCircleDots } from '@phosphor-icons/react';

interface Props {
  charId: string;
  charName: string;
  onBack: () => void;
  onOpenPlayer: () => void;
  onOpenComments?: (song: Song) => void;
}

const CharRecentPage: React.FC<Props> = ({ charId, charName, onBack, onOpenPlayer, onOpenComments }) => {
  const { characters } = useOS();
  const { playSong, current, playing, togglePlay, nextSong, prevSong } = useMusic();

  const recent = useMemo(() => {
    const profile = characters.find(c => c.id === charId)?.musicProfile as CharMusicProfile | undefined;
    return (profile?.recentPlays || []).slice().sort((a, b) => b.at - a.at);
  }, [characters, charId]);

  const songs = recent.map(r => r.song);
  const playAll = () => {
    if (!songs.length) return;
    playSong(songs[0], { replaceQueue: songs, startIdx: 0 });
    onOpenPlayer();
  };

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader title={`${charName} 的最近常听`} onBack={onBack} />

      <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar pb-20 px-3">
        {/* 全单播放 */}
        <button
          onClick={playAll}
          className="w-full mt-1 mb-2 py-2.5 rounded-2xl flex items-center justify-center gap-2 text-xs text-white transition-all active:scale-[0.99] relative overflow-hidden"
          style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
        >
          <PlayIcon size={14} weight="fill" />
          播放全部 · {songs.length} 首
        </button>

        <div className="space-y-1">
          {songs.map((s, i) => {
            const active = current?.id === s.id;
            return (
              <div key={`${s.id}-${i}`}
                className="flex items-center gap-2 rounded-xl transition-colors"
                style={{ background: active ? 'rgba(255,255,255,0.55)' : undefined }}>
                <button
                  onClick={() => playSong(s, { replaceQueue: songs, startIdx: i })}
                  className="flex-1 flex items-center gap-2.5 min-w-0 text-left px-2 py-1.5"
                >
                  <span className="text-[9px] w-5 shrink-0 text-center tabular-nums"
                    style={{ color: active ? C.primary : C.faint }}>
                    {active ? '▶' : i + 1}
                  </span>
                  {s.albumPic ? (
                    <img src={s.albumPic} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0"
                      style={{ border: `1px solid ${C.faint}25` }} />
                  ) : (
                    <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center"
                      style={{ background: gradientFor('gradient-02') }}>
                      <MusicNote size={14} weight="bold" color="white" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] truncate" style={{ color: active ? C.primary : C.text, fontWeight: active ? 600 : 400 }}>
                      {s.name}
                    </div>
                    <div className="text-[9.5px] truncate mt-0.5" style={{ color: C.muted }}>
                      {s.artists}{s.album ? ` · ${s.album}` : ''}
                    </div>
                  </div>
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
            );
          })}
          {songs.length === 0 && (
            <div className="text-center text-[11px] py-12" style={{ color: C.faint }}>
              <Sparkle size={14} className="mx-auto mb-2" color={C.glow} delay={0} />
              还没有常听记录
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
    </div>
  );
};

export default CharRecentPage;
