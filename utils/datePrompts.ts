/**
 * 见面（DateApp）提示词统一构造器
 *
 * 与聊天侧 chatRequestPayload.ts 同构：peek（感知开场）/ send / reroll 三条路径
 * 都从这里拿完整的 messages 数组，DateApp 组件只负责 UI 状态和 fetch。
 *
 * 与聊天侧注入面的差异（刻意为之，不是漏配）：
 *   - 注入：ContextBuilder.buildCoreContext 全量（人设 / 世界书 / 印象 / 记忆 /
 *     记忆宫殿召回 / 情绪 buff）+ 当前虚拟时间。
 *   - 不注入：聊天 App 行为规范（IM 气泡 / 表情包 / 语音 / 引用 / 转账 / 小红书 /
 *     日记等工具块）——这些是线上聊天专属指令，面对面场景里输出会破坏 VN 格式。
 *   - 不注入：实时天气 / 新闻、群聊背景、Notion / 飞书日记标题——见面是高沉浸短会话，
 *     这些背景块收益低，还会稀释 VN 格式指令的权重。
 *   - 日程 / 音乐氛围目前也不进见面场景；以后要加请在这里统一加，别在组件里散拼。
 *
 * 历史构建统一复用 ChatPrompts.buildMessageHistory：html_card / score_card /
 * chat_forward / emoji 等都会被压成短摘要，不会把原始 HTML / JSON / URL 塞进
 * prompt（peek 旧版手搓 mapper 的问题即在此，已统一修掉）。
 */

import { CharacterProfile, UserProfile, Message, Emoji } from '../types';
import { ContextBuilder } from './context';
import { ChatPrompts } from './chatPrompts';
import { injectMemoryPalace } from './memoryPalace/pipeline';

export type ApiMessage = { role: string; content: any };

/**
 * 注入 prompt 的当前时间，直接取真实系统时间（完整日期 + 星期 + 时分）。
 * 不要从 OSContext 的 virtualTime 取——那个名字唬人，实际也是每秒同步的真实
 * 时间，但只有"星期 + 时:分"，缺日期，而且没必要让 prompt 构建依赖 React 状态。
 */
