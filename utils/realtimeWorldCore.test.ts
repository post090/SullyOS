/**
 * realtimeWorldCore 回归测试。
 *
 * 这份叶子被浏览器聊天和主动消息到点生成共用，所以守两件事：
 * 渲染函数按「手上真有什么」裁剪（半截的一段比没有更容易让角色现编），
 * 以及热榜时段 key 按指定时区算（worker 跑在 UTC 上，不指定就跟用户差好几个时段）。
 */

import { describe, expect, it } from 'vitest';
import {
    checkSpecialDates,
    getHotNewsSlot,
    pickRandomNews,
    renderRealtimeWorldBlock,
    resolveHotNewsPlatforms,
    sameHotNewsPlatforms,
    DEFAULT_HOTNEWS_PLATFORMS,
    type NewsItem,
    type WeatherData,
} from './realtimeWorldCore';

const weather: WeatherData = {
    temp: 31, feelsLike: 35, humidity: 60,
    description: '小雨', icon: '10d', city: '上海',
};
const news: NewsItem[] = [{ title: '某某官宣', source: '微博', desc: '一句简介' }];

describe('renderRealtimeWorldBlock', () => {
    it('四样都空 → 返回空串（不留一个什么都没有的抬头）', () => {
        expect(renderRealtimeWorldBlock({})).toBe('');
        expect(renderRealtimeWorldBlock({ specialDates: [], news: [], weather: null })).toBe('');
    });

    it('不传 timeLine 就不出「当前真实时间」那一行', () => {
        // 主动消息到点生成时时间由 fire_pack 的 AMSG_SLOT_CURRENT_TIME 填，
        // 这一段再出一次，同一份提示词里就有了两个钟。
        const out = renderRealtimeWorldBlock({ weather, news });
        expect(out).toContain('真实世界感知系统');
        expect(out).not.toContain('当前真实时间');

        const withTime = renderRealtimeWorldBlock({ timeLine: '2026年8月2日 周日 晚上 21:30', weather });
        expect(withTime).toContain('📅 当前真实时间: 2026年8月2日 周日 晚上 21:30');
    });

    it('节日单独给，天气热搜没开也照样成段', () => {
        const out = renderRealtimeWorldBlock({ specialDates: ['七夕'] });
        expect(out).toContain('🎉 今日特殊: 七夕');
        expect(out).not.toContain('实时天气');
        expect(out).not.toContain('最近真实发生的热点');
    });

    it('天气没拉到 → 连带撤掉「天气是真实的」那条用法提示', () => {
        // 留着的话等于在教角色聊一个它手上根本没有的读数。
        const withWeather = renderRealtimeWorldBlock({ weather });
        expect(withWeather).toContain('🌤️ 【上海实时天气】');
        expect(withWeather).toContain('你的建议: ');
        expect(withWeather).toContain('天气是真实的');

        const without = renderRealtimeWorldBlock({ weather: null, news });
        expect(without).not.toContain('天气是真实的');
    });

    it('热点带来源与简介，并教一遍新闻卡片的写法', () => {
        const out = renderRealtimeWorldBlock({ news });
        expect(out).toContain('- 某某官宣（微博）：一句简介');
        expect(out).toContain('[[NEWS_CARD: 来源|标题]]');
    });
});

describe('getHotNewsSlot', () => {
    it('按指定时区分时段：同一时刻在不同时区落在不同段', () => {
        // 2026-08-02T23:30Z = 上海 8/3 07:30（清晨，slot 1）、纽约 8/2 19:30（傍晚，slot 4）
        const at = new Date('2026-08-02T23:30:00Z');
        expect(getHotNewsSlot({ tz: 'Asia/Shanghai', now: at })).toMatchObject({
            id: '2026-08-03#1', date: '2026-08-03', slot: 1, label: '清晨',
        });
        expect(getHotNewsSlot({ tz: 'America/New_York', now: at })).toMatchObject({
            id: '2026-08-02#4', slot: 4, label: '傍晚',
        });
    });
});

