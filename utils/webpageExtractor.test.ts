import { describe, it, expect, afterEach, vi } from 'vitest';
import { detectFirstUrl, isXhsUrl, parseWebpageHtml, extractWebpageContent } from './webpageExtractor';

describe('detectFirstUrl', () => {
  it('从一句话里揪出 http(s) 链接', () => {
    expect(detectFirstUrl('看看这个 https://example.com/article 挺有意思'))
      .toBe('https://example.com/article');
    expect(detectFirstUrl('http://foo.bar/baz')).toBe('http://foo.bar/baz');
  });

  it('中文句号不进 URL，英文尾标点被剥掉', () => {
    // 中文句号不在 URL 字符集里, 正则到此截断
    expect(detectFirstUrl('链接是 https://example.com/x。后面还有字')).toBe('https://example.com/x');
    // 英文句点/右括号结尾要被剥掉
    expect(detectFirstUrl('see (https://example.com/a).')).toBe('https://example.com/a');
  });

  it('没有链接时返回 null', () => {
    expect(detectFirstUrl('就是普通聊天没有网址')).toBeNull();
    expect(detectFirstUrl('')).toBeNull();
    expect(detectFirstUrl('ftp://nope.com')).toBeNull();
  });
});

describe('isXhsUrl', () => {
  it('识别小红书域名（已有专门 MCP 路径，网页抓取要避开）', () => {
    expect(isXhsUrl('https://www.xiaohongshu.com/explore/abc')).toBe(true);
    expect(isXhsUrl('https://xhslink.com/xxx')).toBe(true);
    expect(isXhsUrl('https://example.com')).toBe(false);
  });
});

describe('parseWebpageHtml', () => {
  // node 测试环境无 DOMParser，会走正则 fallback（htmlToText）。两条路径都应产出标题/正文。
  const html = `
    <html><head>
      <title>测试标题</title>
      <meta name="description" content="这是一段网页摘要描述">
      <meta property="og:site_name" content="测试站">
    </head><body>
      <nav>导航不该进正文</nav>
      <article><p>第一段正文内容。</p><p>第二段正文内容。</p></article>
      <script>console.log('noise')</script>
    </body></html>`;

  it('提取出正文文字（去掉 script 噪音）', () => {
    const r = parseWebpageHtml(html, 'https://test.example.com/p');
    expect(r.content).toContain('第一段正文内容');
    expect(r.content).toContain('第二段正文内容');
    expect(r.content).not.toContain('console.log');
  });

  it('没有站点名时用域名兜底', () => {
    const r = parseWebpageHtml('<p>hi</p>', 'https://www.foo.bar/x');
    expect(r.siteName).toBe('foo.bar');
    expect(r.title).toBeTruthy();
  });

  it('摘要非空且有上限', () => {
    const longBody = '<p>' + '内容'.repeat(500) + '</p>';
    const r = parseWebpageHtml(longBody, 'https://x.com');
    expect(r.excerpt.length).toBeLessThanOrEqual(141); // 140 + 省略号
  });
});

describe('extractWebpageContent 提取链路（apizero 主 → sfworker/Jina 降级）', () => {
  // 长到能过 MIN_EXTRACT_CHARS(80) 的正文样例。
  const LONG_BODY = 'curl 是常用的命令行工具，用来请求 Web 服务器。'.repeat(10);

  // apizero content-extract 的真实响应结构（阮一峰博客实测裁剪版）。
  const apizeroOk = {
    code: 0,
    msg: '成功',
    data: {
      url: 'https://www.ruanyifeng.com/blog/2019/09/curl-reference.html',
      title: 'curl 的用法指南',
      publish_time: '',
      content: LONG_BODY,
      word_count: LONG_BODY.length,
      reading_time: '2 分钟',
      image_count: 1,
      images: ['https://www.ruanyifeng.com/blog/images/cover.png'],
    },
  };

  // 按 URL 分流的 fetch stub：apizero 端点一份响应，sfworker /fetch-webpage 一份响应。
  const stubFetch = (apizeroBody: any, workerBody?: any) => {
    const fn = vi.fn(async (input: any) => {
      const target = String(input);
      const body = target.includes('apizero.cn') ? apizeroBody : workerBody;
      if (body === undefined) throw new Error(`unexpected fetch: ${target}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('主路径：apizero 成功 → 直接用其结果，不再碰 sfworker', async () => {
    const fn = stubFetch(apizeroOk);
    const wp = await extractWebpageContent('https://www.ruanyifeng.com/blog/2019/09/curl-reference.html');
    expect(wp.title).toBe('curl 的用法指南');
    expect(wp.content).toBe(LONG_BODY);
    expect(wp.siteName).toBe('ruanyifeng.com');
    expect(wp.image).toBe('https://www.ruanyifeng.com/blog/images/cover.png');
    expect(wp.excerpt.length).toBeGreaterThan(0);
    expect(wp.video).toBeUndefined();
    // 只调了 apizero 一次，没走 worker
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).toContain('apizero.cn/api/content-extract');
    expect(String(fn.mock.calls[0][0])).toContain('key=sk_live_'); // 内置 key 带上了
  });

  it('apizero 业务失败（code≠0）→ 降级 sfworker/Jina 老链路', async () => {
    const fn = stubFetch(
      { code: 5020, msg: '目标网页无法访问' },
      { success: true, data: { mode: 'reader', title: 'Jina 抓到的标题', content: LONG_BODY } },
    );
    const wp = await extractWebpageContent('https://example.com/a');
    expect(wp.title).toBe('Jina 抓到的标题');
    expect(wp.content).toBe(LONG_BODY);
    expect(fn).toHaveBeenCalledTimes(2); // apizero 一次 + worker 一次
  });

  it('apizero 正文过短（SPA 壳 / 登录墙 / 文档站）→ 降级 Jina 拿正文，不拿壳当正文', async () => {
    const fn = stubFetch(
      { code: 0, data: { title: '标题', content: '请开启 JavaScript', images: [] } },
      { success: true, data: { mode: 'reader', title: '渲染后的真标题', content: LONG_BODY } },
    );
    const wp = await extractWebpageContent('https://spa.example.com/page');
    expect(wp.title).toBe('渲染后的真标题');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('超长正文截断到 8000 字并标记 truncated', async () => {
    const huge = 'x'.repeat(9000);
    stubFetch({ code: 0, data: { title: '长文', content: huge, images: [] } });
    const wp = await extractWebpageContent('https://example.com/long');
    expect(wp.content.length).toBe(8000);
    expect(wp.truncated).toBe(true);
  });
});
