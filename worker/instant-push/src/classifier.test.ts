import { describe, it, expect } from 'vitest';
import { classifyLLMOutput } from './classifier';

describe('classifyLLMOutput', () => {
  it('D1 finish 干净文本 → sanitize 不改字符', () => {
    const r = classifyLLMOutput('你好');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('你好');
      expect(r.sanitizedBody).toBe('你好');
      // sanitize 跟原文相等, 上层 onLLMOutput 不会塞 notification.body
      expect(r.sanitizedBody).toBe(r.cleanedText);
      expect(r.directives).toEqual([]);
    }
  });

  it('D2 finish 含 SEND_EMOJI → sanitize 改字符 (notification 路径替换)', () => {
    const r = classifyLLMOutput('测试[[SEND_EMOJI: 笑]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      // cleanedText: classifier 只剥 DATA + SIDE_EFFECT 标签, SEND_EMOJI 不在里面 → 原文留给客户端 Step 9
      expect(r.cleanedText).toBe('测试[[SEND_EMOJI: 笑]]');
      // sanitizedBody: 走 sanitizeForNotification, 替换成 [表情：笑]
      expect(r.sanitizedBody).toBe('测试[表情：笑]');
      expect(r.sanitizedBody).not.toBe(r.cleanedText);
    }
  });

  it('D3 finish 仅 <think> → sanitize 空串 (触发 ZWSP 守护)', () => {
    const r = classifyLLMOutput('<think>internal monologue</think>');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('<think>internal monologue</think>');
      expect(r.sanitizedBody).toBe('');
      expect(r.sanitizedBody).not.toBe(r.cleanedText);
      // 上层 index.ts 会用 ZWSP 占位防 amsg-sw fallthrough
    }
  });

  it('D4 tool-request 含 prefix narration', () => {
    const r = classifyLLMOutput('让我查查[[RECALL: 2024-05]]');
    expect(r.kind).toBe('tool-request');
    if (r.kind === 'tool-request') {
      expect(r.prefix).toBe('让我查查');
      expect(r.sanitizedPrefix).toBe('让我查查');
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0].function.name).toBe('recall');
      expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ year: '2024', month: '05' });
    }
  });

  it('D5 tool-request prefix 为空 (LLM 直接吐数据标签)', () => {
    const r = classifyLLMOutput('[[SEARCH: weather]]');
    expect(r.kind).toBe('tool-request');
    if (r.kind === 'tool-request') {
      expect(r.prefix).toBe('');
      expect(r.sanitizedPrefix).toBe('');
      // 两者相等, 上层不塞 notification.body, OS banner 显示 title-only
      expect(r.sanitizedPrefix).toBe(r.prefix);
      expect(r.toolCalls[0].function.name).toBe('web_search');
    }
  });

  it('D6 finish + directives (side-effect tag)', () => {
    const r = classifyLLMOutput('OK[[ACTION:POKE]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('OK');
      expect(r.directives).toEqual([{ type: 'poke' }]);
    }
  });

  it('转账金额容错: 带单位 / 千分位 / 冒号后空格 (老正则 `(\\d+)` 全漏)', () => {
    for (const [input, amount] of [
      ['[[ACTION:TRANSFER:520元]]', 520],
      ['[[ACTION:TRANSFER:1,999]]', 1999],
      ['[[ACTION:TRANSFER: 520]]', 520],
      ['[[ACTION:TRANSFER:520.00]]', 520],
    ] as Array<[string, number]>) {
      const r = classifyLLMOutput(input);
      expect(r.kind, input).toBe('finish');
      if (r.kind === 'finish') {
        expect(r.directives, input).toEqual([{ type: 'transfer', amount }]);
        expect(r.cleanedText, input).toBe('');
      }
    }
  });

  it('金额解析不出来 → 不产生 directive, 标签照剥 (跟客户端同语义)', () => {
    const r = classifyLLMOutput('[[ACTION:TRANSFER:很多]]随便花');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([]);
      expect(r.cleanedText).toBe('随便花');
    }
  });

  it('模仿历史日志的 [系统: ...] → transfer directive (正文剥净, 客户端重放)', () => {
    const r = classifyLLMOutput('[系统: 你向阿桃转账 1999]拿去花');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{ type: 'transfer', amount: 1999 }]);
      expect(r.cleanedText).toBe('拿去花');
      expect(r.sanitizedBody).toBe('拿去花');
    }
  });

  it('新 kv 形态 [[ACTION:TRANSFER|to=user|amount=520]] → directive (worker 与客户端共用一份解析)', () => {
    const r = classifyLLMOutput('[[ACTION:TRANSFER|to=user|amount=520]]拿去');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{ type: 'transfer', amount: 520 }]);
      expect(r.cleanedText).toBe('拿去');
    }
  });

  it('复读历史的 [[记录:TRANSFER|...]] → 零 directive, 正文剥净 (幂等哨兵)', () => {
    const r = classifyLLMOutput('[[记录:TRANSFER|to=user|amount=1999|status=待处理]]拿去花');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([]);
      expect(r.cleanedText).toBe('拿去花');
      expect(r.sanitizedBody).toBe('拿去花');
    }
  });

  it('to=char 伪造 kv → 零 directive, 标签照剥', () => {
    const r = classifyLLMOutput('[[ACTION:TRANSFER|to=char|amount=520]]收到');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([]);
      expect(r.cleanedText).toBe('收到');
    }
  });

  it('方向伪造的日志 (用户→角色) 不产生 directive, 也不进正文', () => {
    const r = classifyLLMOutput('[系统: 阿桃向你转账 1999]我收下啦');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([]);
      expect(r.cleanedText).toBe('我收下啦');
    }
  });

  it('收/退回执 → transfer_accept / transfer_return directive (老实现在 push 路径直接丢失)', () => {
    const accept = classifyLLMOutput('[[ACTION:TRANSFER_ACCEPT]]谢谢你');
    if (accept.kind === 'finish') {
      expect(accept.directives).toEqual([{ type: 'transfer_accept' }]);
      expect(accept.cleanedText).toBe('谢谢你');
    }
    const ret = classifyLLMOutput('[系统: 你退回了阿桃的转账 520]我不能要');
    if (ret.kind === 'finish') {
      expect(ret.directives).toEqual([{ type: 'transfer_return' }]);
      expect(ret.cleanedText).toBe('我不能要');
    }
  });

  it('D6+ finish + 多个 directives', () => {
    const r = classifyLLMOutput('收到[[ACTION:POKE]] 转你[[ACTION:TRANSFER:100]]');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('收到 转你');
      // 转账在 SIDE_EFFECT_TAGS 之前抽 (它要先把正文里的日志形态挖掉), 所以排在 poke 前面。
      // 数组顺序只影响客户端重建出的标签串; 落库顺序由 chatParser 决定 (POKE 恒在转账之前执行)。
      expect(r.directives).toEqual([
        { type: 'transfer', amount: 100 },
        { type: 'poke' },
      ]);
    }
  });

  it('tool-request 多个 DATA tag 一次性收集', () => {
    const r = classifyLLMOutput('[[SEARCH: a]][[SEARCH: b]]');
    if (r.kind === 'tool-request') {
      expect(r.toolCalls).toHaveLength(2);
      expect(r.toolCalls.every(t => t.function.name === 'web_search')).toBe(true);
    }
  });

  it('空输入 → finish + 空 cleanedText', () => {
    const r = classifyLLMOutput('');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('');
      expect(r.sanitizedBody).toBe('');
      expect(r.directives).toEqual([]);
    }
  });

  // ─── 写日记 directive ─────────────────────────────────────────────────────

  it('Notion 短日记 title|content → notion_write_diary directive', () => {
    const r = classifyLLMOutput('好啊[[DIARY: 今天的事|窝在沙发吃西瓜]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('好啊');
      expect(r.directives).toEqual([{
        type: 'notion_write_diary',
        title: '今天的事',
        content: '窝在沙发吃西瓜',
      }]);
    }
  });

  it('Notion 短日记 无 title (无 |) → content 字段拿到整段', () => {
    const r = classifyLLMOutput('[[DIARY: 只是普通的一段]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{
        type: 'notion_write_diary',
        title: '',
        content: '只是普通的一段',
      }]);
    }
  });

  it('Notion 长日记 [[DIARY_START: title|mood]]...[[DIARY_END]] → notion_write_diary + mood', () => {
    const r = classifyLLMOutput('开始写[[DIARY_START: 雨天|惆怅]]\n下了一整天的雨，\n我看着窗外发呆。\n[[DIARY_END]]后记');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      // strip 后剥光长日记整段, 两侧文字直接相连 (跟客户端本地 fetch 路径行为一致, 见
      // applyAssistantPostProcessing.ts:534 同模式 trim).
      expect(r.cleanedText).toBe('开始写后记');
      expect(r.directives).toEqual([{
        type: 'notion_write_diary',
        title: '雨天',
        mood: '惆怅',
        content: '下了一整天的雨，\n我看着窗外发呆。',
      }]);
    }
  });

  it('Notion 长日记 仅 title (无 |) → mood undefined', () => {
    const r = classifyLLMOutput('[[DIARY_START: 标题]]\n内容\n[[DIARY_END]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      const d = r.directives[0] as { type: string; title: string; content: string; mood?: string };
      expect(d.type).toBe('notion_write_diary');
      expect(d.title).toBe('标题');
      expect(d.mood).toBeUndefined();
      expect(d.content).toBe('内容');
    }
  });

  it('飞书短日记 [[FS_DIARY: ...]] → feishu_write_diary', () => {
    const r = classifyLLMOutput('[[FS_DIARY: 飞书标题|飞书内容]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{
        type: 'feishu_write_diary',
        title: '飞书标题',
        content: '飞书内容',
      }]);
    }
  });

  it('飞书长日记 [[FS_DIARY_START..FS_DIARY_END]] → feishu_write_diary + mood', () => {
    const r = classifyLLMOutput('[[FS_DIARY_START: 周末|轻松]]\n睡到自然醒\n[[FS_DIARY_END]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{
        type: 'feishu_write_diary',
        title: '周末',
        mood: '轻松',
        content: '睡到自然醒',
      }]);
    }
  });

  it('Notion 长 + 飞书短同时存在 → 两个 directive 都收', () => {
    const r = classifyLLMOutput('[[DIARY_START: a]]\nx\n[[DIARY_END]]\n[[FS_DIARY: b|y]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toHaveLength(2);
      const types = r.directives.map(d => d.type);
      expect(types).toContain('notion_write_diary');
      expect(types).toContain('feishu_write_diary');
    }
  });
});

