/**
 * ElevenLabs TTS 工具 —— MiniMax / 鱼声的平行实现，供聊天 / 约会 / 电话三选一复用。
 *
 * 与鱼声的相似点：
 *  1. 直接返回二进制音频（mp3），不是 JSON 里塞 hex；
 *  2. v3 模型支持方括号 cue（[laugh] / [sigh] / [whisper] 等），照鱼声那套保留 + 归一；
 *  3. 选音色用 voice_id（voiceProfile.elevenVoiceId）。
 *
 * 与鱼声的关键差异：
 *  1. 走 ElevenLabs 的 `/v1/text-to-speech/{voice_id}` 端点，请求体形态不同；
 *  2. Authorization 用 `xi-api-key` 头而不是 `Bearer`；
 *  3. v3 标签集跟鱼声不重合（v3 用单数动词形态 [laugh]/[sigh]/[whisper]，
 *     鱼声用 -ing 形态 [laughing]/[sighing]/[whispering]）—— 这里归一到 v3 官方支持集；
 *  4. 没有 MiniMax 的 <#秒#> 停顿标记 —— 那套标记 v3 不认、会被原样念出来，
 *     所以这里绝不 insertSpeechBreaks，还要把混进来的 <#x#> 清掉做兜底。
 *
 * 文本清洗 / <语音> 标签解析仍复用 minimaxTts 的那套（与服务商无关）。
 */
import { CharacterProfile, APIConfig } from '../types';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import { normalizeApiKey } from './minimaxApiKey';
import { getProxyWorkerUrl } from './proxyWorker';
import type { TtsResult } from './minimaxTts';

const ELEVEN_PROXY_PATH = '/api/elevenlabs/tts';
const ELEVEN_UPSTREAM_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_ELEVEN_MODEL = 'eleven_v3';

/**
 * ElevenLabs v3 语音演出规范 —— 与鱼声同源（呼吸、句长、情绪节奏的原理一致），
 * 但用 ElevenLabs v3 **原生**的方括号音频标签（[laugh] / [sigh] / [whisper] / [pause] 等），
 * v3 会演绎、不会念出来。不再借用 MiniMax 的 <#秒#> 停顿标记 / emotion 属性那一套。
 *
 * v3 官方支持的音频标签列表（参考 ElevenLabs v3 文档）：
 *   笑：[laugh] [chuckle] [giggle] [scoff]
 *   叹：[sigh] [groan] [gasping] [gasps]
 *   哭：[crying] [sobbing] [sobs] [whimpers] [whimpering]
 *   气声：[whisper] [whispers] [whispering] [whispered]
 *   喊：[shouted] [shouting] [shouts] [shouted voice] [shouting voice]
 *   响度：[quiet] [loud] [normal voice] [whispering voice] [shouting voice]
 *   生理：[coughs] [coughing] [cough] [sneezes] [sneezing] [sniffles] [sniffing]
 *         [yawns] [yawning] [exhales] [exhaling] [inhales] [inhaling]
 *         [clears throat] [sucking teeth] [blew a raspberry] [kiss] [blows kiss]
 *   犹豫：[hesitating] [hesitates] [stammering] [stammers] [pauses] [pause]
 *         [gulps] [gulp] [thinking] [thinks]
 */
