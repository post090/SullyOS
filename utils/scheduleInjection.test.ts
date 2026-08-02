// 日程注入文本的回归守卫。
//
// 主动消息到点生成跟前台聊天共用 buildScheduleInjection，而主动消息把「凌晨触发」变成了
// 常态：日程第一条在 07:00，凌晨一点触发时按「今天刚要开始」写，角色就会顶着清晨的心境
// 说话。凌晨 0-5 点算前一夜的尾巴，独白取「晚」档、措辞也得是夜里的说法。
import { describe, expect, it } from 'vitest';
import { buildScheduleInjection, getFlowNarrativeKey, type RenderableSchedule } from './scheduleInjection';

const schedule: RenderableSchedule = {
    slots: [
        { startTime: '07:00', activity: '晨跑' },
        { startTime: '13:00', activity: '写稿' },
        { startTime: '22:00', activity: '看剧' },
    ],
    flowNarrative: {
        morning: '清晨的空气很好，今天想跑远一点。',
        afternoon: '稿子卡在第三段。',
        evening: '夜里安静下来了，脑子还转着。',
    },
};

/** 用本地时间构造，getHours() 就是写死的那个点，不受机器时区影响。 */
const at = (hour: number, minute = 0) => new Date(2026, 7, 2, hour, minute);

describe('凌晨 0-5 点算前一夜的延续', () => {
    it('凌晨一点、今天第一条还没到 → 独白取「晚」档，不是清晨那句', () => {
        const out = buildScheduleInjection(schedule, undefined, at(1));
        expect(out).toContain('夜里安静下来了');
        expect(out).not.toContain('清晨的空气很好');
    });

    it('凌晨的措辞是夜里的说法，不带「稍后先」那种白天感', () => {
        const out = buildScheduleInjection(schedule, undefined, at(3, 40));
        expect(out).toContain('夜深了');
        expect(out).not.toContain('稍后先');
        // 最早那件事还是要说清楚，只是换个语气
        expect(out).toContain('晨跑');
        expect(out).toContain('07:00');
    });

    it('过了 5 点还没到第一条 → 回到原来的白天措辞与「早」档独白', () => {
        const out = buildScheduleInjection(schedule, undefined, at(6));
        expect(out).toContain('今天还没开始活动，稍后先晨跑（07:00）');
        expect(out).toContain('清晨的空气很好');
        expect(out).not.toContain('夜深了');
    });

    it('白天正落在某条日程上时一切照旧', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14));
        expect(out).toContain('当前时段：13:00 你正在写稿');
        expect(out).toContain('之后安排：22:00 看剧');
        expect(out).toContain('稿子卡在第三段');
    });

    it('一天三档的通用取法本身没变（小剧场、桌面小屋还按它取色）', () => {
        expect(getFlowNarrativeKey(1)).toBe('morning');
        expect(getFlowNarrativeKey(9)).toBe('morning');
        expect(getFlowNarrativeKey(13)).toBe('afternoon');
        expect(getFlowNarrativeKey(21)).toBe('evening');
    });
});
