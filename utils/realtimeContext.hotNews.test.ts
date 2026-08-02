import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOTNEWS_API_BASE_URL, RealtimeContextManager } from './realtimeContext';

function jsonResponse(body: unknown, ok = true, status = 200) {
    return {
        ok,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(body),
    } as any;
}

beforeEach(() => {
    RealtimeContextManager.clearCache();
    vi.restoreAllMocks();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('RealtimeContextManager.fetchHotNews', () => {
    it('uses the migrated news.orz.ai API and supports desc/content summaries', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            status: '200',
            data: [
                { title: 'First headline', url: 'https://example.com/1', desc: '  Upstream summary  ' },
                { title: 'Second headline', url: 'https://example.com/2', content: 'Upstream content' },
                { title: 'Third headline', url: 'https://example.com/3', content: 'Third headline' },
            ],
            msg: 'success',
        })));

        const items = await RealtimeContextManager.fetchHotNews(['weibo']);

        expect(fetch).toHaveBeenCalledOnce();
        const requestedUrl = vi.mocked(fetch).mock.calls[0][0] as string;
        expect(requestedUrl).toBe(`${HOTNEWS_API_BASE_URL}/?platform=weibo`);
        expect(requestedUrl).not.toContain('https://orz.ai/');
        expect(items).toEqual([
            { title: 'First headline', source: RealtimeContextManager.HOTNEWS_PLATFORM_LABELS.weibo, origin: 'weibo', url: 'https://example.com/1', desc: 'Upstream summary' },
            { title: 'Second headline', source: RealtimeContextManager.HOTNEWS_PLATFORM_LABELS.weibo, origin: 'weibo', url: 'https://example.com/2', desc: 'Upstream content' },
            { title: 'Third headline', source: RealtimeContextManager.HOTNEWS_PLATFORM_LABELS.weibo, origin: 'weibo', url: 'https://example.com/3', desc: undefined },
        ]);
    });

    it('returns an empty list on upstream HTTP errors so existing fallbacks can run', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 503)));

        await expect(RealtimeContextManager.fetchHotNews(['weibo'])).resolves.toEqual([]);
    });
});
