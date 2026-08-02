/**
 * 会话级快照的回归护栏。
 *
 * 这里钉的是同一件事的两面：
 *   1. 该报的报到了——三态（开 / 配了没开 / 没配）不能塌成两态，
 *      塌了之后「试过然后放弃」会跟「压根没配」混成一格，决策会做反。
 *   2. 不该报的一个字都没出去——用户填的地址、密钥、token、自己起的名字。
 *
 * 第 2 条用「塞毒药」的方式测：把每一处用户可填的字段都填上能唯一识别的字符串，
 * 然后扫整份上报，一个片段都不许出现。这样以后谁加了新字段忘了收敛，
 * 不用改测试也会被抓到——逐字段断言做不到这一点。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { APIConfig, CharacterProfile, CloudBackupConfig, OSTheme, RealtimeConfig } from '../types';
import {
    amsg2Stage,
    collectAppearance,
    collectCharSettings,
    collectFeatureFlags,
    triState,
    type FeatureSources,
} from './analyticsSnapshot';

/**
 * 毒药串：每一条都放进某个用户可填字段里。它们只要出现在上报里就是泄漏。
 * 挑得足够特别，避免跟正常枚举值（'custom'、'开'）撞车。
 */
const POISON = {
    url: 'https://secret-host.invalid/private-path',
    key: 'sk-SUPERSECRET1234567890',
    token: 'tok-USERPRIVATE-abcdef',
    myName: '我自己起的名字',
    city: '某个能定位到我的城市',
    dbId: 'db-0123456789abcdef',
    css: '.bubble{content:"我写的CSS"}',
};

/** 全部字段都塞了毒药的实时感知配置。 */
function poisonedRealtimeConfig(overrides: Partial<RealtimeConfig> = {}): RealtimeConfig {
    return {
        weatherEnabled: true,
        weatherApiKey: POISON.key,
        weatherCity: POISON.city,
        newsEnabled: true,
        newsApiKey: POISON.key,
        notionEnabled: true,
        notionApiKey: POISON.token,
        notionDatabaseId: POISON.dbId,
        feishuEnabled: true,
        feishuAppId: POISON.token,
        feishuAppSecret: POISON.key,
        feishuBaseId: POISON.dbId,
        feishuTableId: POISON.dbId,
        xhsEnabled: true,
        xhsMcpConfig: {
            enabled: true,
            serverUrl: POISON.url,
            cookie: POISON.token,
            loggedInNickname: POISON.myName,
        },
        cacheMinutes: 30,
        ...overrides,
    };
}

function poisonedSources(overrides: Partial<FeatureSources> = {}): FeatureSources {
    return {
        realtimeConfig: poisonedRealtimeConfig(),
        cloudBackupConfig: {
            enabled: true,
            provider: 'webdav',
            webdavUrl: POISON.url,
            username: POISON.myName,
            password: POISON.key,
            remotePath: POISON.url,
            githubToken: POISON.token,
            githubOwner: POISON.myName,
        } as CloudBackupConfig,
        memoryPalaceConfig: {
            embedding: { apiKey: POISON.key },
            lightLLM: { apiKey: POISON.key },
            rerank: { enabled: true, apiKey: POISON.key },
        },
        remoteVectorConfig: {
            enabled: true,
            supabaseUrl: POISON.url,
            supabaseAnonKey: POISON.key,
        },
        apiConfig: {
            baseUrl: POISON.url,
            apiKey: POISON.key,
            ttsProvider: 'minimax',
        } as APIConfig,
        apiPresetCount: 2,
        vrIndependentApi: true,
        characters: [],
        // Worker 地址和共享密钥同样是用户填的，一起塞毒药。
        amsg2Global: { workerUrl: POISON.url, initializedAt: 1_700_000_000_000 },
        ...overrides,
    };
}

/** 在这个角色的 2.0 面板里存过（或角色自己排过任务），挂着 n 条待触发任务。 */
function amsg2Char(id: string, pendingTasks = 0, enabled = true): CharacterProfile {
    return {
        id,
        name: POISON.myName,
        activeMsg2Config: {
            enabled,
            tasks: Array.from({ length: pendingTasks }, (_, i) => ({
                taskUuid: `${id}-task-${i}`,
                clientTaskId: `${id}-client-${i}`,
                status: 'scheduled',
                mode: 'auto',
                recurrenceType: 'none',
                // 排在明天，免得测试跑着跑着就过点了
                firstSendTime: new Date(Date.now() + 86_400_000).toISOString(),
            })),
        },
    } as unknown as CharacterProfile;
}

