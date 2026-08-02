import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// chatPrompts 是具名 import 进去的，只能在模块边界上替换。
vi.mock('./dailySchedule', () => ({
    getDailyScheduleForChar: vi.fn(async () => schedule),
}));

import { ChatPrompts } from './chatPrompts';
import { ContextBuilder } from './context';
import { DB } from './db';
import { RealtimeContextManager } from './realtimeContext';

// 回归守卫：主动消息的模板是最后一次聊天时打好、到点才渲染的。以前整份 system prompt
// 原样烤进去，里头「打包这一刻」的状态到触发时全过期了——用户在凌晨收到的那条消息，
// 角色照着中午那份世界说话：报着中午的钟、说自己在健身房、劝人带伞、还在祝昨天的节日。
//
// 每条对着一种当时会露出来的样子；默认（前台聊天）那一路必须原样保留。

const userProfile = { name: '条条' } as any;

const baseChar = (over: Record<string, unknown> = {}) => ({
    id: 'char-fp',
    name: '阿一',
    scheduleFeatureEnabled: true,
    ...over,
}) as any;

const realtimeConfig = { weatherEnabled: true, newsEnabled: true } as any;

// vi.mock 的工厂在模块最顶上执行，schedule 必须是 var 提升上去的（const 会踩 TDZ）。
// eslint-disable-next-line no-var
var schedule = {
    id: 'char-fp_2026-08-02',
    charId: 'char-fp',
    date: '2026-08-02',
    generatedAt: 0,
    slots: [
        { startTime: '00:00', activity: '跑步', location: '健身房' },
        { startTime: '23:30', activity: '睡觉' },
    ],
} as any;

const build = async (char: any, forFirePack: boolean) => {
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, [], [], [], [],
        realtimeConfig, undefined, undefined, undefined, undefined, undefined,
        forFirePack ? { forFirePack: true } : undefined,
    );
    return `${parts.stable}\n${parts.volatileState}\n${parts.recencyTail}`;
};

