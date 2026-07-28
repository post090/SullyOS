import { describe, expect, it } from 'vitest';
import { formatMemoryDateWithDistance } from './memoryDate';

describe('记忆日期与距今时间', () => {
    const now = new Date(2026, 6, 28, 9, 0, 0).getTime();

    it('旧记忆标注距今天数', () => {
        const memoryDate = new Date(2026, 6, 1, 23, 30, 0).getTime();
        expect(formatMemoryDateWithDistance(memoryDate, now))
            .toBe('2026年7月1日（距今约27天）');
    });

    it('同一日不受时分影响', () => {
        const memoryDate = new Date(2026, 6, 28, 0, 1, 0).getTime();
        expect(formatMemoryDateWithDistance(memoryDate, now))
            .toBe('2026年7月28日（今天）');
    });

    it('未来日期明确写成多少天后', () => {
        const memoryDate = new Date(2026, 7, 2, 12, 0, 0).getTime();
        expect(formatMemoryDateWithDistance(memoryDate, now))
            .toBe('2026年8月2日（约5天后）');
    });
});
