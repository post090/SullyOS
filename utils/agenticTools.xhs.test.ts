import { afterEach, describe, expect, it, vi } from 'vitest';
import { runXhsDetail, type XhsCaches } from './agenticTools';
import { XhsMcpClient } from './xhsMcpClient';
import { buildToolResultMessage } from './agenticToolFeedback';

describe('runXhsDetail', () => {
    afterEach(() => vi.restoreAllMocks());

    it('exposes Lite interactions/comments to the role and enriches the share card with one request', async () => {
        const getDetail = vi.spyOn(XhsMcpClient, 'getNoteDetail').mockResolvedValue({
            success: true,
            data: {
                data: {
                    note: {
                        note_id: 'note-1',
                        title: '完整标题',
                        desc: '完整正文',
                        user: { user_id: 'author-1', nickname: '楼主' },
                        interact_info: {
                            liked_count: '1.2万',
                            collected_count: '345',
                            comment_count: '2',
                            share_count: '8',
                        },
                    },
                    comments: {
                        list: [{
                            comment_id: 'comment-1',
                            content: '一级评论',
                            user: { user_id: 'user-1', nickname: '甲' },
                            sub_comments: [{
                                comment_id: 'comment-2',
                                content: '回复内容',
                                user_info: { user_id: 'user-2', nickname: '乙' },
                            }],
                        }],
                    },
                },
            },
        });
        const caches: XhsCaches = {
            xsecTokenCache: new Map([['note-1', 'token-1']]),
            noteTitleCache: new Map([['note-1', '搜索标题']]),
            commentUserIdCache: new Map(),
            commentAuthorNameCache: new Map(),
            commentParentIdCache: new Map(),
        };
        const lastXhsNotesRef = {
            current: [{
                noteId: 'note-1',
                title: '搜索标题',
                desc: '搜索摘要',
                likes: 1,
                author: '楼主',
                authorId: 'author-1',
                xsecToken: 'token-1',
            }],
        };

        const result = await runXhsDetail(
            { noteId: 'note-1' },
            {
                char: { xhsEnabled: true } as any,
                userProfile: {} as any,
                realtimeConfig: {
                    xhsMcpConfig: { enabled: true, serverUrl: 'https://example.test/xhs' },
                } as any,
                xhsCaches: caches,
                lastXhsNotesRef,
            },
        );

        expect(getDetail).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && result.detailText).toContain('12000赞 345收藏 2评论 8分享');
        expect(result.ok && result.detailText).toContain('甲: 一级评论');
        expect(result.ok && result.detailText).toContain('乙: 回复内容');
        expect(caches.commentUserIdCache.get('comment-1')).toBe('user-1');
        expect(caches.commentUserIdCache.get('comment-2')).toBe('user-2');
        expect(caches.commentParentIdCache.get('comment-2')).toBe('comment-1');
        expect(lastXhsNotesRef.current[0]).toMatchObject({
            noteId: 'note-1',
            title: '完整标题',
            desc: '完整正文',
            likes: 12_000,
            commentCount: 2,
            comments: [
                { author: '甲', content: '一级评论' },
                { author: '乙', content: '回复内容' },
            ],
        });
    });

    // 回归守卫：详情一个字都没拿回来时，以前回的是 ok:true 外加一段「[加载失败: …]」的正文。
    // 护栏（NEVER_RAN_REASONS）只认 ok:false，这条失败于是被当成正常结果喂给模型——轻则
    // 把报错原文抄进消息里，重则直接说「我点开看了这条笔记」。
    it('详情拿不回来时算这次没跑成，不再包成"成功但正文是一句报错"', async () => {
        vi.spyOn(XhsMcpClient, 'getNoteDetail').mockResolvedValue({
            success: false,
            error: 'connect ECONNREFUSED 127.0.0.1:18060',
        } as any);

        const result = await runXhsDetail(
            { noteId: 'note-404' },
            {
                char: { xhsEnabled: true } as any,
                userProfile: {} as any,
                realtimeConfig: {
                    xhsMcpConfig: { enabled: true, serverUrl: 'https://example.test/xhs' },
                } as any,
            },
        );

        expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
        const feedback = buildToolResultMessage({
            name: 'xhs_detail',
            result,
            history: [{ name: 'xhs_detail', fingerprint: 'a' }],
        });
        expect(feedback).toContain('这件事**没有发生**');
    });

    // 同上：服务器回了 200、正文却是一句报错，也是"这次没读到笔记"。
    // 以前这条包成 ok:true 外加一个 failed 标志，护栏只认 ok:false，照样漏过去。
    it('回了 200 但正文是一句报错 → 同样算没跑成', async () => {
        vi.spyOn(XhsMcpClient, 'getNoteDetail').mockResolvedValue({
            success: true,
            data: '获取笔记详情失败: 需要先搜索',
        } as any);

        const result = await runXhsDetail(
            { noteId: 'note-500' },
            {
                char: { xhsEnabled: true } as any,
                userProfile: {} as any,
                realtimeConfig: {
                    xhsMcpConfig: { enabled: true, serverUrl: 'https://example.test/xhs' },
                } as any,
            },
        );

        expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
        expect(!result.ok && result.message).toContain('获取笔记详情失败');
        const feedback = buildToolResultMessage({
            name: 'xhs_detail',
            result,
            history: [{ name: 'xhs_detail', fingerprint: 'a' }],
        });
        expect(feedback).toContain('这件事**没有发生**');
    });
});
