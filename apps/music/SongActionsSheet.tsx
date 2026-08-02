/**
 * 歌曲半屏操作菜单 — 网易云式 bottom sheet。
 * 从歌单/搜索/专辑等任意歌曲行打开，集中承载：
 *   下一首播放 / 添加到播放列表 / 收藏到歌单(角色+网易云) / 看评论 / 看歌手 / 看专辑 / 分享给角色
 * 自包含：播放队列、角色歌单、网易云歌单、分享(写聊天消息)都在这里完成，
 * 外部只需传 song + 路由回调（评论/歌手/专辑页）。
 */
import React, { useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, Song, toHttps } from '../../context/MusicContext';
import { DB } from '../../utils/db';
import { toCharPlaylistSong } from '../../utils/charPlaylistFill';
import { AlbumSource } from './AlbumDetailPage';
import { C, gradientFor } from './MusicUI';
import {
  Play as PlayIcon, Plus, Heart, ChatCircleDots, User as UserIcon, Disc,
  ShareNetwork, X, CaretLeft, MusicNote, Check, PaperPlaneTilt,
} from '@phosphor-icons/react';

type Stage = 'main' | 'collect' | 'share';

interface Props {
  song: Song;
  onClose: () => void;
  onOpenComments: (song: Song) => void;
  onOpenArtist?: (id: number, name: string) => void;
  onOpenAlbum?: (album: AlbumSource) => void;
}

/** 网易云歌单（懒加载用） */
interface NeteasePl {
  id: number;
  name: string;
  trackCount: number;
  coverImgUrl: string;
}

const MenuRow: React.FC<{
  icon: React.ReactNode;
  label: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  hint?: string;
}> = ({ icon, label, onClick, danger, hint }) => (
  <button
    onClick={onClick}
    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors hover:bg-black/5 active:scale-[0.99]"
    style={{ color: danger ? '#c14d5d' : C.text }}
  >
    <span className="shrink-0 flex items-center justify-center w-5" style={{ color: danger ? '#c14d5d' : C.primary }}>
      {icon}
    </span>
    <span className="text-[13px] flex-1 min-w-0 truncate">{label}</span>
    {hint && <span className="text-[9px] shrink-0" style={{ color: C.faint }}>{hint}</span>}
  </button>
);

