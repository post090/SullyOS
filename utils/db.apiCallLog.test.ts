import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';

describe('API call log atomic persistence', () => {
    beforeEach(async () => {
        await DB.clearApiCallLog();
    });

    it('does not lose concurrent appends', async () => {
        const entries = Array.from({ length: 30 }, (_, index) => ({
            id: `concurrent-${index}`,
            timestamp: Date.now() + index,
            model: 'test-model',
            ok: true,
        }));

        await Promise.all(entries.map(entry => DB.appendApiCallLog(entry)));
        const stored = await DB.getApiCallLog();

        expect(stored.filter(entry => entry.id.startsWith('concurrent-'))).toHaveLength(entries.length);
    });

    it('merges duplicate request IDs instead of counting one HTTP request twice', async () => {
        const id = 'same-http-request';
        await DB.appendApiCallLog({ id, timestamp: Date.now(), model: 'm', ok: true });
        await DB.appendApiCallLog({
            id,
            timestamp: Date.now(),
            model: 'm',
            backendModel: 'm-backend',
            totalTokens: 123,
            ok: true,
        });

        const stored = (await DB.getApiCallLog()).filter(entry => entry.id === id);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ backendModel: 'm-backend', totalTokens: 123 });
    });
});
