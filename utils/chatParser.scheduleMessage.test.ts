import { describe, expect, it, vi, afterEach } from 'vitest';
import { ChatParser } from './chatParser';
import { DB } from './db';

// `[schedule_message | 时间 | fixed | 内容]` 排不上的两种情况：时间解析不出来、时间已经
// 过去。角色在正文里往往已经把话说出去了（「我到点叫你」），排不上就是一句空头承诺。
//
// 离线补收时这条路特别常走：消息是凌晨两点发的，人第二天早上九点才打开 App，重放到这里
// 时约定的八点已经过去。以前这种情况一行日志都没有，排查时只能看到「角色说了但什么都
// 没发生」。现在会留一行 warn 说清是哪条、晚了多久。

const noop = () => {};

afterEach(() => { vi.restoreAllMocks(); });

const run = (content: string, charTz?: string) =>
    ChatParser.parseAndExecuteActions(content, `c-sched-${Date.now()}`, '阿一', noop, undefined, undefined, charTz);

describe('[schedule_message] 排不上时留痕', () => {
    it('时间已经过去 → warn 一行 + 不落库', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const save = vi.spyOn(DB, 'saveScheduledMessage');

        const out = await run('睡吧\n[schedule_message | 2020-01-01 08:00:00 | fixed | 早安，起床啦]');

        expect(out).toBe('睡吧');
        expect(save).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        const line = warn.mock.calls[0].join(' ');
        expect(line).toContain('时间已经过去');
        expect(line).toContain('2020-01-01 08:00:00');
        expect(line).toContain('早安，起床啦');
    });

    it('时间解析不出来 → warn 一行 + 不落库', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const save = vi.spyOn(DB, 'saveScheduledMessage');

        const out = await run('好\n[schedule_message | 明天早上 | fixed | 起床啦]');

        expect(out).toBe('好');
        expect(save).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0].join(' ')).toContain('时间解析不了');
    });

    it('时间还没到 → 照常落库, 不 warn', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const save = vi.spyOn(DB, 'saveScheduledMessage').mockResolvedValue(undefined as any);

        const future = new Date(Date.now() + 3600_000);
        const stamp = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${
            String(future.getDate()).padStart(2, '0')} ${String(future.getHours()).padStart(2, '0')}:${
            String(future.getMinutes()).padStart(2, '0')}:00`;

        const out = await run(`好\n[schedule_message | ${stamp} | fixed | 该出门了]`);

        expect(out).toBe('好');
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0]).toMatchObject({ content: '该出门了' });
        expect(warn).not.toHaveBeenCalled();
    });
});

// 回归守卫：离线补收时一条消息会被拆成正文气泡 + 卡片/系统提示。正文走
// applyAssistantPostProcessing 的 persistMessage 盖上原始发送时刻，而 chatParser 这边
// 以前是一水儿的裸 DB.saveMessage，默认写库当刻——用户凌晨三点收到的那条消息，正文显示
// 凌晨三点、戳一戳和转账显示「早上九点打开 App 那一刻」，一条消息两个时间。
describe('parseAndExecuteActions 落库时间戳', () => {
    it('传了 messageTimestamp → 戳一戳 / 转账 / 日程系统提示全用同一个时刻', async () => {
        const charId = `c-ts-${Date.now()}`;
        const sentAt = Date.UTC(2026, 7, 2, 19, 0);   // 凌晨三点（东八区）发出

        await ChatParser.parseAndExecuteActions(
            '睡吧\n[[ACTION:POKE]]\n[[ACTION:TRANSFER:520]]\n[[ACTION:ADD_EVENT | 面试 | 2026-08-03]]',
            charId, '阿一', noop, undefined, undefined, undefined, sentAt,
        );

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const stamped = msgs.filter(m => m.type !== 'text' || m.role === 'system');
        expect(stamped.length).toBeGreaterThanOrEqual(3);
        for (const m of stamped) expect(m.timestamp).toBe(sentAt);
    }, 20000);

    it('不传 → 维持写库当刻（前台聊天那条路不变）', async () => {
        const charId = `c-ts-none-${Date.now()}`;
        const before = Date.now();
        await ChatParser.parseAndExecuteActions('[[ACTION:POKE]]', charId, '阿一', noop);

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].timestamp).toBeGreaterThanOrEqual(before);
    }, 20000);
});