const SongActionsSheet: React.FC<Props> = ({ song, onClose, onOpenComments, onOpenArtist, onOpenAlbum }) => {
  const { characters, updateCharacter, addToast } = useOS();
  const { cfg, queue, setQueue, idx, profile } = useMusic();

  const [stage, setStage] = useState<Stage>('main');
  const [collectMode, setCollectMode] = useState<'char' | 'netease'>('char');
  // 网易云歌单懒加载
  const [neteasePls, setNeteasePls] = useState<NeteasePl[] | null>(null);
  const [plLoading, setPlLoading] = useState(false);
  // 分享
  const [shareCharId, setShareCharId] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState('');

  // 打开时把初始分享角色置为第一个有音乐角落的角色
  useEffect(() => {
    if (stage === 'share' && !shareCharId) {
      const first = characters.find(c => c.musicProfile?.initializedAt) || characters[0];
      if (first) setShareCharId(first.id);
    }
  }, [stage, shareCharId, characters]);

  // 进入收藏页 + 切到「我的歌单」时自动加载网易云歌单（不用手动点）
  useEffect(() => {
    if (stage === 'collect' && collectMode === 'netease' && !neteasePls && !plLoading && profile?.userId) {
      loadNeteasePls();
    }
  }, [stage, collectMode, neteasePls, plLoading, profile?.userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const char = (id: string) => characters.find(c => c.id === id);

  // ── 播放队列 ──
  const playNext = () => {
    if (queue.some(s => s.id === song.id)) { addToast('已经在播放列表里了', 'info'); onClose(); return; }
    const pos = (idx >= 0 ? idx : -1) + 1;
    setQueue(prev => {
      const next = [...prev];
      next.splice(pos, 0, song);
      return next;
    });
    addToast('已插入下一首播放', 'success');
    onClose();
  };
  const addToQueueTail = () => {
    if (queue.some(s => s.id === song.id)) { addToast('已经在播放列表里了', 'info'); onClose(); return; }
    setQueue(prev => [...prev, song]);
    addToast('已添加到播放列表', 'success');
    onClose();
  };

  // ── 收藏到角色歌单 ──
  const collectToChar = (charId: string, playlistId: string) => {
    const c = char(charId);
    const profile = c?.musicProfile;
    const pl = profile?.playlists.find(p => p.id === playlistId);
    if (!c || !profile || !pl) return;
    if (pl.songs.some(s => s.id === song.id)) { addToast(`《${pl.title}》里已经有这首歌了`, 'info'); return; }
    const newPl = { ...pl, songs: [...pl.songs, toCharPlaylistSong(song, 'user')], updatedAt: Date.now() };
    updateCharacter(c.id, {
      musicProfile: {
        ...profile,
        playlists: profile.playlists.map(p => p.id === playlistId ? newPl : p),
        updatedAt: Date.now(),
      },
    });
    addToast(`已收藏到 ${c.name} 的歌单《${pl.title}》`, 'success');
    onClose();
  };

  // ── 收藏到网易云歌单 ──
  const loadNeteasePls = async () => {
    if (neteasePls || plLoading) return;
    setPlLoading(true);
    try {
      if (!profile?.userId) { addToast('未登录网易云，无法收藏到云歌单', 'info'); return; }
      const r: any = await musicApi.userPlaylist(cfg, profile.userId);
      // 只列出自己创建的歌单 —— 收藏的别人歌单不能往里加歌，藏起来免得误点报错
      const list: NeteasePl[] = (r?.playlist || [])
        .filter((p: any) => {
          const creatorId = p.creator?.userId ?? p.userId;
          return creatorId === profile.userId;
        })
        .map((p: any) => ({
          id: p.id, name: p.name, trackCount: p.trackCount || 0,
          coverImgUrl: toHttps(p.coverImgUrl || p.picUrl || ''),
        }));
      setNeteasePls(list);
      if (list.length === 0) addToast('没有可以收藏的自建歌单', 'info');
    } catch (e: any) {
      addToast(`获取网易云歌单失败：${e.message || '未知错误'}`, 'error');
    } finally {
      setPlLoading(false);
    }
  };
  const collectToNetease = async (plId: number) => {
    try {
      await musicApi.playlistAdd(cfg, plId, [song.id]);
      addToast('已收藏到网易云歌单', 'success');
    } catch (e: any) {
      addToast(`收藏失败：${e.message || '未知错误'}`, 'error');
    }
    onClose();
  };

  // ── 分享给角色（写入 ta 的聊天窗）──
  const shareToChar = async () => {
    if (!shareCharId) return;
    const c = char(shareCharId);
    if (!c) return;
    const line = shareNote.trim() || `分享给你一首歌：${song.name} — ${song.artists}`;
    try {
      await DB.saveMessage({
        charId: shareCharId,
        role: 'user',
        type: 'music_card',
        content: line,
        metadata: {
          song: {
            id: song.id, name: song.name, artists: song.artists,
            album: song.album, albumPic: song.albumPic, duration: song.duration,
          },
          intent: 'share',
        },
      });
      window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId: shareCharId } }));
      addToast(`已把这首歌分享给 ${c.name}`, 'success');
    } catch (e: any) {
      addToast(`分享失败：${e.message || '未知错误'}`, 'error');
    }
    onClose();
  };

  const artistNames = (song.artists || '').split(' / ').map(s => s.trim()).filter(Boolean);
  const backToMain = () => setStage('main');

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={onClose} />
      <div
        className="relative w-full rounded-t-3xl shizuku-glass-strong px-4 pt-3 pb-6 animate-slide-up"
        style={{ background: C.bg, maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* 拖拽把手 */}
        <div className="w-10 h-1 rounded-full mx-auto mb-2" style={{ background: C.faint }} />

        {/* 标题行 */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1">
            {stage !== 'main' && (
              <button onClick={backToMain} className="p-1.5 rounded-full hover:bg-black/5" title="返回">
                <CaretLeft size={16} weight="bold" style={{ color: C.muted }} />
              </button>
            )}
            <span className="text-[11px] tracking-[0.2em] uppercase" style={{ color: C.muted }}>
              {stage === 'main' ? '歌曲操作' : stage === 'collect' ? '收藏到歌单' : '分享给角色'}
            </span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-black/5">
            <X size={16} weight="bold" style={{ color: C.muted }} />
          </button>
        </div>

        {/* 歌曲信息头 */}
        <div className="flex items-center gap-3 rounded-2xl p-2 mb-2" style={{ background: 'rgba(255,255,255,0.6)' }}>
          {song.albumPic ? (
            <img src={toHttps(song.albumPic)} alt="" className="w-11 h-11 rounded-xl object-cover shrink-0" />
          ) : (
            <div className="w-11 h-11 rounded-xl shrink-0 flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, color: 'white' }}>
              <MusicNote size={18} weight="bold" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate" style={{ color: C.text }}>{song.name}</div>
            <div className="text-[10px] truncate" style={{ color: C.muted }}>
              {song.artists}{song.album ? ` · ${song.album}` : ''}
            </div>
          </div>
        </div>

        {/* 滚动内容区 */}
        <div className="overflow-y-auto shizuku-scrollbar -mx-1 px-1">
          {stage === 'main' && (
            <div className="space-y-0.5 pb-1">
              <MenuRow icon={<PlayIcon size={14} weight="fill" />} label="下一首播放" onClick={playNext} />
              <MenuRow icon={<Plus size={14} weight="bold" />} label="添加到播放列表" onClick={addToQueueTail} />
              <MenuRow
                icon={<Heart size={14} weight="fill" />}
                label="收藏到歌单"
                onClick={() => setStage('collect')}
              />
              <MenuRow
                icon={<ShareNetwork size={14} weight="fill" />}
                label="分享给角色"
                onClick={() => setStage('share')}
              />
              <div className="my-1" style={{ borderTop: `1px solid ${C.faint}30` }} />
              {onOpenComments && (
                <MenuRow
                  icon={<ChatCircleDots size={14} weight="fill" />}
                  label="看评论"
                  onClick={() => { onClose(); onOpenComments(song); }}
                />
              )}
              {/* 歌手：多歌手每行一个 */}
              {onOpenArtist && song.artistIds && song.artistIds.length > 0 && artistNames.length === song.artistIds.length && (
                song.artistIds.map((id, i) => (
                  <MenuRow
                    key={id}
                    icon={<UserIcon size={14} weight="fill" />}
                    label={`歌手：${artistNames[i]}`}
                    onClick={() => { onClose(); onOpenArtist(id, artistNames[i]); }}
                  />
                ))
              )}
              {onOpenAlbum && song.albumId && (
                <MenuRow
                  icon={<Disc size={14} weight="fill" />}
                  label={`专辑：${song.album}`}
                  onClick={() => {
                    onClose();
                    onOpenAlbum({ id: song.albumId!, name: song.album, coverImgUrl: song.albumPic, artistName: song.artists });
                  }}
                />
              )}
            </div>
          )}

          {stage === 'collect' && (
            <div className="space-y-1 pb-1">
              {/* 顶部切换：角色歌单 / 我的歌单 */}
              <div className="flex items-center gap-1 shizuku-glass rounded-full p-1 mb-2">
                {([['char', '角色歌单'], ['netease', '我的歌单']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setCollectMode(k)}
                    className="flex-1 py-1.5 rounded-full text-[11px] tracking-wider transition-all"
                    style={{
                      background: collectMode === k ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : 'transparent',
                      color: collectMode === k ? 'white' : C.muted,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {collectMode === 'char' ? (
                characters.length === 0 ? (
                  <div className="text-center text-[11px] py-6" style={{ color: C.faint }}>还没有角色</div>
                ) : (
                  <div className="space-y-2">
                    {characters.map(c => {
                      const pls = c.musicProfile?.playlists || [];
                      if (pls.length === 0) return null;
                      return pls.map(pl => (
                        <div key={`${c.id}-${pl.id}`} className="rounded-2xl shizuku-glass overflow-hidden">
                          <button
                            onClick={() => collectToChar(c.id, pl.id)}
                            className="w-full flex items-center gap-3 p-2.5 text-left active:scale-[0.99] transition-transform"
                          >
                            {/* 歌单封面 —— 跟角色主页一致：有首歌封面用封面，否则用渐变+音符 */}
                            {pl.songs[0]?.albumPic ? (
                              <img src={toHttps(pl.songs[0].albumPic)} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0"
                                style={{ border: `1px solid ${C.faint}30` }} />
                            ) : (
                              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white shrink-0"
                                style={{ background: gradientFor(pl.coverStyle) }}>
                                <MusicNote size={18} weight="bold" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm truncate" style={{ color: C.text }}>{pl.title}</div>
                              <div className="text-[10px] truncate" style={{ color: C.muted }}>
                                {c.name} · {pl.songs.length} 首
                              </div>
                            </div>
                            <div className="text-[10px] shrink-0" style={{ color: C.accent }}>›</div>
                          </button>
                        </div>
                      ));
                    })}
                  </div>
                )
              ) : (
                <div className="space-y-2">
                  {(neteasePls || []).length === 0 && !plLoading && (
                    <div className="text-center text-[11px] py-6" style={{ color: C.faint }}>
                      {profile?.userId ? '没有找到歌单' : '未登录网易云'}
                    </div>
                  )}
                  {plLoading && (
                    <div className="text-center text-[11px] py-6" style={{ color: C.muted }}>
                      <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin align-middle mr-1"
                        style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
                      加载中…
                    </div>
                  )}
                  {(neteasePls || []).map(pl => (
                    <div key={pl.id} className="rounded-2xl shizuku-glass overflow-hidden">
                      <button
                        onClick={() => collectToNetease(pl.id)}
                        className="w-full flex items-center gap-3 p-2.5 text-left active:scale-[0.99] transition-transform"
                      >
                        {pl.coverImgUrl ? (
                          <img src={pl.coverImgUrl} alt="" className="w-12 h-12 rounded-xl object-cover"
                            style={{ border: `1px solid ${C.faint}30` }} />
                        ) : (
                          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white shrink-0"
                            style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}>
                            <Heart size={18} weight="fill" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate" style={{ color: C.text }}>{pl.name}</div>
                          <div className="text-[10px] truncate" style={{ color: C.muted }}>{pl.trackCount} 首</div>
                        </div>
                        <div className="text-[10px] shrink-0" style={{ color: C.accent }}>›</div>
                      </button>
                    </div>
                  ))}
                  {(neteasePls || []).length > 0 && (
                    <button
                      onClick={() => { setNeteasePls(null); loadNeteasePls(); }}
                      className="w-full py-1.5 rounded-lg text-[10px] mt-1"
                      style={{ color: C.faint, border: `1px dashed ${C.faint}40` }}
                    >刷新</button>
                  )}
                </div>
              )}
            </div>
          )}

          {stage === 'share' && (
            <div className="space-y-2 pb-1">
              {/* 选角色 */}
              {characters.length === 0 ? (
                <div className="text-center text-[11px] py-6" style={{ color: C.faint }}>还没有角色可以分享</div>
              ) : (
                <div className="flex items-center gap-2 overflow-x-auto pb-1 shizuku-scrollbar">
                  {characters.map(c => (
                    <button
                      key={c.id}
                      onClick={() => setShareCharId(c.id)}
                      className="shrink-0 text-center"
                    >
                      <div
                        className="w-12 h-12 mx-auto rounded-full flex items-center justify-center text-white text-sm font-semibold transition-all"
                        style={{
                          background: shareCharId === c.id
                            ? `linear-gradient(135deg, ${C.primary}, ${C.accent})`
                            : `linear-gradient(135deg, ${C.faint}, ${C.muted})`,
                          border: shareCharId === c.id ? `2px solid ${C.glow}` : '2px solid transparent',
                          boxShadow: shareCharId === c.id ? `0 2px 12px ${C.glow}40` : 'none',
                        }}
                      >
                        {c.avatar?.startsWith('data:') || c.avatar?.startsWith('http') ? (
                          <img src={c.avatar} alt="" className="w-full h-full rounded-full object-cover" />
                        ) : (
                          c.name.slice(0, 1)
                        )}
                      </div>
                      <div className="text-[9px] mt-1 max-w-[52px] truncate" style={{ color: shareCharId === c.id ? C.primary : C.muted }}>
                        {c.name}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {/* 附言 */}
              <textarea
                value={shareNote}
                onChange={e => setShareNote(e.target.value)}
                placeholder="写一句想说的话（可选）…"
                rows={2}
                className="w-full px-3 py-2 rounded-xl text-[12px] outline-none resize-none"
                style={{ background: '#fff', border: `1px solid ${C.faint}40`, color: C.text }}
              />
              <button
                onClick={shareToChar}
                disabled={!shareCharId}
                className="w-full py-2.5 rounded-xl text-xs text-white flex items-center justify-center gap-1.5 disabled:opacity-40 transition-all active:scale-[0.99]"
                style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
              >
                <PaperPlaneTilt size={13} weight="fill" />
                分享给 {shareCharId ? char(shareCharId)?.name || '' : ''}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SongActionsSheet;
