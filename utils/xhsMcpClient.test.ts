import { describe, expect, it } from 'vitest';
import {
    normalizeNote,
    normalizeXhsComments,
    normalizeXhsLiteDetail,
    parseXhsCount,
} from './xhsMcpClient';

describe('XHS Lite response normalization', () => {
    it('parses compact counters without turning 1.2万 into 1', () => {
        expect(parseXhsCount('1.2万')).toBe(12_000);
        expect(parseXhsCount('3万+')).toBe(30_000);
        expect(parseXhsCount('2.5k')).toBe(2_500);
        expect(parseXhsCount('1,234')).toBe(1_234);
    });

    it('reads snake_case interaction counters returned by Lite', () => {
        expect(normalizeNote({
            note_id: 'note-1',
            title: '标题',
            interact_info: {
                liked_count: '1.2万',
                collected_count: '345',
                comment_count: '67',
                share_count: '8',
            },
        })).toMatchObject({
            noteId: 'note-1',
            likes: 12_000,
            collects: 345,
            commentCount: 67,
            shareCount: 8,
        });
    });

    it('keeps user/user_info authors and nested sub_comments', () => {
        const payload = {
            data: {
                note: { note_id: 'note-1', title: '标题' },
                comments: {
                    list: [{
                        comment_id: 'comment-1',
                        content: '一级评论',
                        like_count: '1.2万',
                        user: { user_id: 'user-1', nickname: '甲' },
                        sub_comments: [{
                            comment_id: 'comment-2',
                            content: '回复内容',
                            like_count: '2',
                            user_info: { user_id: 'user-2', nickname: '乙' },
                        }],
                    }],
                },
            },
        };

        expect(normalizeXhsComments(payload)).toMatchObject([{
            commentId: 'comment-1',
            userId: 'user-1',
            author: '甲',
            likes: 12_000,
            subComments: [{
                commentId: 'comment-2',
                userId: 'user-2',
                author: '乙',
                parentCommentId: 'comment-1',
            }],
        }]);
        expect(normalizeXhsLiteDetail(payload).comments).toEqual([
            {
                author: '甲',
                content: '一级评论',
                likes: 12_000,
                commentId: 'comment-1',
                userId: 'user-1',
            },
            {
                author: '乙',
                content: '回复内容',
                likes: 2,
                commentId: 'comment-2',
                userId: 'user-2',
            },
        ]);
    });
});