export const ELEVEN_VOICE_ACTING_GUIDE = `### 让它听起来像活人在说话（重要）

**你现在是在「说话」，不是在「打字」。** 这条会被转成真实语音念给对方听，所以内容必须口语化、像嘴里自然说出来的话，不能是书面语。别用书面/正式措辞、长定语从句、文绉绉的连接词（"然而""与此同时""综上所述"这类一律不要）；该用"嗯""欸""那个……""反正"这些日常口头语就用。一句话读出来要顺口、像聊天，不像念稿。

你写的字会被 ElevenLabs v3 原样念出来。目标不是"写一段通顺的话"，而是"写一段读出来有呼吸、有情绪起伏的对白"。读稿感、客服腔、新闻播报腔一旦出现就重写。

**1. v3 用方括号音频标签控制情绪和声音——只能用下面这一小撮官方支持的标签，别自己造词。**
v3 只认这些标签；写 \`[smug]\`\`[teasing]\`\`[curious]\` 这种自造词，它大多无效（等于没打、照样平读）。把你想表达的情绪**对到下面最接近的那个**：
- 情感语调：\`[whisper]\`（悄悄话/气声/紧张害怕）、\`[whispering]\`（持续轻声）、\`[shouted]\`（突然喊一句）、\`[shouting]\`（持续喊）、\`[quiet]\`（压低声）、\`[loud]\`（大声）。
- 笑：\`[laugh]\`（哈哈大笑）、\`[chuckle]\`（轻笑/嘿嘿）、\`[giggle]\`（咯咯笑）、\`[scoff]\`（哼/嗤）。
- 叹/喘：\`[sigh]\`（叹气）、\`[groan]\`（哀嚎/受不了）、\`[gasping]\`（倒吸一口气）、\`[inhales]\`（吸气）、\`[exhales]\`（呼气）。
- 哭：\`[crying]\`（哭腔）、\`[sobbing]\`（抽泣）、\`[whimpers]\`（呜咽）。
- 生理：\`[clears throat]\`（清嗓）、\`[coughs]\`（咳嗽）、\`[yawns]\`（打哈欠）、\`[sneezes]\`（打喷嚏）、\`[sniffles]\`（吸鼻子）、\`[gulps]\`（吞咽）。
- 犹豫/停顿：\`[pause]\`（短停）、\`[pauses]\`（多次停顿）、\`[hesitating]\`（犹豫）、\`[stammering]\`（结巴）、\`[thinking]\`（思考）、\`[gulps]\`（紧张吞咽）。
- 其他：\`[kiss]\`（飞吻）、\`[blew a raspberry]\`（吐舌咂嘴）。
**⚠️ 硬性格式：半角英文方括号 \`[like this]\`，只写上面列出的英文词。** 别用圆括号 \`(sighs)\`、中文 \`[轻声]\`、全角【】、或 \`<语音 emotion>\` 属性。

**2.〔铁律〕情绪有起伏就放一个标签，放在情绪真正起来的那个点——通常在句子中间（逗号之间），不是机械地每句开头。**
- **放在哪：贴着情绪发生的那个词。** 多在句中（两个逗号之间），不是句号后一律来一个。例：\`地铁挤得，[groan] 跟沙丁鱼罐头似的\`、\`你推荐那家店我去了，[laugh] 是真的好吃\`。整句一个基调时才放句首。
- **放多密：有情绪起伏就放、跟着情绪变。** 一长段全程没标签 → 平读、人机（最大翻车）；但一处别堆 3 个以上、短句别硬塞 → 发飘、鬼畜。一个情绪点一个即可。
- 小短句（"好啦""嗯""喂？"三五个字）不放，靠标点。

**完整范例（标签落在逗号之间的情绪点，且只用支持的标签）：**
原文（人机）：你终于回消息了。我还以为你今天不理我了呢。我今天上班差点迟到，地铁挤得像沙丁鱼罐头。你上次推荐的那家店我去了，真的好吃。下次有空一起去吧。

改好（自然）：
\`你终于回消息了，[laugh] 我可等你半天了！我今天上班差点迟到，[sigh] 地铁挤得跟沙丁鱼罐头似的。你上次推荐那家店我去了，[chuckle] 是真的好吃！下次有空，[whisper] 一起去好不好嘛？\`

**3. 段与段之间要换气，别无缝冲。** 换行或停顿后如果还是你在继续说，第二段开头加个语气词 / 一次叹气当缓冲，别一上来就冲进正题。
✅ 我知道你不是故意的……[sigh] 只是，我还是会有点难过。
❌ 我知道你不是故意的。只是我还是会有点难过。（两句贴死，像棒读）

**4. 句子长短交错。** 一连串等长的句子是棒读头号来源。短句砸下来，长句铺开。想强调就拆开念："我。没。拿。"

**5. 停顿也能靠标点和省略号。** 逗号轻顿、句号收住、破折号拉长、省略号"……"表欲言又止；需要明显沉默就用 \`[pause]\` 或多个省略号。

**6. 情绪不同，节奏不同（每句给它自己的标签，别一个包到底；只用支持的标签）：**
- 温柔安抚：慢、稳、短句多。"[whisper] 没事……先别急着吓自己。"
- 委屈撒娇：语气软、省略号多一点。"[sobbing] 嗯……你刚刚是不是又不理我。"
- 别扭傲娇：前半句嘴硬后半句放软。"哈，你还真会折腾我。[chuckle] 算了，我帮你就是了。"
- 害羞：被戳穿心事。"[giggle] 你你你别乱说啊……谁、谁脸红了。"
- 紧张犹豫：断裂感，短句多。"[hesitating] 等等……我好像，有点不确定。"
- 得意吐槽：别太慢。"[scoff] 行吧，人类又发明了新的折磨方式。"

（朗读语种不是中文时，上面示例里的中文语气词换成该语言里自然的叹词 / 填充词即可，方括号标签写法不变，呼吸和节奏的原理也不变。）`;