/** 从没碰过 2.0 的角色：config 整个缺失。 */
const untouchedChar = (id: string) =>
    ({ id, name: POISON.myName } as unknown as CharacterProfile);

/** 把一份上报摊平成一个字符串，用来扫毒药。 */
const flatten = (flags: Record<string, string>) => JSON.stringify(flags);

/** 断言整份上报里不含任何毒药片段。 */
function expectNoLeak(flags: Record<string, string>) {
    const dump = flatten(flags);
    for (const [label, secret] of Object.entries(POISON)) {
        expect(dump, `${label} 泄漏进了上报`).not.toContain(secret);
    }
}

beforeEach(() => {
    localStorage.clear();
});

describe('当前功能启用 · 不泄漏配置内容', () => {
    it('所有配置塞满密钥地址名字，上报里一个片段都不出现', () => {
        localStorage.setItem('aetheros.mcp.servers', JSON.stringify([
            { id: 'a', name: POISON.myName, url: POISON.url, enabled: true, tools: [{ name: 'x' }] },
        ]));
        localStorage.setItem('aetheros.luckin.mcpToken', POISON.token);
        localStorage.setItem('aetheros.mcd.mcpToken', POISON.token);
        localStorage.setItem('qqBridge:wsUrl', POISON.url);
        localStorage.setItem('study_api_config', JSON.stringify({ baseUrl: POISON.url, apiKey: POISON.key }));
        localStorage.setItem('instant_push_config_v1', JSON.stringify({
            enabled: true, workerUrl: 'https://my-private-worker.invalid', clientToken: POISON.token,
        }));

        expectNoLeak(collectFeatureFlags(poisonedSources()));
    });

    it('上报值全是短枚举，不含 URL、密钥前缀或中文自定义名', () => {
        const flags = collectFeatureFlags(poisonedSources());
        for (const [field, value] of Object.entries(flags)) {
            expect(value, `${field} 看着像原始配置值`).not.toMatch(/https?:\/\/|sk-|tok-/);
            // 枚举和档位都很短。超长说明有人把原始值透传进来了。
            expect(value.length, `${field} 的值太长，像是原始配置`).toBeLessThanOrEqual(12);
        }
    });

    it('认不出的服务商收敛成 custom，不原样带出去', () => {
        const flags = collectFeatureFlags(poisonedSources({
            cloudBackupConfig: { enabled: true, provider: POISON.myName, webdavUrl: POISON.url } as unknown as CloudBackupConfig,
            apiConfig: { baseUrl: '', apiKey: POISON.key, ttsProvider: POISON.myName } as unknown as APIConfig,
        }));
        expect(flags.云端备份服务商).toBe('custom');
        expect(flags.语音合成).toBe('custom');
    });
});

describe('当前功能启用 · 三态不能塌成两态', () => {
    it('配了但关着，跟压根没配是两个值', () => {
        expect(triState(true, true)).toBe('开');
        expect(triState(true, false)).toBe('配了没开');
        expect(triState(false, false)).toBe('没配');
        // 没配却报开着是自相矛盾的状态，也归到「没配」。
        expect(triState(false, true)).toBe('没配');
    });

    it('填了小红书桥接地址但开关关着 → 配了没开', () => {
        const flags = collectFeatureFlags(poisonedSources({
            realtimeConfig: poisonedRealtimeConfig({ xhsEnabled: false }),
        }));
        expect(flags.小红书).toBe('配了没开');
    });

    it('飞书四件套没填全 → 没配（而不是靠开关判定）', () => {
        const flags = collectFeatureFlags(poisonedSources({
            realtimeConfig: poisonedRealtimeConfig({ feishuEnabled: true, feishuBaseId: '' }),
        }));
        expect(flags.飞书).toBe('没配');
    });

    it('点单 token 填了但开关关着 → 配了没开', () => {
        localStorage.setItem('aetheros.mcd.mcpToken', POISON.token);
        localStorage.setItem('aetheros.mcd.mcpEnabled', '0');
        expect(collectFeatureFlags(poisonedSources()).麦当劳点单).toBe('配了没开');
    });
});

