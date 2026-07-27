import { describe, it, expect } from 'vitest';
import { interactionGapNote, tzAwarenessNote, resolveCharTimeZone, tzShortLabel } from './timezone';
import type { CharacterProfile } from '../types';

const NOW = 1_700_000_000_000; // 固定 now，避免依赖系统时钟
const min = (n: number) => NOW - n * 60_000;
const hr = (n: number) => NOW - n * 3_600_000;
const day = (n: number) => NOW - n * 86_400_000;

describe('interactionGapNote', () => {
    it('lastTs 为空 → 空串（不注入）', () => {
        expect(interactionGapNote(undefined, NOW)).toBe('');
    });

    it('5 分钟内 → 「刚刚还在联系」', () => {
        expect(interactionGapNote(min(2), NOW)).toContain('刚刚还在联系');
    });

    it('分钟级 → X 分钟', () => {
        expect(interactionGapNote(min(30), NOW)).toContain('30 分钟');
    });

    it('小时级 → X 小时', () => {
        expect(interactionGapNote(hr(5), NOW)).toContain('5 小时');
    });

    it('天级 → X 天 + 久未联系体感', () => {
        const note = interactionGapNote(day(3), NOW);
        expect(note).toContain('3 天');
        expect(note).toContain('已经有一阵子没联系了');
    });

    it('未来时间戳（时钟漂移）→ 空串，不产生负数', () => {
        expect(interactionGapNote(NOW + 60_000, NOW)).toBe('');
    });
});

describe('tzAwarenessNote', () => {
    it('无时区 → 空串', () => {
        expect(tzAwarenessNote(undefined)).toBe('');
    });
    it('有时区 → 含时差提示与时区标签', () => {
        const note = tzAwarenessNote('America/New_York');
        expect(note).toContain('时区');
        expect(note).toContain('纽约');
    });
});

describe('resolveCharTimeZone', () => {
    const base = { customTimezone: 'Asia/Tokyo' } as Partial<CharacterProfile>;
    it('未开启 → undefined（跟随本机）', () => {
        expect(resolveCharTimeZone({ ...base, customTimezoneEnabled: false } as CharacterProfile)).toBeUndefined();
    });
    it('开启且有值 → 返回时区 id', () => {
        expect(resolveCharTimeZone({ ...base, customTimezoneEnabled: true } as CharacterProfile)).toBe('Asia/Tokyo');
    });
    it('开启但无值 → undefined', () => {
        expect(resolveCharTimeZone({ customTimezoneEnabled: true } as CharacterProfile)).toBeUndefined();
    });
});

describe('tzShortLabel', () => {
    it('取清单标签里的第一个地名，去掉并列项和 UTC 偏移', () => {
        expect(tzShortLabel('America/New_York')).toBe('纽约');
        expect(tzShortLabel('Asia/Shanghai')).toBe('北京');
        expect(tzShortLabel('Asia/Tokyo')).toBe('东京');
    });
    it('单地名的条目原样取到', () => {
        expect(tzShortLabel('Europe/London')).toBe('伦敦');
        expect(tzShortLabel('Australia/Sydney')).toBe('悉尼');
    });
    it('不在清单里的时区退回 IANA id 末段', () => {
        expect(tzShortLabel('America/Argentina/Ushuaia')).toBe('Ushuaia');
        expect(tzShortLabel('Africa/Porto-Novo')).toBe('Porto-Novo');
    });
    it('结果够短，放得进卡片角标', () => {
        for (const id of ['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/Paris']) {
            expect(tzShortLabel(id).length).toBeLessThanOrEqual(6);
        }
    });
});
