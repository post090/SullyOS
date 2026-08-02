import { describe, it, expect } from 'vitest';
import { shouldAutoPlayGeneratedVoice } from './voicePlayback';

// 语音条合成完的播放时机。以前是无条件播（收到 AI 语音就直接响），
// 用户「有时候不想听」没有出口 —— 这里把两条规则钉住：
// 自动来的默认不响、用户自己点的一定响。
describe('shouldAutoPlayGeneratedVoice', () => {
  it('AI 自动发来的语音：没开开关 → 不播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true })).toBe(false);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: false })).toBe(false);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: undefined })).toBe(false);
  });

  it('AI 自动发来的语音：开了「收到就自动播放」→ 播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: true })).toBe(true);
  });

  it('用户主动点的（转换语音 / 点空语音条）：不管开关都播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false })).toBe(true);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false, autoPlayEnabled: false })).toBe(true);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false, autoPlayEnabled: true })).toBe(true);
  });
});
