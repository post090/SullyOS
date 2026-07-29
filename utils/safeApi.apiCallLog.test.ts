import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    recordApiCall: vi.fn(),
}));

vi.mock('./apiCallLog', () => ({
    recordApiCall: mocks.recordApiCall,
    getApiCallAmbientContext: () => ({}),
}));

import { safeFetchJson } from './safeApi';

describe('safeFetchJson API log fallback', () => {
    beforeEach(() => {
        mocks.recordApiCall.mockReset();
        vi.restoreAllMocks();
    });

    it('records the parsed chat response without depending on Response.clone()', async () => {
        const responseBody = {
            model: 'backend-model',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify(responseBody),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        const meta = { appName: '消息', purpose: '聊天回复' };

        await safeFetchJson(
            'https://api.test/v1/chat/completions',
            { method: 'POST', body: JSON.stringify({ model: 'requested-model', messages: [{ role: 'user', content: 'hi' }] }) },
            0,
            0,
            meta,
        );

        expect(fetchMock).toHaveBeenCalledOnce();
        const requestInit = fetchMock.mock.calls[0][1] as RequestInit & { __sullyApiCallId?: string };
        expect(requestInit.__sullyApiCallId).toMatch(/^api-/);
        expect(mocks.recordApiCall).toHaveBeenCalledWith(expect.objectContaining({
            requestId: requestInit.__sullyApiCallId,
            ok: true,
            response: responseBody,
            meta,
        }));
    });
});