beforeEach(() => {
    // 天气/热搜真去联网太慢也不稳定，桩成固定内容；测的是「这一段进没进 prompt」。
    vi.spyOn(RealtimeContextManager, 'fetchWeather').mockResolvedValue({
        city: '上海', description: '晴', temp: 31, feelsLike: 35, humidity: 60,
    } as any);
    vi.spyOn(RealtimeContextManager, 'fetchNews').mockResolvedValue([
        { title: '某某官宣', source: '微博' },
    ] as any);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('forFirePack —— 打包时刻的状态一律不烤进模板', () => {
    // 这一块不烤进来不等于主动消息看不到天气热搜：模板里留着 AMSG_SLOT_REALTIME_WORLD，
    // worker 到点自己去拉一次再填（见 worker/amsg 的 realtimeWorld）。这里守的是
    // 「别把打包那一刻的读数腌进去」。
    it('【真实世界感知系统】整块不进：当前真实时间 / 天气 / 热搜 / 真实世界钢印', async () => {
        const normal = await build(baseChar(), false);
        expect(normal).toContain('真实世界感知系统');
        expect(normal).toContain('当前真实时间');
        expect(normal).toContain('实时天气');
        expect(normal).toContain('最近真实发生的热点');

        const packed = await build(baseChar(), true);
        expect(packed).not.toContain('真实世界感知系统');
        expect(packed).not.toContain('当前真实时间');
        expect(packed).not.toContain('实时天气');
        expect(packed).not.toContain('最近真实发生的热点');
        // 抬头那句「⚠️ 以下信息来自真实世界」措辞比任何免责声明都硬，一并带走
        expect(packed).not.toContain('以下信息来自真实世界');
    });

    it('「现在是 X」时间块不进（当前时间由 worker 到点填槽）', async () => {
        expect(await build(baseChar(), false)).toContain('现在是');
        expect(await build(baseChar(), true)).not.toContain('现在是');
    });

    it('日程当前时段不进（改由 AMSG_SLOT_SCENE 到点现挑）', async () => {
        expect(await build(baseChar(), false)).toContain('当前时段：');
        expect(await build(baseChar(), true)).not.toContain('当前时段：');
    });

    it('「你刚刚和对方结束了一通电话 / 见面」不进', async () => {
        const msgs = [
            { id: 1, charId: 'char-fp', role: 'assistant', type: 'text', content: '喂', timestamp: 1, metadata: { source: 'call' } },
            { id: 2, charId: 'char-fp', role: 'user', type: 'text', content: '嗯', timestamp: 2 },
        ] as any[];
        const withMsgs = async (forFirePack: boolean) => {
            const parts = await ChatPrompts.buildSystemPromptParts(
                baseChar(), userProfile, [], [], [], msgs,
                realtimeConfig, undefined, undefined, undefined, undefined, undefined,
                forFirePack ? { forFirePack: true } : undefined,
            );
            return parts.volatileState;
        };
        expect(await withMsgs(false)).toContain('刚刚和对方结束了一通电话');
        expect(await withMsgs(true)).not.toContain('刚刚和对方结束了一通电话');
    });

    it('生活记录：摘要数据留着，代记工具说明不进', async () => {
        const char = baseChar({ id: 'char-fp-life', lifeRecordEnabled: true });
        const normal = await build(char, false);
        expect(normal).toContain('的生活记录（潜意识背景）');
        expect(normal).toContain('代记工具');

        const packed = await build(char, true);
        expect(packed).toContain('的生活记录（潜意识背景）');
        expect(packed).not.toContain('代记工具');
        expect(packed).not.toContain('[[LIFE:');
    });

    it('生活记录的否决反馈不进、也不被消费掉（它是读完就清的一次性内容）', async () => {
        const charId = `char-fp-fb-${Date.now()}`;
        const char = baseChar({ id: charId, name: '阿一', lifeRecordEnabled: true });
        await DB.saveLifeRecord({
            id: `life-fb-${Date.now()}`,
            module: 'med', kind: 'take', date: '2026-08-02', timestamp: Date.now(),
            payload: { name: '布洛芬' },
            recordedBy: charId, recordedByName: '阿一',
            reviewStatus: 'rejected', pendingFeedback: true,
        } as any);

        // 打包这一轮不该看到，也不该把 pendingFeedback 清掉
        expect(await build(char, true)).not.toContain('记录反馈');

        // 用户下次真正聊天时还在
        expect(await build(char, false)).toContain('记录反馈');
    }, 20000);
});

// 回归守卫：「用户此刻也在《彼方》里」说的是用户当下挂在哪个房间。烤进模板之后，
// 用户下线好几个小时了，角色还在说「看你小人挂在听歌房」。worker 够不着用户此刻的
// 彼方状态，所以这一段没有到点补的槽位，属于「不补」的那一类。
describe('彼方：用户此刻挂在哪个房间不进打包', () => {
    const vrChar = () => baseChar({ id: 'char-fp-vr', vrState: { enabled: true } });
    const vrUser = {
        name: '条条',
        vrState: { enabled: true, currentRoom: 'music', activity: '发呆中' },
    } as any;

    const buildVr = async (forFirePack: boolean) => {
        const parts = await ChatPrompts.buildSystemPromptParts(
            vrChar(), vrUser, [], [], [], [],
            realtimeConfig, undefined, undefined, undefined, undefined, undefined,
            forFirePack ? { forFirePack: true } : undefined,
        );
        return `${parts.stable}\n${parts.volatileState}`;
    };

    it('前台聊天照常告诉角色用户挂在哪个房间', async () => {
        const out = await buildVr(false);
        expect(out).toContain('此刻也在《彼方》');
        expect(out).toContain('【听歌房】');
        expect(out).toContain('发呆中');
    });

    it('打包时整段不进；《彼方》是什么的常驻框定照留（那个不随时间变）', async () => {
        const out = await buildVr(true);
        expect(out).not.toContain('此刻也在《彼方》');
        expect(out).not.toContain('【听歌房】');
        expect(out).not.toContain('发呆中');
        expect(out).toContain('关于《彼方》');
    });
});

describe('天气开着但角色关了时间感知', () => {
    it('不该从天气块里漏出「当前真实时间」', async () => {
        const char = baseChar({ id: 'char-fp-notime', timeAwarenessEnabled: false });
        const out = await build(char, false);
        expect(out).toContain('实时天气');
        expect(out).not.toContain('当前真实时间');
    });
});

describe('ContextBuilder.buildScheduleInjection 仍是同一份实现', () => {
    it('转发到 scheduleInjection 那个纯叶子（worker 到点渲染共用它）', () => {
        const at = new Date(2026, 7, 2, 12, 0);
        expect(ContextBuilder.buildScheduleInjection(schedule, undefined, at))
            .toContain('当前时段：00:00 你正在跑步（健身房）');
    });
});

describe('群聊背景的时间标注', () => {
    const groups = [{ id: 'g-fp', name: '深夜茶话会', members: ['char-fp-grp'] }] as any;

    const groupBlock = async (forFirePack: boolean) => {
        const parts = await ChatPrompts.buildSystemPromptParts(
            baseChar({ id: 'char-fp-grp', customTimezoneEnabled: true, customTimezone: 'Asia/Shanghai' }),
            userProfile, groups, [], [], [],
            realtimeConfig, undefined, undefined, undefined, undefined, undefined,
            forFirePack ? { forFirePack: true } : undefined,
        );
        return parts.volatileState;
    };

    it('前台聊天带「约 X 分钟前」；打包时只留绝对时间戳', async () => {
        await DB.saveMessage({
            charId: 'user', groupId: 'g-fp', role: 'user', type: 'text',
            content: '今晚吃火锅吗', timestamp: Date.now() - 3 * 60_000,
        } as any);

        expect(await groupBlock(false)).toMatch(/· 约?\s*\d+\s*分钟前|· 刚刚/);
        // 打包时的「刚才」到点渲染时早就不是那个刚才了：角色会把昨天的群聊说成
        // 「刚才群里说晚上一起吃饭」。
        expect(await groupBlock(true)).not.toContain('分钟前');
    }, 20000);
});

// 回归守卫：小红书服务器多半跑在用户自己电脑上（localhost:xxxx）。CF worker 连不上，
// 但提示词照样教角色「你有小红书号的哦，可以帮你搜东西」——角色到点真去用，
// 撞一鼻子灰之后还会把没发生的搜索说成发生过。够不着的地址干脆不进打包的那份提示词。
describe('小红书：worker 够不着的服务器不写进 fire_pack', () => {
    const withServer = async (serverUrl: string, forFirePack: boolean) => {
        const parts = await ChatPrompts.buildSystemPromptParts(
            baseChar({ id: 'char-fp-xhs', xhsEnabled: true }), userProfile, [], [], [], [],
            { ...realtimeConfig, xhsMcpConfig: { enabled: true, serverUrl } } as any,
            undefined, undefined, undefined, undefined, undefined,
            forFirePack ? { forFirePack: true } : undefined,
        );
        return parts.stable;
    };

    it('本机地址：前台照常教，打包时整段不进', async () => {
        expect(await withServer('http://localhost:18060', false)).toContain('小红书');
        expect(await withServer('http://localhost:18060', true)).not.toContain('小红书');
        expect(await withServer('http://192.168.1.7:18060', true)).not.toContain('小红书');
    });

    it('公网地址：打包时照常带上', async () => {
        expect(await withServer('https://xhs.example.com', true)).toContain('小红书');
    });
});
