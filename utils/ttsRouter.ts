/**
 * TTS 服务商路由：按 apiConfig.ttsProvider 把语音合成分发到 MiniMax / 鱼声 Fish Audio / ElevenLabs。
 *
 * 聊天语音条（Chat）、约会（DateSession）直接用这里的 synthesizeSpeech(Detailed)，
 * 不必关心底层是哪家。CallApp 因为要做分句流式 + 缓存键对齐，单独在自己内部分支。
 */
import { CharacterProfile, APIConfig } from '../types';
import {
  synthesizeSpeechDetailed as minimaxSynthesizeDetailed,
  type TtsResult,
} from './minimaxTts';
import { synthesizeSpeechFishDetailed } from './fishAudioTts';
import { synthesizeSpeechElevenDetailed } from './elevenLabsTts';
import { resolveTtsProvider } from './ttsProvider';

export type { TtsResult };

type SynthOptions = { languageBoost?: string; groupId?: string; emotion?: string };

export async function synthesizeSpeechDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<TtsResult> {
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') {
    return synthesizeSpeechFishDetailed(text, char, apiConfig, options);
  }
  if (provider === 'elevenlabs') {
    return synthesizeSpeechElevenDetailed(text, char, apiConfig, options);
  }
  return minimaxSynthesizeDetailed(text, char, apiConfig, options);
}

export async function synthesizeSpeech(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<string> {
  const { url } = await synthesizeSpeechDetailed(text, char, apiConfig, options);
  return url;
}

/**
 * 当前 TTS 服务商下，这个角色是否已配好可用音色。
 * 鱼声看 fishReferenceId；ElevenLabs 看 elevenVoiceId；MiniMax 看 voiceId / timberWeights。
 * 各处「要不要显示语音按钮 / 要不要触发自动 TTS」的判断统一用它，避免漏掉分支。
 */
export const characterHasVoice = (char: CharacterProfile, apiConfig: APIConfig): boolean => {
  const vp = char.voiceProfile;
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') {
    return !!vp?.fishReferenceId;
  }
  if (provider === 'elevenlabs') {
    return !!vp?.elevenVoiceId;
  }
  return !!(vp?.voiceId || (vp?.timberWeights && vp.timberWeights.length > 0));
};
