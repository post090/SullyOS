import { describe, it, expect } from 'vitest';
import { renderFireSceneBlock, resolveFireSceneSong, type AmsgFireScene } from './amsgFireScene';
import type { RenderableSchedule } from './scheduleInjection';

// 回归守卫：角色的「当前时段」和由它推出来的「此刻在听的歌」以前是跟着角色设定一起
// 烤进 fire_pack 模板的——说的是打包那一刻的事。凌晨三点触发时，角色会照着中午打的包
// 说「我在健身房呢，今天多跑了两公里」。
//
// 现在这两块随包只带原始素材（整天的作息表 + 歌单抽样池），worker 到点按角色时区现挑。
// 下面每条都对着一种「烤死」会露出来的样子。

const schedule: RenderableSchedule = {
    slots: [
        { startTime: '08:00', activity: '起床做早饭' },
        { startTime: '14:00', activity: '跑步', location: '健身房' },
        { startTime: '22:00', activity: '戴着耳机瘫在沙发上', innerThought: '今天有点累' },
    ],
};

const songs = [
    { id: 1, name: '夜航星', artists: '某某' },
    { id: 2, name: '海底', artists: '另一位' },
];

const scene: AmsgFireScene = { charId: 'char-1', dateKey: '2026-08-02', schedule, songPool: songs };

/** 2026-08-02 的某个上海时刻（上海 = UTC+8，无夏令时）。 */
const shanghaiAt = (hour: number, minute = 0) =>
    Date.UTC(2026, 7, 2, hour - 8, minute);

