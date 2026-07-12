/**
 * 通用 MCP 客户端 (Model Context Protocol, Streamable HTTP)
 *
 * 与 mcdMcpClient / luckinMcpClient 的「一家一个客户端」不同，这里是用户
 * 自配的任意远程 MCP 服务器：设置里填 URL（+ 可选 Bearer Token），发现工具后
 * 以 OpenAI function-calling 格式注入聊天请求，工具循环见 useChatAI。
 *
 * 网络路径（用户三选一，见 docs/mcp-client.md）：
 * 1. 直连 —— MCP 服务器 CORS 配置正确时（能读到 Mcp-Session-Id 响应头）
 * 2. 本地代理 —— node scripts/mcp-proxy.mjs，代理 URL 填 http://localhost:18061
 * 3. 用户自己的 Cloudflare Worker —— worker/mcp-proxy/，部署到用户自己的账号
 * 代理约定统一为 <代理URL>?target=<url-encoded 服务器URL>，可选 X-Proxy-Key 头。
 * 刻意不走中心 sfworker：MCP 流量（含用户的 Bearer Token）不该过项目方的服务器。
 */

export interface McpToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

export interface McpServerConfig {
    id: string;
    name: string;
    url: string;
    /** Bearer Token，可选（Authorization: Bearer <token>） */
    token?: string;
    /** 代理 URL，可选。空 = 浏览器直连 */
    proxyUrl?: string;
    /** 自部署 Worker 的防白嫖密钥，可选（X-Proxy-Key 头） */
    proxyKey?: string;
    enabled: boolean;
    /** 「发现工具」后持久化的工具清单（聊天注入直接读这里，不用每次握手） */
    tools?: McpToolDef[];
    /**
     * 绑定角色：空/缺省 = 通用（所有角色可用）；非空 = 只有这些角色能用。
     * 老配置没有该字段，天然落在通用语义上。
     */
    charIds?: string[];
    updatedAt: number;
}

export interface McpToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

const MCP_SERVERS_KEY = 'aetheros.mcp.servers';
const MCP_USE_NATIVE_TOOLS_KEY = 'aetheros.mcp.useNativeTools';
const MCP_PROTOCOL_VERSION = '2024-11-05';
// 远端 MCP / 用户自建代理都可能保持连接不结束。不能让一次 tools/call
// 永久卡住整条聊天链路（外层 isTyping 只有等 Promise 结束后才会清掉）。
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

// ========== 服务器配置 (持久化在 localStorage) ==========

export const loadMcpServers = (): McpServerConfig[] => {
    try {
        const raw = localStorage.getItem(MCP_SERVERS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
};

export const saveMcpServers = (servers: McpServerConfig[]): void => {
    try { localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers)); } catch { /* ignore */ }
};

/** 当前聊天模型/中转是否支持 OpenAI function calling；默认支持。 */
export const getMcpUseNativeTools = (): boolean => {
    try { return localStorage.getItem(MCP_USE_NATIVE_TOOLS_KEY) !== '0'; }
    catch { return true; }
};

export const setMcpUseNativeTools = (enabled: boolean): void => {
    try { localStorage.setItem(MCP_USE_NATIVE_TOOLS_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
};

export const createMcpServer = (name: string, url: string): McpServerConfig => ({
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    url,
    enabled: false,
    updatedAt: Date.now(),
});

/**
 * 启用且已发现工具、且对当前角色可见的服务器。
 * charId 缺省时只返回通用服务器（绑定了角色的必须给出匹配的 charId 才可见），
 * 保证没有角色上下文的调用点不会泄漏绑定服务器的工具。
 */
export const getEnabledMcpServers = (charId?: string): McpServerConfig[] =>
    loadMcpServers().filter(s =>
        s.enabled && s.url && (s.tools?.length || 0) > 0 &&
        (!s.charIds?.length || (charId != null && s.charIds.includes(charId))),
    );

/** 有任何一个启用且已发现工具、对该角色可见的服务器 → 聊天进入 MCP 工具模式 */
export const isMcpChatAvailable = (charId?: string): boolean => getEnabledMcpServers(charId).length > 0;

// ── 备份用：随「设置 → 导出/导入备份」一起带走（存 localStorage） ──
export function exportMcpLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const servers = localStorage.getItem(MCP_SERVERS_KEY);
        const useNativeTools = localStorage.getItem(MCP_USE_NATIVE_TOOLS_KEY);
        if (servers) out[MCP_SERVERS_KEY] = servers;
        if (useNativeTools) out[MCP_USE_NATIVE_TOOLS_KEY] = useNativeTools;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importMcpLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        if (typeof data[MCP_SERVERS_KEY] === 'string') localStorage.setItem(MCP_SERVERS_KEY, data[MCP_SERVERS_KEY]);
        if (typeof data[MCP_USE_NATIVE_TOOLS_KEY] === 'string') localStorage.setItem(MCP_USE_NATIVE_TOOLS_KEY, data[MCP_USE_NATIVE_TOOLS_KEY]);
    } catch { /* ignore */ }
}

// ========== JSON-RPC 会话状态 (内存, 每服务器一份) ==========

