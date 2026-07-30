// 上岸计划 · 面试音频「说话状态」分析（只谈表达层面，绝不带岗位/公司/人名等隐私信息）
// Blob → base64 → OpenAI 兼容 chat/completions 的 input_audio 内容块，交给音频理解模型，
// 返回结构化说话状态评估。双轨模式（transcribeMode='stt'）下 wantTranscript=false：
// STT 已出转写、这里只做后台分析；一体模式（'audioModel'）wantTranscript=true：顺带要转写。

import { resilientFetch } from './resilientFetch';

export interface AnswerAudioAnalysis {
    /** 仅 wantTranscript（一体模式）时才有 */
    transcript?: string;
    /** 吐字清晰度 1-5 */
    clarity: number;
    /** 语速快慢 */
    pace: 'slow' | 'normal' | 'fast';
    /** 自信/稳定度 1-5 */
    confidence: number;
    /** 一句话中文点评（只谈表达状态） */
    note: string;
}

interface AudioApi { baseUrl: string; apiKey: string; model: string; }

/** Blob → base64（去掉 dataURL 前缀）。 */
const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
        const s = String(fr.result || '');
        const comma = s.indexOf(',');
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    fr.onerror = () => reject(new Error('音频读取失败'));
    fr.readAsDataURL(blob);
});

/** mime → input_audio format（webm/m4a/wav/mp3…）。 */
const mimeToFormat = (mime: string): string => {
    const m = (mime || '').toLowerCase();
    if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
    if (m.includes('wav')) return 'wav';
    if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
    return 'webm';
};

const clampScore = (v: any): number => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return 3;
    return Math.min(5, Math.max(1, n));
};

/**
 * 分析一段面试回答录音的「说话状态」。仅评估表达层面（清晰度/语速/自信），
 * 不涉及答题内容对错，也不带任何岗位/公司/个人隐私信息。
 * @param wantTranscript 一体模式：顺带让模型转写（双轨模式下 STT 已转写，传 false）。
 */
export async function analyzeAnswerAudio(
    blob: Blob,
    api: AudioApi,
    questionText: string,
    wantTranscript = false,
): Promise<AnswerAudioAnalysis> {
    const base = (api.baseUrl || '').replace(/\/+$/, '');
    if (!base || !api.apiKey) throw new Error('音频理解模型未配置');
    const b64 = await blobToBase64(blob);
    const format = mimeToFormat(blob.type);
    // 提示词只谈表达状态；题目文本仅作语境，不注入公司/岗位信息（调用方保证 questionText 已脱敏）
    const sys = [
        '你是语音表达教练。下面是一段面试回答的录音。',
        '只从「说话表达」层面评估，不要评判回答内容对错，也不要提及任何公司、岗位、人名等信息。',
        wantTranscript ? '先转写这段录音，再评估。' : '',
        '严格输出 JSON：{"transcript"?:string,"clarity":1到5整数,"pace":"slow"或"normal"或"fast","confidence":1到5整数,"note":"一句话中文点评（只谈吐字/语速/停顿/自信等表达状态）"}。不要输出任何其它内容。',
    ].filter(Boolean).join('\u000a');
    const q = (questionText || '').trim();
    const userText = wantTranscript
        ? `请转写并评估这段回答的说话状态。${q ? `（当前问题语境：${q.slice(0, 60)}）` : ''}`
        : `请评估这段回答的说话状态（表达层面）。${q ? `（当前问题语境：${q.slice(0, 60)}）` : ''}`;
    const body = {
        model: api.model,
        messages: [
            { role: 'system', content: sys },
            {
                role: 'user',
                content: [
                    { type: 'text', text: userText },
                    { type: 'input_audio', input_audio: { data: b64, format } },
                ],
            },
        ],
        temperature: 0.3,
        max_tokens: 800,
        stream: false,
    };
    const resp = await resilientFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify(body),
    }, { timeoutMs: 120_000, retries: 1 });
    if (!resp.ok) throw new Error(`音频分析接口返回 ${resp.status}`);
    const data = await resp.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content;
    const textOut = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map((c: any) => c?.text || '').join('') : '';
    const jsonMatch = textOut.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('音频分析返回无法解析');
    const parsed = JSON.parse(jsonMatch[0]);
    const pace: AnswerAudioAnalysis['pace'] = ['slow', 'normal', 'fast'].includes(parsed.pace) ? parsed.pace : 'normal';
    return {
        transcript: typeof parsed.transcript === 'string' && parsed.transcript.trim() ? parsed.transcript.trim() : undefined,
        clarity: clampScore(parsed.clarity),
        pace,
        confidence: clampScore(parsed.confidence),
        note: (typeof parsed.note === 'string' ? parsed.note : '').trim() || '表达平稳',
    };
}

/** pace → 中文标签（UI 浮条 / 表达复盘用）。 */
export const paceLabel = (p: AnswerAudioAnalysis['pace']): string =>
    p === 'slow' ? '语速偏慢' : p === 'fast' ? '语速偏快' : '语速适中';
