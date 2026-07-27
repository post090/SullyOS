// 「今日特殊」节日要按角色所在地的日历日判，不能跟着用户的手机过节。
//
// 回归守卫：checkSpecialDates 原本无条件读设备时间，于是同一段注入里
// 「📅 当前真实时间」是角色时区、「🎉 今日特殊」却是用户时区，两句自相矛盾——
// 角色会在自己的 2/13 晚上被告知今天是情人节，又在真正的 2/14 白天什么都收不到。
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeContextManager } from './realtimeContext';

const originalTimeZone = process.env.TZ;
afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});
afterEach(() => vi.useRealTimers());

const freeze = (iso: string) => {
    process.env.TZ = 'Asia/Shanghai';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
};

describe('checkSpecialDates 跟随角色时区', () => {
    it('用户已到 2/14、角色那边还是 2/13 时，角色不该被告知今天是情人节', () => {
        // 北京 2026-02-14 07:00 == 纽约 2026-02-13 18:00
        freeze('2026-02-13T23:00:00Z');

        expect(RealtimeContextManager.checkSpecialDates()).toContain('情人节');
        expect(RealtimeContextManager.checkSpecialDates('America/New_York')).toEqual([]);
    });

    it('用户已过 2/14、角色那边正是情人节白天时，角色要收到', () => {
        // 北京 2026-02-15 00:30 == 纽约 2026-02-14 11:30
        freeze('2026-02-14T16:30:00Z');

        expect(RealtimeContextManager.checkSpecialDates()).toEqual([]);
        expect(RealtimeContextManager.checkSpecialDates('America/New_York')).toContain('情人节');
    });

    it('不传时区时保持原本的设备时间行为', () => {
        freeze('2026-02-13T23:00:00Z');

        expect(RealtimeContextManager.checkSpecialDates(undefined)).toContain('情人节');
    });
});
