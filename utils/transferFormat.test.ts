import { describe, it, expect } from 'vitest';
import {
    parseTransferAmount,
    formatTransferAmount,
    extractTransferCommands,
    formatTransferRecord,
    type TransferRecordInput,
} from './transferFormat';
import { sanitizeForBubble, sanitizeForNotification } from './sanitize';

describe('parseTransferAmount', () => {
    it('纯数字', () => {
        expect(parseTransferAmount('1999')).toBe(1999);
        expect(parseTransferAmount('520')).toBe(520);
    });

    it('带单位 / 币种符号', () => {
        expect(parseTransferAmount('520元')).toBe(520);
        expect(parseTransferAmount('520块')).toBe(520);
        expect(parseTransferAmount('520块钱')).toBe(520);
        expect(parseTransferAmount('¥520')).toBe(520);
        expect(parseTransferAmount('￥520元')).toBe(520);
        expect(parseTransferAmount('520 RMB')).toBe(520);
    });

    it('千分位 / 小数 / 全角 / 多余空白', () => {
        expect(parseTransferAmount('1,999')).toBe(1999);
        expect(parseTransferAmount('1，999')).toBe(1999);
        expect(parseTransferAmount('520.00')).toBe(520);
        expect(parseTransferAmount('520.5')).toBe(520.5);
        expect(parseTransferAmount('５２０')).toBe(520);
        expect(parseTransferAmount('  520  ')).toBe(520);
    });

    it('非法值一律 null（0 / 负数 / 非数字 / 空）', () => {
        expect(parseTransferAmount('0')).toBeNull();
        expect(parseTransferAmount('-520')).toBeNull();
        expect(parseTransferAmount('很多')).toBeNull();
        expect(parseTransferAmount('')).toBeNull();
        expect(parseTransferAmount(undefined)).toBeNull();
        expect(parseTransferAmount(NaN)).toBeNull();
        expect(parseTransferAmount(Infinity)).toBeNull();
    });

    it('上限不设 —— 人设引导出的天价由用户自己负责', () => {
        expect(parseTransferAmount('999999999')).toBe(999999999);
    });
});

describe('formatTransferAmount', () => {
    it('整数去小数点，非整数保留两位', () => {
        expect(formatTransferAmount(520)).toBe('520');
        expect(formatTransferAmount(520.5)).toBe('520.5');
        expect(formatTransferAmount(520.456)).toBe('520.46');
    });
});

describe('extractTransferCommands — 规范标签', () => {
    it('基础形态', () => {
        const r = extractTransferCommands('给你[[ACTION:TRANSFER:1999]]拿去买喝的');
        expect(r.events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(r.text).toBe('给你拿去买喝的');
    });

    it('冒号后多空格 / 带单位 / 千分位（老正则会漏，漏了就静默消失）', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER: 520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:520元]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:1,999]]').events)
            .toEqual([{ kind: 'send', amount: '1999' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:520.00]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('一条回复里多笔全部保留，不设数量上限（老实现只认第一个，第二笔静默丢失）', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER:520]]吃饭\n[[ACTION:TRANSFER:1314]]打车');
        expect(r.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1314' },
        ]);
        expect(r.text).toBe('吃饭\n打车');
    });

    it('金额非法 → 剥掉保正文，不产生事件', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER:很多]]随便花');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('随便花');
        expect(r.consumed).toBe(1);
    });

    it('ACCEPT / RETURN 不会被 TRANSFER 正则误吃', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER_ACCEPT]]谢谢你').events)
            .toEqual([{ kind: 'accept' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER_RETURN]]我不能要').events)
            .toEqual([{ kind: 'return' }]);
    });

    it('按出现顺序返回，保住角色的语序意图', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER_ACCEPT]]收下了\n[[ACTION:TRANSFER:520]]这个还你');
        expect(r.events).toEqual([{ kind: 'accept' }, { kind: 'send', amount: '520' }]);
    });
});