interface McpJsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: any;
    id?: number;
}

interface McpJsonRpcResponse {
    jsonrpc: '2.0';
    id?: number;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

interface McpSession {
    sessionId: string | null;
    initialized: boolean;
    initPromise: Promise<void> | null;
}

const sessions = new Map<string, McpSession>();
let requestIdCounter = 0;

const getSession = (serverId: string): McpSession => {
    let s = sessions.get(serverId);
    if (!s) {
        s = { sessionId: null, initialized: false, initPromise: null };
        sessions.set(serverId, s);
    }
    return s;
};

export const resetMcpSession = (serverId: string): void => {
    sessions.delete(serverId);
};

/** 实际请求地址：配了代理就包成 <proxy>?target=<url>，没配就直连 */
export const buildMcpFetchUrl = (server: Pick<McpServerConfig, 'url' | 'proxyUrl'>): string => {
    const proxy = (server.proxyUrl || '').trim().replace(/\/+$/, '');
    if (!proxy) return server.url;
    const sep = proxy.includes('?') ? '&' : '?';
    return `${proxy}${sep}target=${encodeURIComponent(server.url)}`;
};

const buildRequest = (method: string, params?: any, isNotification = false): McpJsonRpcRequest => {
    const req: McpJsonRpcRequest = { jsonrpc: '2.0', method, params };
    if (!isNotification) req.id = ++requestIdCounter;
    return req;
};

const parseSse = (text: string): McpJsonRpcResponse | null => {
    const dataLines: string[] = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('data:')) dataLines.push(line.slice(5));
    }
    for (let i = dataLines.length - 1; i >= 0; i--) {
        try { return JSON.parse(dataLines[i]); } catch { /* try previous */ }
    }
    return null;
};

const parseResp = (text: string, contentType: string): McpJsonRpcResponse => {
    if (contentType.includes('text/event-stream') || /^\s*(event:|data:)/.test(text)) {
        const parsed = parseSse(text);
        if (parsed) return parsed;
    }
    try { return JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        throw new Error(`MCP: 无法解析响应: ${text.slice(0, 300)}`);
    }
};

/** Streamable HTTP 的 SSE 可能保持连接；读到当前 JSON-RPC id 的结果即可返回。 */
const readSseResponse = async (resp: Response, expectedId: number | string | undefined): Promise<McpJsonRpcResponse> => {
    const reader = resp.body?.getReader();
    if (!reader) return parseResp(await resp.text(), 'text/event-stream');
    const decoder = new TextDecoder();
    let buffer = '';
    const parseEvent = (event: string): McpJsonRpcResponse | null => {
        const data = event.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data || data === '[DONE]') return null;
        try {
            const parsed = JSON.parse(data) as McpJsonRpcResponse;
            return expectedId == null || parsed.id === expectedId ? parsed : null;
        } catch { return null; }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';
            for (const event of events) {
                const parsed = parseEvent(event);
                if (parsed) return parsed;
            }
            if (done) {
                const parsed = parseEvent(buffer);
                if (parsed) return parsed;
                throw new Error('MCP SSE 流结束，但没有收到本次请求的响应');
            }
        }
    } finally {
        await reader.cancel().catch(() => { /* 已结束或已 abort */ });
    }
};

const post = async (
    server: McpServerConfig,
    body: McpJsonRpcRequest,
    expectResponse = true,
): Promise<{ response: McpJsonRpcResponse | null }> => {
    const session = getSession(server.id);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    if (server.token) headers['Authorization'] = `Bearer ${server.token}`;
    if (server.proxyUrl && server.proxyKey) headers['X-Proxy-Key'] = server.proxyKey;
    if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;

    let resp: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP_REQUEST_TIMEOUT_MS);
    try {
        try {
            resp = await fetch(buildMcpFetchUrl(server), {
                method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
            });
        } catch (e: any) {
            if (controller.signal.aborted) {
                throw new Error(`MCP 请求超时（${Math.round(MCP_REQUEST_TIMEOUT_MS / 1000)} 秒）`);
            }
            // 直连时 fetch 抛 TypeError 十有八九是 CORS，把排查方向直接告诉用户
            const hint = server.proxyUrl
                ? '请检查代理 URL 是否可访问、代理密钥是否正确。'
                : '很可能是浏览器 CORS 限制。请在这个服务器的「代理 URL」里配置代理（本地 node scripts/mcp-proxy.mjs 或自部署 worker/mcp-proxy）。';
            throw new Error(`MCP 请求失败: ${e?.message || e}。${hint}`);
        }

        // fetch 拿到响应头不代表 SSE 响应体已经结束；DeepWiki / 代理若一直不关流，
        // resp.text() 同样必须受同一个超时控制。
        const readText = async (): Promise<string> => {
            try { return await resp.text(); }
            catch (e) {
                if (controller.signal.aborted) {
                    throw new Error(`MCP 请求超时（${Math.round(MCP_REQUEST_TIMEOUT_MS / 1000)} 秒）`);
                }
                throw e;
            }
        };

        const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
        if (newSid) session.sessionId = newSid;

        if (resp.status === 401 || resp.status === 403) {
            const txt = await readText().catch(() => '');
            throw new Error(`MCP 鉴权失败 (${resp.status}): Token 可能无效或过期。${txt.slice(0, 120)}`);
        }
        if (resp.status === 202) return { response: null };
        if (!resp.ok) {
            const txt = await readText().catch(() => '');
            throw new Error(`MCP HTTP ${resp.status}: ${txt.slice(0, 200)}`);
        }
        if (!expectResponse) return { response: null };

        const ct = resp.headers.get('content-type') || '';
        try {
            if (ct.includes('text/event-stream')) {
                return { response: await readSseResponse(resp, body.id) };
            }
            const text = await readText();
            return { response: parseResp(text, ct) };
        } catch (e) {
            if (controller.signal.aborted) {
                throw new Error(`MCP 请求超时（${Math.round(MCP_REQUEST_TIMEOUT_MS / 1000)} 秒）`);
            }
            throw e;
        }
    } finally {
        clearTimeout(timeoutId);
    }
};

