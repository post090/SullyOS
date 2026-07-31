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

/** AudioBuffer → 16-bit PCM 单声道 WAV（语音足用，体积比立体声小一半）。 */
const audioBufferToWav = (buf: AudioBuffer): Blob => {
    const sampleRate = buf.sampleRate;
    const len = buf.length;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const dataSize = len * 2; // 单声道 * 16bit
    const arr = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arr);
    const wr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); wr(8, 'WAVE');
    wr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    wr(36, 'data'); view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
    }
    return new Blob([arr], { type: 'audio/wav' });
};

/**
 * 把录音转成多模态模型普遍能吃的格式。Android WebView 的 MediaRecorder 只能吐 webm/opus，
 * 而 Gemini 等模型只收 mp3/wav/mpeg（会报 mime type is not supported by Gemini: 'audio/webm'）。
 * 这里用浏览器自带的 WebAudio 把 webm 本地解码再重编成 WAV（PCM），跟模型无关。
 * wav/mp3/mpeg/m4a 直接放行；解码失败就原样发（不比现状更差）。
 */
const toModelFriendlyAudio = async (blob: Blob): Promise<Blob> => {
    const t = (blob.type || '').toLowerCase();
    if (/wav|mpeg|mp3|mp4|m4a|aac/.test(t)) return blob;
    try {
        const AC: any = (typeof window !== 'undefined') && ((window as any).AudioContext || (window as any).webkitAudioContext);
        if (!AC) return blob;
        const ab = await blob.arrayBuffer();
        const ctx: AudioContext = new AC();
        const decoded = await ctx.decodeAudioData(ab.slice(0));
        try { await ctx.close(); } catch { /* noop */ }
        return audioBufferToWav(decoded);
    } catch {
        return blob;
    }
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
    const sendBlob = await toModelFriendlyAudio(blob);
    const b64 = await blobToBase64(sendBlob);
    const format = mimeToFormat(sendBlob.type);
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

/**
 * 录音 blob → OpenAI 兼容 input_audio 内容块所需的 { data(base64), format }（含 webm→WAV 本地转码）。
 * 给「跟随全局·一次调用」把音频直接塞进主模型回复请求复用，与 analyzeAnswerAudio 同一套格式。
 */
export const buildInputAudioPart = async (blob: Blob): Promise<{ data: string; format: string }> => {
    const sendBlob = await toModelFriendlyAudio(blob);
    return { data: await blobToBase64(sendBlob), format: mimeToFormat(sendBlob.type) };
};
