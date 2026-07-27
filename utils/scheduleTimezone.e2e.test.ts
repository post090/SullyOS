// 端到端钉住「用户在中国 + 角色在纽约」时，日程全链路按角色那边的时间走。
//
// 回归守卫：同一时刻（北京 21:00 == 纽约 09:00），若哪天有人把某个环节改回读设备时间，
// 当前时段就会从「晨间画草稿」跳到「睡前刷画集」，下面的断言会挂。
// 这正是用户反馈的现象：角色那边明明是早上 9 点，卡片却把晚上 21 点标成进行中。
import { afterAll, describe, expect, it } from 'vitest';
import { ContextBuilder } from '../utils/context';
import { getFlowNarrativeKey } from '../utils/scheduleGenerator';
import { getCurrentScheduleSlotIndex, getScheduleDateKey, getScheduleWallClock } from '../utils/scheduleTime';
import type { CharacterProfile, DailySchedule, ScheduleSlot } from '../types';

const originalTimeZone = process.env.TZ;
afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});

/** 北京时间 2026-07-26 21:00 == 纽约同日 09:00（EDT, UTC-4）。 */
const INSTANT = new Date('2026-07-26T13:00:00Z');

const nyChar = {
    id: 'char-ny',
    customTimezoneEnabled: true,
    customTimezone: 'America/New_York',
} as unknown as CharacterProfile;

const slots: ScheduleSlot[] = [
    { startTime: '09:00', activity: '晨间画草稿', description: '开着窗画线稿' },
    { startTime: '13:00', activity: '午后遛狗' },
    { startTime: '21:00', activity: '睡前刷画集' },
];

const schedule = {
    id: 'char-ny_2026-07-26',
    charId: 'char-ny',
    date: '2026-07-26',
    slots,
    generatedAt: INSTANT.getTime(),
    flowNarrative: {
        morning: '刚醒，咖啡还没喝完就想先把线稿开个头。',
        afternoon: '下午有点晒，遛完狗人是懒的。',
        evening: '今天画完了，躺着刷画集。',
    },
} as unknown as DailySchedule;

describe('日程跟随角色时区（用户在中国 / 角色在纽约）', () => {
    it('当前时段按纽约 09:00 判定，而不是设备的 21:00', () => {
        process.env.TZ = 'Asia/Shanghai';
        expect(getCurrentScheduleSlotIndex(slots, nyChar, INSTANT)).toBe(0);
    });

    it('同一时刻若退回设备时间会落到晚上那条——守卫这个差异', () => {
        process.env.TZ = 'Asia/Shanghai';
        const withCharClock = getCurrentScheduleSlotIndex(slots, nyChar, INSTANT);
        const withDeviceClock = getCurrentScheduleSlotIndex(slots, null, INSTANT);

        expect(slots[withCharClock].activity).toBe('晨间画草稿');
        expect(slots[withDeviceClock].activity).toBe('睡前刷画集');
        expect(withCharClock).not.toBe(withDeviceClock);
    });

    it('日期 key 用纽约的日历日', () => {
        process.env.TZ = 'Asia/Shanghai';
        expect(getScheduleDateKey(nyChar, INSTANT)).toBe('2026-07-26');
    });

    it('喂给模型的日程注入说的是「晨间画草稿」，不是「睡前刷画集」', () => {
        process.env.TZ = 'Asia/Shanghai';
        const charNow = getScheduleWallClock(nyChar, INSTANT);
        const injected = ContextBuilder.buildScheduleInjection(schedule, undefined, charNow);

        expect(injected).toContain('晨间画草稿');
        expect(injected).not.toContain('睡前刷画集');
    });

    it('意识流选 morning 段，不是 evening 段', () => {
        process.env.TZ = 'Asia/Shanghai';
        const charNow = getScheduleWallClock(nyChar, INSTANT);

        expect(getFlowNarrativeKey(charNow.getHours())).toBe('morning');
        expect(ContextBuilder.buildScheduleInjection(schedule, undefined, charNow)).toContain('咖啡还没喝完');
    });

    it('没开自定义时区的角色仍跟随设备时间', () => {
        process.env.TZ = 'Asia/Shanghai';
        const plain = { ...nyChar, customTimezoneEnabled: false } as CharacterProfile;

        expect(getScheduleWallClock(plain, INSTANT).getHours()).toBe(INSTANT.getHours());
        expect(getCurrentScheduleSlotIndex(slots, plain, INSTANT)).toBe(2);
    });
});
