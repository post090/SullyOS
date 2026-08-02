import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';

/**
 * 主动消息 2.0 的送达端：提示词是几小时前打包的，副作用到点才在本地跑。
 * 这份测试盯住两类「时间差」引起的穿帮：
 *  1. 重放出来的副作用产物没带推送标记 → 处理失败重来时被当成"上次什么都没做"，整套再跑一遍；
 *  2. 打包之后用户把配置关掉（日记服务、HTML 卡片）→ 角色的话已经说满，动作却静默蒸发。
 */

afterEach(() => { vi.restoreAllMocks(); });

const makeCtx = (char: any, extra: Partial<PostProcessCtx> = {}): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char,
        userProfile: { name: '我' } as any,
        emojis: [],
        contextMsgs: [],
        fullMessages: [],
        initialData: {},
        historyMsgCount: 0,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: { setMessages: vi.fn(), addToast: vi.fn() },
        instantRender: true,
        ...extra,
    };
};

const pushMeta = (messageId: string) => ({
    source: 'active_msg_2',
    activeMsg2: { messageId, taskId: 'task-1' },
});

describe('directive 重放出来的副作用产物带推送标记', () => {
    it('转账 directive 落库的卡片带 activeMsg2.messageId', async () => {
        const charId = `c-replay-transfer-${Date.now()}`;

        await applyAssistantPostProcessing('给你买奶茶', makeCtx({ id: charId, name: '阿一' }, {
            skipSecondPassLLM: true,
            directives: [{ type: 'transfer', amount: 520 }],
            mcdInheritMeta: pushMeta('push-1'),
        }));

        const msgs = await DB.getMessagesByCharId(charId, true);
        const card = msgs.find(m => m.type === 'transfer');
        // 修复前: 卡片没有任何标记 → 重试清场认不出来, 这笔转账会被再转一次
        expect(card?.metadata?.activeMsg2?.messageId).toBe('push-1');
        expect(card?.metadata?.amount).toBe('520');
        // 正文气泡本来就带标记, 顺带确认两者对得上
        const text = msgs.find(m => m.type === 'text' && m.role === 'assistant');
        expect(text?.metadata?.activeMsg2?.messageId).toBe('push-1');
    });

    // 冻结的那首歌只能顺着 directive 显式递给 chatParser: 重放时拼回的
    // `[[MUSIC_ACTION:add|深夜]]` 标签里只有歌单名, 带不动歌名。这条接线断了的话,
    // 音乐动作会静默退回「取用户此刻在听的那首」—— 补收那刻用户多半什么都没放,
    // 于是正文聊着这首歌, 卡片和加歌单整个不发生。
    it('music_action directive 里冻结的歌递到卡片上（用户此刻没在听也照样出卡）', async () => {
        const charId = `c-replay-music-${Date.now()}`;
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '深夜', created: false });

        await applyAssistantPostProcessing('这首真好听', makeCtx({ id: charId, name: '阿一' }, {
            skipSecondPassLLM: true,
            directives: [{
                type: 'music_action', verb: 'add', args: ['深夜'],
                song: { id: 33, name: '夜航星', artists: '某某' },
            }],
            hooks: {
                setMessages: vi.fn(),
                addToast: vi.fn(),
                musicHooks: {
                    getListeningSnapshot: () => null,
                    joinListeningTogether: vi.fn(),
                    addSongToCharPlaylist: addSong,
                },
            },
        }));

        const card = (await DB.getMessagesByCharId(charId, true)).find(m => m.type === 'music_card');
        expect(card?.metadata?.song?.name).toBe('夜航星');
        expect(addSong.mock.calls[0][1]).toMatchObject({ id: 33, name: '夜航星' });
    });
});

describe('打包之后配置被关掉', () => {
    it('日记服务没连上 → 落一条系统提示，而不是当无事发生', async () => {
        const charId = `c-diary-off-${Date.now()}`;

        await applyAssistantPostProcessing(
            '今天的事我想写下来\n[[DIARY: 今天|见到你很开心]]',
            makeCtx({ id: charId, name: '阿一' }, { skipSecondPassLLM: true }),
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        const note = msgs.find(m => m.role === 'system');
        // 修复前: 标签被静默剥掉, 用户只看到角色说"我想写下来"然后什么都没发生
        expect(note?.content).toContain('想写日记');
        expect(note?.content).toContain('没写成');
        expect(msgs.some(m => m.type === 'text' && m.content.includes('今天的事我想写下来'))).toBe(true);
    });

    it('HTML 卡片开关关着 → 源码降级成占位文本，不把 <div> 漏进气泡', async () => {
        const charId = `c-html-off-${Date.now()}`;

        await applyAssistantPostProcessing(
            '给你做了张卡片\n[html]<div class="x">生日快乐</div>[/html]',
            makeCtx({ id: charId, name: '阿一', htmlModeEnabled: false }, { skipSecondPassLLM: true }),
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        expect(msgs.some(m => m.type === 'html_card')).toBe(false);
        const all = msgs.map(m => m.content).join('\n');
        // 修复前: sanitize 和 hasDisplayContent 都不剥 [html], 整段 <div class="x"> 原样进气泡
        expect(all).not.toContain('<div');
        expect(all).toContain('[HTML 卡片]');
    });

    it('HTML 卡片开着时照常出卡片（不回归）', async () => {
        const charId = `c-html-on-${Date.now()}`;

        await applyAssistantPostProcessing(
            '给你做了张卡片\n[html]<div class="x">生日快乐</div>[/html]',
            makeCtx({ id: charId, name: '阿一', htmlModeEnabled: true }, { skipSecondPassLLM: true }),
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        const card = msgs.find(m => m.type === 'html_card');
        expect(card?.metadata?.htmlSource).toContain('生日快乐');
        expect(msgs.some(m => m.content.includes('[HTML 卡片]'))).toBe(false);
    });
});
