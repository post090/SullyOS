/**
 * 角色歌单「按品味挑歌」（从 CharVisitPage 抽出，歌单详情页也要用）。
 * 只负责搜歌和挑选，不落盘 —— 挑好的歌由调用方决定怎么持久化。
 *
 * 关键：每个歌单走一组**不同**的关键词，否则三个歌单会搜出一模一样的歌。
 * - searchHints 优先（LLM 产出的艺人名+曲风词 / OST 标题）
 * - 兜底：歌单 title + mood 中文词 + signatureArtists 轮换
 * - OST 标题按 type 加搜索后缀（game→OST、musical→选段…），搜出来的是原声而非翻唱
 * - starred 的关键词搜出来取更多条（灵魂艺人/最爱 OST 占比更高），非 starred 取少
 * - 去掉本角色其它歌单已经有的歌，避免跨歌单撞曲
 */
import { CharMusicProfile, CharPlaylist, CharPlaylistSong } from '../types';
import { musicApi, toHttps, MusicCfg, Song } from '../context/MusicContext';

/** 网易云搜索结果 → 全局 Song（详情页加歌 / 填充共用的字段映射） */
export const songFromSearch = (s: any): Song => ({
  id: s.id,
  name: s.name,
  artists: (s.ar || s.artists || []).map((a: any) => a.name).join(' / '),
  album: s.al?.name || s.album?.name || '',
  albumPic: toHttps(s.al?.picUrl || s.album?.picUrl || ''),
  duration: (s.dt || s.duration || 0) / 1000,
  fee: s.fee ?? 0,
});

/**
 * Song → 角色歌单快照。source='user' 表示是用户亲手加进去的
 * （prompt 侧会告诉 LLM 这层关系），填充挑的歌不带 source（默认 discovered）。
 */
export const toCharPlaylistSong = (s: Song, source?: 'user' | 'discovered'): CharPlaylistSong => ({
  id: s.id, name: s.name, artists: s.artists, album: s.album,
  albumPic: s.albumPic, duration: s.duration, fee: s.fee,
  ...(source ? { source, addedAt: Date.now() } : {}),
});

/** 按品味为歌单挑至多 8 首新歌（已跨歌单去重），失败的关键词静默跳过。 */
export async function pickSongsForPlaylist(
  profile: CharMusicProfile,
  pl: CharPlaylist,
  cfg: MusicCfg,
): Promise<CharPlaylistSong[]> {
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
  if (uniqKws.length === 0) return [];

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
        picked.push(toCharPlaylistSong(s));
        if (picked.length >= 8) break;
      }
    } catch { /* 单个关键词失败不阻塞 */ }
  }
  return picked;
}
