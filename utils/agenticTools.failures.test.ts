// utils/agenticTools.failures.test.ts
//
// 回归守卫：工具「没跑成」不能被说成「跑了但没结果」。
//
// 这一组 bug 长得都一样——数据源的 success:false 里混着两种完全不同的事（连不上 / 真的
// 没有），工具却把它们归成同一个 reason。护栏（agenticToolFeedback 的 NEVER_RAN_REASONS）
// 只认得出「没跑成」那一类，混过去之后角色就会把没发生的事说成发生过：Notion 凭据过期
// 时张口就是「你昨天没写日记呀」。
//
// 所以每条用例除了断 reason，还会把结果喂给回喂层，确认模型收到的是「这件事没有发生」。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./realtimeFetchCore', () => ({
  performSearch: vi.fn(),
  notionGetDiaryByDate: vi.fn(),
  notionReadDiaryContent: vi.fn(),
  notionReadNoteContent: vi.fn(),
  notionSearchUserNotes: vi.fn(),
  feishuGetDiaryByDate: vi.fn(),
}));

import {
  runSearch,
  runReadDiary,
  runFsReadDiary,
  runReadNote,
  runXhsMyProfile,
  type AgenticToolCtx,
} from './agenticTools';
import * as core from './realtimeFetchCore';
import { XhsMcpClient } from './xhsMcpClient';
import { buildToolResultMessage } from './agenticToolFeedback';

const mocked = core as unknown as Record<string, ReturnType<typeof vi.fn>>;

const ctx = (realtimeConfig: Record<string, unknown>): AgenticToolCtx => ({
  char: { name: '测试角色' },
  userProfile: { name: '用户' } as any,
  realtimeConfig: realtimeConfig as any,
});

const notionCtx = ctx({
  notionEnabled: true,
  notionApiKey: 'key',
  notionDatabaseId: 'db',
  notionNotesDatabaseId: 'notes-db',
});

const feishuCtx = ctx({
  feishuEnabled: true,
  feishuAppId: 'app',
  feishuAppSecret: 'secret',
  feishuBaseId: 'base',
  feishuTableId: 'table',
});

const xhsCtx = (mcp: Record<string, unknown>): AgenticToolCtx => ({
  char: { name: '测试角色', xhsEnabled: true },
  userProfile: { name: '用户' } as any,
  realtimeConfig: { xhsMcpConfig: { enabled: true, serverUrl: 'https://example.test/xhs', ...mcp } } as any,
});

/** 回喂层有没有跟模型说死「这件事没有发生」——护栏真正生效的那一层。 */
const feedbackSaysNeverHappened = (name: string, result: unknown): boolean =>
  buildToolResultMessage({ name, result, history: [{ name, fingerprint: 'x' }] })
    .includes('这件事**没有发生**');

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('runSearch', () => {
  it('搜索服务连不上 → unreachable，回喂明说没发生', async () => {
    mocked.performSearch.mockResolvedValue({ success: false, results: [], message: '搜索出错: fetch failed', reached: false });
    const r = await runSearch({ query: '今天有什么新闻' }, ctx({ newsEnabled: true, newsApiKey: 'key' }));
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('web_search', r)).toBe(true);
  });

  it('搜过了但没结果 → no_results，这时角色说「没搜到」是实话', async () => {
    mocked.performSearch.mockResolvedValue({ success: false, results: [], message: '没有找到相关结果', reached: true });
    const r = await runSearch({ query: '冷门词' }, ctx({ newsEnabled: true, newsApiKey: 'key' }));
    expect(r).toMatchObject({ ok: false, reason: 'no_results' });
    expect(feedbackSaysNeverHappened('web_search', r)).toBe(false);
  });

  it('搜到了 → ok', async () => {
    mocked.performSearch.mockResolvedValue({
      success: true,
      results: [{ title: '标题', description: '摘要', url: 'https://x.test' }],
      message: '搜索成功',
      reached: true,
    });
    expect(await runSearch({ query: '猫' }, ctx({ newsEnabled: true, newsApiKey: 'key' })))
      .toMatchObject({ ok: true, rawResultCount: 1 });
  });
});