describe('平台清单', () => {
    it('留空用内置默认，配了就用配的', () => {
        expect(resolveHotNewsPlatforms()).toEqual(DEFAULT_HOTNEWS_PLATFORMS);
        expect(resolveHotNewsPlatforms([])).toEqual(DEFAULT_HOTNEWS_PLATFORMS);
        expect(resolveHotNewsPlatforms(['weibo'])).toEqual(['weibo']);
    });

    it('比对与顺序无关（快照能不能复用看它）', () => {
        expect(sameHotNewsPlatforms(['a', 'b'], ['b', 'a'])).toBe(true);
        expect(sameHotNewsPlatforms(['a'], ['a', 'b'])).toBe(false);
    });
});

// 节日表原本只有公历，春节/除夕当天角色毫无反应。农历日期靠预算好的公历日期表查，
// 所以这里抽查几个已知日子钉住表没抄错，也钉住「超出年限就静默没有」不会瞎猜。
describe('checkSpecialDates 农历节日', () => {
    // 12:00 Asia/Shanghai，避开跨日边界；不受跑测试的机器时区影响
    const noonInShanghai = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 4, 0, 0);
    const on = (y: number, m: number, d: number) => checkSpecialDates('Asia/Shanghai', noonInShanghai(y, m, d));

    it('抽查几个已知日子：除夕、春节、元宵、端午、七夕、中秋、重阳', () => {
        expect(on(2026, 2, 16)).toContain('除夕');
        expect(on(2026, 2, 17)).toContain('春节');
        expect(on(2026, 3, 3)).toContain('元宵节');
        expect(on(2026, 6, 19)).toContain('端午节');
        expect(on(2026, 8, 19)).toContain('七夕');
        expect(on(2026, 9, 25)).toContain('中秋节');
        expect(on(2026, 10, 18)).toContain('重阳节');
        // 换一年也得对上（春节每年浮动，抄错一年整年都歪）
        expect(on(2027, 2, 6)).toContain('春节');
        expect(on(2030, 2, 3)).toContain('春节');
        expect(on(2034, 2, 19)).toContain('春节');
    });

    it('不是节日的日子什么都不给', () => {
        expect(on(2026, 2, 18)).toEqual([]);
        expect(on(2026, 7, 7)).toEqual([]); // 七夕看农历，公历 7/7 不算
    });

    it('公历跟农历撞一天时两个都给', () => {
        expect(on(2031, 10, 1)).toEqual(['国庆节', '中秋节']);
        expect(on(2033, 2, 14)).toEqual(['情人节', '元宵节']);
    });

    it('超出表覆盖的年份 → 静默没有农历节日，不会拿别年的日子顶上', () => {
        expect(on(2036, 2, 17)).toEqual([]);
        expect(on(2025, 2, 17)).toEqual([]);
    });

    it('农历节日也跟角色所在地的日历走', () => {
        // 上海 2026-02-17 09:00（春节）== 纽约 2026-02-16 20:00（除夕）
        const at = Date.UTC(2026, 1, 17, 1, 0, 0);
        expect(checkSpecialDates('Asia/Shanghai', at)).toContain('春节');
        expect(checkSpecialDates('America/New_York', at)).toContain('除夕');
    });
});

describe('pickRandomNews', () => {
    it('抽的条数不超过池子，且都来自池子', () => {
        const pool = Array.from({ length: 3 }, (_, i) => ({ title: `t${i}` }));
        const picks = pickRandomNews(pool, 5);
        expect(picks).toHaveLength(3);
        expect(pickRandomNews(pool, 2)).toHaveLength(2);
        for (const p of picks) expect(pool).toContainEqual(p);
        // 原池子不能被打乱（调用方还拿着它做别的事）
        expect(pool.map(p => p.title)).toEqual(['t0', 't1', 't2']);
    });
});
