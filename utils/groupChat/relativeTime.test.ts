import { describe, expect, it } from 'vitest';
import { formatRelativeAge } from './relativeTime';

describe('formatRelativeAge', () => {
    const now = Date.UTC(2026, 6, 29, 12, 0, 0);

    it('给近消息标注分钟和小时', () => {
        expect(formatRelativeAge(now - 45_000, now)).toBe('刚刚');
        expect(formatRelativeAge(now - 12 * 60_000, now)).toBe('约 12 分钟前');
        expect(formatRelativeAge(now - 5 * 3_600_000, now)).toBe('约 5 小时前');
    });

    it('给跨天旧消息明确标注约几天前', () => {
        expect(formatRelativeAge(now - 2 * 86_400_000, now)).toBe('约 2 天前');
    });

    it('支持更久的消息并保护异常或未来时间', () => {
        expect(formatRelativeAge(now - 65 * 86_400_000, now)).toBe('约 2 个月前');
        expect(formatRelativeAge(now - 800 * 86_400_000, now)).toBe('约 2 年前');
        expect(formatRelativeAge(now + 60_000, now)).toBe('刚刚');
        expect(formatRelativeAge(Number.NaN, now)).toBe('时间未知');
    });
});