describe('当前功能启用 · 开关值的判定', () => {
    it("QQ 桥的 enabled 存 '0' 时算关着，不能当成「有值就是开」", () => {
        localStorage.setItem('qqBridge:wsUrl', POISON.url);
        localStorage.setItem('qqBridge:enabled', '0');
        expect(collectFeatureFlags(poisonedSources()).QQ桥接).toBe('配了没开');

        localStorage.setItem('qqBridge:enabled', '1');
        expect(collectFeatureFlags(poisonedSources()).QQ桥接).toBe('开');
    });

    it('Instant Push 填了地址但没生成 VAPID 密钥 → 配了没开', () => {
        localStorage.setItem('instant_push_config_v1', JSON.stringify({
            enabled: true, workerUrl: 'https://my-worker.invalid',
        }));
        // push_vapid_v1 没设 → isPushVapidReady() 为 false
        expect(collectFeatureFlags(poisonedSources()).InstantPush).toBe('配了没开');
    });

    it('MCP 分开数「配了几个 / 启用几个 / 连通几个」', () => {
        localStorage.setItem('aetheros.mcp.servers', JSON.stringify([
            { id: 'a', name: 'a', url: 'https://a.invalid', enabled: true, tools: [{ name: 'x' }] },
            { id: 'b', name: 'b', url: 'https://b.invalid', enabled: true, tools: [] },
            { id: 'c', name: 'c', url: 'https://c.invalid', enabled: false },
        ]));
        const flags = collectFeatureFlags(poisonedSources());
        expect(flags.自配MCP服务器).toBe('2-3');
        expect(flags.启用中的MCP服务器).toBe('2-3');
        // 只有一个真的发现到工具了——「加了但连不上」就是靠这个差值看出来的
        expect(flags.连通的MCP服务器).toBe('1');
    });

    it('主动消息 2.0 的四态不能塌：三关卡在哪一关要修的引导不一样', () => {
        expect(amsg2Stage(false, false, 0)).toBe('没配');
        expect(amsg2Stage(true, false, 0)).toBe('填了没连上');
        expect(amsg2Stage(true, true, 0)).toBe('连上没开角色');
        expect(amsg2Stage(true, true, 2)).toBe('开');
        // 地址删了但连接记录还在 / 备份里带着开着的角色配置：没地址就不可能工作
        expect(amsg2Stage(false, true, 3)).toBe('没配');
    });

    it('2.0 只填了地址没连上 → 不能报成已经在用', () => {
        const flags = collectFeatureFlags(poisonedSources({
            amsg2Global: { workerUrl: POISON.url },   // 没有 initializedAt
            characters: [amsg2Char('c1', 1)],
        }));
        expect(flags['主动消息2.0']).toBe('填了没连上');
    });

    it('从没碰过 2.0 的角色不算「开了」——默认可用不等于用起来了', () => {
        // isAmsg2EnabledForChar 对 config 缺失的角色返回 true（默认可用），
        // 拿它数会把角色总数报成 2.0 用户数。
        const flags = collectFeatureFlags(poisonedSources({
            characters: [untouchedChar('a'), untouchedChar('b'), untouchedChar('c')],
        }));
        expect(flags['开了2.0的角色数']).toBe('0');
        expect(flags['主动消息2.0']).toBe('连上没开角色');
    });

    it('在面板里关掉的角色不计入，开着的才数', () => {
        const flags = collectFeatureFlags(poisonedSources({
            characters: [amsg2Char('a'), amsg2Char('b', 0, false), untouchedChar('c')],
        }));
        expect(flags['开了2.0的角色数']).toBe('1');
    });

    it('真在用 2.0 的人同时开着 Instant Push → 记一笔（那三样静默失效）', () => {
        localStorage.setItem('instant_push_config_v1', JSON.stringify({
            enabled: true, workerUrl: 'https://my-worker.invalid',
        }));
        // isPushVapidReady 只看公钥长度（>60），内容无所谓
        localStorage.setItem('push_vapid_v1', JSON.stringify({
            vapidPublicKey: 'B'.repeat(87), vapidPrivateKey: 'k'.repeat(43),
        }));
        expect(collectFeatureFlags(poisonedSources({
            characters: [amsg2Char('a', 1)],
        }))['2.0与InstantPush同开']).toBe('是');

        // 没人真在用 2.0 的话，光开着 instant 不算踩坑
        expect(collectFeatureFlags(poisonedSources({
            characters: [untouchedChar('a')],
        }))['2.0与InstantPush同开']).toBe('否');
    });

    it('不上报已经全局下线的主动消息 Push 加速', () => {
        // 那一层 FORCE_DISABLED 恒为关，报出来会被误读成「没人用」。
        localStorage.setItem('proactive_push_enabled_v1', 'true');
        expect(collectFeatureFlags(poisonedSources())).not.toHaveProperty('主动消息Push加速');
    });
});