const getRealTimeStr = (): string => {
    const now = new Date();
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${ChatPrompts.formatDate(now.getTime())} ${days[now.getDay()]}`;
};

/** 立绘系统要求必备的五种基础情绪；角色自定义立绘在此之上叠加 */
export const REQUIRED_DATE_EMOTIONS = ['normal', 'happy', 'angry', 'sad', 'shy'];

const getDateEmotions = (char: CharacterProfile): string[] =>
    [...REQUIRED_DATE_EMOTIONS, ...(char.customDateSprites || [])];

/**
 * 见面侧的时间间隔提示。与 ChatPrompts.getTimeGapHint（IM 风格文案）刻意分开：
 * 这里的措辞面向"多久没见面/互动"的场景判断，不是"多久没回消息"。
 */
const getTimeGapHint = (lastMsgTimestamp: number | undefined): string => {
    if (!lastMsgTimestamp) return '这是你们的初次互动。';
    const now = Date.now();
    const diffMs = now - lastMsgTimestamp;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const currentHour = new Date().getHours();
    const isNight = currentHour >= 23 || currentHour <= 6;

    if (diffMins < 5) return '';
    if (diffMins < 60) return `[系统提示: 距离上次互动: ${diffMins} 分钟。]`;
    if (diffHours < 6) {
        if (isNight) return `[系统提示: 距离上次互动: ${diffHours} 小时。现在是深夜/清晨。]`;
        return `[系统提示: 距离上次互动: ${diffHours} 小时。]`;
    }
    if (diffHours < 24) return `[系统提示: 距离上次互动: ${diffHours} 小时。]`;
    const days = Math.floor(diffHours / 24);
    return `[系统提示: 距离上次互动: ${days} 天。]`;
};

/**
 * 把 buildMessageHistory 的结构化输出压平成纯文本（peek 的 [最近记录] 块用）。
 * 图片消息的 image_url 部分丢弃，只保留文字占位（peek 不需要看图）。
 */
const flattenHistoryToText = (apiMessages: ApiMessage[]): string =>
    apiMessages.map(m => {
        const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
                ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ')
                : '';
        return `${m.role}: ${text}`;
    }).join('\n');

/**
 * VN 模式系统提示（send 与 reroll 共用同一份，避免两处手抄漂移）。
 * reroll 的差异只体现在末尾 user 消息的 System Note 里，不在这里分叉。
 */
const buildVNModeBlock = (char: CharacterProfile): string => {
    const timeStr = getRealTimeStr();
    const dateEmotions = getDateEmotions(char);
    return `### [Visual Novel Mode: 视觉小说脚本模式]
你正在与用户进行**面对面**的互动。这不是聊天，是一场真实的见面。

### 核心规则：一行一念 (One Line per Beat)
前端解析器基于**换行符**来分割气泡。
1. **禁止混写**: 严禁在同一行里既写动作又写带引号的台词。
2. **情绪标签**: **每一行都必须以** \`[emotion]\` **开头**，表示该行的表情立绘。情绪随内容变化——台词温柔就用 [happy]，动作紧张就用 [shy]，语气冲就用 [angry]。**不要整段只用一个情绪，要逐行根据语境切换。** 仅限使用以下情绪: ${dateEmotions.join(', ')}。不要使用任何不在此列表中的标签。
3. **格式**: 台词用双引号 **"..."**，动作/叙述直接写（不加引号）。

### ⭐ 动作与叙述行的写法
你不是在列清单，你是在写一个正在发生的场景。每一行动作/叙述都应该让人感受到**此时此刻的空气**。

**具体要求**：
- 写出**感官**：光线怎么落的、空气什么味道、皮肤什么触感、周围什么声音
- 写出**节奏**：动作之间有停顿、有犹豫、有呼吸，不要一口气做完三个动作
- 写出**情绪的痕迹**：不要说"他很紧张"，而是写他的手指在桌面上画了一道看不见的线
- 让每一行都有**画面**，像电影里的一个镜头

❌ **不要这样写**（只用一个情绪 + 干巴巴的动作罗列）：
[normal] 把手放下，看向你。
走到你身边，坐下来。
拿起杯子，喝了一口水。

✅ **要这样写**（每行标注情绪 + 有呼吸感的叙述）：
[normal] 指尖从发梢滑落，垂在身侧。视线转过来的时候并不急，像是刚好、又像是故意。
[shy] "……你一直在看我吗？"
[happy] 嘴角的弧度藏不住，像是被戳中了什么小心思。
[normal] 脚步踩在木地板上的声音很轻。在你旁边坐下来，衣料带过一缕还没散尽的冷风。

### 场景上下文
1. **Time**: 当前时间 ${timeStr}。
2. **Location**: 你们现在**面对面**。
3. **Context**: 参考历史记录。如果刚刚才看到开场白（Opening），请自然接话。
`;
};

/**
 * 历史构建（send / reroll 共用）：
 * 1. 开了记忆宫殿 → 按高水位线过滤掉已被向量记忆替代的旧消息（chat 是在 DB 层做的；
 *    这里 allMsgs 用 includeProcessed=true 因为见面记录展示 + injectMemoryPalace
 *    还需要全集，所以手动过一遍）。
 * 2. 复用 ChatPrompts.buildMessageHistory 压缩各类卡片。
 * 3. 排除最后一条（待重发的 user msg），由调用方单独追加带 System Note 的版本。
 */
const buildDateHistory = (
    allMsgs: Message[],
    char: CharacterProfile,
    userProfile: UserProfile | null | undefined,
    emojis: Emoji[],
): ApiMessage[] => {
    const limit = char.contextLimit || 500;
    const hwm = parseInt(localStorage.getItem(`mp_lastMsgId_${char.id}`) || '0', 10);
    const palaceFiltered = hwm > 0 ? allMsgs.filter(m => m.id > hwm) : allMsgs;
    const historyForBuild = palaceFiltered.slice(0, -1);
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        historyForBuild, limit, char, userProfile || ({} as UserProfile), emojis,
    );
    return apiMessages;
};

