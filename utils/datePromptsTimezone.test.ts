// 见面（Peek 开场）注入的「当前时间」必须是角色所在地的真实钟点。
//
// 回归守卫：getRealTimeStr 曾把 nowInTimeZone 折算过的 Date 再喂给同样会折算的
// ChatPrompts.formatDate，导致时间被多减一个时差——角色时区 America/New_York、
// 设备 Asia/Shanghai 时，纽约的 07-26 09:00 会被写成 07-25 21:00，
// 而星期又取自只折算一次的 Date，于是日期和星期自相矛盾（25 号是周六，却标周日）。
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DatePrompts } from './datePrompts';
import type { CharacterProfile, UserProfile } from '../types';

const originalTimeZone = process.env.TZ;
afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});
afterEach(() => vi.useRealTimers());

/** 北京 2026-07-26 21:00（周日）== 纽约同日 09:00（周日, EDT）。 */
const INSTANT = new Date('2026-07-26T13:00:00Z');

const userProfile = { name: '楪' } as UserProfile;

const makeChar = (overrides: Partial<CharacterProfile>): CharacterProfile => ({
    id: 'char-1',
    name: '小画',
    persona: '画师',
    ...overrides,
} as CharacterProfile);

const peekText = (char: CharacterProfile): string => {
    const { messages } = DatePrompts.buildPeekPayload({
        char,
        userProfile,
        allMsgs: [],
        emojis: [],
    });
    return messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
};

describe('见面 Peek 注入的当前时间跟随角色时区', () => {
    it('角色在纽约时写的是纽约的 09:00，不是被多减一个时差的 07-25 21:00', () => {
        process.env.TZ = 'Asia/Shanghai';
        vi.useFakeTimers();
        vi.setSystemTime(INSTANT);

        const text = peekText(makeChar({
            customTimezoneEnabled: true,
            customTimezone: 'America/New_York',
        }));

        expect(text).toContain('当前时间: 2026-07-26 09:00 周日');
        expect(text).not.toContain('2026-07-25');
    });

    it('日期与星期必须自洽（旧实现里 07-25 会配上周日）', () => {
        process.env.TZ = 'Asia/Shanghai';
        vi.useFakeTimers();
        vi.setSystemTime(INSTANT);

        const text = peekText(makeChar({
            customTimezoneEnabled: true,
            customTimezone: 'America/New_York',
        }));

        const matched = /当前时间: (\d{4}-\d{2}-\d{2}) \d{2}:\d{2} (周.)/.exec(text);
        expect(matched).not.toBeNull();

        const [, dateStr, weekday] = matched!;
        const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const [y, m, d] = dateStr.split('-').map(Number);
        expect(weekday).toBe(days[new Date(y, m - 1, d).getDay()]);
    });

    it('没开自定义时区的角色仍写设备时间', () => {
        process.env.TZ = 'Asia/Shanghai';
        vi.useFakeTimers();
        vi.setSystemTime(INSTANT);

        expect(peekText(makeChar({}))).toContain('当前时间: 2026-07-26 21:00 周日');
    });
});