// ElevenLabs v3 方括号标签：单层 [..]（区别于系统标记 [[..]]），内容 1–40 字符。
const ELEVEN_BRACKET_CUE_RE = /\[[^\[\]]{1,40}\]/g;

// ⚠️ ElevenLabs v3 实际可靠生效的标签就这一小撮（来自 v3 官方文档）。其它自然语言标签
// （[smug]/[teasing]/[curious]… 这种）v3 大多弱响应甚至忽略 → 听起来像没打标签、平。
// 所以一律把标签归一到这个支持集，映射不到的丢弃。
const ELEVEN_SUPPORTED_CUES = new Set([
  // 情感语调 / 响度
  'whisper', 'whispers', 'whispering', 'whispered',
  'whispering voice', 'shouted', 'shouting', 'shouts', 'shouted voice', 'shouting voice',
  'quiet', 'loud', 'normal voice',
  // 笑
  'laugh', 'laughs', 'laughing', 'chuckle', 'chuckles', 'chuckling',
  'giggle', 'giggles', 'giggling', 'scoff', 'scoffs', 'scoffing',
  // 叹 / 喘
  'sigh', 'sighs', 'sighing', 'groan', 'groans', 'groaning',
  'gasping', 'gasps', 'gasp', 'inhales', 'inhaling', 'inhale',
  'exhales', 'exhaling', 'exhale',
  // 哭
  'crying', 'sobbing', 'sobs', 'sob', 'whimpers', 'whimpering', 'whimper',
  // 生理
  'clears throat', 'coughs', 'coughing', 'cough',
  'yawns', 'yawning', 'yawn',
  'sneezes', 'sneezing', 'sneeze',
  'sniffles', 'sniffing', 'sniffle',
  'sucking teeth', 'blew a raspberry',
  'kiss', 'blows kiss',
  // 犹豫 / 停顿
  'pause', 'pauses', 'hesitating', 'hesitates', 'hesitate',
  'stammering', 'stammers', 'stammer',
  'gulps', 'gulp', 'thinking', 'thinks', 'think',
]);

