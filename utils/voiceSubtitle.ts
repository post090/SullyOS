import { Message } from '../types';

/**
 * 字幕对齐模式（外语语音）下，中文字幕和 <语音> 块会被 chunkText 拆成同一回合里的
 * 不同气泡：字幕是独立的文字气泡，语音消息本身标签外往往没有中文。
 *
 * 以前语音条的中文翻译 (originalText) 只看「标签外的文字」，看不到就发一次 LLM
 * 请求把外语翻回中文——请求一失败翻译就永远空着（用户报的「外语语音没翻译」）。
 *
 * 这个 helper 从同一批 assistant 消息里把字幕直接收回来当翻译：确定性、零成本、
 * 内容还和用户看到的字幕逐字一致。收不到（纯语音回合）再让调用方走 LLM 兜底。
 *
 * 约束：
 *  - 只收 msg 所在的连续 assistant 批次（前后扩展，遇到非 assistant 停）
 *  - 批次里除 msg 外还有别的语音消息 → 字幕归属含糊，返回 ''（走 LLM 兜底）
 *  - 只收 type==='text' 且不含语音标签的气泡；emoji / 卡片等跳过
 *  - 双语气泡只取 %%BILINGUAL%% 之前的「选」语言半边（那才是字幕面）
 */
export function collectVoiceBatchSubtitle(
    messages: Pick<Message, 'id' | 'role' | 'type' | 'content'>[],
    msgId: number,
): string {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return '';
    let start = idx;
    let end = idx;
    while (start > 0 && messages[start - 1].role === 'assistant') start--;
    while (end < messages.length - 1 && messages[end + 1].role === 'assistant') end++;

    const VOICE_OPEN_RE = /<[语語]音[^>]*>/;
    const parts: string[] = [];
    for (let i = start; i <= end; i++) {
        const m = messages[i];
        if (i === idx) continue;
        if (m.type !== 'text') continue;
        if (VOICE_OPEN_RE.test(m.content || '')) return ''; // 同批第二条语音：归属含糊
        const half = (m.content || '').split(/%%BILINGUAL%%/i)[0].trim();
        if (half) parts.push(half);
    }
    // 兜个上限，防极端长回合把翻译面板撑爆
    return parts.join('\n').slice(0, 2000);
}
