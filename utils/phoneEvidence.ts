import type { PhoneEvidence } from '../types';

const renderPhoneField = (input: unknown, seen: Set<object>): string => {
    if (input == null) return '';
    const valueType = typeof input;
    if (valueType === 'string') return input as string;
    if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') return String(input);
    if (valueType === 'symbol' || valueType === 'function') return String(input);

    if (valueType === 'object') {
        const objectValue = input as object;
        if (seen.has(objectValue)) return '[循环引用]';
        seen.add(objectValue);
        let text: string;
        if (Array.isArray(input)) {
            text = input.map(item => renderPhoneField(item, seen)).filter(Boolean).join('\n');
        } else {
            const entries = Object.entries(input as Record<string, unknown>);
            text = entries.length
                ? entries.map(([key, value]) => `${key}: ${renderPhoneField(value, seen)}`).join('\n')
                : '';
        }
        seen.delete(objectValue);
        return text;
    }

    return String(input);
};

/**
 * LLM 自定义 App 偶尔会把本应为字符串的字段返回成对象。
 * React 不能直接渲染对象；这里在生成边界和历史数据展示边界统一降级成可读文本。
 */
export function phoneFieldToText(input: unknown, fallback: string = ''): string {
    const text = renderPhoneField(input, new Set()).trim();
    return text || fallback;
}

export function normalizePhoneEvidence(record: PhoneEvidence): PhoneEvidence {
    const raw = record as unknown as Record<string, unknown>;
    const value = phoneFieldToText(raw.value);
    return {
        ...record,
        title: phoneFieldToText(raw.title, 'Unknown'),
        detail: phoneFieldToText(raw.detail, '...'),
        value: value || undefined,
    };
}
