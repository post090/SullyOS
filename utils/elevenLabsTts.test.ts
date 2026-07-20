import { describe, it, expect } from 'vitest';
import {
  cleanTextForTtsEleven,
  stripElevenMarkupForDisplay,
  stripElevenCuesForDisplay,
  normalizeElevenVoiceId,
  ELEVEN_VOICE_ACTING_GUIDE,
} from './elevenLabsTts';

describe('cleanTextForTtsEleven', () => {
  it('keeps v3-supported bracket cues intact (sent to ElevenLabs as-is)', () => {
    const out = cleanTextForTtsEleven('你终于回消息了，[laugh] 我可等你半天了');
    expect(out).toContain('[laugh]');
    expect(out).toContain('我可等你半天了');
  });

  it('drops MiniMax <#秒#> pause markers (v3 would read them aloud)', () => {
    expect(cleanTextForTtsEleven('等等<#0.5#>我再想想')).toBe('等等我再想想');
    expect(cleanTextForTtsEleven('a<#1.2#>b<# 0.4 #>c')).toBe('abc');
  });

  it('drops [[system markers]] (double brackets are not audio cues)', () => {
    expect(cleanTextForTtsEleven('[[CALL_STARTED]] 喂？')).toBe('喂？');
  });

  it('drops Chinese stage cues in full-width parens', () => {
    const out = cleanTextForTtsEleven('（叹气）算了，听你的');
    expect(out).not.toContain('（叹气）');
    expect(out).toContain('算了，听你的');
  });

  it('converts (laughs)/(sighs) Western parens → bracket cues (v3 supports both singular and -s/-ing forms)', () => {
    const out = cleanTextForTtsEleven('(laughs) 哈哈，我赢了');
    // v3 接受 laugh/laughs/laughing 任一形态，不强制归一到单数；只要能被 v3 识别即可。
    expect(out).toMatch(/\[(laugh|laughs|laughing)\]/);
    expect(out).not.toContain('(laughs)');
  });

  it('keeps Fish Audio -ing forms as-is (v3 also accepts -ing forms)', () => {
    // 鱼声用 [laughing]/[sighing]/[whispering]，v3 也认这些 -ing 形态，直接保留即可。
    expect(cleanTextForTtsEleven('我赢了 [laughing]')).toMatch(/\[(laugh|laughs|laughing)\]/);
    expect(cleanTextForTtsEleven('唉 [sighing] 算了')).toMatch(/\[(sigh|sighs|sighing)\]/);
    expect(cleanTextForTtsEleven('[whispering] 跟你说个秘密')).toMatch(/\[(whisper|whispers|whispering)\]/);
  });

  it('maps self-invented emotion words to nearest v3-supported cue', () => {
    expect(cleanTextForTtsEleven('[happy] 太好了')).toMatch(/\[(laugh|laughs|laughing)\]/);
    expect(cleanTextForTtsEleven('[angry] 烦死了')).toMatch(/\[(groan|groans|groaning)\]/);
    expect(cleanTextForTtsEleven('[shy] 别说了')).toMatch(/\[(giggle|giggles|giggling)\]/);
    expect(cleanTextForTtsEleven('[nervous] 那个……')).toMatch(/\[(whisper|whispers|whispering)\]/);
  });

  it('drops cues that cannot be mapped to any v3-supported tag (rather than read aloud)', () => {
    // v3 不认 [curious]/[teasing]/[重要]/中文词，全丢弃，免得原样念出来
    const out = cleanTextForTtsEleven('嗯 [curious] 你说什么 [重要] 都行');
    expect(out).not.toContain('[curious]');
    expect(out).not.toContain('[重要]');
    expect(out).toContain('你说什么');
    expect(out).toContain('都行');
  });

  it('inserts [pause] for line breaks (v3 has no <#秒#> pause marker)', () => {
    const out = cleanTextForTtsEleven('第一段\n第二段');
    expect(out).toContain('[pause]');
    expect(out).toContain('第一段');
    expect(out).toContain('第二段');
  });

  it('collapses 3+ adjacent cues down to at most 2 (avoid giggle/chaos)', () => {
    const out = cleanTextForTtsEleven('[laugh][sigh][pause][groan] 嗨');
    // 至少不再有 4 个 cue
    const cueCount = (out.match(/\[[^\]]+\]/g) || []).length;
    expect(cueCount).toBeLessThanOrEqual(2);
    expect(out).toContain('嗨');
  });

  it('extracts <语音> content when present (LLM-styled voice tag is provider-agnostic)', () => {
    const out = cleanTextForTtsEleven('显示文字<语音 emotion="happy">spoken [laugh]</语音>');
    expect(out).toContain('spoken');
    expect(out).toContain('[laugh]');
    expect(out).not.toContain('显示文字');
    expect(out).not.toContain('<语音');
  });

  it('handles empty / whitespace-only input', () => {
    expect(cleanTextForTtsEleven('')).toBe('');
    expect(cleanTextForTtsEleven('   ')).toBe('');
  });
});

