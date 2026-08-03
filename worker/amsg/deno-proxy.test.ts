/**
 * Deno 代理层的回归守卫。
 *
 * 这两组断言各自钉住一个「改坏了不会当场报错、但线上会出怪事」的行为：
 *   - 响应头清洗：留着 content-encoding 的话，浏览器会拿已经解压过的 body 再解一次，
 *     报的错跟真实原因八竿子打不着。
 *   - 请求改写：host 没换掉的话上游收到的是 deno.net 的 host；路径前缀吃掉的话
 *     上游地址带子路径的人会 404。
 */
import { describe, expect, it, vi } from 'vitest';

// deno-proxy.ts 顶层就调 Deno.serve()，import 之前得先把 Deno 垫上，
// 否则模块一加载就 ReferenceError。serve 垫成空实现，不真起服务。
vi.stubGlobal('Deno', {
  env: { get: (): string | undefined => undefined },
  serve: (): void => undefined,
});

const { buildUpstreamRequest, relayResponse, isConfigured } = await import('./deno-proxy');

describe('relayResponse - 响应头清洗', () => {
  /** 造一个「上游回了压缩响应」的场景：fetch 已经替我们解压，但头还留着压缩前的描述。 */
  const upstreamResponse = () =>
    new Response('{"success":true}', {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': '1234',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'X-Amsg-Server-Version': '2.6.0',
      },
    });

  it('摘掉 content-encoding：留着的话浏览器会对已解压的 body 再解一次压', () => {
    expect(relayResponse(upstreamResponse()).headers.get('content-encoding')).toBeNull();
  });

  it('摘掉 content-length：解压后长度已经对不上了', () => {
    expect(relayResponse(upstreamResponse()).headers.get('content-length')).toBeNull();
  });

  it('摘掉 transfer-encoding：逐跳头，跨代理带过去没有意义', () => {
    expect(relayResponse(upstreamResponse()).headers.get('transfer-encoding')).toBeNull();
  });

  it('业务头原样留着 —— 别把 CORS 和版本号一起清掉了', () => {
    const relayed = relayResponse(upstreamResponse());
    expect(relayed.headers.get('access-control-allow-origin')).toBe('*');
    expect(relayed.headers.get('x-amsg-server-version')).toBe('2.6.0');
    expect(relayed.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('状态码和 body 原样透传', async () => {
    const relayed = relayResponse(
      new Response('nope', { status: 401, statusText: 'Unauthorized' }),
    );
    expect(relayed.status).toBe(401);
    expect(await relayed.text()).toBe('nope');
  });
});

describe('buildUpstreamRequest - 请求改写', () => {
  const incoming = (url: string, init?: RequestInit) => new Request(url, init);

  it('路径和查询串原样接到上游域名后面', () => {
    const rewritten = buildUpstreamRequest(
      incoming('https://proxy.deno.net/init-tenant?foo=bar'),
      'https://amsg.example.workers.dev',
    );
    expect(rewritten.url).toBe('https://amsg.example.workers.dev/init-tenant?foo=bar');
  });

  it('上游地址带子路径时不能把前缀吃掉', () => {
    const rewritten = buildUpstreamRequest(
      incoming('https://proxy.deno.net/capabilities'),
      'https://example.com/amsg',
    );
    expect(rewritten.url).toBe('https://example.com/amsg/capabilities');
  });

  it('删掉 host：不删的话上游收到的是 deno.net 的 host', () => {
    const request = incoming('https://proxy.deno.net/config-check', {
      headers: { Host: 'proxy.deno.net' },
    });
    expect(buildUpstreamRequest(request, 'https://amsg.example.workers.dev').headers.get('host'))
      .toBeNull();
  });

  it('鉴权头和自定义头必须原样带过去，否则 amsg 一律 401', () => {
    const request = incoming('https://proxy.deno.net/init-tenant', {
      method: 'POST',
      headers: {
        'X-Client-Token': 'shared-secret',
        'X-User-Id': 'u-1',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const rewritten = buildUpstreamRequest(request, 'https://amsg.example.workers.dev');
    expect(rewritten.headers.get('x-client-token')).toBe('shared-secret');
    expect(rewritten.headers.get('x-user-id')).toBe('u-1');
    expect(rewritten.headers.get('content-type')).toBe('application/json');
  });

  it('方法原样保留，POST 的 body 跟着走', async () => {
    const request = incoming('https://proxy.deno.net/init-tenant', {
      method: 'POST',
      body: '{"probe":true}',
    });
    const rewritten = buildUpstreamRequest(request, 'https://amsg.example.workers.dev');
    expect(rewritten.method).toBe('POST');
    expect(await rewritten.text()).toBe('{"probe":true}');
  });

  it('GET 不能带 body', () => {
    const rewritten = buildUpstreamRequest(
      incoming('https://proxy.deno.net/capabilities'),
      'https://amsg.example.workers.dev',
    );
    expect(rewritten.body).toBeNull();
  });
});

describe('isConfigured - 上游地址有没有填', () => {
  it('占位符没改 → 判定为没配，好让自检端点直说而不是闷头转发', () => {
    expect(isConfigured('https://sullyos-amsg.你的账号.workers.dev')).toBe(false);
  });

  it('填了真实地址 → 通过', () => {
    expect(isConfigured('https://amsg.example.workers.dev')).toBe(true);
  });

  it('不是 http(s) 开头 → 不通过', () => {
    expect(isConfigured('amsg.example.workers.dev')).toBe(false);
    expect(isConfigured('')).toBe(false);
  });
});
