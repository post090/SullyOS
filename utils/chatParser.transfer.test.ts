import { describe, expect, it } from 'vitest';
import { extractTransferCommands } from './transferFormat';

// 本文件原为 master 上 chatParser.extractAssistantTransfers 的测试。合并时那份实现被
// utils/transferFormat.ts:extractTransferCommands 取代 (与 worker classifier 共用一份源码,
// 额外覆盖 kv 形态 / [[记录:]] 幂等哨兵 / 收退回执 / 方向校验), 其能力 (全角括号【】/
// 主语「我」/ credits 后缀) 已并入。这里逐条保留原测试的行为断言, 改打新入口。

const sendAmounts = (input: string) =>
    extractTransferCommands(input).events.flatMap(e => (e.kind === 'send' ? [e.amount] : []));

describe('extractTransferCommands — 承接 extractAssistantTransfers 的行为', () => {
    it('keeps supporting the canonical action format', () => {
        const r = extractTransferCommands('给你。\n[[ACTION:TRANSFER:520]]');
        expect(r.text).toBe('给你。');
        expect(sendAmounts('给你。\n[[ACTION:TRANSFER:520]]')).toEqual(['520']);
    });

    it('tolerates full-width punctuation, currency symbols and decimals', () => {
        const input = '[[ ACTION：TRANSFER：￥1,999.50 元 ]]';
        const r = extractTransferCommands(input);
        expect(r.text).toBe('');
        // 金额归一化: 1,999.50 → 1999.5 (原实现保留尾零 '1999.50'; 数值等价,
        // formatTransferAmount 整数去点、非整数保两位, 与 metadata.amount 的既有形态一致)
        expect(sendAmounts(input)).toEqual(['1999.5']);
    });

    it('recovers a transfer when the model imitates a system log', () => {
        const r1 = extractTransferCommands('拿着。\n[系统: 你向小鱼转账 1999]');
        expect(r1.text).toBe('拿着。');
        expect(sendAmounts('拿着。\n[系统: 你向小鱼转账 1999]')).toEqual(['1999']);

        // 全角括号 + 主语「我」(角色以第一人称说话): 同样是合法转账
        const r2 = extractTransferCommands('【系统：我向你转账￥520元】');
        expect(r2.text).toBe('');
        expect(sendAmounts('【系统：我向你转账￥520元】')).toEqual(['520']);
    });

    it('does not turn an incoming user transfer log into an outgoing transfer', () => {
        // 原实现把这行原样留在正文里; 我们更进一步: 整块消费掉且零事件 —— 这是历史 leak,
        // 落进气泡就是用户反馈的原样复现 (sanitize 终线同样会剥, 这里在解析层就拦掉)。
        const incoming = '[系统: 用户向你转账 1999]';
        const r = extractTransferCommands(incoming);
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(1);
        expect(r.text).toBe('');
    });

    it('extracts multiple transfers and ignores zero-value actions', () => {
        const input = '[[ACTION:TRANSFER:520]]\n[[ACTION:TRANSFER:0]]\n[[ACTION:TRANSFER:1314]]';
        const r = extractTransferCommands(input);
        expect(r.text).toBe('');
        expect(sendAmounts(input)).toEqual(['520', '1314']);
    });

    it('credits 后缀同样解析 (原 CANONICAL_TRANSFER_RE 允许)', () => {
        expect(sendAmounts('[[ACTION:TRANSFER:520 credits]]')).toEqual(['520']);
    });
});