describe('extractTransferCommands — 模仿历史日志的口语形态', () => {
    it('用户实际反馈的那一条：整块还原成真转账', () => {
        const r = extractTransferCommands('[系统: 你向阿桃转账 1999]拿去花');
        expect(r.events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(r.text).toBe('拿去花');
    });

    it('措辞变体', () => {
        const cases = [
            '[系统: 你向阿桃转账1999]',
            '[系统：你向阿桃转账 1999]',
            '[系统: 你给阿桃转账 1999]',
            '[系统: 你给阿桃转了1999]',
            '[系统: 你向阿桃转账了 ￥1,999元]',
            '[System: 你向阿桃转账 1999]',
        ];
        for (const c of cases) {
            expect(extractTransferCommands(c).events, c).toEqual([{ kind: 'send', amount: '1999' }]);
        }
    });

    it('群摘要形态 [转账1999]', () => {
        expect(extractTransferCommands('[转账1999]').events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(extractTransferCommands('[转账 520]').events).toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('回执形态 → accept / return', () => {
        expect(extractTransferCommands('[系统: 你接收了阿桃的转账 520]').events)
            .toEqual([{ kind: 'accept' }]);
        expect(extractTransferCommands('[系统: 你退回了阿桃的转账 520]').events)
            .toEqual([{ kind: 'return' }]);
    });
});

describe('extractTransferCommands — 方向校验（伪造必须拦下，不能渲染）', () => {
    it('用户→角色的转账日志：剥掉，不产生事件', () => {
        const r = extractTransferCommands('[系统: 阿桃向你转账 1999]我收下啦');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('我收下啦');
        expect(r.consumed).toBe(1);
    });

    it('角色替用户签收 / 退回：同样剥掉', () => {
        expect(extractTransferCommands('[系统: 阿桃接收了你的转账 1999]').events).toEqual([]);
        expect(extractTransferCommands('[系统: 阿桃退回了你的转账 1999]').events).toEqual([]);
    });

    it('待处理提示的完整历史行（带尾巴）也算伪造', () => {
        const r = extractTransferCommands('[系统: 阿桃向你转账 1999（待你处理，可收下或退回）]');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(1);
    });
});

describe('extractTransferCommands — 不越界', () => {
    it('自由散文不认：叙述不是指令', () => {
        const r = extractTransferCommands('我刚给你转了1999，记得查收');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(0);
        expect(r.text).toBe('我刚给你转了1999，记得查收');
    });

    it('非转账的系统日志不消费（留给 sanitize 终线）', () => {
        const r = extractTransferCommands('[系统: 用户戳了你一下]我在呢');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(0);
        expect(r.text).toBe('[系统: 用户戳了你一下]我在呢');
    });

    it('空输入 / 无标签', () => {
        expect(extractTransferCommands('')).toEqual({ text: '', events: [], consumed: 0 });
        expect(extractTransferCommands('今天天气不错')).toEqual({
            text: '今天天气不错', events: [], consumed: 0,
        });
    });

    it('正文原样保留，只挖走标签', () => {
        const r0 = extractTransferCommands('前面[[ACTION:TRANSFER:520]]中间[系统: 你向阿桃转账 1]后面');
        expect(r0.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1' },
        ]);
        expect(r0.text).toBe('前面中间后面');
    });
});

// ─── 词汇表统一: 记录形态 ↔ ACTION kv 形态 ─────────────────────────────────

describe('formatTransferRecord — 历史渲染', () => {
    it('原始转账: to = role 的对手方', () => {
        expect(formatTransferRecord({ role: 'assistant', amount: '1999' }))
            .toBe('[[记录:TRANSFER|to=user|amount=1999|status=待处理]]');
        expect(formatTransferRecord({ role: 'user', amount: '520' }))
            .toBe('[[记录:TRANSFER|to=char|amount=520|status=待处理]]');
    });

    it('原始转账读 live status —— 被收/退后不再显示待处理 (修掉旧渲染的不一致)', () => {
        expect(formatTransferRecord({ role: 'assistant', amount: '1999', status: 'accepted' }))
            .toBe('[[记录:TRANSFER|to=user|amount=1999|status=已收下]]');
        expect(formatTransferRecord({ role: 'user', amount: '520', status: 'returned' }))
            .toBe('[[记录:TRANSFER|to=char|amount=520|status=已退回]]');
    });

    it('回执: to = 出回执一方自己', () => {
        // 角色出的回执 (收下用户的转账): 钱当初流向 char
        expect(formatTransferRecord({ role: 'assistant', amount: '520', receipt: 'accepted' }))
            .toBe('[[记录:TRANSFER|to=char|amount=520|status=已收下]]');
        // 用户出的回执 (退回角色的转账): 钱当初流向 user
        expect(formatTransferRecord({ role: 'user', amount: '1999', receipt: 'returned' }))
            .toBe('[[记录:TRANSFER|to=user|amount=1999|status=已退回]]');
    });

    it('缺金额的老数据: 省略 amount 字段而不是留空值', () => {
        expect(formatTransferRecord({ role: 'assistant' }))
            .toBe('[[记录:TRANSFER|to=user|status=待处理]]');
    });
});

describe('往返性质 — 渲染端产出的任何记录行, 解析端恒为消费且零事件, sanitize 恒剥净', () => {
    // 覆盖 role × receipt × status 的全部组合 —— 这条性质破了, 复读历史就会产生假转账
    const allCases: TransferRecordInput[] = [];
    for (const role of ['user', 'assistant'] as const) {
        for (const amount of ['1999', undefined] as const) {
            allCases.push({ role, amount });
            for (const status of ['accepted', 'returned'] as const) allCases.push({ role, amount, status });
            for (const receipt of ['accepted', 'returned'] as const) allCases.push({ role, amount, receipt });
        }
    }

    it(`全部 ${allCases.length} 种记录行: 解析消费 + 零事件 + 正文保留`, () => {
        for (const rec of allCases) {
            const line = formatTransferRecord(rec);
            const r = extractTransferCommands(`${line}拿去花`);
            expect(r.events, line).toEqual([]);
            expect(r.consumed, line).toBe(1);
            expect(r.text, line).toBe('拿去花');
        }
    });

    it('sanitize 终线: bubble 与 notification 都剥净记录行', () => {
        for (const rec of allCases) {
            const line = formatTransferRecord(rec);
            expect(sanitizeForBubble(`${line}拿去花`), line).toBe('拿去花');
            expect(sanitizeForNotification(`${line}拿去花`), line).toBe('拿去花');
        }
    });

    it('记录命名空间整体受保护 (未来的记录:POKE 等): sanitize 剥, 解析端只认领 TRANSFER', () => {
        // 未来事件类型 —— 解析端不消费 (不归转账管), sanitize 终线兜底
        const future = '[[记录:POKE|by=user]]我在呢';
        expect(extractTransferCommands(future).consumed).toBe(0);
        expect(sanitizeForBubble(future)).toBe('我在呢');
    });

    it('繁体 / 全角冒号变体的记录行同样零事件', () => {
        for (const v of ['[[記錄:TRANSFER|to=user|amount=1999|status=待处理]]', '[[记录：TRANSFER|to=user|amount=1999]]']) {
            const r = extractTransferCommands(`${v}拿去`);
            expect(r.events, v).toEqual([]);
            expect(r.consumed, v).toBe(1);
        }
    });
});

describe('extractTransferCommands — ACTION kv 形态 (新 canonical)', () => {
    it('基础形态', () => {
        const r = extractTransferCommands('给你[[ACTION:TRANSFER|to=user|amount=520]]买杯喝的');
        expect(r.events).toEqual([{ kind: 'send', amount: '520' }]);
        expect(r.text).toBe('给你买杯喝的');
    });

    it('kv 顺序不敏感 / to 缺省 / 金额容错沿用', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER|amount=520|to=user]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER|amount=1999]]').events)
            .toEqual([{ kind: 'send', amount: '1999' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER|to=user|amount=1,999元]]').events)
            .toEqual([{ kind: 'send', amount: '1999' }]);
    });

    it('裸值容错: [[ACTION:TRANSFER|520]] 当 amount', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER|520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('to 指向角色自己 → 伪造, 整块丢弃零事件 (方向由 role 决定, 文本只做校验)', () => {
        for (const to of ['char', 'self', 'me', '角色', '自己', '我', 'CHAR']) {
            const r = extractTransferCommands(`[[ACTION:TRANSFER|to=${to}|amount=520]]收到`);
            expect(r.events, `to=${to}`).toEqual([]);
            expect(r.consumed, `to=${to}`).toBe(1);
            expect(r.text, `to=${to}`).toBe('收到');
        }
    });

    it('to 写名字 / 用户 → 放行 (私聊对手方唯一)', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER|to=用户|amount=520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER|to=阿桃|amount=520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('金额缺失 / 非法 / 裸 [[ACTION:TRANSFER]] → 剥掉零事件', () => {
        for (const s of ['[[ACTION:TRANSFER|to=user]]', '[[ACTION:TRANSFER|amount=很多]]', '[[ACTION:TRANSFER]]']) {
            const r = extractTransferCommands(`${s}好嘞`);
            expect(r.events, s).toEqual([]);
            expect(r.consumed, s).toBe(1);
            expect(r.text, s).toBe('好嘞');
        }
    });

    it('kv 形态不误吃 ACCEPT / RETURN', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER_ACCEPT]]谢谢').events).toEqual([{ kind: 'accept' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER_RETURN]]不能要').events).toEqual([{ kind: 'return' }]);
    });

    it('新老形态混用, 各自生效', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER|to=user|amount=520]]\n[[ACTION:TRANSFER:1314]]');
        expect(r.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1314' },
        ]);
    });
});

describe('extractTransferCommands — 老正文回归', () => {
    it('legacy 正文原样保留，只挖走标签', () => {
        const r = extractTransferCommands('前面[[ACTION:TRANSFER:520]]中间[系统: 你向阿桃转账 1]后面');
        expect(r.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1' },
        ]);
        expect(r.text).toBe('前面中间后面');
    });
});
