/**
 * resilientFetch —— 全 App 通用的「带超时 + 瞬断补枪」fetch 薄壳。
 *
 * 背景（2026-07 网络瞬断三连修的推广篇）：APK 切后台再回前台时，系统 HTTP 栈会复用
 * 服务器已掐掉的 keep-alive 连接，第一枪必炸（unexpected end of stream / SSL handshake /
 * connection reset）——换条新连接重发几乎必成。聊天主链路已由 safeFetchJson 兜底，
 * 这里给**其余所有信息传输场景**（embedding / 备份 / worker / 新闻 / LLM 旁路）提供
 * 同等待遇，不用每处自己造轮子。
 *
 * 与 safeFetchJson 的分工：
 * - safeFetchJson：聊天主链路专用（原生 Chat Runtime、SSE 流式、采样参数自愈……全家桶）。
 * - resilientFetch：其它一切。只做两件事——超时（每次尝试独立计时）+ 瞬断重试；
 *   返回原始 Response，解析仍由调用方自理，接入成本 = 把 fetch( 换个名字。
 *
 * ⚠️ 重试安全性由调用方判断：非幂等 POST（会写数据且无去重的，如诗歌接龙 append）
 * 传 retries: 0 —— 只吃超时保护，不补枪，避免重发写两份。
 */

/** 瞬时网络错误判定：这类错误换条连接重试几乎必成（与 safeApi 的正则同源）。 */
export const isTransientNetError = (e: any): boolean => {
    if (!e) return false;
    if (e.name === 'TypeError') return true;      // WebView "Failed to fetch"（含 CORS/断网）
    if (e.name === 'AbortError') return true;     // 我们自己的超时 abort（值得换条连接再试）
    return /Failed to fetch|Load failed|NetworkError|timeout|aborted|unexpected end of stream|connection reset|connection abort|broken pipe|ssl|handshake|econnreset|epipe|stream.*reset|Connection refused|Unable to resolve host/i
        .test(e.message || '');
};

export interface ResilientFetchOptions {
    /** 每次尝试的硬超时毫秒数。默认 20s；LLM 生成类调用建议 120s。0 = 不超时。 */
    timeoutMs?: number;
    /** 额外补枪次数（不含首发）。默认 1。非幂等写请求传 0。 */
    retries?: number;
    /** HTTP 5xx / 429 是否也算可重试（响应会被丢弃换新请求）。默认 true。 */
    retryOn5xx?: boolean;
}

/**
 * 带超时 + 瞬断重试的 fetch。成功（含 4xx 等非网络失败）返回原始 Response。
 * 退避：1s、2s。外部 signal 生效：调用方 abort 时立即放弃且不再重试。
 */
export async function resilientFetch(
    url: string,
    init: RequestInit = {},
    opts: ResilientFetchOptions = {},
): Promise<Response> {
    const { timeoutMs = 20_000, retries = 1, retryOn5xx = true } = opts;
    let lastErr: any = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        // 每次尝试独立超时；与调用方自带的 signal 串联
        let attemptInit = init;
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (timeoutMs > 0) {
            const ac = new AbortController();
            timer = setTimeout(() => ac.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
            if (init.signal) {
                if (init.signal.aborted) { clearTimeout(timer); throw new Error('aborted'); }
                init.signal.addEventListener('abort', () => ac.abort(), { once: true });
            }
            attemptInit = { ...init, signal: ac.signal };
        }
        try {
            const res = await fetch(url, attemptInit);
            if (timer) clearTimeout(timer);
            // 5xx/429 换条连接再试（最后一次尝试就原样返回，让调用方按老路径报错）
            if (retryOn5xx && attempt < retries && (res.status === 429 || res.status >= 500)) {
                lastErr = new Error(`HTTP ${res.status}`);
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            return res;
        } catch (e: any) {
            if (timer) clearTimeout(timer);
            // 调用方主动 abort：立即放弃，不补枪
            if (init.signal?.aborted) throw e;
            lastErr = e;
            if (attempt < retries && isTransientNetError(e)) {
                console.warn(`🔁 [resilientFetch] 瞬断补枪 ${attempt + 1}/${retries}: ${e?.message || e}`, url.slice(0, 120));
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            throw e;
        }
    }
    throw lastErr || new Error('resilientFetch failed');
}

/** 只要超时不要重试的便捷款（非幂等写请求用）。 */
export const fetchWithTimeout = (url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> =>
    resilientFetch(url, init, { timeoutMs, retries: 0, retryOn5xx: false });
