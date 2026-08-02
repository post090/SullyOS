// utils/xhsMcpClient.concurrency.test.ts
// MCP 握手的并发安全。
//
// mcpCallTool 里是 `if (!mcpInitialized) await mcpInitialize(...)` 这种 check-then-act：
// 两个调用同时进来时都会看到 mcpInitialized=false，于是各握一次手，后完成的那个把
// 模块级 mcpSessionId 覆盖掉——先发起的那个再拿它发 tools/call，用的就是别人的 session
// （表现是随机的 MCP session error / 空结果）。
//
// worker 到点最多并发跑 8 个任务，两个任务同一分钟都用小红书工具就会踩到。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SERVER = 'https://xhs.example.com/mcp';

/** 记录每次 fetch 的 method 与带上的 session 头。 */
type Seen = { method: string; session: string | null };

const setupFetch = (opts: { initDelayMs: number }) => {
  const seen: Seen[] = [];
  let sessionSeq = 0;

  const fetchMock = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const session = (init.headers || {})['Mcp-Session-Id'] ?? null;
    seen.push({ method: body.method, session });

    if (body.method === 'initialize') {
      // 握手慢：给并发的第二个调用留出「也看到 mcpInitialized=false」的窗口
      await new Promise((r) => setTimeout(r, opts.initDelayMs));
      const id = `sess-${++sessionSeq}`;
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'mcp-session-id' ? id : 'application/json') },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } }),
      };
    }
    if (body.method === 'tools/list') {
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'mcp-session-id' ? null : 'application/json') },
        text: async () => JSON.stringify({
          jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search' }] },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'mcp-session-id' ? null : 'application/json') },
      text: async () => JSON.stringify({
        jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"notes":[]}' }] },
      }),
    };
  });

  vi.stubGlobal('fetch', fetchMock);
  return { seen };
};

describe('XHS MCP 握手的并发安全', () => {
  beforeEach(() => {
    vi.resetModules();  // 模块级 session 状态每个用例重来
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('两个调用并发进来，只握一次手（回归：重复 initialize）', async () => {
    const { seen } = setupFetch({ initDelayMs: 20 });
    const { XhsMcpClient } = await import('./xhsMcpClient');

    await Promise.all([
      XhsMcpClient.search(SERVER, 'k1'),
      XhsMcpClient.search(SERVER, 'k2'),
    ]);

    expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
  });

  it('两个并发调用带的是同一个 session（回归：后握手的把先前的 session 覆盖掉）', async () => {
    const { seen } = setupFetch({ initDelayMs: 20 });
    const { XhsMcpClient } = await import('./xhsMcpClient');

    await Promise.all([
      XhsMcpClient.search(SERVER, 'k1'),
      XhsMcpClient.search(SERVER, 'k2'),
    ]);

    const callSessions = seen.filter((s) => s.method === 'tools/call').map((s) => s.session);
    expect(callSessions).toHaveLength(2);
    expect(callSessions[0]).toBe('sess-1');
    expect(callSessions[1]).toBe('sess-1');
  });

  it('握手完成后的调用直接复用，不再重复握手', async () => {
    const { seen } = setupFetch({ initDelayMs: 0 });
    const { XhsMcpClient } = await import('./xhsMcpClient');

    await XhsMcpClient.search(SERVER, 'k1');
    await XhsMcpClient.search(SERVER, 'k2');

    expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
  });

  it('握手失败不留下「正在握手」的残留，下一次调用能重新握手', async () => {
    const failing = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', failing);
    const { XhsMcpClient } = await import('./xhsMcpClient');

    const first = await XhsMcpClient.search(SERVER, 'k1');
    expect(first.success).toBe(false);

    const { seen } = setupFetch({ initDelayMs: 0 });
    const second = await XhsMcpClient.search(SERVER, 'k2');
    expect(second.success).toBe(true);
    expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
  });
});
