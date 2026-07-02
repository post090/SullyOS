import { describe, it, expect } from 'vitest';
import { normalizeVoiceTags, sanitizeIntoSegments, sanitizeForBubble } from './sanitize';
import { ChatParser } from './chatParser';
import { collectVoiceBatchSubtitle } from './voiceSubtitle';

// 语音标签自愈：模型把 <语音> 写歪的各种真实形态都要能修回规范，
// 否则 chunkText 原子块保护 / hasVoiceTag 配对全失效 → 掉格式。
describe('normalizeVoiceTags', () => {
  it('规范输入原样保留', () => {
    const s = '<语音 emotion="calm">你好</语音>';
    expect(normalizeVoiceTags(s)).toBe(s);
    expect(normalizeVoiceTags('没有语音标签的普通文本')).toBe('没有语音标签的普通文本');
  });

  it('未闭合开标签 → 末尾补闭合', () => {
    expect(normalizeVoiceTags('<语音 emotion="calm">うん、そのまま。'))
      .toBe('<语音 emotion="calm">うん、そのまま。</语音>');
  });

  it('未闭合繁体開标签 → 补繁体闭合', () => {
    expect(normalizeVoiceTags('<語音>大丈夫。')).toBe('<語音>大丈夫。</語音>');
  });

  it('孤儿闭合标签 → 删除', () => {
    expect(normalizeVoiceTags('前半句</语音>后半句')).toBe('前半句后半句');
  });

  it('嵌套多余开标签 → 删除，保持一对', () => {
    expect(normalizeVoiceTags('<语音>第一段<语音>第二段</语音>'))
      .toBe('<语音>第一段第二段</语音>');
  });

  it('全角尖括号 → 半角', () => {
    expect(normalizeVoiceTags('＜语音 emotion="sad"＞ごめん＜/语音＞'))
      .toBe('<语音 emotion="sad">ごめん</语音>');
  });

  it('闭合标签内空格 / 全角斜杠 → 规范', () => {
    expect(normalizeVoiceTags('<语音>hi</ 语音 >')).toBe('<语音>hi</语音>');
    expect(normalizeVoiceTags('<语音>hi<／语音>')).toBe('<语音>hi</语音>');
  });

  it('属性少空格 / 全角引号 / 全角等号 → 规范', () => {
    expect(normalizeVoiceTags('<语音emotion="happy">hi</语音>'))
      .toBe('<语音 emotion="happy">hi</语音>');
    expect(normalizeVoiceTags('<语音 emotion=“calm”>hi</语音>'))
      .toBe('<语音 emotion="calm">hi</语音>');
    expect(normalizeVoiceTags('<语音 emotion＝"calm">hi</语音>'))
      .toBe('<语音 emotion="calm">hi</语音>');
  });

  it('自闭合空标签 <语音/> → 删除，不吞后文', () => {
    expect(normalizeVoiceTags('<语音/>后面的正文')).toBe('后面的正文');
  });

  it('多对标签依次配对，互不干扰', () => {
    const s = '<语音>一</语音>中间<语音>二</语音>';
    expect(normalizeVoiceTags(s)).toBe(s);
  });
});

describe('自愈后整条管线联动', () => {
  it('sanitizeForBubble: 未闭合多段语音 → 修好后 chunkText 保护成单 chunk', () => {
    // 模型忘写闭合 + 内容多段：修复前保护正则配不上，语音块会被切碎
    const raw = '<语音 emotion="calm">第一段。\n\n第二段。';
    const cleaned = sanitizeForBubble(raw);
    const chunks = ChatParser.chunkText(cleaned);
    expect(chunks).toEqual(['<语音 emotion="calm">第一段。\n\n第二段。</语音>']);
  });

  it('sanitizeIntoSegments (worker): 未闭合语音 → 单 segment，banner 取内部文字', () => {
    const segs = sanitizeIntoSegments('<语音 emotion="sad">ごめんね。\n\n本当に。');
    expect(segs).toEqual([
      { raw: '<语音 emotion="sad">ごめんね。\n\n本当に。</语音>', sanitized: 'ごめんね。\n\n本当に。' },
    ]);
  });

  it('sanitizeIntoSegments: 简繁互换闭合 (<语音>…</語音>) 也整块保护', () => {
    const segs = sanitizeIntoSegments('<语音>hi\n\nthere</語音>');
    expect(segs).toHaveLength(1);
    expect(segs[0].sanitized).toBe('hi\n\nthere');
  });
});

// 「外语语音没翻译」修复：字幕从同批次兄弟气泡直接收回来
describe('collectVoiceBatchSubtitle', () => {
  const mk = (id: number, role: 'user' | 'assistant', content: string, type: 'text' | 'emoji' = 'text') =>
    ({ id, role, type, content }) as any;

  it('同批次字幕气泡按序拼接，跳过语音消息本身', () => {
    const msgs = [
      mk(1, 'user', '你在吗'),
      mk(2, 'assistant', '别怕，我在。'),
      mk(3, 'assistant', '闭上眼睛休息吧。'),
      mk(4, 'assistant', '<语音 emotion="calm">目を閉じて。</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 4)).toBe('别怕，我在。\n闭上眼睛休息吧。');
  });

  it('批次边界：不越过 user 消息去收上一轮的文字', () => {
    const msgs = [
      mk(1, 'assistant', '上一轮的话'),
      mk(2, 'user', '嗯'),
      mk(3, 'assistant', '这轮的字幕'),
      mk(4, 'assistant', '<语音>voice</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 4)).toBe('这轮的字幕');
  });

  it('同批次有第二条语音 → 归属含糊，返回空串走 LLM 兜底', () => {
    const msgs = [
      mk(1, 'assistant', '字幕'),
      mk(2, 'assistant', '<语音>one</语音>'),
      mk(3, 'assistant', '<语音>two</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 3)).toBe('');
  });

  it('双语气泡只取 %%BILINGUAL%% 前的半边', () => {
    const msgs = [
      mk(1, 'assistant', '中文字幕\n%%BILINGUAL%%\ntranslated half'),
      mk(2, 'assistant', '<语音>voice</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 2)).toBe('中文字幕');
  });

  it('emoji 气泡跳过；纯语音回合返回空串', () => {
    const msgs = [
      mk(1, 'assistant', 'https://emoji.example/a.png', 'emoji'),
      mk(2, 'assistant', '<语音>voice only</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 2)).toBe('');
  });

  it('消息不存在 → 空串', () => {
    expect(collectVoiceBatchSubtitle([], 99)).toBe('');
  });
});