// 把模型可能写出的各种标签（同义词 / 鱼声 -ing 习惯 / MiniMax 习惯 / 自造词 / 圆括号声音标签）
// 映射到 v3 支持集。鱼声的 -ing 形态会自动归一到 v3 的原形 / 单数形态。
const ELEVEN_CUE_SYNONYMS: Record<string, string> = {
  // 停顿（含 MiniMax/旧版/鱼声写法）
  'break': 'pause', 'short pause': 'pause', 'long pause': 'pause', 'long-break': 'pause',
  'longbreak': 'pause', 'long break': 'pause',
  // 鱼声 -ing 形态 → v3 原形
  'laughing': 'laugh', 'chuckling': 'chuckle', 'giggling': 'giggle',
  'sighing': 'sigh', 'groaning': 'groan', 'panting': 'gasp', 'moaning': 'groan',
  'sobbing': 'sobbing', 'crying loudly': 'crying',
  // 正面情绪 → v3 没专门的 happy，归到 laugh/chuckle
  happy: 'laugh', joyful: 'laugh', delighted: 'laugh', cheerful: 'laugh', glad: 'laugh',
  smug: 'chuckle', proud: 'chuckle', gleeful: 'laugh', playful: 'chuckle', teasing: 'chuckle',
  confident: 'chuckle', surprised: 'gasp', amazed: 'gasp', curious: 'gasp', hopeful: 'sigh',
  enthusiastic: 'laugh', eager: 'laugh', excited: 'laugh',
  // 生气/烦躁
  annoyed: 'groan', irritated: 'groan', frustrated: 'groan', mad: 'groan', furious: 'groan',
  grumpy: 'groan', angry: 'groan',
  // 难过/失落
  unhappy: 'sigh', disappointed: 'sigh', hurt: 'sigh', depressed: 'sigh',
  pleading: 'sobbing', sulking: 'sigh', lonely: 'sigh', regretful: 'sigh', sad: 'sigh',
  // 害羞/尴尬 → giggle
  shy: 'giggle', bashful: 'giggle', awkward: 'giggle', flustered: 'giggle',
  embarrassed: 'giggle',
  // 轻柔/温柔/疲惫/平静 → whisper
  'soft tone': 'whisper', 'soft voice': 'whisper', gentle: 'whisper', tender: 'whisper',
  warm: 'whisper', calm: 'whisper', soothing: 'whisper',
  tired: 'yawns', sleepy: 'yawns', relaxed: 'sigh', sincere: 'whisper', soft: 'whisper',
  // 气声/紧张/害怕 → whisper
  nervous: 'whisper', anxious: 'whisper', scared: 'whisper', fearful: 'whisper',
  worried: 'whisper', timid: 'whisper', breathy: 'whisper',
  // 悄悄话
  hushed: 'whisper', murmuring: 'whisper',
  // 强调 → loud
  emphatic: 'loud', stressing: 'loud', emphasis: 'loud',
  // 音效
  laugh: 'laugh', laughs: 'laugh',
  giggle: 'giggle', giggles: 'giggle',
  chuckle: 'chuckle', chuckles: 'chuckle',
  sigh: 'sigh', sighs: 'sigh',
  sob: 'sobbing', sobs: 'sobbing',
  cry: 'crying', cries: 'crying',
  groan: 'groan', groans: 'groan',
  pant: 'gasp', pants: 'gasp', gasp: 'gasp', gasps: 'gasp',
  'out of breath': 'gasp',
  moan: 'groan', moans: 'groan',
  'clears throat': 'clears throat', ahem: 'clears throat',
  cough: 'coughs', coughs: 'coughs',
  yawn: 'yawns', yawns: 'yawns',
};

/**
 * 把任意 cue 文本归一到 ElevenLabs v3 支持的标签。映射不到返回 ''（应丢弃）。
 * 顺序：精确支持集 → 精确同义词 → 自然语言短语包含匹配。
 */
