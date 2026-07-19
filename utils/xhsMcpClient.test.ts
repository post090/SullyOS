import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XhsMcpClient } from './xhsMcpClient';

function jsonResponse(body: any, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('XhsMcpClient Bridge credentials', () => {
    beforeEach(() => {
        localStorage.clear();
        XhsMcpClient.setCookie();
        XhsMcpClient.setBridgeToken();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('电脑 Skills Bridge 的 health 和命令请求都携带 Bearer token', async () => {
        const url = 'http://192.168.1.8:18061/api';
        const calls: Array<{ url: string; headers: Headers }> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), headers: new Headers(init?.headers) });
            if (String(input).endsWith('/api/health')) return jsonResponse({ status: 'ok' });
            if (String(input).endsWith('/api/check-login')) return jsonResponse({ logged_in: false });
            throw new Error(`unexpected request: ${String(input)}`);
        }));

        const result = await XhsMcpClient.testConnection(url, undefined, 'bridge-secret');

        expect(result.connected).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls.every(call => call.headers.get('authorization') === 'Bearer bridge-secret')).toBe(true);
        expect(calls.every(call => call.headers.get('x-xhs-cookie') === null)).toBe(true);
    });

    it('从电脑 Bridge 切到 Lite 时不泄漏 Bridge token，只发送 Lite cookie', async () => {
        const computerUrl = 'http://192.168.1.8:18061/api';
        const liteUrl = 'https://worker.example/api';
        XhsMcpClient.setBridgeToken('bridge-secret', computerUrl);

        const calls: Array<{ url: string; headers: Headers }> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), headers: new Headers(init?.headers) });
            if (String(input).endsWith('/api/health')) return jsonResponse({ status: 'ok' });
            if (String(input).endsWith('/api/check-login')) return jsonResponse({ logged_in: false });
            throw new Error(`unexpected request: ${String(input)}`);
        }));

        const result = await XhsMcpClient.testConnection(liteUrl, 'a1=x; web_session=y', undefined);

        expect(result.connected).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls.every(call => call.headers.get('authorization') === null)).toBe(true);
        expect(calls.every(call => call.headers.get('x-xhs-cookie') === 'a1=x; web_session=y')).toBe(true);
    });

    it('网络层拦截时返回可操作的局域网诊断，不只暴露 Failed to fetch', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }));

        const url = 'http://192.168.1.8:18061/api';
        const result = await XhsMcpClient.testConnection(url, undefined, 'bridge-secret');

        expect(result.connected).toBe(false);
        expect(result.error).toContain('无法访问电脑 Bridge');
        expect(result.error).toContain('同一 Wi-Fi');
        expect(result.error).toContain('CORS/PNA');
    });

    it('服务端拒绝 token 时返回明确鉴权错误', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Bridge 访问令牌错误或未提供' }, 401)));

        const result = await XhsMcpClient.testConnection('http://192.168.1.8:18061/api', undefined, 'wrong');

        expect(result).toEqual({ connected: false, error: 'Bridge 访问令牌错误或未填写' });
    });
});
