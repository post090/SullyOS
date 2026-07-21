import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
    DB: {
        getDailySchedule: vi.fn(),
        saveDailySchedule: vi.fn(),
    },
}));

import { DB } from './db';
import { getLocalDailySchedule } from './dailySchedule';
import type { DailySchedule } from '../types';

const originalTimeZone = process.env.TZ;
const getSchedule = vi.mocked(DB.getDailySchedule);
const saveSchedule = vi.mocked(DB.saveDailySchedule);

afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});

beforeEach(() => {
    process.env.TZ = 'Asia/Shanghai';
    getSchedule.mockReset();
    saveSchedule.mockReset();
});

const schedule = (date: string, generatedAt: number): DailySchedule => ({
    id: `char-1_${date}`,
    charId: 'char-1',
    date,
    slots: [{ startTime: '08:00', activity: '早餐' }],
    generatedAt,
});

describe('local daily schedule compatibility', () => {
    it('loads the China-local key directly', async () => {
        const at = new Date('2026-07-20T16:30:00.000Z'); // 北京 7/21 00:30
        const current = schedule('2026-07-21', at.getTime());
        getSchedule.mockResolvedValueOnce(current);

        await expect(getLocalDailySchedule('char-1', at)).resolves.toBe(current);
        expect(getSchedule).toHaveBeenCalledWith('char-1', '2026-07-21');
        expect(saveSchedule).not.toHaveBeenCalled();
    });

    it('rekeys a legacy UTC record only when generated on the current local day', async () => {
        const at = new Date('2026-07-20T16:30:00.000Z');
        const legacy = schedule('2026-07-20', at.getTime());
        getSchedule.mockResolvedValueOnce(null).mockResolvedValueOnce(legacy);

        const result = await getLocalDailySchedule('char-1', at);
        expect(result?.date).toBe('2026-07-21');
        expect(result?.id).toBe('char-1_2026-07-21');
        expect(saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
            id: 'char-1_2026-07-21',
            date: '2026-07-21',
        }));
    });

    it('does not rewrite a genuinely historical legacy record', async () => {
        const at = new Date('2026-07-20T16:30:00.000Z');
        const historical = schedule('2026-07-20', new Date('2026-07-20T02:00:00.000Z').getTime());
        getSchedule.mockResolvedValueOnce(null).mockResolvedValueOnce(historical);

        await expect(getLocalDailySchedule('char-1', at)).resolves.toBeNull();
        expect(saveSchedule).not.toHaveBeenCalled();
    });
});