const normalizeElevenCue = (inner: string): string => {
  const key = (inner || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return '';
  if (ELEVEN_SUPPORTED_CUES.has(key)) return key;
  if (ELEVEN_CUE_SYNONYMS[key]) return ELEVEN_CUE_SYNONYMS[key];
  for (const [syn, canon] of Object.entries(ELEVEN_CUE_SYNONYMS)) {
    if (key.includes(syn)) return canon;
  }
  for (const canon of ELEVEN_SUPPORTED_CUES) {
    if (key.includes(canon)) return canon;
  }
  return '';
};

/** emotion 属性兜底映射（→ v3 支持集）。 */
const ELEVEN_EMOTION_MAP: Record<string, string> = {
  happy: 'laugh',
  sad: 'sigh',
  angry: 'groan',
  fearful: 'whisper',
  disgusted: 'groan',
  surprised: 'gasp',
  calm: 'sigh',
};

const ELEVEN_VOICE_TAG_RE = /<[语語]音[^>]*>([\s\S]*?)<\/[语語]音>/;

/**
 * ElevenLabs 专用文本清洗（区别于 MiniMax / 鱼声）：
 * 关键差异 —— **保留**英文方括号标签（[laugh]/[whisper]…）原样送进 API。
 * 但要清掉「会被 v3 念出来」的脏东西：
 *  - 系统标记 [[..]]、双语分隔、中文舞台指示（…）、MiniMax <#秒#>；
 *  - **把所有标签归一到 v3 实际支持的标签**（圆括号声音标签转方括号、自造/同义词
 *    映射到支持集、映射不到的丢弃），避免写了无效标签等于没打、或被原样念出来。
 */
export const cleanTextForTtsEleven = (raw: string): string => {
  if (!raw) return '';
  const tagMatch = raw.match(ELEVEN_VOICE_TAG_RE);
  let text = tagMatch ? tagMatch[1] : raw;
  text = text
    .replace(/\[\[.*?\]\]/g, '')                 // [[系统标记]]（双层，先于单层 cue 处理）
    .replace(/%%BILINGUAL%%[\s\S]*/i, '')        // 双语分隔及之后
    .replace(/（[^）]{0,48}）/g, '')              // 中文圆括号舞台指示，一律删
    .replace(/<#\s*[\d.]+\s*#>/g, '')            // MiniMax 停顿标记，v3 不认
    // 西文圆括号（模型按 MiniMax 习惯写的 (laughs)/(sighs) 等）→ 先转成方括号，交给下面归一
    .replace(/\(([^)]{1,40})\)/g, '[$1]')
    // 换行写死成停顿：段落空行 → 长停，普通换行 → 短停（v3 的 pause）
    .replace(/\n{2,}/g, ' [pause] ')
    .replace(/\n+/g, ' [pause] ')
    // 归一：每个方括号 cue → v3 实际支持的标签；映射不到的（含中文、自造词、舞台指示）丢弃
    .replace(/\[([^\[\]]{1,40})\]/g, (_m, inner: string) => {
      const canon = normalizeElevenCue(inner);
      return canon ? `[${canon}]` : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  // 把挤在一起的多个 cue 压到最多 2 个：换行停顿 [pause] 常撞上模型句界写的
  // [sigh][confident]，叠成 3+ 会突兀/鬼畜。保留一个停顿 + 一个情绪即可。
  text = collapseAdjacentCues(text);
  return text;
};

/**
 * 合并相邻 cue：连写的 [a][b][c]（中间只有空格）压到最多 2 个。
 * 规则：先去相邻重复；≤2 个原样保留（[sobbing][whisper] 这种合法叠加不动）；
 * 3+ 时——有停顿 cue 就留「停顿 + 最后一个情绪」，没有就留前两个情绪。
 */
const collapseAdjacentCues = (s: string): string =>
  s.replace(/\[[^\]]+\](?:\s*\[[^\]]+\])+/g, (run) => {
    const cues = run.match(/\[[^\]]+\]/g) || [];
    const dedup = cues.filter((c, i) => i === 0 || c.toLowerCase() !== cues[i - 1].toLowerCase());
    if (dedup.length <= 2) return dedup.join(' ');
    const isPause = (c: string) => /^\[pause[s]?\]$/i.test(c);
    const pause = dedup.find(isPause);
    const emotions = dedup.filter(c => !isPause(c));
    if (pause) return emotions.length ? `${pause} ${emotions[emotions.length - 1]}` : pause;
    return `${emotions[0]} ${emotions[1]}`;
  });

/**
 * 把 ElevenLabs 演出标记从「要显示给用户」的文本里清掉。
 * 只删「被识别为 cue 的」方括号/圆括号（[laugh]/[pause]/[scoff]/(laughs) 等
 * —— 凡 normalizeElevenCue 认得的都算），普通括注（[备注]/[TODO]/(顺便) 等）原样保留。
 * 因为只删可识别的 cue 词，可**安全地无差别用于任意显示文本**（聊天气泡 / 转文字 / 翻译），
 * 也不会误伤用户自己打的括号内容。
 *
 * 与 stripElevenCuesForDisplay 同逻辑；保留两个名字是为了和 fishAudioTts 的
 * stripFishMarkupForDisplay / stripFishCuesForDisplay 对齐，方便上层按习惯挑用。
 */
export const stripElevenMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(/\[([^\[\]]{1,40})\]/g, (m, inner: string) => (normalizeElevenCue(inner) ? '' : m))
    .replace(/\(([^)]{1,40})\)/g, (m, inner: string) => (normalizeElevenCue(inner) ? '' : m))
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
};

/**
 * 精准版显示清洗：只删「被识别为 cue 的」方括号/圆括号（[laugh]/[pause]/[scoff]/(laughs) 等
 * —— 凡 normalizeElevenCue 认得的都算），普通括注（[重要]/[TODO]/(顺便) 等）原样保留。
 * 因为只删可识别的 cue 词，可**安全地无差别用于任意显示文本**（聊天气泡 / 转文字 / 翻译），
 * 不挑服务商，也不会误伤用户自己打的括号内容。
 */
