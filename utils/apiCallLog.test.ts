import { describe, it, expect } from 'vitest';
import { scanSseForLog, coreModelName, isSameCoreModel } from './apiCallLog';

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

describe('coreModelName 核心名归一化（实际后端琥珀判定用）', () => {
    it('剥方括号/半角圆括号/全角圆括号渠道标签', () => {
        expect(coreModelName('[千岛-自营]gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
        expect(coreModelName('(按次)gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
        expect(coreModelName('（官转）gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
    });

    it('渠道标签不同但核心名相同 → 判定一致（不误报琥珀）', () => {
        expect(coreModelName('(按次)gemini-3.1-pro-preview')).toBe(coreModelName('gemini-3.1-pro-preview'));
        expect(coreModelName('[co假流]Gemini-3.1-Pro-Preview')).toBe(coreModelName('gemini-3.1-pro-preview'));
    });

    it('核心名真的不同（如 -c 后缀）→ 判定不一致（该报琥珀）', () => {
        expect(coreModelName('[逆-V]gemini-3.1-pro-preview-c')).not.toBe(coreModelName('[千岛-自营]gemini-3.1-pro-preview'));
    });
});

describe('isSameCoreModel 方向性同名判定', () => {
    it('裸前缀 / 路径前缀 → 同名（gcli-X↔X、X↔models/X）', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('gemini-3.1-pro-preview', 'models/gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('(按次)gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('[千岛-自营]gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
    });

    it('尾部变体 → 不同名（缩水降级信号必须报琥珀）', () => {
        expect(isSameCoreModel('[千岛-自营]gemini-3.1-pro-preview', '[逆-V]gemini-3.1-pro-preview-c')).toBe(false);
        expect(isSameCoreModel('gpt-4o', 'gpt-4o-mini')).toBe(false);
        expect(isSameCoreModel('gemini-3.1-pro-preview', 'gemini-3.1-flash-preview')).toBe(false);
    });

    it('短名不做 endsWith 宽容；空值不报警', () => {
        expect(isSameCoreModel('4o', 'gpt-4o')).toBe(false);
        expect(isSameCoreModel('x', '')).toBe(true);
    });
});