const doInitialize = async (server: McpServerConfig): Promise<void> => {
    const session = getSession(server.id);
    const initReq = buildRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'SullyOS-MCP', version: '1.0.0' },
    });
    const { response } = await post(server, initReq);
    if (response?.error) throw new Error(`Initialize 失败: ${response.error.message}`);

    // 直连模式下读不到 Session-Id 说明 CORS 没暴露响应头（服务器可能有会话但我们拿不到），
    // Streamable HTTP 无状态服务器也可能压根不发。这里不硬报错：tools/list 能通就算能用。
    const notif = buildRequest('notifications/initialized', {}, true);
    await post(server, notif, false).catch(() => { /* notification 失败不阻塞 */ });

    session.initialized = true;
};

const ensureInitialized = async (server: McpServerConfig): Promise<void> => {
    const session = getSession(server.id);
    if (session.initialized) return;
    if (!session.initPromise) {
        session.initPromise = doInitialize(server).catch((e) => {
            session.initPromise = null;
            throw e;
        });
    }
    await session.initPromise;
};

// ========== 公开 API ==========

/** 握手 + tools/list。调用方负责把返回的工具清单存回 McpServerConfig.tools */
export const discoverMcpTools = async (server: McpServerConfig): Promise<McpToolDef[]> => {
    resetMcpSession(server.id);
    await ensureInitialized(server);
    const { response } = await post(server, buildRequest('tools/list'));
    if (response?.error) throw new Error(`tools/list 失败: ${response.error.message}`);
    const tools = response?.result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
    }));
};

/** 调用一个工具（会自动补握手；session 失效自动重试一次） */
export const callMcpTool = async (
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any> = {},
): Promise<McpToolResult> => {
    const finish = (result: McpToolResult): McpToolResult => {
        let resultPreview = '';
        if (result.success) {
            try { resultPreview = JSON.stringify(result.data).slice(0, 800); }
            catch { resultPreview = String(result.data).slice(0, 800); }
        }
        // 不记录 URL / Token，只证明真实 tools/call 的目标、参数与服务端返回。
        console.info('🔌 [MCP] tools/call 完成', {
            server: server.name,
            tool: toolName,
            args,
            success: result.success,
            ...(result.success ? { result: resultPreview } : { error: result.error }),
        });
        return result;
    };
    try {
        await ensureInitialized(server);
        const body = buildRequest('tools/call', { name: toolName, arguments: args });
        let response: McpJsonRpcResponse | null;
        try {
            ({ response } = await post(server, body));
        } catch (e: any) {
            // 404/400 常见于服务器重启后 session 失效，重握手再试一次
            if (/HTTP (400|404)/.test(e?.message || '')) {
                resetMcpSession(server.id);
                await ensureInitialized(server);
                ({ response } = await post(server, buildRequest('tools/call', { name: toolName, arguments: args })));
            } else {
                throw e;
            }
        }
        if (!response) return finish({ success: false, error: '空响应' });
        if (response.error) return finish({ success: false, error: `MCP 错误 [${response.error.code}]: ${response.error.message}` });

        const result = response.result;
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return finish({ success: false, error: fullText || 'MCP 工具执行失败', rawText: fullText });
            try {
                return finish({ success: true, data: JSON.parse(fullText), rawText: fullText });
            } catch {
                return finish({ success: true, data: fullText, rawText: fullText });
            }
        }
        return finish({ success: true, data: result });
    } catch (e: any) {
        return finish({ success: false, error: e?.message || String(e) });
    }
};

/** 测试连接: 验证握手 + tools/list 能通，返回工具清单供持久化 */
export const testMcpConnection = async (server: McpServerConfig): Promise<{ ok: boolean; message: string; tools?: McpToolDef[] }> => {
    try {
        const tools = await discoverMcpTools(server);
        if (!tools.length) return { ok: true, message: '已连接, 但工具清单为空', tools };
        return { ok: true, message: `已连接, 发现 ${tools.length} 个工具: ${tools.map(t => t.name).slice(0, 8).join('、')}${tools.length > 8 ? '…' : ''}`, tools };
    } catch (e: any) {
        return { ok: false, message: e?.message || String(e) };
    }
};
