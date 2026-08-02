import { describe, expect, it, vi, afterEach } from 'vitest';
import { ChatParser } from './chatParser';
import { DB } from './db';

/**
 * 主动消息 2.0 的送达端重放：一条推送到点才在本地跑副作用，跟「角色写这句话」隔着几小时。
 * 这份测试盯住三件在那个时间差里会出错的事：
 *  1. 副作用产物要带上这条推送的标记（认不出来 = 处理失败重来时整套副作用再跑一遍）；
 *  2. 角色说「这笔我收下了」，收的必须是它写这句话时看得到的那笔；
 *  3. 热点卡的链接宁可不挂，也别按相似标题猜错一条。
 */

const noop = () => {};

afterEach(() => { vi.restoreAllMocks(); });

const inheritMeta = {
    source: 'active_msg_2',
    activeMsg2: { messageId: 'push-abc', taskId: 'task-1' },
};

describe('parseAndExecuteActions 的副作用产物继承推送标记', () => {
    it('戳一戳 / 转账卡 / 日程系统提示都带上 activeMsg2.messageId', async () => {
        const charId = `c-inherit-${Date.now()}`;

        await ChatParser.parseAndExecuteActions(
            '给你\n[[ACTION:POKE]]\n[[ACTION:TRANSFER:520]]\n[[ACTION:ADD_EVENT | 面试 | 2099-08-03]]',
            charId, '阿一', noop, undefined, undefined, undefined, undefined, inheritMeta,
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        expect(msgs.length).toBe(3);
        for (const m of msgs) {
            // 修复前: 副作用产物一个标记都不带 → 重试时被当成"上次什么都没做", 转账再跑一遍
            expect(m.metadata?.activeMsg2?.messageId).toBe('push-abc');
            expect(m.metadata?.source).toBe('active_msg_2');
        }
        // 卡片自己的字段不能被继承的元数据挤掉
        const transfer = msgs.find(m => m.type === 'transfer');
        expect(transfer?.metadata?.amount).toBe('520');
        expect(transfer?.metadata?.status).toBe('pending');
    });

    it('不传 inheritMeta 时元数据保持原样（本地聊天路径不受影响）', async () => {
        const charId = `c-inherit-none-${Date.now()}`;

        await ChatParser.parseAndExecuteActions(
            '[[ACTION:TRANSFER:66]]', charId, '阿一', noop,
        );

        const [transfer] = await DB.getMessagesByCharId(charId, true);
        expect(transfer.metadata).toEqual({ amount: '66', status: 'pending' });
    });

    it('热点卡也带标记', async () => {
        const charId = `c-inherit-news-${Date.now()}`;
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(null as any);

        await ChatParser.parseAndExecuteActions(
            '[[NEWS_CARD: 微博|某某官宣]]', charId, '阿一', noop,
            undefined, undefined, undefined, undefined, inheritMeta,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.type).toBe('news_card');
        expect(card.metadata?.activeMsg2?.messageId).toBe('push-abc');
        expect(card.metadata?.title).toBe('某某官宣');
    });
});

describe('TRANSFER_ACCEPT 结算哪一笔', () => {
    /** 造一笔用户发出的待收转账 */
    const putPending = (charId: string, amount: string, timestamp: number) =>
        DB.saveMessage({
            charId, role: 'user', type: 'transfer', content: '[转账]',
            timestamp, metadata: { amount, status: 'pending' },
        } as any);

    it('收的是消息发出那一刻就存在的那笔，而不是用户后来新转的', async () => {
        const charId = `c-accept-${Date.now()}`;
        const sentAt = Date.now() - 6 * 3600_000;   // 角色是六小时前说的这句话
        await putPending(charId, '5', sentAt - 60_000);      // 夜里那笔 5 块
        await putPending(charId, '1000', sentAt + 3600_000); // 用户早上新转的 1000

        await ChatParser.parseAndExecuteActions(
            '这五块我收下啦\n[[ACTION:TRANSFER_ACCEPT]]',
            charId, '阿一', noop, undefined, undefined, undefined, sentAt,
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        // 修复前: 取"重放时刻最新的一笔待收" → 把早上那 1000 给收了
        const receipt = msgs.find(m => m.role === 'assistant' && m.metadata?.receipt === 'accepted');
        expect(receipt?.metadata?.amount).toBe('5');
        const five = msgs.find(m => m.role === 'user' && m.metadata?.amount === '5');
        const thousand = msgs.find(m => m.role === 'user' && m.metadata?.amount === '1000');
        expect(five?.metadata?.status).toBe('accepted');
        expect(thousand?.metadata?.status).toBe('pending');
    });

    it('消息发出时一笔待收都没有 → 退回按最新一笔结算并留一行日志', async () => {
        const charId = `c-accept-late-${Date.now()}`;
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const sentAt = Date.now() - 6 * 3600_000;
        await putPending(charId, '1000', sentAt + 3600_000);

        await ChatParser.parseAndExecuteActions(
            '[[ACTION:TRANSFER_ACCEPT]]', charId, '阿一', noop, undefined, undefined, undefined, sentAt,
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        expect(msgs.find(m => m.role === 'assistant')?.metadata?.amount).toBe('1000');
        expect(warn.mock.calls.some(c => c.join(' ').includes('并没有待收的转账'))).toBe(true);
    });

    it('不传时间戳时维持老行为：结算最新一笔', async () => {
        const charId = `c-accept-now-${Date.now()}`;
        await putPending(charId, '5', Date.now() - 60_000);
        await putPending(charId, '1000', Date.now());

        await ChatParser.parseAndExecuteActions(
            '[[ACTION:TRANSFER_ACCEPT]]', charId, '阿一', noop,
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        expect(msgs.find(m => m.role === 'assistant')?.metadata?.amount).toBe('1000');
    });
});

describe('NEWS_CARD 回填链接', () => {
    const snapshotOf = (titles: Array<{ title: string; url: string }>) => ({
        id: 'x', date: '2026-08-02', slot: 0, slotLabel: '早间', platforms: ['weibo'],
        fetchedAt: Date.now(),
        items: titles.map(t => ({ title: t.title, url: t.url, source: '微博', desc: '' })),
    });

    it('两条相似标题都能对上 → 这张卡不挂链接', async () => {
        const charId = `c-news-ambiguous-${Date.now()}`;
        vi.spyOn(console, 'warn').mockImplementation(noop);
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(snapshotOf([
            { title: '某某官宣退圈', url: 'https://example.com/a' },
            { title: '某某官宣新剧开机', url: 'https://example.com/b' },
        ]) as any);

        await ChatParser.parseAndExecuteActions(
            '[[NEWS_CARD: 微博|某某官宣]]', charId, '阿一', noop,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        // 修复前: 模糊匹配挑第一条 → 卡片标题说 A、点进去是 B
        expect(card.metadata?.url).toBeUndefined();
        expect(card.metadata?.title).toBe('某某官宣');
    });

    it('只有一条对得上 → 照常补链接', async () => {
        const charId = `c-news-unique-${Date.now()}`;
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(snapshotOf([
            { title: '某某官宣退圈', url: 'https://example.com/a' },
            { title: '完全无关的另一条', url: 'https://example.com/z' },
        ]) as any);

        await ChatParser.parseAndExecuteActions(
            '[[NEWS_CARD: 微博|某某官宣]]', charId, '阿一', noop,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.url).toBe('https://example.com/a');
    });

    it('标题完全一致时优先精确匹配，不受相似标题干扰', async () => {
        const charId = `c-news-exact-${Date.now()}`;
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(snapshotOf([
            { title: '某某官宣退圈的后续报道', url: 'https://example.com/b' },
            { title: '某某官宣退圈', url: 'https://example.com/a' },
        ]) as any);

        await ChatParser.parseAndExecuteActions(
            '[[NEWS_CARD: 微博|某某官宣退圈]]', charId, '阿一', noop,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.url).toBe('https://example.com/a');
    });
});

describe('MUSIC_ACTION 取不到"正在听"快照', () => {
    it('留一行日志说明这条音乐动作跳过了（补收时用户多半早就不听了）', async () => {
        const charId = `c-music-${Date.now()}`;
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const addSong = vi.fn();

        const out = await ChatParser.parseAndExecuteActions(
            '这首真好听[[MUSIC_ACTION:add|深夜]]', charId, '阿一', noop,
            { getListeningSnapshot: () => null, joinListeningTogether: noop, addSongToCharPlaylist: addSong as any },
        );

        expect(out).toBe('这首真好听');
        expect(addSong).not.toHaveBeenCalled();
        // 修复前: 整个动作静默蒸发, 排查时一点线索都没有
        expect(warn.mock.calls.some(c => c.join(' ').includes('正在听'))).toBe(true);
    });
});

/**
 * 定时消息的正文是角色几小时前对着**它自己那时在听的那首**写的，而
 * `[[MUSIC_ACTION:add|歌单标题]]` 标签里只有歌单名、没有歌名。只按「用户此刻在听的那首」
 * 重放的话：补收那一刻用户多半什么都没放 → 卡片和加歌单整个不发生；就算用户恰好在听，
 * 加的也是用户那首，不是角色说的那首。worker 到点把那首冻进 directive，调用方
 * （applyAssistantPostProcessing）当参数递进来，这里认它。
 */
describe('MUSIC_ACTION 用推送里冻结的那首歌重放', () => {
    /** 角色自己的歌单（冻结的歌就是从这里的抽样池挑的，回来按 id 能补齐封面/时长） */
    const putCharWithPlaylist = (charId: string) => DB.saveCharacter({
        id: charId,
        name: '阿一',
        musicProfile: {
            bio: '', genreTags: [], signatureArtists: [], likedSongIds: [], recentPlays: [],
            playlists: [{
                id: 'pl-1', title: '深夜', description: '', coverStyle: 'gradient-01',
                createdAt: 0, updatedAt: 0,
                songs: [{
                    id: 33, name: '夜航星', artists: '某某', album: '星尘',
                    albumPic: 'https://example.com/cover.jpg', duration: 233000, fee: 0,
                    source: 'discovered',
                }],
            }],
        },
    } as any);

    it('用户此刻没在听歌，照样出卡片 + 加歌单（用角色说的那首）', async () => {
        const charId = `c-music-frozen-${Date.now()}`;
        await putCharWithPlaylist(charId);
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '深夜', created: false });

        await ChatParser.parseAndExecuteActions(
            '在听《夜航星》，也收进歌单了[[MUSIC_ACTION:add|深夜]]', charId, '阿一', noop,
            { getListeningSnapshot: () => null, joinListeningTogether: noop, addSongToCharPlaylist: addSong },
            undefined, undefined, undefined, inheritMeta,
            { id: 33, name: '夜航星', artists: '某某' },
        );

        // 修复前: 快照为空 → 整条音乐动作跳过，正文聊着这首歌、卡片和歌单动作却没发生
        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.type).toBe('music_card');
        expect(card.metadata?.song?.name).toBe('夜航星');
        // 卡片要封面/时长，directive 带不动这些字段，回角色歌单按 id 补齐
        expect(card.metadata?.song?.songId).toBe(33);
        expect(card.metadata?.song?.albumPic).toBe('https://example.com/cover.jpg');
        expect(card.metadata?.song?.duration).toBe(233000);
        expect(card.metadata?.activeMsg2?.messageId).toBe('push-abc');
        expect(addSong).toHaveBeenCalledTimes(1);
        expect(addSong.mock.calls[0][1]).toMatchObject({ id: 33, name: '夜航星' });
        // 这首是角色自己在听的，不是从用户那儿收来的：标成 'user' 会让之后的提示词
        // 说「这首是 ta 给我的」
        expect(addSong.mock.calls[0][1].source).toBe('discovered');
        expect(addSong.mock.calls[0][2]).toEqual({ kind: 'existing', title: '深夜' });
    });

    it('用户此刻在听别的歌 → 认角色说的那首，不是用户那首', async () => {
        const charId = `c-music-frozen-conflict-${Date.now()}`;
        await putCharWithPlaylist(charId);
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '深夜', created: false });
        const userSong = {
            songId: 99, name: '用户在听的歌', artists: '别人', album: '', albumPic: '', duration: 0, fee: 0,
        };

        await ChatParser.parseAndExecuteActions(
            '[[MUSIC_ACTION:add|深夜]]', charId, '阿一', noop,
            { getListeningSnapshot: () => userSong, joinListeningTogether: noop, addSongToCharPlaylist: addSong },
            undefined, undefined, undefined, inheritMeta,
            { id: 33, name: '夜航星', artists: '某某' },
        );

        // 修复前: 卡片和加进歌单的都是用户那首，跟正文说的对不上
        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.song?.name).toBe('夜航星');
        expect(addSong.mock.calls[0][1].id).toBe(33);
    });

    it('歌单里找不到（id 和歌名都对不上）→ 只用推送带的那几个字段，不改口说成用户那首', async () => {
        const charId = `c-music-frozen-miss-${Date.now()}`;
        await putCharWithPlaylist(charId);
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '深夜', created: false });

        await ChatParser.parseAndExecuteActions(
            '[[MUSIC_ACTION:add|深夜]]', charId, '阿一', noop,
            {
                getListeningSnapshot: () => ({
                    songId: 99, name: '用户在听的歌', artists: '别人', album: '', albumPic: '', duration: 0, fee: 0,
                }),
                joinListeningTogether: noop,
                addSongToCharPlaylist: addSong,
            },
            undefined, undefined, undefined, inheritMeta,
            { id: 777, name: '早就被删掉的歌', artists: '谁' },
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.song).toMatchObject({ songId: 777, name: '早就被删掉的歌', albumPic: '' });
    });

    it('没传冻结的歌（instant push / 本地聊天）→ 维持老行为，取用户此刻在听的那首', async () => {
        const charId = `c-music-live-${Date.now()}`;
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '我喜欢的音乐', created: false });
        const userSong = {
            songId: 99, name: '用户在听的歌', artists: '别人', album: '', albumPic: '', duration: 0, fee: 0,
        };

        await ChatParser.parseAndExecuteActions(
            '[[MUSIC_ACTION:add]]', charId, '阿一', noop,
            { getListeningSnapshot: () => userSong, joinListeningTogether: noop, addSongToCharPlaylist: addSong },
            undefined, undefined, undefined, inheritMeta,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.song?.name).toBe('用户在听的歌');
        // 从用户那儿收来的歌照旧打 'user' 标（提示词会说「这首是 ta 给我的」）
        expect(addSong.mock.calls[0][1].source).toBe('user');
    });
});