describe('runReadDiary（Notion 日记）', () => {
  it('查询没跑通（凭据过期 / 代理挂了）→ unreachable，不能说成「那天没写」', async () => {
    mocked.notionGetDiaryByDate.mockResolvedValue({ success: false, entries: [], message: '查询失败: 401' });
    const r = await runReadDiary({ date: '2026-08-01' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('notion_read_diary', r)).toBe(true);
  });

  it('查到了、那天真没写 → not_found', async () => {
    mocked.notionGetDiaryByDate.mockResolvedValue({ success: true, entries: [], message: '没有找到' });
    const r = await runReadDiary({ date: '2026-08-01' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(feedbackSaysNeverHappened('notion_read_diary', r)).toBe(false);
  });

  // 「找到条目、正文一篇都没读回来」是读取失败，不是"日记是空的"。真的空白日记
  // notionReadDiaryContent 会 success:true 带回「（空白日记）」，走不到这条分支。
  it('条目找到了但正文全没读回来 → 回喂也得说没发生', async () => {
    mocked.notionGetDiaryByDate.mockResolvedValue({
      success: true,
      entries: [{ id: 'p1', title: '标题', date: '2026-08-01', url: '' }],
      message: '找到 1 篇日记',
    });
    mocked.notionReadDiaryContent.mockResolvedValue({ success: false, content: '', message: '读取失败: 401' });
    const r = await runReadDiary({ date: '2026-08-01' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'empty_content' });
    expect(feedbackSaysNeverHappened('notion_read_diary', r)).toBe(true);
  });

  it('真的空白日记照旧算读到了', async () => {
    mocked.notionGetDiaryByDate.mockResolvedValue({
      success: true,
      entries: [{ id: 'p1', title: '标题', date: '2026-08-01', url: '' }],
      message: '找到 1 篇日记',
    });
    mocked.notionReadDiaryContent.mockResolvedValue({ success: true, content: '（空白日记）', message: '日记内容为空' });
    expect(await runReadDiary({ date: '2026-08-01' }, notionCtx)).toMatchObject({ ok: true, entryCount: 1 });
  });
});

describe('runFsReadDiary（飞书日记）', () => {
  it('拿不到 token / 接口报错 → unreachable', async () => {
    mocked.feishuGetDiaryByDate.mockResolvedValue({ success: false, entries: [], message: '获取token失败: 400' });
    const r = await runFsReadDiary({ date: '2026-08-01' }, feishuCtx);
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('feishu_read_diary', r)).toBe(true);
  });

  it('查到了、那天真没写 → not_found', async () => {
    mocked.feishuGetDiaryByDate.mockResolvedValue({ success: true, entries: [], message: '没有找到' });
    const r = await runFsReadDiary({ date: '2026-08-01' }, feishuCtx);
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(feedbackSaysNeverHappened('feishu_read_diary', r)).toBe(false);
  });
});

describe('runReadNote（Notion 笔记）', () => {
  it('搜不动 → unreachable，不能说成「对方没写过这篇」', async () => {
    mocked.notionSearchUserNotes.mockResolvedValue({ success: false, entries: [], message: '搜索失败: 502' });
    const r = await runReadNote({ keyword: '旅行' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('read_note', r)).toBe(true);
  });

  it('搜过了没这篇 → not_found', async () => {
    mocked.notionSearchUserNotes.mockResolvedValue({ success: true, entries: [], message: '没有找到' });
    const r = await runReadNote({ keyword: '旅行' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(feedbackSaysNeverHappened('read_note', r)).toBe(false);
  });

  it('条目找到了但正文全没读回来 → 回喂也得说没发生', async () => {
    mocked.notionSearchUserNotes.mockResolvedValue({
      success: true,
      entries: [{ id: 'n1', title: '旅行计划', date: '2026-07-30', url: '' }],
      message: '找到 1 篇笔记',
    });
    mocked.notionReadNoteContent.mockResolvedValue({ success: false, content: '', message: '读取失败: 401' });
    const r = await runReadNote({ keyword: '旅行' }, notionCtx);
    expect(r).toMatchObject({ ok: false, reason: 'empty_content' });
    expect(feedbackSaysNeverHappened('read_note', r)).toBe(true);
  });
});

describe('runXhsMyProfile', () => {
  // 主页打不开就降级搜昵称，搜索也连不上时以前照样回 ok:true，笔记那栏写「（没有搜到相关
  // 笔记）」——角色于是说「我翻了下我的小红书，一条都没找到」。小红书服务器多半在用户
  // 自己电脑上，后台到点时人睡了机器关了，这条走得最勤。
  it('主页打不开、降级搜索也连不上 → unreachable', async () => {
    vi.spyOn(XhsMcpClient, 'search').mockResolvedValue({ success: false, error: 'connect ECONNREFUSED' } as any);
    const r = await runXhsMyProfile({}, xhsCtx({ loggedInNickname: '小明' }));
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('xhs_my_profile', r)).toBe(true);
  });

  it('降级搜索跑通了、真的一条都没有 → 照旧 ok，可以说「没搜到」', async () => {
    vi.spyOn(XhsMcpClient, 'search').mockResolvedValue({ success: true, data: { notes: [] } } as any);
    const r = await runXhsMyProfile({}, xhsCtx({ loggedInNickname: '小明' }));
    expect(r).toMatchObject({ ok: true, gotProfile: false });
    expect(r.ok && r.feedsStr).toBe('（没有搜到相关笔记）');
  });

  it('只有 userId、主页请求挂了又没昵称可降级 → unreachable', async () => {
    vi.spyOn(XhsMcpClient, 'getUserProfile').mockResolvedValue({ success: false, error: 'timeout' } as any);
    const r = await runXhsMyProfile({}, xhsCtx({ loggedInUserId: 'uid-1' }));
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(feedbackSaysNeverHappened('xhs_my_profile', r)).toBe(true);
  });
});
