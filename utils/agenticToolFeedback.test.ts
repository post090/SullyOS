// utils/agenticToolFeedback.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildDuplicateToolMessage,
  buildToolResultMessage,
  describeTool,
  toolCallFingerprint,
  type ToolCallRecord,
} from './agenticToolFeedback';

describe('toolCallFingerprint', () => {
  it('同名同参算同一次调用', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .toBe(toolCallFingerprint('recall', { year: '2026', month: '06' }));
  });

  // 模型两轮之间重新拼参数时字段顺序常常会变，不规范化的话同一个查询会被当成两次不同的，
  // 重复调用闸就形同虚设。
  it('参数字段顺序不同仍算同一次', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .toBe(toolCallFingerprint('recall', { month: '06', year: '2026' }));
  });

  it('嵌套对象里的顺序也一样处理', () => {
    expect(toolCallFingerprint('x', { a: { p: 1, q: 2 } }))
      .toBe(toolCallFingerprint('x', { a: { q: 2, p: 1 } }));
  });

  it('换参数就是另一次调用——多轮能力不能被闸误伤', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .not.toBe(toolCallFingerprint('recall', { year: '2026', month: '07' }));
    expect(toolCallFingerprint('web_search', { query: 'a' }))
      .not.toBe(toolCallFingerprint('web_search', { query: 'b' }));
  });

  it('工具名不同就是不同调用', () => {
    expect(toolCallFingerprint('recall', {})).not.toBe(toolCallFingerprint('web_search', {}));
  });

  it('无参数 / undefined 不炸', () => {
    expect(toolCallFingerprint('xhs_browse', undefined)).toBe(toolCallFingerprint('xhs_browse', {}));
  });
});

describe('describeTool', () => {
  it('已知工具给人话', () => {
    expect(describeTool('recall')).toBe('调取某个月的记忆');
    expect(describeTool('web_search')).toBe('联网搜索');
  });

  it('不认识的工具用原名，不编一个出来', () => {
    expect(describeTool('some_future_tool')).toBe('some_future_tool');
  });

  // 后台到点时角色能给自己排下一条消息。漏在标签表外的话，回喂会拼出
  // 「你schedule_active_message，拿回了…」——内部工具名直接进了模型看得见的散文。
  it('排下一条消息的工具有人话说法，不把内部工具名漏进散文', () => {
    expect(describeTool('schedule_active_message')).toBe('给自己排下一条消息');
    expect(buildToolResultMessage({
      name: 'schedule_active_message',
      result: { ok: true },
      history: [{ name: 'schedule_active_message', fingerprint: 'a' }],
    })).not.toContain('schedule_active_message');
  });

  // 用户自配的 MCP 工具不在标签表里。原名直接回填会拼出「你mcp__get_secret，拿回了…」——
  // 句子读不通，路由用的前缀还漏进了模型能看见的散文（模型照着学就往正文里写假调用）。
  it('MCP 工具剥掉路由前缀，凑成读得通的动宾短语', () => {
    expect(describeTool('mcp__get_secret')).toBe('调用「get_secret」');
  });
});

