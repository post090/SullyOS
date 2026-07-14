import { describe, it, expect } from 'vitest';
import { scanSseForLog } from './apiCallLog';

// 锁住 API 调用记录的 SSE 兜底解析：流式响应 JSON.parse 必然失败，
// 后端自报 model（首个非空）与 usage（末个非空）从 data: 行里扫出来。

describe('scanSseForLog', () => {
    it('抠出首个 model 与最后一个 usage', () => {
        const sse = [
            'data: {"id":"x","model":"[逆-V]gemini-3.1-pro-preview-c","choices":[{"delta":{"content":"a"}}]}',
            'data: {"model":"[逆-V]gemini-3.1-pro-preview-c","choices":[{"delta":{"content":"b"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15572,"completion_tokens":725,"total_tokens":16297}}',
            'data: [DONE]',
        ].join('\n');
        const { model, usage } = scanSseForLog(sse);
        expect(model).toBe('[逆-V]gemini-3.1-pro-preview-c');
        expect((usage as any).prompt_tokens).toBe(15572);
        expect((usage as any).total_tokens).toBe(16297);
    });

    it('坏行/空行/[DONE] 跳过不崩', () => {
        const sse = 'data: 不是json\n\ndata: [DONE]\ndata: {"model":"m1","choices":[]}';
        const { model, usage } = scanSseForLog(sse);
        expect(model).toBe('m1');
        expect(usage).toBeUndefined();
    });

    it('非 SSE 文本返回空结果', () => {
        expect(scanSseForLog('{"model":"x"}')).toEqual({ model: undefined, usage: undefined });
    });
});