describe('stripElevenMarkupForDisplay', () => {
  it('removes bracket cues from display text', () => {
    expect(stripElevenMarkupForDisplay('你赢了 [laugh] 哈哈')).toBe('你赢了 哈哈');
  });

  it('removes Western-paren sound tags but keeps normal asides', () => {
    expect(stripElevenMarkupForDisplay('(laughs) 哈哈')).toBe('哈哈');
    expect(stripElevenMarkupForDisplay('(顺便说一句) 这事')).toBe('(顺便说一句) 这事');
  });

  it('does not touch non-cue brackets like [备注] or [TODO]', () => {
    // 注意：[备注]/[TODO] 不是 v3 支持的 cue，会被当成普通括注保留
    expect(stripElevenMarkupForDisplay('看 [备注] 这里')).toBe('看 [备注] 这里');
  });

  it('collapses double spaces left behind after cue removal', () => {
    expect(stripElevenMarkupForDisplay('a [laugh]  b')).toBe('a b');
  });
});

describe('stripElevenCuesForDisplay', () => {
  it('only removes recognized cues, leaves other brackets intact (safe for arbitrary text)', () => {
    expect(stripElevenCuesForDisplay('[laugh] 嗨 [备注] (顺便) [sigh]')).toBe('嗨 [备注] (顺便)');
  });

  it('handles undefined / null / empty', () => {
    expect(stripElevenCuesForDisplay(undefined)).toBe('');
    expect(stripElevenCuesForDisplay(null)).toBe('');
    expect(stripElevenCuesForDisplay('')).toBe('');
  });
});

describe('normalizeElevenVoiceId', () => {
  it('extracts voice_id from ElevenLabs share URL', () => {
    expect(normalizeElevenVoiceId('https://elevenlabs.io/app/voice-lab/share/voice/21m00Tcm4TlvDq8ikWAM'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenVoiceId('https://elevenlabs.io/voice/share/voice/21m00Tcm4TlvDq8ikWAM'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
  });

  it('passes through a bare voice_id unchanged', () => {
    expect(normalizeElevenVoiceId('21m00Tcm4TlvDq8ikWAM')).toBe('21m00Tcm4TlvDq8ikWAM');
  });

  it('handles surrounding whitespace', () => {
    expect(normalizeElevenVoiceId('  21m00Tcm4TlvDq8ikWAM  ')).toBe('21m00Tcm4TlvDq8ikWAM');
  });

  it('returns empty string for empty / null input', () => {
    expect(normalizeElevenVoiceId('')).toBe('');
    expect(normalizeElevenVoiceId(null)).toBe('');
    expect(normalizeElevenVoiceId(undefined)).toBe('');
  });

  it('strips query strings from pasted URLs', () => {
    expect(normalizeElevenVoiceId('https://elevenlabs.io/app/voice-lab/share/voice/21m00Tcm4TlvDq8ikWAM?foo=bar'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
  });
});

describe('ELEVEN_VOICE_ACTING_GUIDE', () => {
  it('is a non-empty string (prompt injection sanity check)', () => {
    expect(typeof ELEVEN_VOICE_ACTING_GUIDE).toBe('string');
    expect(ELEVEN_VOICE_ACTING_GUIDE.length).toBeGreaterThan(500);
  });

  it('documents the v3 bracket-cue format, not MiniMax <#秒#> pause markers', () => {
    expect(ELEVEN_VOICE_ACTING_GUIDE).toMatch(/\[laugh\]|\[sigh\]|\[whisper\]/);
    expect(ELEVEN_VOICE_ACTING_GUIDE).not.toContain('<#秒#>');
  });

  it('warns against self-invented cue words (which v3 ignores)', () => {
    expect(ELEVEN_VOICE_ACTING_GUIDE).toMatch(/smug|teasing|自造|造词/);
  });
});
