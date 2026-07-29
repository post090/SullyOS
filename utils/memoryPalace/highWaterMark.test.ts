import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../db';
import {
    getLocalMemoryPalaceHighWaterMark,
    getReliableMemoryPalaceHighWaterMark,
    setReliableMemoryPalaceHighWaterMark,
} from './highWaterMark';

const CHAR_ID = 'hwm-test-character';
const LOCAL_KEY = `mp_lastMsgId_${CHAR_ID}`;
const MIRROR_KEY = `mp_hwm_v1_${CHAR_ID}`;

describe('Memory Palace high-water mark mirror', () => {
    beforeEach(async () => {
        localStorage.removeItem(LOCAL_KEY);
        await DB.deleteAsset(MIRROR_KEY).catch(() => {});
    });

    it('restores a waterline lost from localStorage using its IndexedDB mirror', async () => {
        await setReliableMemoryPalaceHighWaterMark(CHAR_ID, 321);
        localStorage.removeItem(LOCAL_KEY);

        expect(getLocalMemoryPalaceHighWaterMark(CHAR_ID)).toBe(0);
        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(321);
        expect(localStorage.getItem(LOCAL_KEY)).toBe('321');
    });

    it('uses the larger monotonic value and refreshes a stale mirror', async () => {
        await DB.saveAssetRaw(MIRROR_KEY, {
            version: 1,
            charId: CHAR_ID,
            msgId: 120,
            updatedAt: 1,
        });
        localStorage.setItem(LOCAL_KEY, '450');

        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(450);
        localStorage.removeItem(LOCAL_KEY);
        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(450);
    });

    it('ignores malformed or negative values', async () => {
        localStorage.setItem(LOCAL_KEY, '-9');
        await DB.saveAssetRaw(MIRROR_KEY, { msgId: 'not-a-number' });

        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(0);
    });
});