describe('classifyLLMOutput — LIFE / NEWS_CARD', () => {
  it('[[LIFE:...]] → life_record directive, 正文剥干净', () => {
    const r = classifyLLMOutput('你今天吃药了吗\n[[LIFE:MED|布洛芬]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('你今天吃药了吗');
      expect(r.sanitizedBody).toBe('你今天吃药了吗');
      expect(r.directives).toEqual([{ type: 'life_record', body: 'MED|布洛芬' }]);
    }
  });

  it('无参形态 [[LIFE:PERIOD_START]] 一样收', () => {
    const r = classifyLLMOutput('记下了[[LIFE:PERIOD_START]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('记下了');
      expect(r.directives).toEqual([{ type: 'life_record', body: 'PERIOD_START' }]);
    }
  });

  it('一条消息里多个 LIFE → 逐个收', () => {
    const r = classifyLLMOutput('[[LIFE:MED|布洛芬]][[LIFE:EXERCISE|跑步|30分钟]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'life_record', body: 'MED|布洛芬' },
        { type: 'life_record', body: 'EXERCISE|跑步|30分钟' },
      ]);
    }
  });

  it('[[NEWS_CARD: 来源|标题]] → news_card directive, 前后空格归一', () => {
    const r = classifyLLMOutput('刷到条新闻\n[[NEWS_CARD: 微博|某某官宣 ]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('刷到条新闻');
      expect(r.sanitizedBody).toBe('刷到条新闻');
      expect(r.directives).toEqual([{ type: 'news_card', body: '微博|某某官宣' }]);
    }
  });

  it('省略来源的 [[NEWS_CARD: 标题]] 也收', () => {
    const r = classifyLLMOutput('[[NEWS_CARD: 某某官宣]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('');
      expect(r.directives).toEqual([{ type: 'news_card', body: '某某官宣' }]);
    }
  });
});