export const stripElevenCuesForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(/\[([^\[\]]{1,40})\]/g, (m, inner: string) => (normalizeElevenCue(inner) ? '' : m))
    .replace(/\(([^)]{1,40})\)/g, (m, inner: string) => (normalizeElevenCue(inner) ? '' : m))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
};

/** 解析 apiConfig 里的 ElevenLabs Key（独立 Key，不复用通用 apiKey —— 那是 LLM 的）。 */
export const resolveElevenLabsApiKey = (apiConfig: APIConfig): string =>
  normalizeApiKey(apiConfig.elevenLabsApiKey || '');

/**
 * 归一化 ElevenLabs 音色 id（voice_id）。容忍用户直接粘 ElevenLabs 网页链接：
 *   https://elevenlabs.io/app/voice-lab/share/voice/21m00Tcm4TlvDq8ikWAM
 *   https://elevenlabs.io/voice/share/voice/21m00Tcm4TlvDq8ikWAM
 * 也容忍只粘 id 本身。voice_id 是 20 位字母数字串（如 21m00Tcm4TlvDq8ikWAM）。
 *
 * 注意：URL 路径里可能多次出现 /voice/（如 /voice/share/voice/<id>），所以
 * 匹配 voice_id 形态时要求长度 16–32 位字母数字，避免误匹配到 'share' 这种短词。
 */
