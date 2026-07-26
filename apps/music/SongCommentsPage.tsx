/**
 * 单曲评论区（只读）— 拉网易云真实评论，shizuku 风格展示。
 * 走 /comment/music 接口：首页带 hotComments（热门），之后分页拉最新评论。
 * 纯浏览，不做点赞/回复等写操作，不影响真实账号。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, toHttps } from '../../context/MusicContext';
import { C, MizuHeader, BokehBg } from './MusicUI';
import { Heart, ChatCircleDots } from '@phosphor-icons/react';

interface Props {
  song: { id: number; name: string; artists: string; albumPic: string };
  onBack: () => void;
}

interface CommentItem {
  id: number;
  nickname: string;
  avatarUrl: string;
  content: string;
  time: number;
  likedCount: number;
  /** 被回复的楼层（引用块） */
  replied: { nickname: string; content: string }[];
}

const PAGE = 30;

const fmtLikes = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : `${n}`);

const fmtCmtTime = (ts: number) => {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  if (sameDay) return hm;
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? md : `${d.getFullYear()}年${md}`;
};

const mapComment = (c: any): CommentItem => ({
  id: c.commentId,
  nickname: c.user?.nickname || '未知用户',
  avatarUrl: toHttps(c.user?.avatarUrl || ''),
  content: c.content || '',
  time: c.time || 0,
  likedCount: c.likedCount || 0,
  replied: (c.beReplied || [])
    .filter((b: any) => b?.content)
    .map((b: any) => ({ nickname: b.user?.nickname || '未知用户', content: b.content })),
});

const SongCommentsPage: React.FC<Props> = ({ song, onBack }) => {
  const { addToast } = useOS();
  const { cfg } = useMusic();

  // 不稳定引用收进 ref，避免 effect 反复触发
  const toastRef = useRef(addToast);
  toastRef.current = addToast;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const [hotComments, setHotComments] = useState<CommentItem[]>([]);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const r = await musicApi.call(cfgRef.current, '/comment/music', { id: song.id, limit: PAGE, offset });
      const latest: CommentItem[] = (r?.comments || []).map(mapComment);
      if (offset === 0) {
        setHotComments((r?.hotComments || []).map(mapComment));
        setComments(latest);
      } else {
        setComments(prev => [...prev, ...latest]);
      }
      setTotal(r?.total || 0);
      setHasMore(!!r?.more);
    } catch (e: any) {
      toastRef.current(`加载评论失败：${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [song.id]);

  useEffect(() => { load(0); }, [load]);

  const CommentRow: React.FC<{ c: CommentItem }> = ({ c }) => (
    <div className="flex gap-2.5 px-3.5 py-2.5">
      {c.avatarUrl ? (
        <img src={c.avatarUrl} alt="" className="w-8 h-8 rounded-full shrink-0 object-cover"
          style={{ border: '1.5px solid rgba(255,255,255,0.7)' }} />
      ) : (
        <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center"
          style={{ background: `${C.lavender}50`, color: C.primary }}>
          <ChatCircleDots size={14} weight="bold" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] truncate" style={{ color: C.muted }}>{c.nickname}</span>
          <span className="flex items-center gap-0.5 text-[9px] shrink-0" style={{ color: C.faint }}>
            <Heart size={9} weight="fill" color={c.likedCount > 0 ? C.sakura : C.faint} />
            {fmtLikes(c.likedCount)}
          </span>
        </div>
        <div className="text-[11.5px] leading-relaxed mt-0.5" style={{ color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {c.content}
        </div>
        {c.replied.map((b, i) => (
          <div key={i} className="mt-1 px-2 py-1 rounded-lg text-[10px] leading-relaxed"
            style={{ background: 'rgba(255,255,255,0.5)', color: C.muted, borderLeft: `2px solid ${C.lavender}` }}>
            <span style={{ color: C.accent }}>@{b.nickname}：</span>{b.content}
          </div>
        ))}
        <div className="text-[9px] mt-1" style={{ color: C.faint }}>{fmtCmtTime(c.time)}</div>
      </div>
    </div>
  );

  const SectionLabel: React.FC<{ label: string }> = ({ label }) => (
    <div className="px-4 pt-3 pb-1 text-[10px] font-semibold tracking-wider" style={{ color: C.primary }}>
      {label}
    </div>
  );

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader title="评论区" onBack={onBack} />

      <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar pb-8">
        {/* 歌曲卡 */}
        <div className="mx-3.5 mt-3 px-3 py-2.5 rounded-2xl shizuku-glass flex items-center gap-2.5">
          {song.albumPic ? (
            <img src={song.albumPic} alt="" className="w-11 h-11 rounded-xl object-cover shrink-0"
              style={{ border: '1.5px solid rgba(255,255,255,0.7)' }} />
          ) : (
            <div className="w-11 h-11 rounded-xl shrink-0" style={{ background: `${C.lavender}50` }} />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium truncate" style={{ color: C.text }}>{song.name}</div>
            <div className="text-[10px] truncate mt-0.5" style={{ color: C.muted }}>{song.artists}</div>
          </div>
          {total > 0 && (
            <span className="text-[9px] px-2 py-0.5 rounded-full shrink-0 shizuku-glass" style={{ color: C.primary }}>
              {total > 10000 ? `${(total / 10000).toFixed(1)}万` : total} 条
            </span>
          )}
        </div>

        {hotComments.length > 0 && (
          <>
            <SectionLabel label="♪ 热门评论" />
            <div className="mx-2 rounded-2xl shizuku-glass divide-y" style={{ borderColor: 'rgba(255,255,255,0.4)' }}>
              {hotComments.map(c => <CommentRow key={c.id} c={c} />)}
            </div>
          </>
        )}

        {(comments.length > 0 || !loading) && <SectionLabel label="♪ 最新评论" />}
        {comments.length > 0 && (
          <div className="mx-2 rounded-2xl shizuku-glass divide-y" style={{ borderColor: 'rgba(255,255,255,0.4)' }}>
            {comments.map(c => <CommentRow key={c.id} c={c} />)}
          </div>
        )}
        {!loading && comments.length === 0 && hotComments.length === 0 && (
          <div className="text-center text-[11px] py-10" style={{ color: C.faint }}>
            还没有评论，或这首歌拉不到评论区。
          </div>
        )}

        {loading && (
          <div className="text-center text-[10px] py-4" style={{ color: C.faint }}>加载中…</div>
        )}
        {!loading && hasMore && (
          <div className="px-4 mt-3">
            <button
              onClick={() => load(comments.length)}
              className="w-full py-2 rounded-xl text-[11px] shizuku-glass transition-all active:scale-[0.98]"
              style={{ color: C.primary }}
            >
              加载更多评论
            </button>
          </div>
        )}

        <div className="text-center text-[9px] mt-4" style={{ color: C.faint }}>
          只读 · 评论来自网易云
        </div>
      </div>
    </div>
  );
};

export default SongCommentsPage;