describe('buildToolResultMessage', () => {
  const history: ToolCallRecord[] = [
    { name: 'recall', fingerprint: toolCallFingerprint('recall', { year: '2026', month: '06' }) },
  ];

  it('把工具结果原样带上', () => {
    const msg = buildToolResultMessage({
      name: 'recall',
      result: { ok: true, logsText: '六月发生的事' },
      history,
    });
    expect(msg).toContain('六月发生的事');
  });

  it('MCP 工具的回喂句子读得通，且不把 mcp__ 前缀漏给模型', () => {
    const msg = buildToolResultMessage({
      name: 'mcp__get_secret',
      result: { ok: true, data: '暗号' },
      history: [{ name: 'mcp__get_secret', fingerprint: toolCallFingerprint('mcp__get_secret', {}) }],
    });
    expect(msg).toContain('调用「get_secret」');
    expect(msg).not.toContain('mcp__');
  });

  // 这条是整个改动的意义所在：裸 JSON 里没有任何东西告诉模型「这一步做完了」，
  // 提示词里但凡有一句常驻的「先去查 X」，它就会每轮照做，直到跑满上限。
  it('结尾必须写明别重复调用', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: { ok: true }, history });
    expect(msg).toContain('不要再来一遍');
  });

  it('把已经用过的工具点名列出来', () => {
    const msg = buildToolResultMessage({
      name: 'web_search',
      result: { ok: true },
      history: [
        ...history,
        { name: 'web_search', fingerprint: toolCallFingerprint('web_search', { query: 'x' }) },
      ],
    });
    expect(msg).toContain('调取某个月的记忆');
    expect(msg).toContain('联网搜索');
  });

  it('同一个工具用过多次只在清单里列一次', () => {
    const msg = buildToolResultMessage({
      name: 'recall',
      result: { ok: true },
      history: [
        { name: 'recall', fingerprint: 'a' },
        { name: 'recall', fingerprint: 'b' },
      ],
    });
    expect(msg.match(/调取某个月的记忆/g)?.length).toBe(2); // 开头一次 + 清单一次
  });

  it('给出「直接写消息」这条出路，别把调工具当成回答', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: {}, history });
    expect(msg).toContain('直接把要发的消息写出来');
  });

  // 「把要发的消息写出来」很容易被读成「从头再写一遍」：模型把已经说出去的几句连同里面的
  // 标记一起重抄，下游照着标记再执行一次（转账就真的发两次）。所以得明说接着往下写。
  it('提醒别重写已经说出去的内容和标签', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: { ok: true }, history });
    expect(msg).toContain('前面已经说出去的内容和标签不要重写');
  });

  // 搜索结果里没有任何时间信息，模型看不出这条是今早的还是三年前的，很容易把旧闻
  // 当成刚发生的事讲给用户听。
  it('搜索结果带一句「不一定是最新的」', () => {
    const msg = buildToolResultMessage({
      name: 'web_search',
      result: { ok: true, resultsText: '某某公司发布了新品' },
      history: [{ name: 'web_search', fingerprint: 'a' }],
    });
    expect(msg).toContain('不一定是最新的');
  });

  it('这句只跟着搜索走，别的工具不加', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: { ok: true }, history });
    expect(msg).not.toContain('不一定是最新的');
  });

  // 回归守卫：小红书 / MCP 服务器多半跑在用户自己电脑上，后台到点时人睡了机器关了，
  // worker 怎么也连不上。以前这种失败跟「搜过了但没结果」共用一个 reason，模型看见
  // ok:false 就挑个说法圆过去——「我刚在小红书搜了下，没啥好东西诶」。一次根本没发生的
  // 搜索被说成发生过。现在这类失败的回喂里明写「这件事没有发生，别说你查过」。
  describe('这次调用没跑起来时，得拦住角色说「我查过了」', () => {
    const neverRanCases: Array<[string, string]> = [
      ['xhs_search', 'unreachable'],
      ['xhs_browse', 'not_enabled'],
      ['notion_read_diary', 'not_configured'],
      ['web_search', 'no_api_key'],
      ['mcp__get_secret', 'mcp_error'],
      // empty_content 看着像「跑了但是空的」，实际只在「条目找到了、正文一篇都没读回来」
      // 时出现——真的空白日记会带着「（空白日记）」正常返回。所以它也是一次读取失败。
      ['notion_read_diary', 'empty_content'],
      ['read_note', 'empty_content'],
    ];

    it.each(neverRanCases)('%s / %s → 明说这件事没发生', (name, reason) => {
      const msg = buildToolResultMessage({
        name,
        result: { ok: false, reason },
        history: [{ name, fingerprint: toolCallFingerprint(name, {}) }],
      });
      expect(msg).toContain('没能跑起来');
      expect(msg).toContain('这件事**没有发生**');
      expect(msg).not.toContain('拿回了下面这些');
    });

    it('「跑了但没东西」不加这句——角色说「我搜了下没啥」是实话', () => {
      for (const reason of ['no_results', 'not_found', 'no_logs']) {
        const msg = buildToolResultMessage({
          name: 'xhs_search',
          result: { ok: false, reason },
          history: [{ name: 'xhs_search', fingerprint: 'a' }],
        });
        expect(msg, reason).toContain('拿回了下面这些');
        expect(msg, reason).not.toContain('没有发生');
      }
    });

    it('成功的结果照旧', () => {
      const msg = buildToolResultMessage({ name: 'xhs_search', result: { ok: true, notes: [] }, history });
      expect(msg).toContain('拿回了下面这些');
      expect(msg).not.toContain('没有发生');
    });
  });
});

describe('buildDuplicateToolMessage', () => {
  it('说清这次没真去查，结果在上面', () => {
    const msg = buildDuplicateToolMessage('recall');
    expect(msg).toContain('调取某个月的记忆');
    expect(msg).toContain('没有再执行');
  });

  // 同上：被打回之后让它「把要发的消息写出来」，模型很容易连前面说过的话带标记一起重写，
  // 下游就会照着标记再执行一次。
  it('提醒别重写已经说出去的内容和标签', () => {
    expect(buildDuplicateToolMessage('recall')).toContain('前面已经说出去的内容和标签不要重写');
  });
});