export const normalizeElevenVoiceId = (raw?: string | null): string => {
  const s = (raw || '').trim();
  if (!s) return '';
  // 1) URL 里的 /voice/<id> 路径，要求 id 形态（16–32 位字母数字）—— 排除 /voice/share/ 误匹配
  const byPath = s.match(/\/voice\/([A-Za-z0-9]{16,32})/i);
  if (byPath) return byPath[1];
  // 2) ElevenLabs voice_id 形态：16–32 位字母数字（含大小写）
  const byId = s.match(/\b[A-Za-z0-9]{16,32}\b/);
  if (byId) return byId[0];
  // 3) 兜底：去掉可能的查询串/空白
  return s.split(/[?#\s]/)[0];
};

/** 该角色能否用 ElevenLabs 合成（必须有 Key + voice_id）。 */
export const canSynthesizeEleven = (char: CharacterProfile, apiConfig: APIConfig): boolean =>
  !!resolveElevenLabsApiKey(apiConfig) && !!normalizeElevenVoiceId(char.voiceProfile?.elevenVoiceId);

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const shouldBypassWebProxy = (): boolean => {
  if (typeof window === 'undefined') return false;
  const protocol = String(window.location.protocol || '').toLowerCase();
  if (protocol === 'file:') return true;
  const host = String(window.location.hostname || '').toLowerCase();
  return host === 'github.io' || host.endsWith('.github.io');
};

/** base64 → Blob（CapacitorHttp 二进制响应是 base64 字符串）。 */
const base64ToBlob = (b64: string, mime = 'audio/mpeg'): Blob => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

/**
 * 调 ElevenLabs /v1/text-to-speech/{voice_id}，拿回音频 Blob。
 * web：默认走 /api/elevenlabs/tts 代理；静态预览（github.io / file:）走通用 worker 代理。
 * native：CapacitorHttp 直连上游，responseType='blob' 绕过浏览器 CORS。
 */
const elevenFetchAudio = async (
  payload: any,
  apiKey: string,
  voiceId: string,
  model: string,
): Promise<Blob> => {
  const upstreamUrl = `${ELEVEN_UPSTREAM_BASE}/${voiceId}`;
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'xi-api-key': apiKey,
    Accept: 'audio/mpeg',
  };

  if (isNative()) {
    const response = await CapacitorHttp.request({
      url: upstreamUrl,
      method: 'POST',
      headers: jsonHeaders,
      data: payload,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) {
      // Native 路径补 detail：CapacitorHttp 在非 2xx 时 response.data 可能是错误体字符串（JSON / 文本），
      // 拼到 throw message 里方便排查（之前只显示 HTTP 状态码，调试困难）。
      let detail = '';
      try {
        const d = response.data;
        detail = typeof d === 'string' ? d.slice(0, 200) : JSON.stringify(d).slice(0, 200);
      } catch { /* ignore */ }
      throw new Error(`ElevenLabs TTS 失败 (HTTP ${response.status})${detail ? `：${detail}` : ''}`);
    }
    // CapacitorHttp blob 响应：data 是 base64 字符串。
    // ⚠️ 关键修复：上游 ElevenLabs 在某些 validation 场景会返回 200 + JSON 错误体（不是 4xx）。
    // CapacitorHttp 拿到这种响应时 response.data 是 JSON 字符串的 base64，base64ToBlob 会得到
    // 一个 type 为 'audio/mpeg' 但内容是 JSON 文本的 blob。这里嗅探一下：base64 解码后前几个字节
    // 是不是 JSON 起始字符（{ 或 [），是就当错误处理，避免坏 blob 进缓存。
    const b64Data = String(response.data || '');
    const blob = base64ToBlob(b64Data);
    if (blob.size < 32 || !(await isLikelyAudioBlob(blob))) {
      const text = await blob.text().catch(() => '');
      throw new Error(`ElevenLabs TTS 返回非音频内容${text ? `：${text.slice(0, 200)}` : ''}`);
    }
    return blob;
  }

  // 静态部署（github.io / file:）没有 /api serverless 代理，直连 api.elevenlabs.io 会被浏览器
  // CORS 挡（ElevenLabs 不发 ACAO 头）。走项目通用 worker 代理 /elevenlabs/tts（带 CORS 头）。
  // voice_id 和 model 放 query，避免自定义头触发预检失败；只留 Authorization（worker 已允许）。
  let url: string;
  let headers: Record<string, string>;
  if (shouldBypassWebProxy()) {
    url = `${getProxyWorkerUrl()}/elevenlabs/tts?voice_id=${encodeURIComponent(voiceId)}&model=${encodeURIComponent(model)}`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  } else {
    url = ELEVEN_PROXY_PATH;
    headers = jsonHeaders;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`ElevenLabs TTS 失败 (HTTP ${res.status})${detail ? `：${detail}` : ''}`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('ElevenLabs TTS 返回空音频');
  // ⚠️ 关键修复：blob.type 不是 audio/* 时拒绝接受（防止 JSON 错误体被当音频缓存）。
  // 后端 proxy 已经做了 contentType 嗅探会拦截，这里是客户端兜底——任何路径（包括 native、worker）
  // 拿到非音频 blob 都拒绝，避免坏 blob 进 IndexedDB 造成"持续中毒"。
  if (!(await isLikelyAudioBlob(blob))) {
    const text = await blob.text().catch(() => '');
    throw new Error(`ElevenLabs TTS 返回非音频内容${text ? `：${text.slice(0, 200)}` : ''}`);
  }
  return blob;
};

/**
 * 判断 blob 是不是真的音频。两道关：
 * 1. blob.type 以 'audio/' 开头 → 通过
 * 2. blob.type 为空（CapacitorHttp base64 解码的 blob 没设 type）→ 嗅探前 4 字节，看是不是
 *    MP3/ID3/WAV/OGG/FLAC 等音频魔术字节；JSON 错误体（{ 或 [）会被拦下。
 *
 * 异步：因为读前 4 字节是 async 操作。调用方用 await。
 */
const isLikelyAudioBlob = async (blob: Blob): Promise<boolean> => {
  const t = (blob.type || '').toLowerCase();
  if (t.startsWith('audio/')) return true;
  if (t && !t.startsWith('application/octet-stream') && !t.startsWith('text/')) {
    // 显式非 audio / 非二进制流 → 拒绝（如 application/json）
    return false;
  }
  // type 为空 / octet-stream → 嗅探前 4 字节魔术字节
  try {
    const buf = await blob.slice(0, 4).arrayBuffer();
    const bytes = new Uint8Array(buf);
    // MP3 frame sync: 0xFF 0xE0 mask
    if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return true;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // "ID3"
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true; // "RIFF" (WAV)
    if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return true; // "OggS"
    if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) return true; // "fLaC"
    // JSON 错误体起始字符：{ 0x7B 或 [ 0x5B
    if (bytes[0] === 0x7B || bytes[0] === 0x5B) return false;
    // 其它二进制 → 假定是音频（兼容性优先，让 play() 自己判）
    return true;
  } catch {
    // 嗅探失败 → 假定是音频（避免误拒正常 blob）
    return true;
  }
};

/**
 * 调 ElevenLabs TTS，返回可播放 URL + 原始 blob（可写 IndexedDB 持久化）。
 * 与 minimaxTts.synthesizeSpeechDetailed / fishAudioTts.synthesizeSpeechFishDetailed 同签名，
 * 方便 ttsRouter 透明切换。
 */
export async function synthesizeSpeechElevenDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  // 与 minimax/fish 同签名方便 ttsRouter 透明切换。
  // 注意：languageBoost 和 groupId 在 ElevenLabs v3 里**没有对应字段**（v3 自动语种检测，
  // 不需要 language hint），传了也会被忽略——参数保留只是为了签名对齐，避免 TS 报错。
  // emotion 会被映射到 v3 支持的方括号 cue（如 happy → [laugh]）作为兜底。
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<TtsResult> {
  const apiKey = resolveElevenLabsApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少 ElevenLabs API Key');
  const vp = char.voiceProfile;
  const voiceId = normalizeElevenVoiceId(vp?.elevenVoiceId);
  if (!voiceId) throw new Error('角色未配置 ElevenLabs 音色（voice_id）');

  const model = (vp?.elevenModel || apiConfig.elevenLabsModel || DEFAULT_ELEVEN_MODEL).trim() || DEFAULT_ELEVEN_MODEL;

  // ElevenLabs-aware 清洗：保留方括号 cue / 圆括号特效，只清系统标记和 MiniMax 残留。
  let spoken = cleanTextForTtsEleven(text);
  // 兜底：上层传了整条 emotion 属性、且正文没有任何「情绪/语气」cue 时，前置一个 cue。
  // 注意只看情绪类 cue，[pause] 这类停顿不算（否则换行插的停顿会顶掉兜底）。
  const emotionCues = (spoken.match(/\[([^\]]+)\]/g) || [])
    .filter(c => !/^\[pauses?\]$/i.test(c.trim()));
  const hasInlineCue = emotionCues.length > 0;
  const elevenEmotion = options?.emotion ? ELEVEN_EMOTION_MAP[options.emotion.toLowerCase()] : undefined;
  if (elevenEmotion && !hasInlineCue) spoken = `[${elevenEmotion}] ${spoken}`;
  if (!spoken) throw new Error('ElevenLabs TTS 文本为空');

  // F12 调试：打印 LLM 带标签原文 + 实际送 ElevenLabs 的文本，方便排查「标签被念出来」之类问题。
  console.log('[elevenlabs] TTS', {
    model,
    voice_id: voiceId,
    emotion_attr: options?.emotion || '',
    raw_llm_text: text,        // LLM 输出的带标签原文
    sent_to_eleven: spoken,    // 清洗后真正发给 ElevenLabs 的文本
  });

  const payload: any = {
    text: spoken,
    model_id: model,
    // voice_id 后端 proxy 从 body 读出来拼到上游 URL；native / 静态 worker 路径会从函数参数取。
    voice_id: voiceId,
    // 语速：角色配了就用角色的；没配则默认 0.9（比 1.0 慢一档）—— ElevenLabs 默认读得偏快，
    // 尤其外语长段落容易"一口气念完"，稍微放慢更像真人说话、段落停顿也更听得出。
    voice_settings: {
      speed: (typeof vp?.speed === 'number' && vp.speed > 0) ? Math.max(0.7, Math.min(1.2, vp.speed)) : 0.9,
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.35,
      use_speaker_boost: true,
    },
  };

  const cacheKey = hashTtsParams({
    kind: 'elevenlabs-tts',
    text: payload.text,
    model,
    voice_id: voiceId,
    voice_settings: payload.voice_settings,
  });
  const cached = await getCachedTts(cacheKey);
  if (cached) {
    return { url: URL.createObjectURL(cached), blob: cached };
  }

  const blob = await elevenFetchAudio(payload, apiKey, voiceId, model);
  saveCachedTts(cacheKey, blob).catch(() => { /* ignore */ });
  return { url: URL.createObjectURL(blob), blob };
}

/** 薄封装：只要可播放 URL 时用。 */
export async function synthesizeSpeechEleven(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<string> {
  const { url } = await synthesizeSpeechElevenDetailed(text, char, apiConfig, options);
  return url;
}
