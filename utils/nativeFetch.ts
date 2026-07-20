import { Capacitor, CapacitorHttp } from '@capacitor/core';

const isNativePlatform = (): boolean => {
    try { return Capacitor.isNativePlatform(); } catch { return false; }
};

/**
 * fetch 的原生绕 CORS 版：原生平台（Android/iOS WebView）走 CapacitorHttp（系统 HTTP 栈，
 * 无 CORS、无预检），web 端继续用浏览器 fetch。返回标准 Response，可直接喂给 safeResponseJson
 * 等期望 Response 的工具，调用方几乎不用改。
 *
 * 用途：Settings 里测第三方 API（刷新模型列表、测试 API 连接等）——这些端点多半没配 CORS，
 * 在 WebView 里裸 fetch 会被挡成 "Failed to fetch"。走 CapacitorHttp 绕过。
 *
 * 限制：CapacitorHttp 不支持流式，整包响应一次拿回。对 API 测试/模型列表这种小响应无所谓；
 * 别拿它做 SSE 长连接聊天（那是 safeApi 的事，且聊天能跑就别动）。
 */
export async function nativeFetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (!isNativePlatform()) {
        return fetch(url, init);
    }
    const headersObj: Record<string, string> = {};
    const h = init.headers;
    if (h) {
        if (h instanceof Headers) {
            h.forEach((v, k) => { headersObj[k] = v; });
        } else if (Array.isArray(h)) {
            for (const [k, v] of h) headersObj[k] = String(v);
        } else {
            Object.assign(headersObj, h as Record<string, string>);
        }
    }
    let data: any;
    if (init.body != null) {
        const bodyStr = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        try { data = JSON.parse(bodyStr); } catch { data = bodyStr; }
    }
    const r = await CapacitorHttp.request({
        url,
        method: (init.method as string) || 'GET',
        headers: headersObj,
        data,
    });
    const dataStr = typeof r.data === 'string' ? r.data : (r.data == null ? '' : JSON.stringify(r.data));
    const respHeaders = new Headers();
    for (const [k, v] of Object.entries(r.headers || {})) respHeaders.set(k, String(v));
    return new Response(dataStr, { status: r.status, headers: respHeaders });
}