describe('当前外观 · 不泄漏用户自己捏的东西', () => {
    it('自己起的主题名、字体、白框 CSS、提示音直链都不出去', () => {
        const theme = {
            skin: 'default',
            customFont: POISON.url,
            chatChromeCustomCss: POISON.css,
            chatSound: { src: POISON.url },
            chatBubbleFontSize: 18,
        } as unknown as OSTheme;
        const char = { id: 'c1', name: POISON.myName, bubbleStyle: POISON.myName } as unknown as CharacterProfile;

        const flags = collectAppearance(theme, char);
        expectNoLeak(flags);
        expect(flags.气泡主题).toBe('custom');
        expect(flags.自定义字体).toBe('用了');
        expect(flags.自定义白框CSS).toBe('用了');
        expect(flags.提示音).toBe('custom');
        // 开放数值只报调没调过，不报 18
        expect(flags.气泡字号).toBe('调过');
    });

    it('没设过的项报默认值，不缺席也不报 undefined', () => {
        const flags = collectAppearance({} as OSTheme, undefined);
        expect(flags.桌面皮肤).toBe('default');
        expect(flags.自定义字体).toBe('没用');
        expect(flags.提示音).toBe('没设');
        expect(Object.values(flags)).not.toContain(undefined);
    });
});

describe('当前角色设置 · 不泄漏角色内容', () => {
    const poisonedChar = (over: Partial<CharacterProfile> = {}) => ({
        id: 'c1',
        name: POISON.myName,
        persona: POISON.myName,
        chatSound: { src: POISON.url },
        ...over,
    } as unknown as CharacterProfile);

    it('角色名、设定、提示音直链都不出去', () => {
        const flags = collectCharSettings([poisonedChar()], 'c1');
        expectNoLeak(flags);
        expect(flags.角色提示音).toBe('custom');
    });

    it('默认关的开关问「有没有人开过」，只要一个角色开了就算', () => {
        const flags = collectCharSettings(
            [poisonedChar({ memoryPalaceEnabled: false }), poisonedChar({ memoryPalaceEnabled: true })],
            'c1',
        );
        expect(flags.记忆宫殿).toBe('有人开');
    });

    it('默认开的开关问「有没有人特意关掉」——否则答案永远是「有」', () => {
        const allDefault = collectCharSettings([poisonedChar(), poisonedChar()], 'c1');
        expect(allDefault.时间感知).toBe('都开着');

        const oneOff = collectCharSettings(
            [poisonedChar(), poisonedChar({ timeAwarenessEnabled: false })],
            'c1',
        );
        expect(oneOff.时间感知).toBe('有人关掉');
    });

    it('活跃角色找不到时回落到第一个，不崩', () => {
        const flags = collectCharSettings([poisonedChar()], 'not-exist');
        expect(flags.思考链风格).toBe('echo');
    });

    it('定时消息任务数是全部角色合计，不是当前活跃角色那一个', () => {
        // 只看活跃角色的话，这里会报 0——而这个人其实挂着 4 条任务。
        // 一个人挂十几个角色时，活跃角色恰好没排任务的概率很大。
        const flags = collectCharSettings(
            [amsg2Char('active', 0), amsg2Char('b', 2), amsg2Char('c', 2)],
            'active',
        );
        expect(flags.定时消息任务数).toBe('4+');
    });
});