// 复述型模型经常把整条消息重写一遍 (先说一遍再"总结"一遍), 同一个标签就出现两次。
// 客户端重放不去重, 放过去就是同一笔钱转两次账。
describe('classifyLLMOutput — 同一条消息里重复的副作用只出一个 directive', () => {
  it('两个一模一样的转账标签 → 只出一个 transfer directive', () => {
    const r = classifyLLMOutput('给你买奶茶[[ACTION:TRANSFER:520]]\n刚刚给你转了[[ACTION:TRANSFER:520]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{ type: 'transfer', amount: 520 }]);
    }
  });

  it('金额不同的两笔仍然是两件事, 都留', () => {
    const r = classifyLLMOutput('[[ACTION:TRANSFER:520]][[ACTION:TRANSFER:1314]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'transfer', amount: 520 },
        { type: 'transfer', amount: 1314 },
      ]);
    }
  });

  it('重复的日程 / 生活记录同样只留第一个', () => {
    const r = classifyLLMOutput(
      '[[ACTION:ADD_EVENT|面试|2026-08-03]][[LIFE:MED|布洛芬]]\n'
      + '再说一遍：[[ACTION:ADD_EVENT|面试|2026-08-03]][[LIFE:MED|布洛芬]]',
    );
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'add_event', title: '面试', date: '2026-08-03' },
        { type: 'life_record', body: 'MED|布洛芬' },
      ]);
    }
  });

  it('参数不同的小红书动作不会被误吞', () => {
    const r = classifyLLMOutput('[[XHS_LIKE: n1]][[XHS_LIKE: n1]][[XHS_LIKE: n2]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'xhs_like', noteId: 'n1' },
        { type: 'xhs_like', noteId: 'n2' },
      ]);
    }
  });
});