describe('renderFireSceneBlock — 到点现挑时段', () => {
    it('同一份作息表，不同触发时刻挑出不同时段', () => {
        const noon = renderFireSceneBlock(scene, shanghaiAt(14, 30), { tzId: 'Asia/Shanghai' });
        expect(noon).toContain('当前时段：14:00 你正在跑步（健身房）');
        expect(noon).toContain('之后安排：22:00 戴着耳机瘫在沙发上');

        const lateNight = renderFireSceneBlock(scene, shanghaiAt(23, 10), { tzId: 'Asia/Shanghai' });
        expect(lateNight).toContain('当前时段：22:00 你正在戴着耳机瘫在沙发上');
        expect(lateNight).not.toContain('跑步');
        expect(lateNight).not.toContain('健身房');
    });

    it('按角色时区读表，不吃 worker 自己的 UTC', () => {
        // 同一个绝对时刻：上海是下午 14:30，纽约是凌晨 02:30（当天第一条 08:00 还没到）。
        // 时区吃错的话，纽约角色会在凌晨两点半说自己正在健身房跑步。
        const at = shanghaiAt(14, 30);
        expect(renderFireSceneBlock(scene, at, { tzId: 'Asia/Shanghai' })).toContain('14:00 你正在跑步');
        const ny = renderFireSceneBlock(scene, at, { tzId: 'America/New_York' });
        // 这条钉的是「挑中哪一条」，不是那句引子怎么写（凌晨那档的措辞由 scheduleInjection 定）。
        expect(ny).toContain('起床做早饭（08:00）');
        expect(ny).not.toContain('跑步');
    });

    it('今天第一条还没到点 → 说「稍后先」，不硬安一个当前时段', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(6), { tzId: 'Asia/Shanghai' });
        expect(out).toContain('今天还没开始活动，稍后先起床做早饭（08:00）');
        expect(out).not.toContain('当前时段');
    });

    it('时段暗示在听歌 → 补一句此刻在听什么；不暗示的时段不补', () => {
        const listening = renderFireSceneBlock(scene, shanghaiAt(22, 30), { tzId: 'Asia/Shanghai' });
        expect(listening).toMatch(/你此刻在听：《(夜航星|海底)》/);

        const running = renderFireSceneBlock(scene, shanghaiAt(14, 30), { tzId: 'Asia/Shanghai' });
        expect(running).not.toContain('你此刻在听');
    });

    it('同一时段内反复触发抽到同一首歌（别每条主动消息换一首）', () => {
        const a = renderFireSceneBlock(scene, shanghaiAt(22, 10), { tzId: 'Asia/Shanghai' });
        const b = renderFireSceneBlock(scene, shanghaiAt(23, 50), { tzId: 'Asia/Shanghai' });
        const songOf = (s: string) => s.match(/你此刻在听：《(.+?)》/)?.[1];
        expect(songOf(a)).toBeTruthy();
        expect(songOf(b)).toBe(songOf(a));
    });

    it('歌单是空的 → 只有日程，不硬编一首歌', () => {
        const out = renderFireSceneBlock({ ...scene, songPool: [] }, shanghaiAt(22, 30), { tzId: 'Asia/Shanghai' });
        expect(out).toContain('22:00 你正在戴着耳机');
        expect(out).not.toContain('你此刻在听');
    });

    it('没日程 / 空表 → 空串（槽位被抹平，模板跟没这回事一样）', () => {
        expect(renderFireSceneBlock(null, shanghaiAt(14), { tzId: 'Asia/Shanghai' })).toBe('');
        expect(renderFireSceneBlock(
            { ...scene, schedule: { ...schedule, slots: [] } },
            shanghaiAt(14),
            { tzId: 'Asia/Shanghai' },
        )).toBe('');
    });

    // 回归守卫：日程表里只有「几点做什么」，没有日期。周五晚上打的包周日上午触发时，
    // 光按墙钟时分照样挑得出「09:00 晨会」——角色于是在周日说自己正在开周五的会。
    // 到点先比日期，跨天了整段不用（宁缺勿错，跟「实时世界拉不到就整段消失」同一条线）。
    it('同一天触发 → 照常渲染', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(14, 30), { tzId: 'Asia/Shanghai' });
        expect(out).toContain('当前时段：14:00 你正在跑步（健身房）');
    });

    it('跨天触发 → 整段消失（日程和「此刻在听」一起走）', () => {
        // 上海 8/4 22:30：按时分挑的话正好落在「戴着耳机瘫在沙发上」那一档，还会带出一首歌。
        const nextDays = Date.UTC(2026, 7, 4, 22 - 8, 30);
        expect(renderFireSceneBlock(scene, nextDays, { tzId: 'Asia/Shanghai' })).toBe('');
    });

    it('跨天判定按角色时区算，不是 UTC 日历日', () => {
        // 上海 8/3 00:30（= 8/2 16:30Z）：UTC 还是 8/2，角色那边已经翻篇了。
        const justAfterMidnight = Date.UTC(2026, 7, 2, 16, 30);
        expect(renderFireSceneBlock(scene, justAfterMidnight, { tzId: 'Asia/Shanghai' })).toBe('');
        // 同一时刻的纽约角色还停在 8/2 12:30，表照用。
        expect(renderFireSceneBlock(
            { ...scene, dateKey: '2026-08-02' },
            justAfterMidnight,
            { tzId: 'America/New_York' },
        )).toContain('当前时段：08:00');
    });

    // 回归守卫：`[[MUSIC_ACTION:add|歌单标题]]` 标签里只有歌单名，没有歌名。worker 要把
    // 这次挑中的那首冻进 directive，客户端重放时才知道正文说的是哪首歌 —— 冻的那首必须
    // 跟 prompt 里写的严格一致，两处各挑一次就会出现「正文说 A、卡片是 B」。
    it('挑出来的那首跟 prompt 里写的是同一首', () => {
        const at = shanghaiAt(22, 30);
        const song = resolveFireSceneSong(scene, at, { tzId: 'Asia/Shanghai' });
        expect(song).not.toBeNull();
        expect(renderFireSceneBlock(scene, at, { tzId: 'Asia/Shanghai' }))
            .toContain(`你此刻在听：《${song!.name}》— ${song!.artists}`);
    });

    it('正文里没有「你此刻在听」的场合一律返回 null（别冻一首没人提过的歌）', () => {
        const tz = { tzId: 'Asia/Shanghai' };
        // 不暗示听歌的时段
        expect(resolveFireSceneSong(scene, shanghaiAt(14, 30), tz)).toBeNull();
        // 歌单是空的
        expect(resolveFireSceneSong({ ...scene, songPool: [] }, shanghaiAt(22, 30), tz)).toBeNull();
        // 没日程 / 空表
        expect(resolveFireSceneSong(null, shanghaiAt(22, 30), tz)).toBeNull();
        expect(resolveFireSceneSong(
            { ...scene, schedule: { ...schedule, slots: [] } }, shanghaiAt(22, 30), tz,
        )).toBeNull();
        // 跨天：整段作废，「此刻在听」跟着走
        expect(resolveFireSceneSong(scene, Date.UTC(2026, 7, 4, 22 - 8, 30), tz)).toBeNull();
        for (const out of [
            renderFireSceneBlock(scene, shanghaiAt(14, 30), tz),
            renderFireSceneBlock({ ...scene, songPool: [] }, shanghaiAt(22, 30), tz),
        ]) {
            expect(out).not.toContain('你此刻在听');
        }
    });

    it('同一时段内反复触发冻的是同一首（跟 prompt 一样不跳歌）', () => {
        const tz = { tzId: 'Asia/Shanghai' };
        expect(resolveFireSceneSong(scene, shanghaiAt(23, 50), tz))
            .toEqual(resolveFireSceneSong(scene, shanghaiAt(22, 10), tz));
    });

    it('意识流独白按触发时刻的时段取（不是打包时刻那一档）', () => {
        const withFlow: AmsgFireScene = {
            ...scene,
            schedule: {
                ...schedule,
                flowNarrative: { morning: '早上的念头', afternoon: '下午的念头', evening: '晚上的念头' },
            },
        };
        expect(renderFireSceneBlock(withFlow, shanghaiAt(9), { tzId: 'Asia/Shanghai' })).toContain('早上的念头');
        expect(renderFireSceneBlock(withFlow, shanghaiAt(21), { tzId: 'Asia/Shanghai' })).toContain('晚上的念头');
    });
});