export const DatePrompts = {
    getTimeGapHint,

    /**
     * Peek（感知开场）：用户"悄悄靠近"前，让 LLM 第三人称描写角色当下的状态。
     * 历史以纯文本块塞进 user 消息（保持"你不在和用户对话"的框定），
     * 但文本本身来自 buildMessageHistory，卡片/媒体已压成短摘要。
     */
    buildPeekPayload: (input: {
        char: CharacterProfile;
        userProfile: UserProfile;
        allMsgs: Message[];
        emojis: Emoji[];
    }): { messages: ApiMessage[] } => {
        const { char, userProfile, allMsgs, emojis } = input;
        const timeStr = getRealTimeStr();
        const limit = char.contextLimit || 500;
        const peekLimit = Math.min(limit, 50);
        const lastMsg = allMsgs[allMsgs.length - 1];
        const gapHint = getTimeGapHint(lastMsg?.timestamp);

        const { apiMessages } = ChatPrompts.buildMessageHistory(
            allMsgs, peekLimit, char, userProfile || ({} as UserProfile), emojis,
        );
        const recentMsgs = flattenHistoryToText(apiMessages);

        const baseContext = ContextBuilder.buildCoreContext(char, userProfile, false);

        // 根据时间间隔选择合适的分隔符
        const contextSeparator = gapHint
            ? `\n\n--- [TIME SKIP: ${gapHint}] ---\n\n`
            : `\n\n--- [SCENE CONTINUATION: 刚刚还在聊天，现在来到了面对面的场景] ---\n\n`;

        const peekInstructions = `
### 场景：感知 (Sense Presence)
当前时间: ${timeStr}
时间上下文: ${gapHint}

### 任务
你现在并不在和用户直接对话。用户正在悄悄靠近你所在的地点。
请用**第三人称**描写一段话。
描述：${char.name} 此时此刻正在做什么？周围环境是怎样的？状态如何？

### 逻辑检查
1. **上下文连贯性**: 参考 [最近记录]（注意消息来源标签：[聊天]是文字聊天、[约会]是面对面、[通话]是语音通话）。如果有 [TIME SKIP] 且间隔很久，开启新场景；如果是 [SCENE CONTINUATION]，说明刚刚还在聊天，**必须**自然衔接最近的聊天话题和情绪状态，不要无视之前的对话内容。
2. **状态一致性**: ${gapHint.includes('天') ? '如果间隔了很多天，可能在发呆、忙碌或者有点落寞。' : '根据最近的聊天内容和情绪来决定当前状态。如果刚聊完，角色的状态应该与聊天内容相呼应。'}
3. **描写风格**: 电影感，沉浸式，细节丰富。不要输出任何前缀，直接输出描写内容。`;

        return {
            messages: [
                { role: 'system', content: baseContext },
                { role: 'user', content: `[最近记录 (Previous Context)]:${recentMsgs}${contextSeparator}${peekInstructions}\n\n(Start sensing...)` },
            ],
        };
    },

    /**
     * Session（send / reroll 共用）。
     * allMsgs 须为 includeProcessed=true 的全量消息，且最后一条是本轮要重新追加的
     * user 消息（send：刚落库的输入；reroll：触发上一条 AI 回复的那条）。
     */
    buildSessionPayload: async (input: {
        char: CharacterProfile;
        userProfile: UserProfile;
        allMsgs: Message[];
        emojis: Emoji[];
        userText: string;
        variant: 'send' | 'reroll';
    }): Promise<{ messages: ApiMessage[] }> => {
        const { char, userProfile, allMsgs, emojis, userText, variant } = input;

        const historyMsgs = buildDateHistory(allMsgs, char, userProfile, emojis);

        // 向量召回挂到 char.memoryPalaceInjection，buildCoreContext 会读取
        await injectMemoryPalace(char, allMsgs, undefined, userProfile?.name);
        const systemPrompt = ContextBuilder.buildCoreContext(char, userProfile)
            + buildVNModeBlock(char);

        const note = variant === 'send'
            ? `(System Note: 严格遵守 VN 格式。每一行都要以 [emotion] 开头，根据内容逐行切换情绪标签，不要整段只用同一个。叙述行写出场景的呼吸感，不要罗列动作。)`
            : `(System Note: Reroll. 用不同的角度重写。依然严格遵守 VN 格式：每一行以 [emotion] 开头并逐行切换情绪，叙述行保持场景的呼吸感，不要罗列动作。)`;

        return {
            messages: [
                { role: 'system', content: systemPrompt },
                ...historyMsgs,
                { role: 'user', content: `${userText}\n\n${note}` },
            ],
        };
    },
};
