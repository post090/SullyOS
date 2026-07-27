// 角色写下的时间文本要按 ta 自己的时区还原成真实时刻。
//
// 回归守卫：定时消息 [schedule_message | YYYY-MM-DD HH:MM:SS | ...] 原本直接 new Date(文本)，
// 按设备时区解释。角色在纽约看着自己的上午 09:00 说「今晚 21:00 找你」，
// 设备在中国就会把它当成北京 21:00（= 纽约当天 09:00），消息当场就到期了。
import { afterAll, describe, expect, it } from 'vitest';
import { nowInTimeZone, wallClockToTimestamp } from './timezone';

const originalTimeZone = process.env.TZ;
afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});

describe('wallClockToTimestamp', () => {
    it('角色在纽约写的 21:00 还原成纽约的 21:00，不是设备的 21:00', () => {
        process.env.TZ = 'Asia/Shanghai';
        const ts = wallClockToTimestamp('2026-07-26 21:00:00', 'America/New_York');

        // 纽约 2026-07-26 21:00 (EDT, UTC-4) == UTC 2026-07-27 01:00
        expect(new Date(ts).toISOString()).toBe('2026-07-27T01:00:00.000Z');
    });

    it('和 nowInTimeZone 互为逆运算', () => {
        process.env.TZ = 'Asia/Shanghai';
        const tz = 'America/New_York';
        const wall = nowInTimeZone(tz, new Date('2026-07-26T13:00:00Z'));
        const text = `${wall.getFullYear()}-${String(wall.getMonth() + 1).padStart(2, '0')}-${String(wall.getDate()).padStart(2, '0')} `
            + `${String(wall.getHours()).padStart(2, '0')}:${String(wall.getMinutes()).padStart(2, '0')}:00`;

        expect(wallClockToTimestamp(text, tz)).toBe(new Date('2026-07-26T13:00:00Z').getTime());
    });

    it('不传时区时与 new Date(文本) 行为一致', () => {
        process.env.TZ = 'Asia/Shanghai';
        expect(wallClockToTimestamp('2026-07-26 21:00:00'))
            .toBe(new Date('2026-07-26T21:00:00').getTime());
    });

    it('角色在东京、设备在纽约（反向时差）也成立', () => {
        process.env.TZ = 'America/New_York';
        const ts = wallClockToTimestamp('2026-07-26 08:00:00', 'Asia/Tokyo');

        // 东京 2026-07-26 08:00 (UTC+9) == UTC 2026-07-25 23:00
        expect(new Date(ts).toISOString()).toBe('2026-07-25T23:00:00.000Z');
    });

    it('非法文本返回 NaN，交给调用方判', () => {
        process.env.TZ = 'Asia/Shanghai';
        expect(Number.isNaN(wallClockToTimestamp('不是时间', 'America/New_York'))).toBe(true);
    });
});
