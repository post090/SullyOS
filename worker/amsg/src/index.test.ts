// worker/amsg/src/index.test.ts
// onBeforeFire 的四道门 —— 这个功能最关键的决策路径，一个判断写错位就是「该拦的没拦」
// 或者「全都不发」。门的顺序本身也是行为的一部分（注释里专门写过），一起钉住。
//
// 顺序：charId 校验 → 活跃会话租约(skip) → fire_pack 存在(否则抛) → 防穿帮闸(skip)
//      → 任务指令存在(否则抛) → 挂 scratch + 填槽返回
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  amsgFireSettled, amsgHooks, amsgStaleSkip, attachScheduledTasks, buildWorkerConfig,
  offloadOversizedPush,
  resolveVapidEmail, runFireScheduleTool, runMcpFireTool,
} from './index';
import { MAX_TOOL_ITERATIONS } from './agentic';
import { MAX_PUSH_PAYLOAD_BYTES } from '@rei-standard/amsg-server/cloudflare';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_LAST_SKIP_KEY,
  AMSG_SELF_LOG_KEY,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_INSTRUCTION,
  amsgStateNamespace,
  amsgXhsSessionKey,
  FIRE_PACK_VERSION,
  packStateValue,
  parseSelfLog,
} from '../../../utils/amsgFirePack';
import { AMSG_CHAT_PRESENCE_KEY } from '../../../utils/amsgChatPresence';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from '../../../utils/amsgToolPack';
import { buildMcpNameMap, MCP_FIRE_NAME_BUDGET, type McpFireServer } from '../../../utils/mcpFireCore';
import { MAX_FIRE_SCHEDULES } from '../../../utils/amsgFireSchedule';
import { MAX_ACTIVE_TASKS_PER_CHAR } from '../../../utils/amsg2Tasks';

const CHAR_ID = 'preset-nyah';
const TASK_UUID = '3637dae1-1461-4444-a747-34e406f67acc';
const NOW = new Date('2026-07-25T12:00:00.000Z');

const PACK_BUILT_AT = Date.parse('2026-07-25T09:00:00.000Z');

const firePackValue = (
  lastUserMessageAt: number | null = null,
  extra: Record<string, unknown> = {},
) => JSON.stringify({
  // 版本跟着 amsgFirePack 走：升版是前端 + worker 一起动的事，测试跟着走就行。
  v: FIRE_PACK_VERSION,
  template: `现在是 ${AMSG_SLOT_CURRENT_TIME}。\n${AMSG_SLOT_TASK_INSTRUCTION}`,
  lastUserMessageAt,
  tzId: 'Asia/Shanghai',
  userTzId: 'Asia/Shanghai',
  targetName: '小明',
  builtAt: PACK_BUILT_AT,
  pendingTasks: [],
  scene: null,
  ...extra,
});

const presenceValue = (
  activeAt: number,
  opts: { lastUserMessageAt?: number | null; charId?: string } = {},
) => JSON.stringify({
  v: 1,
  charId: opts.charId ?? CHAR_ID,
  activeAt,
  lastUserMessageAt: opts.lastUserMessageAt === undefined ? activeAt : opts.lastUserMessageAt,
});

// tool_pack / tool_config 与 fire_pack 同批原子上传，所以默认造齐——缺任何一份都是
// 云端状态异常，走抛错路径（见下面「缺 tool_pack → 抛错」那条）。
const toolPackValue = JSON.stringify({
  v: 1, charName: 'Nyah', xhsEnabled: false, activeMemoryMonths: [], memories: [],
  timeAwarenessEnabled: true,
});
const toolConfigValue = JSON.stringify({
  v: 1, proxyWorkerUrl: '', weatherEnabled: false, newsEnabled: false,
  notionEnabled: false, feishuEnabled: false,
});

/** 带一台通用 MCP 服务器的 tool_config（extra 用来改开关 / 服务器可见范围）。 */
const mcpToolConfigValue = (extra: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false,
  mcpServers: [{
    id: 'srv-memory',
    name: '记忆库',
    url: 'https://mcp.example.com/mcp',
    tools: [{
      name: 'search_memory',
      description: '按关键词查记忆',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }],
  }],
  ...extra,
});

/** 造一个 FireCtx；rows 是 readState 按 namespace 返回的内容。 */
const makeCtx = (opts: {
  metadata?: Record<string, unknown>;
  charRows?: Array<{ key: string; value: string }>;
  globalRows?: Array<{ key: string; value: string }>;
  recurrenceType?: string;
  nextSendAt?: string | null;
  /** 写不进 client_state 时的样子：跳过原因写失败不该连累这次 skip。 */
  writeStateFails?: boolean;
}) => {
  const charRows = opts.charRows ?? [
    { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
    { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
  ];
  const globalRows = opts.globalRows ?? [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }];
  const readState = vi.fn(async (namespace: string) =>
    namespace.startsWith('amsg:char:') ? charRows : globalRows);
  const writeState = vi.fn(async (
    _namespace: string,
    _entries: Array<{ key: string; value: string | null }>,
  ) => {
    if (opts.writeStateFails) throw new Error('write failed');
    return { upserted: 1, skipped: 0, deleted: 0 };
  });
  const scratch: Record<string, unknown> = {};
  return {
    ctx: {
      task: {
        id: 42,
        uuid: TASK_UUID,
        contactName: 'Nyah',
        recurrenceType: opts.recurrenceType ?? 'none',
        nextSendAt: opts.nextSendAt ?? '2026-07-25T12:00:00.000Z',
        metadata: {
          charId: CHAR_ID,
          amsgExpirePolicy: 'expire',
          amsgTaskInstruction: '问问对方吃了没',
          ...opts.metadata,
        },
      },
      userId: 'u1',
      readState,
      writeState,
      now: NOW,
      scratch,
    } as any,
    scratch,
    readState,
    writeState,
  };
};

/** onBeforeFire 生成路径的返回值：{ messages, tools? }（skip 那一支各测各的）。 */
interface FiredResult {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string; parameters: unknown } }>;
}

/** 取生成路径的返回值；顺手确认没退回 skip / null，省得每条用例各自强转。 */
const fired = (result: unknown): FiredResult => {
  expect(result, '生成路径应该返回 { messages, tools? }').toHaveProperty('messages');
  return result as FiredResult;
};

describe('onBeforeFire 四道门', () => {
  it('正常路径：填好槽返回 prompt，并把工具状态挂上 scratch', async () => {
    const { ctx, scratch } = makeCtx({});
    const result = await amsgHooks.onBeforeFire(ctx);

    const messages = fired(result).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    // 槽位必须被填掉，不能把 {{AMSG_*}} 原样发给 LLM
    expect(messages[0].content).not.toContain(AMSG_SLOT_CURRENT_TIME);
    expect(messages[0].content).not.toContain(AMSG_SLOT_TASK_INSTRUCTION);
    expect(messages[0].content).toContain('问问对方吃了没');
    // scratch.fire 必须在返回 messages 之前挂好——onLLMOutput / executeToolCalls 全靠它
    expect(scratch.fire).toBeTruthy();
    expect((scratch.fire as any).occurrenceMs).toBe(Date.parse('2026-07-25T12:00:00.000Z'));
  });

  it('活跃会话租约新鲜 → skip，而且排在 fire_pack 检查之前（缺 fire_pack 也照样 skip）', async () => {
    const { ctx } = makeCtx({
      // 故意不给 fire_pack：如果 presence 门被挪到后面，这里会变成抛错而不是 skip
      charRows: [{ key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) }],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('force 策略不吃活跃租约这道门（闹钟型照发）', async () => {
    const { ctx } = makeCtx({
      metadata: { amsgExpirePolicy: 'force' },
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('租约过期（超 TTL）不拦', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 120_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('防穿帮闸：一次性任务在锚点之后有新用户消息 → skip', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      // fire_pack 里的 lastUserMessageAt 晚于锚点 = 排程后用户又说话了
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor + 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  // presence 行是每轮聊天一开场就写的小值，fire_pack 要等去抖 10s + 整包上传才落地。
  // 只看 fire_pack 的话，用户刚说完话、包还没传上来的那十几秒里任务照发，正撞在对话上。
  it('防穿帮闸：presence 记的用户开口时刻比 fire_pack 新 → 用新的那份判，作废', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        // 租约本身已经过期（不吃第一道门），但它记着的「最后一条用户消息」仍然算数
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 120_000, { lastUserMessageAt: anchor + 60_000 }) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('防穿帮闸：presence 是别的角色的 → 不拿来当锚点材料', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        {
          key: AMSG_CHAT_PRESENCE_KEY,
          value: presenceValue(NOW.getTime() - 120_000, { lastUserMessageAt: anchor + 60_000, charId: 'other-char' }),
        },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('防穿帮闸：锚点之后没有新用户消息 → 照发', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  // ─── 不降级：状态不完整一律抛错，不再退回排程时冻结的 prompt ───

  it('云端没有 fire_pack → 抛错（不降级）', async () => {
    const { ctx } = makeCtx({ charRows: [] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  it('fire_pack 解析失败 → 抛错（不降级）', async () => {
    const { ctx } = makeCtx({ charRows: [{ key: AMSG_FIRE_PACK_KEY, value: '{"v":1,"template":"老格式"}' }] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  // ─── 闸跳过时留一句原因 ───
  //
  // 闸判定该让路就直接跳过，一条 push 都不发，而远端那行任务照样被消费掉——客户端事后
  // 看到的跟「发出去了但没收到」一模一样，用户只会觉得功能坏了。这几条钉住那句解释。

  it('用户正在聊天被拦下 → 写下原因，说明是让路了', async () => {
    const { ctx, writeState } = makeCtx({
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '应该写过 last_skip').toBeTruthy();
    const skip = JSON.parse(String(call![1][0].value));
    expect(skip.reason).toBe('active-chat-presence');
    expect(skip.taskUuid).toBe(TASK_UUID);
  });

  it('对话已经聊到别处被作废 → 原因写成另一种，两者能分开', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx, writeState } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor + 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(JSON.parse(String(call![1][0].value)).reason).toBe('conversation-moved-on');
  });

  it('正常触发不留跳过记录（别让上一次的解释赖着不走）', async () => {
    const { ctx, writeState } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call).toBeUndefined();
  });

  it('原因写失败照样把这次拦下来——闸的效果不能取决于能不能写日志', async () => {
    const { ctx } = makeCtx({
      writeStateFails: true,
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  // ─── 值压缩：前端压过的 fire_pack 要能读出来，没压过的老数据也要照常读 ───

  it('前端压过的 fire_pack 照常读出来', async () => {
    // 真实的 fire_pack 是几万字的角色设定加聊天记录，这里也得凑到那个量级：
    // 太短的内容压完反而更大，packStateValue 会按设计原样返回、测不到解压路径。
    const bulky = JSON.stringify({
      ...JSON.parse(firePackValue()),
      template: `${'【角色系统设定】你是一个会在深夜突然想起对方的人。\n'.repeat(400)}`
        + `现在是 ${AMSG_SLOT_CURRENT_TIME}。\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    });
    const packed = await packStateValue(bulky);
    expect(packed.startsWith('gz1:'), '这个量级应该压得动').toBe(true);
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: packed },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const messages = fired(await amsgHooks.onBeforeFire(ctx)).messages;
    expect(messages[0].content).toContain('问问对方吃了没');
    expect(messages[0].content).not.toContain(AMSG_SLOT_CURRENT_TIME);
  });

  it('压过的值坏掉 → 抛错，不拿半截内容当 prompt 发出去', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: 'gz1:bm90LWd6aXAtYXQtYWxs' },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  it('云端没有 tool_pack → 抛错（和 fire_pack 同批上传，缺了就是状态异常，不给空壳继续）', async () => {
    const { ctx } = makeCtx({ charRows: [{ key: AMSG_FIRE_PACK_KEY, value: firePackValue() }] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/tool_pack/);
  });

  it('云端没有 tool_config → 抛错（同上）', async () => {
    const { ctx } = makeCtx({ globalRows: [] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/tool_config/);
  });

  it('任务行 next_send_at 解析不出时间 → 抛错（occurrence 是闸和缓存键的必需字段）', async () => {
    const { ctx } = makeCtx({ nextSendAt: '不是时间' });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/next_send_at/);
  });

  it('任务缺 amsgTaskInstruction（旧格式）→ 抛错，不能用默认指令凑一个', async () => {
    const { ctx } = makeCtx({ metadata: { amsgTaskInstruction: undefined } });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/amsgTaskInstruction/);
  });

  it('任务 metadata 缺 charId → 抛错', async () => {
    const { ctx } = makeCtx({ metadata: { charId: undefined } });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/charId/);
  });
});

// ─── 通用 MCP：到点把工具说明块和 tools 声明一起带上 ───
//
// 提示词块和 tools 数组同源同拍（都来自那一行 tool_config），所以这几条一起钉：
// 教了角色用工具，请求里就得真有工具；没配 MCP 的用户则一个字都不该多出来。

describe('onBeforeFire 注入通用 MCP', () => {
  it('配了 MCP 服务器 → prompt 尾部带工具块，请求带 mcp__ 前缀的 tools', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{ key: AMSG_TOOL_CONFIG_KEY, value: mcpToolConfigValue() }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    const prompt = result.messages[0].content;
    expect(prompt).toContain('问问对方吃了没');           // 原来的任务指令还在
    expect(prompt).toContain('【外部工具');
    expect(prompt).toContain('search_memory');

    expect(result.tools?.map((t) => t.function.name)).toEqual(['mcp__search_memory']);
    // 参数表要原样带上，不然模型只能瞎猜字段名
    expect(result.tools?.[0].function.parameters).toMatchObject({
      properties: { query: { type: 'string' } },
    });
    // 名映射进 scratch，executeToolCalls 按暴露名回查是哪台服务器的哪个工具
    expect((scratch.fire as any).mcpResolve.get('search_memory').toolName).toBe('search_memory');
  });

  it('没配 MCP → 一切照旧：不带 tools、prompt 里没有工具块', async () => {
    const { ctx, scratch } = makeCtx({});
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    expect(result.messages[0].content).not.toContain('【外部工具');
    expect((scratch.fire as any).mcpResolve).toBeNull();
  });

  it('服务器只对别的角色可见 → 当作没配（凭据不该串到不相干的角色身上）', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{
        key: AMSG_TOOL_CONFIG_KEY,
        value: mcpToolConfigValue({
          mcpServers: [{
            id: 'srv-memory', name: '记忆库', url: 'https://mcp.example.com/mcp',
            charIds: ['别的角色'],
            tools: [{ name: 'search_memory', inputSchema: { type: 'object', properties: {} } }],
          }],
        }),
      }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    expect(result.messages[0].content).not.toContain('【外部工具');
    expect((scratch.fire as any).mcpResolve).toBeNull();
  });

  it('用户关了兼容模式（中转拒 tools）→ 不带 tools 参数，改用正文协议教一遍', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{
        key: AMSG_TOOL_CONFIG_KEY,
        value: mcpToolConfigValue({ mcpUseNativeTools: false }),
      }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    const prompt = result.messages[0].content;
    expect(prompt).toContain('tool_name({"参数":"值"})');
    expect(prompt).toContain('search_memory(query*:string)');
    // 工具还是要认识的，只是走正文那条路
    expect((scratch.fire as any).mcpResolve.size).toBe(1);
  });
});

// ─── VAPID 配置兜底 ───
// scheduled() 在 !vapid.email 时会 console.error 后直接 return——整个 tick 一条任务都不处理。
// 而「推送凭据」面板复制出来的 env 里 VAPID_EMAIL 是注释掉的可选项，照着部署必然缺它，
// 表现是「到点了什么都不发、前端没有任何报错」。email 只是 VAPID JWT 的 sub（联系方式），
// 不影响签名有效性，缺省给一个合法 mailto 即可——instant-push worker 一直就是这么做的。
describe('VAPID 配置', () => {
  const baseEnv = {
    AMSG_MASTER_KEY: 'k'.repeat(64),
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    DB: {},
  } as any;

  it('没配 VAPID_EMAIL 时回退到合法 mailto，不能让 scheduled() 整轮跳过', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: undefined });
    expect(config.vapid.email).toMatch(/^mailto:/);
  });

  it('VAPID_EMAIL 只有空白字符时同样回退（空串一样会让 scheduled 跳过）', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: '   ' });
    expect(config.vapid.email).toMatch(/^mailto:/);
  });

  it('配了就用配的那个，不覆盖用户的联系方式', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: 'mailto:me@example.com' });
    expect(config.vapid.email).toBe('mailto:me@example.com');
  });

  it('解析函数本身：缺省/空白回退，配了就原样用', () => {
    expect(resolveVapidEmail(undefined)).toMatch(/^mailto:/);
    expect(resolveVapidEmail('')).toMatch(/^mailto:/);
    expect(resolveVapidEmail('  ')).toMatch(/^mailto:/);
    expect(resolveVapidEmail('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

// 回归守卫：一条 Web Push 只装得下 3993 字节明文，而角色一次可能分享六七张笔记。
// 过去的做法是硬砍到 4 张，用户看到的是「说分享了 6 张、只出来 4 张卡」。现在按真实
// 字节算：装得下照装，装不下把整份挪进 client_state、push 只留引用键，一张不少。
describe('offloadOversizedPush — push 装不下时旁路存储', () => {
  const CLIENT_TASK_ID = 'task-uuid-1';
  const bigNote = (n: number) => ({
    idx: n,
    note: {
      noteId: `note-${n}`,
      title: `第 ${n} 篇笔记的标题`.repeat(4),
      desc: '描述'.repeat(60),
      likes: 100 + n,
      author: `作者${n}`,
      authorId: `author-${n}`,
      coverUrl: `https://example.com/cover-${n}-${'x'.repeat(40)}.jpg`,
    },
  });
  const pushWith = (noteCount: number) => ({
    messageKind: 'content',
    message: '看到几个好东西，分享给你～',
    title: '来自 小满',
    metadata: {
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      directives: Array.from({ length: noteCount }, (_, i) => ({ type: 'xhs_share', idx: i + 1 })),
      xhsSession: {
        notes: Array.from({ length: noteCount }, (_, i) => bigNote(i + 1)),
        xsecTokens: [],
      },
    },
  });

  it('装得下就原样发，不碰云端状态（日常 1-3 张走的就是这条）', async () => {
    const writeState = vi.fn();
    const payload = pushWith(1);
    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);
    expect(out).toBe(payload);
    expect(writeState).not.toHaveBeenCalled();
  });

  it('装不下 → 整份 xhsSession 存进 client_state，push 换成引用键且回到限内', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const payload = pushWith(8);
    // 上限按 UTF-8 字节算，不是字符数——中文一个字三个字节，拿 .length 比会算漏一大截。
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    expect(utf8Bytes(payload)).toBeGreaterThan(MAX_PUSH_PAYLOAD_BYTES);

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    const key = amsgXhsSessionKey(CLIENT_TASK_ID);
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace(CHAR_ID), [
      { key, value: JSON.stringify((payload.metadata as any).xhsSession) },
    ]);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.xhsSessionRef).toBe(key);
    expect(meta.xhsSession).toBeUndefined();
    expect(meta.directives).toHaveLength(8);          // 引用一条不少，只是数据挪了地方
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  it('老部署没有写入口 → 抛错走重试，绝不砍掉笔记凑合发出去', async () => {
    await expect(offloadOversizedPush(pushWith(8) as any, undefined, CHAR_ID, CLIENT_TASK_ID))
      .rejects.toThrow(/AMSG2_WRITE_STATE_UNSUPPORTED/);
  });

  it('超限但没有可旁路的内容 → 原样交给库抛 PUSH_PAYLOAD_TOO_LARGE，不假装成功', async () => {
    const writeState = vi.fn();
    const fat = { messageKind: 'content', message: '正'.repeat(2000), metadata: { charId: CHAR_ID } };
    const out = await offloadOversizedPush(fat as any, writeState, CHAR_ID, CLIENT_TASK_ID);
    expect(out).toBe(fat);
    expect(writeState).not.toHaveBeenCalled();
  });

  // 回归守卫：判定要留余量。这里量的是 hook 交还给库的那份，库之后还会补
  // messageId / sessionId / timestamp / messageIndex / totalMessages（sendHookPushPayloads），
  // 实测多出一百多字节。卡着上限判的话，量出来「刚好装得下」的那一档补完字段就超了：
  // 既没旁路、也发不出去，整条消息丢掉，而且每次重试都死在同一处。
  it('贴着上限（余量不足）也走旁路，别等库补完字段才发现超了', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

    // 拿真实形状撑到「限内、但余量不到 256 字节」这一档，逐字节逼近，不写死魔数。
    const payload = pushWith(1) as any;
    while (utf8Bytes(payload) < MAX_PUSH_PAYLOAD_BYTES - 200) {
      payload.message += '一';
    }
    expect(utf8Bytes(payload)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);   // 旧判定会说「装得下」

    const out = await offloadOversizedPush(payload, writeState, CHAR_ID, CLIENT_TASK_ID);

    expect(writeState).toHaveBeenCalledTimes(1);
    expect((out.metadata as any).xhsSessionRef).toBe(amsgXhsSessionKey(CLIENT_TASK_ID));
    // 挪走之后要给库补字段留出足够空间。
    expect(MAX_PUSH_PAYLOAD_BYTES - utf8Bytes(out)).toBeGreaterThanOrEqual(256);
  });
});

// 服务端工具循环的编排：跑完一个工具之后跟模型说什么，以及重复调用怎么办。
// 这段是「amsg2 和前台行为对齐」的落点——前台每次回喂都明说「别再输出这个标签了」，
// worker 以前只回裸 JSON，模型看不出这一步已经做完，提示词里有句常驻的「先去查 X」
// 就会每轮照做、跑满上限，然后 AGENTIC_LOOP_EXCEEDED、任务不出清、下一分钟整条重跑。
describe('executeToolCalls 的工具编排', () => {
  const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    function: { name, arguments: JSON.stringify(args) },
  });

  /** 造一个跑到 executeToolCalls 那一步的 sessionCtx（scratch.fire 由 onBeforeFire 挂好）。 */
  const readySession = async () => {
    const { ctx, scratch } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    return { sessionId: 'sess_task_42', scratch } as any;
  };

  it('回喂的不是裸 JSON，而是带「别重复」引导的一段话', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    expect(out.content).not.toMatch(/^\{/);        // 不是裸 JSON
    expect(out.content).toContain('不要再来一遍');
    expect(out.content).toContain('调取某个月的记忆');
  });

  it('同名同参第二次直接打回，不再真跑一遍工具', async () => {
    const session = await readySession();
    const call = toolCall('c1', 'recall', { year: '2026', month: '06' });
    await amsgHooks.executeToolCalls([call], session);
    const [second] = await amsgHooks.executeToolCalls(
      [{ ...call, id: 'c2' }],
      session,
    );
    expect(second.content).toContain('没有再去查');
  });

  // 闸只拦「完全一样」的调用。换个月份是正当的多轮使用，拦了就是把能力砍了。
  it('换了参数照常放行——多轮能力不受影响', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    const [other] = await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { year: '2026', month: '07' })],
      session,
    );
    expect(other.content).not.toContain('没有再去查');
  });

  it('参数字段顺序变了仍算同一次调用', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    const [reordered] = await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { month: '06', year: '2026' })],
      session,
    );
    expect(reordered.content).toContain('没有再去查');
  });

  // 轮次快用完了还在请求工具，上游会抛 AGENTIC_LOOP_EXCEEDED：这次攒的旁白全丢、任务
  // 不出清、下一分钟整条从头重跑。先在回喂里说一声，模型自己收尾最省。
  it('倒数第二轮的回喂末尾加一句「这是最后一轮」', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      { ...session, iteration: MAX_TOOL_ITERATIONS - 2 },
    );
    expect(out.content).toContain('最后一轮');
  });

  it('还早的轮次不加那句话（别一上来就催着收尾）', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      { ...session, iteration: 0 },
    );
    expect(out.content).not.toContain('最后一轮');
  });
});

// 轮次预算：worker 判「这是最后一轮了」用的数必须和上游真正跑的轮数是同一个，
// 否则不是提前一轮白收尾、就是照旧撞上 AGENTIC_LOOP_EXCEEDED。
describe('轮次上限与上游共用同一个数', () => {
  const sessionCtx = (scratch: Record<string, unknown>, llmOutputText: string, iteration: number) => ({
    sessionId: 'sess_task_42',
    taskId: 42,
    taskUuid: TASK_UUID,
    llmResponse: {},
    llmOutputText,
    contactName: 'Nyah',
    metadata: { charId: CHAR_ID, amsgMode: 'auto' },
    scratch,
    iteration,
  }) as any;

  it('onBeforeFire 把轮次上限显式回传给上游', async () => {
    const { ctx } = makeCtx({});
    const result = await amsgHooks.onBeforeFire(ctx) as { maxToolIterations?: number };
    expect(result.maxToolIterations).toBe(MAX_TOOL_ITERATIONS);
  });

  it('最后一轮还想调工具 → 直接收尾，不把 tool-request 交回上游', async () => {
    const { ctx, scratch } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);

    const first = await amsgHooks.onLLMOutput(
      sessionCtx(scratch, '我先想想六月的事。\n[[RECALL: 2026-06]]', 0)) as any;
    expect(first.decision).toBe('tool-request');

    const last = await amsgHooks.onLLMOutput(
      sessionCtx(scratch, '再查一次。\n[[RECALL: 2026-07]]', MAX_TOOL_ITERATIONS - 1)) as any;
    expect(last.decision).toBe('finish');
    expect(last.pushPayloads.map((p: any) => p.message).join('\n')).toContain('我先想想六月的事');
  });
});

// 通用 MCP 的执行环节：worker 直连用户自己配的服务器（服务端 fetch 没有 CORS，
// 不经代理）。这里钉三件事——真的打到了配置里那个地址并带上凭据、同一次 fire 内
// 握手只做一次、以及任何失败都以 ok:false 回喂而不是把整条 fire 炸掉。
describe('runMcpFireTool', () => {
  const probe: McpFireServer = {
    id: 's1',
    name: '探针',
    url: 'https://probe.example.com/mcp',
    token: 'tok-1',
    tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: {} } }],
  };
  // maxNameLen 与 onBeforeFire 一致（给前缀留位）。
  const stashFragment = () => ({
    mcpResolve: buildMcpNameMap([probe], { maxNameLen: MCP_FIRE_NAME_BUDGET }),
    mcpSessions: new Map(),
    mcpSpentMs: 0,
  });

  const rpcOk = (id: number, result: unknown) => new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  afterEach(() => vi.unstubAllGlobals());

  it('握手 + tools/call 直连 server.url，带 Bearer，结果 ok', async () => {
    const seen: Array<{ url: string; body: any; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const body = JSON.parse(init.body);
      seen.push({ url: String(input), body, auth: new Headers(init.headers).get('Authorization') });
      if (body.method === 'initialize') {
        return rpcOk(body.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      return rpcOk(body.id, { content: [{ type: 'text', text: '暗号 MARKER-123' }] });
    }));

    const result = await runMcpFireTool(stashFragment(), 'mcp__get_secret', {});

    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain('MARKER-123');
    expect(seen.every((s) => s.url.startsWith('https://probe.example.com/mcp'))).toBe(true);
    expect(seen.every((s) => s.auth === 'Bearer tok-1')).toBe(true);
    expect(seen.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  });

  // 会话挂在单次 fire 的 stash 上；一次 fire 最多五轮，每轮都重握手就是白烧往返。
  it('同一 fire 内第二次调用复用 session（不重复握手）', async () => {
    let handshakes = 0;
    vi.stubGlobal('fetch', vi.fn(async (_: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        handshakes++;
        return rpcOk(body.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      return rpcOk(body.id, { content: [{ type: 'text', text: 'x' }] });
    }));

    const stash = stashFragment();
    await runMcpFireTool(stash, 'mcp__get_secret', {});
    await runMcpFireTool(stash, 'mcp__get_secret', { a: 1 });

    expect(handshakes).toBe(1);
  });

  it('未配置的工具名 → ok:false 而不是抛错（回喂给模型圆场）', async () => {
    const result = await runMcpFireTool(stashFragment(), 'mcp__nope', {});
    expect(result).toMatchObject({ ok: false, reason: 'unknown_tool' });
  });

  it('服务器错误 → ok:false 带原因（不炸 fire 链）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await runMcpFireTool(stashFragment(), 'mcp__get_secret', {});
    expect(result).toMatchObject({ ok: false, reason: 'mcp_error', source: '探针' });
  });

  // 单次超时之外还有一条全 fire 共享的总预算：native FC 一轮能吐好几个调用，
  // executeToolCalls 串行 await，只卡单次的话 25s × N 照样能顶穿 240s 总预算，
  // 那就是 AGENTIC_LOOP_EXCEEDED、任务不出清、下一分钟整条从头重跑。
  it('预算用尽 → 直接 ok:false 早退，一个请求都不发', async () => {
    const fetchSpy = vi.fn(async () => new Response('never', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const stash = { ...stashFragment(), mcpSpentMs: 120_000 };
    const result = await runMcpFireTool(stash, 'mcp__get_secret', {});

    expect(result).toMatchObject({ ok: false, reason: 'mcp_budget_exhausted', source: '探针' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('调用完把耗时记进 mcpSpentMs（后续调用才知道还剩多少）', async () => {
    // 假时钟：只在服务器回 tools/call 结果那一刻往前拨 700ms，模拟这次调用真的花了这么久。
    // 不用真等，也不受「这段代码一共读了几次 Date.now」影响。
    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('fetch', vi.fn(async (_: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return rpcOk(body.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      clock += 700;
      return rpcOk(body.id, { content: [{ type: 'text', text: 'x' }] });
    }));

    const stash = stashFragment();
    await runMcpFireTool(stash, 'mcp__get_secret', {});
    nowSpy.mockRestore();

    expect(stash.mcpSpentMs).toBe(700);
  });
});

// 回归守卫：主动消息的多轮连续性。
//
// fire_pack 的【最近对话上下文】停在「用户最后一次聊天」那一刻，用户离线期间不会刷新。
// 没有这条回写链的话，连着触发两次，角色第二次读到的上下文与第一次逐字一样——它不知道
// 自己刚说过什么，只会把同一句话换个说法再发一遍，而且全程不报错，静默退化成单轮。
// 下面这组用例是端到端的：真的跑两次 fire，第二次的 prompt 里必须出现第一次发的正文。
describe('self_log — 角色自述回写', () => {
  const CLIENT_TASK_ID = 'client-task-1';

  /** 带自述槽位的 fire_pack（当前客户端打的包长这样）。 */
  const slottedFirePack = (builtAt: number = PACK_BUILT_AT) => JSON.stringify({
    v: FIRE_PACK_VERSION,
    template: `【最近对话上下文】\n用户：先睡了${AMSG_SLOT_SELF_LOG}\n\n【本次任务】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    lastUserMessageAt: null,
    tzId: 'Asia/Shanghai',
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    builtAt,
    pendingTasks: [],
    scene: null,
  });

  /** 会真的记住写入的假 client_state：第二次 fire 靠它读回第一次写下的自述。 */
  const makeStore = (firePack: string) => {
    const rows = new Map<string, string>([
      [AMSG_FIRE_PACK_KEY, firePack],
      [AMSG_TOOL_PACK_KEY, toolPackValue],
    ]);
    let writeFails = false;
    const readState = vi.fn(async (namespace: string) => (
      namespace.startsWith('amsg:char:')
        ? [...rows].map(([key, value]) => ({ key, value }))
        : [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }]
    ));
    const writeState = vi.fn(async (
      _namespace: string,
      entries: Array<{ key: string; value: string | null }>,
    ) => {
      if (writeFails) throw new Error('write failed');
      for (const entry of entries) {
        if (entry.value === null) rows.delete(entry.key);
        else rows.set(entry.key, entry.value);
      }
      return { upserted: entries.length, skipped: 0, deleted: 0 };
    });
    return {
      rows,
      readState,
      writeState,
      failWrites: () => { writeFails = true; },
      selfLog: () => parseSelfLog(rows.get(AMSG_SELF_LOG_KEY) ?? ''),
    };
  };

  /**
   * 跑一次完整的 fire：组 prompt → 交一段 LLM 输出 → 走完 finish → 模拟库发完推送后
   * 调 onAfterSend（amsg-server 2.6.0-next.10 的发送后回执；task 传 D1 行原样的最小
   * 子集，对号只看 id）。sentCount 缺省 = 全部段都送出去了；传数字模拟部分失败。
   * 返回这次实际发给 LLM 的 prompt，第二次调用时用它断言「接上了没有」。
   */
  const runFire = async (
    store: ReturnType<typeof makeStore>,
    opts: { sendAt: string; llmOutput: string; sentCount?: number; skipAfterSend?: boolean },
  ) => {
    const scratch: Record<string, unknown> = {};
    const fireCtx = {
      task: {
        id: 42,
        uuid: TASK_UUID,
        contactName: 'Nyah',
        recurrenceType: 'daily',
        nextSendAt: opts.sendAt,
        metadata: {
          charId: CHAR_ID,
          amsgExpirePolicy: 'force',
          amsgTaskInstruction: '想到什么说什么',
          amsgClientTaskId: CLIENT_TASK_ID,
        },
      },
      userId: 'u1',
      readState: store.readState,
      writeState: store.writeState,
      now: new Date(opts.sendAt),
      scratch,
    } as any;

    const prompt = fired(await amsgHooks.onBeforeFire(fireCtx)).messages[0].content;

    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42@1',
      taskId: 42,
      taskUuid: TASK_UUID,
      llmResponse: {},
      llmOutputText: opts.llmOutput,
      contactName: 'Nyah',
      metadata: {
        charId: CHAR_ID,
        amsgClientTaskId: CLIENT_TASK_ID,
        amsgMode: 'auto',
      },
      scratch,
      writeState: store.writeState,
    } as any) as any;

    // 上游的 onFireSettled 无论这次 fire 是发出去了、跳过了还是抛错了都会调一次，
    // 这里照着来——只在 finish 分支调的话，验不到「没正文可发时角色自排的任务还落不落账」。
    if (!opts.skipAfterSend) {
      const sent = decision.decision === 'finish';
      const total = sent ? decision.pushPayloads.length : 0;
      await amsgFireSettled({
        status: sent ? 'sent' : 'skipped',
        sentCount: sent ? (opts.sentCount ?? total) : 0,
        scratch,
        writeState: store.writeState,
      });
    }

    return { prompt, decision, scratch };
  };

  it('第二次触发能看见第一次发了什么（核心回归守卫）', async () => {
    const store = makeStore(slottedFirePack());

    const first = await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '刚看到楼下那只猫又来了',
    });
    expect(first.decision.decision).toBe('finish');
    expect(first.prompt, '第一次当然还没有自述').not.toContain('刚看到楼下那只猫又来了');

    const second = await runFire(store, {
      sendAt: '2026-07-25T14:00:00.000Z',
      llmOutput: '它蹲在那儿一直没走',
    });
    expect(second.prompt).toContain('刚看到楼下那只猫又来了');
    expect(second.prompt).toContain('【这之后你又主动发过（对方还没回）】');
    // 位置：夹在对话上下文和本次任务之间，别跑到指令后面被当成新指令读。
    expect(second.prompt.indexOf('刚看到楼下那只猫又来了'))
      .toBeLessThan(second.prompt.indexOf('想到什么说什么'));

    // 两次都记下了，第三次能一路接上去。
    expect(store.selfLog()?.entries.map((e) => e.text))
      .toEqual(['刚看到楼下那只猫又来了', '它蹲在那儿一直没走']);
  });

  it('多段消息合成一条记（用户那边是几条气泡，对角色是一次「我说了这些」）', async () => {
    const store = makeStore(slottedFirePack());
    await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '喂\n在吗',
    });
    expect(store.selfLog()?.entries).toHaveLength(1);
    expect(store.selfLog()?.entries[0].text).toBe('喂\n在吗');
  });

  it('同一次触发重跑（投递失败重试）不会记成两条', async () => {
    const store = makeStore(slottedFirePack());
    const sendAt = '2026-07-25T12:00:00.000Z';
    await runFire(store, { sendAt, llmOutput: '第一次生成的话' });
    await runFire(store, { sendAt, llmOutput: '重跑时生成的话' });

    const entries = store.selfLog()?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].text, '同 id 覆盖，留最后一次真正发出去的那份').toBe('重跑时生成的话');
  });

  it('客户端传了新 fire_pack → 旧自述作废，不会在 prompt 里出现两遍', async () => {
    const store = makeStore(slottedFirePack());
    await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '刚看到楼下那只猫又来了',
    });

    // 用户回来聊了一轮：客户端重新打包上传，新模板的对话记录里本来就含那条主动消息。
    store.rows.set(AMSG_FIRE_PACK_KEY, slottedFirePack(PACK_BUILT_AT + 60_000));

    const next = await runFire(store, {
      sendAt: '2026-07-25T14:00:00.000Z',
      llmOutput: '那只猫今天还来吗',
    });
    expect(next.prompt).not.toContain('刚看到楼下那只猫又来了');
    // 日志本身从空的重攒，锚点跟上新的那份包。
    expect(store.selfLog()?.basePackAt).toBe(PACK_BUILT_AT + 60_000);
    expect(store.selfLog()?.entries.map((e) => e.text)).toEqual(['那只猫今天还来吗']);
  });

  // 对齐锚点是必填的，没有它自述日志无从判断新旧。所以缺锚点的包按「云端状态坏了」
  // 硬失败，而不是悄悄退回单轮——静默降级的话，多轮连续性没了也没人会发现。
  it('包里缺对齐锚点 → 抛错，不静默退回单轮', async () => {
    const store = makeStore(JSON.stringify({
      v: FIRE_PACK_VERSION,
      template: `【最近对话上下文】\n用户：先睡了${AMSG_SLOT_SELF_LOG}\n\n【本次任务】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
      lastUserMessageAt: null,
      tzId: 'Asia/Shanghai',
      userTzId: 'Asia/Shanghai',
      targetName: '小明',
      pendingTasks: [],
      scene: null,
    }));
    await expect(runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '在干嘛呢',
    })).rejects.toThrow('AMSG2_FIRE_STATE_MISSING');
    expect(store.rows.has(AMSG_SELF_LOG_KEY)).toBe(false);
  });

  it('自述写不进去不连累这次投递（消息照发，只是下次接不上）', async () => {
    const store = makeStore(slottedFirePack());
    store.failWrites();
    const { decision } = await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '在干嘛呢',
    });
    expect(decision.decision).toBe('finish');
    expect(decision.pushPayloads[0].message).toBe('在干嘛呢');
  });

  // ⑥ 的核心回归守卫：写库时机从「推送发出前」挪到「发出后」。旧实现在 onLLMOutput
  // 里就落盘——推送全挂时云端记了「说过」，下次 fire 角色接着一句用户根本没收到的话说。
  describe('发送后才写（onAfterSend 回执）', () => {
    it('onLLMOutput 只挂到 scratch 上不落盘；onAfterSend 才写库', async () => {
      const store = makeStore(slottedFirePack());
      const { decision, scratch } = await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '刚看到楼下那只猫又来了',
        skipAfterSend: true,
      });
      expect(decision.decision).toBe('finish');
      expect(store.selfLog(), '推送还没发出去，不能已经记了「说过」').toBeNull();
      expect((scratch.fire as any).selfLogTexts).toEqual(['刚看到楼下那只猫又来了']);

      await amsgFireSettled({ sentCount: 1, scratch, writeState: store.writeState });
      expect(store.selfLog()?.entries.map((e) => e.text)).toEqual(['刚看到楼下那只猫又来了']);
      expect((scratch.fire as any).selfLogTexts, '认领后清空，重复回执不会记两遍').toBeNull();
    });

    it('部分失败：只把真送出去的前 sentCount 段写进日志，没送出去的正文不进', async () => {
      const store = makeStore(slottedFirePack());
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '第一段送出去了\n第二段没送出去',
        sentCount: 1,
      });
      const entries = store.selfLog()?.entries ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe('第一段送出去了');
      expect(entries[0].text).not.toContain('第二段没送出去');
    });

    it('sentCount=0（推送全挂）不写——用户什么都没收到，云端不能记「说过」', async () => {
      const store = makeStore(slottedFirePack());
      const { scratch } = await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '一段都没送出去的话',
        sentCount: 0,
      });
      expect(store.selfLog()).toBeNull();
      expect((scratch.fire as any).selfLogTexts, '认领过就清空，重试的下一条 fire 会重新生成').toBeNull();
    });

    it('entry.at 是实际发送时刻，不再是名义 occurrenceMs（cron 迟到半小时时名义时刻是谎话）', async () => {
      const store = makeStore(slottedFirePack());
      const before = Date.now();
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',   // 名义时刻在 2026 年
        llmOutput: '在干嘛呢',
      });
      const entry = store.selfLog()?.entries[0];
      expect(entry?.at).toBeGreaterThanOrEqual(before);
      expect(entry?.at).not.toBe(Date.parse('2026-07-25T12:00:00.000Z'));
      // 去重语义不动：id 仍是 clientTaskId@occurrenceMs。
      expect(entry?.id).toBe(`${CLIENT_TASK_ID}@${Date.parse('2026-07-25T12:00:00.000Z')}`);
    });

    // scratch 上没挂本次 fire 的记录：onBeforeFire 抛错、或者这次走的是 skip 出口。
    it('scratch 上没有本次 fire 的记录 → 不猜不写，也不炸', async () => {
      const store = makeStore(slottedFirePack());
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '在干嘛呢',
        skipAfterSend: true,
      });
      await expect(amsgFireSettled({ sentCount: 1, scratch: {}, writeState: store.writeState }))
        .resolves.toBeUndefined();
      expect(store.selfLog()).toBeNull();
    });

    it('并发的两次 fire 各写各的——scratch 是每次 fire 独有的一份', async () => {
      const storeA = makeStore(slottedFirePack());
      const storeB = makeStore(slottedFirePack());
      const a = await runFire(storeA, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: 'A 的话',
        skipAfterSend: true,
      });
      const b = await runFire(storeB, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: 'B 的话',
        skipAfterSend: true,
      });

      await amsgFireSettled({ sentCount: 1, scratch: b.scratch, writeState: storeB.writeState });
      expect(storeB.selfLog()?.entries.map((e) => e.text)).toEqual(['B 的话']);
      expect(storeA.selfLog(), 'B 的回执不能把 A 的正文带走').toBeNull();

      await amsgFireSettled({ sentCount: 1, scratch: a.scratch, writeState: storeA.writeState });
      expect(storeA.selfLog()?.entries.map((e) => e.text)).toEqual(['A 的话']);
    });
  });
});

// 回归守卫：角色到点给自己排下一条。这是「连续自行回复」的触发端——上面那组 self_log
// 保证第二次知道第一次说了什么，这组保证第二次会自己发生。
describe('自排后续任务', () => {
  const makeStash = (over: Record<string, unknown> = {}) => ({
    session: { narrations: [], toolCalls: [], duplicateToolCalls: 0, mcpCallSeq: 0 },
    occurrenceMs: Date.parse('2026-07-25T12:00:00.000Z'),
    selfLog: { v: 2 as const, basePackAt: 1, entries: [], tasks: [] },
    pendingTaskCount: 0,
    scheduledTasks: [],
    charId: CHAR_ID,
    anchorMs: 1_700_000_000_000,
    tz: { tzId: 'Asia/Shanghai' },
    taskUuid: TASK_UUID,
    taskRowId: '42',
    ...over,
  }) as any;

  const okSchedule = vi.fn(async (opts: any) => ({
    created: true as const, id: 7, uuid: opts.uuid, nextSendAt: opts.firstSendTime,
  }));
  const NOW_MS = Date.parse('2026-07-25T12:00:00.000Z');
  const sendAt = new Date(NOW_MS + 90 * 60_000).toISOString();

  afterEach(() => { okSchedule.mockClear(); });

  it('排成功：任务落到远端，也记进自述日志供下次读回', async () => {
    const stash = makeStash();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);

    expect(out.ok).toBe(true);
    expect(okSchedule).toHaveBeenCalledTimes(1);
    const opts = okSchedule.mock.calls[0][0];
    expect(opts.firstSendTime).toBe(sendAt);
    expect(opts.metadata.charId).toBe(CHAR_ID);
    // 到点那条要能走满血链路：任务指令、归属键、防穿帮字段一个都不能少
    expect(opts.metadata.amsgTaskInstruction).toBeTruthy();
    expect(opts.metadata.amsgClientTaskId).toBeTruthy();
    expect(opts.metadata.amsgExpirePolicy).toBe('expire');
    expect(opts.metadata.amsgAnchorMs).toBe(1_700_000_000_000);

    expect(stash.scheduledTasks).toHaveLength(1);
    expect(stash.selfLog.tasks).toHaveLength(1);
    expect(stash.selfLog.tasks[0].source).toBe('character');
  });

  // 幽灵任务回归守卫：角色排了任务，但这轮最终一句话都没发出去（只做了副作用 / 空生成 /
  // 推送全挂）。任务在 scheduleTask 那一刻就真的建进 D1 了 —— 账要是没落下来，客户端认领
  // 不到、面板看不见、用户取消不掉，它却会一直按时发下去。
  it('这轮没发出任何正文时，角色自排的任务照样落进 self_log', async () => {
    const stash = makeStash();
    await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(stash.selfLogDirty, '排完任务就该标记有未落盘改动').toBe(true);

    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'skipped', sentCount: 0, scratch: { fire: stash }, writeState,
    } as any);

    const entries = writeState.mock.calls[0][1];
    const written = JSON.parse(String(entries.find((e) => e.key === AMSG_SELF_LOG_KEY)!.value));
    expect(written.tasks).toHaveLength(1);
    expect(written.tasks[0].source).toBe('character');
    // 一段都没送出去 = 用户什么都没收到，不能记「我说过什么」
    expect(written.entries ?? []).toHaveLength(0);
  });

  it('什么都没添进日志时不写库（别为一次空 fire 白打一个请求）', async () => {
    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'skipped', sentCount: 0, scratch: { fire: makeStash() }, writeState,
    } as any);
    expect(writeState).not.toHaveBeenCalled();
  });

  /** 撞车回执：带上已存在那行的脱敏投影（上游 2.6.0-next.11 起）。 */
  const dupSchedule = (over: Record<string, unknown> = {}) => vi.fn(async (opts: any) => ({
    created: false as const,
    reason: 'duplicate' as const,
    uuid: opts.uuid,
    task: {
      nextSendAt: sendAt,
      recurrenceType: 'none',
      messageType: 'auto',
      clientTaskId: 'client-dup',
      ...over,
    },
  }));

  it('uuid 由触发时刻推出来 —— fire 重跑撞车不多排一条，但这一轮照样记账', async () => {
    const first = makeStash();
    await runFireScheduleTool(first, okSchedule, { send_at: sendAt }, NOW_MS);
    const uuidA = okSchedule.mock.calls[0][0].uuid;

    // 同一次触发重跑：新 stash（fire 重跑会重新挂 scratch），uuid 应该一模一样。
    // 重跑的起因通常是投递失败——上一轮记的账随那次失败一起没了。这一轮再不记，任务
    // 就只活在 D1 里：随 push 带不回客户端、面板列不出来、用户也取消不掉。
    okSchedule.mockClear();
    const retry = makeStash();
    const remoteSendAt = new Date(NOW_MS + 95 * 60_000).toISOString();
    const dup = dupSchedule({ nextSendAt: remoteSendAt });
    const out = await runFireScheduleTool(retry, dup, { send_at: sendAt }, NOW_MS);

    expect(dup.mock.calls[0][0].uuid).toBe(uuidA);
    expect(out.ok, '撞车对模型来说结果一样：那条确实排上了').toBe(true);
    expect(out.already_scheduled).toBe(true);
    expect(retry.scheduledTasks, '这一轮也要记下来').toHaveLength(1);
    expect(retry.selfLog.tasks).toHaveLength(1);
    // 真正会响的是远端那行的时间，不是这一轮模型想改成的那个。
    expect(retry.scheduledTasks[0].firstSendTime).toBe(remoteSendAt);
    expect(out.send_at).toBe(remoteSendAt);
  });

  // uuid 的序号取自「这一轮已经排了几条」。撞车不记账的话序号不涨，同一轮里第二次排
  // 会算出同一个 uuid、再撞一次——模型以为排了两条，实际只有一条。
  it('撞车之后序号照涨：同一轮第二次排的是新任务，不是又撞回同一条', async () => {
    const stash = makeStash();
    const dup = dupSchedule();
    await runFireScheduleTool(stash, dup, { send_at: sendAt }, NOW_MS);
    await runFireScheduleTool(
      stash, dup, { send_at: new Date(NOW_MS + 150 * 60_000).toISOString() }, NOW_MS);

    const uuids = dup.mock.calls.map((c: any[]) => c[0].uuid);
    expect(new Set(uuids).size, '两次调用不能落到同一个 uuid 上').toBe(2);
  });

  it('单次 fire 排满就打回，不再调远端', async () => {
    const stash = makeStash();
    for (let i = 0; i < MAX_FIRE_SCHEDULES; i += 1) {
      await runFireScheduleTool(stash, okSchedule, { send_at: new Date(NOW_MS + (90 + i) * 60_000).toISOString() }, NOW_MS);
    }
    okSchedule.mockClear();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('fire_limit');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  it('角色挂着的任务已经到上限 → 打回（离线连排也绕不过每角色上限）', async () => {
    const stash = makeStash({ pendingTaskCount: MAX_ACTIVE_TASKS_PER_CHAR });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('task_limit');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  it('参数写歪 → 回喂一句能照做的话，不抛错（抛错等于整条任务重跑）', async () => {
    const stash = makeStash();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: '明天' }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(String(out.message)).toContain('墙钟');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  // ③ 在 fire 工具入口的落地：角色写的裸墙钟按 stash.tz（fire_pack 的参照系）解析。
  it('裸 send_at 按角色时区解析（UTC 运行时不再差一个时差）', async () => {
    const stash = makeStash();   // Asia/Shanghai
    const out = await runFireScheduleTool(
      stash, okSchedule, { send_at: '2026-07-26T09:00:00' }, NOW_MS,
    );
    expect(out.ok).toBe(true);
    // 上海墙钟 07-26 09:00 = 01:00Z。旧行为（按 UTC 解析）会给 09:00Z，差 8 小时。
    expect(okSchedule.mock.calls[0][0].firstSendTime).toBe('2026-07-26T01:00:00.000Z');
  });

  it('上游护栏抛错 → 转成回喂，不连累这次投递', async () => {
    const stash = makeStash();
    const boom = vi.fn(async () => { throw new RangeError('firstSendTime 至少要比现在晚 60 秒'); });
    const out = await runFireScheduleTool(stash, boom as any, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('schedule_rejected');
    expect(String(out.message)).toContain('60 秒');
  });

  it('老部署没有这个口子 → 明确告诉角色排不了，别让它承诺了又没下文', async () => {
    const out = await runFireScheduleTool(makeStash(), undefined, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_supported');
  });
});

describe('attachScheduledTasks', () => {
  const task = { taskUuid: 'u1', clientTaskId: 'c1' } as any;

  it('挂在最后一条 push 上（与 directives 同位置，收侧只重放一次）', () => {
    const out = attachScheduledTasks(
      [{ message: 'a', metadata: { charId: CHAR_ID } }, { message: 'b', metadata: { charId: CHAR_ID } }],
      [task],
    );
    expect((out[0].metadata as any).amsgSelfScheduled).toBeUndefined();
    expect((out[1].metadata as any).amsgSelfScheduled).toEqual([task]);
    expect((out[1].metadata as any).charId, '原有 metadata 不能被顶掉').toBe(CHAR_ID);
  });

  it('没排任务 / 没有 push 时原样返回', () => {
    const payloads = [{ message: 'a' }];
    expect(attachScheduledTasks(payloads, [])).toBe(payloads);
    expect(attachScheduledTasks([], [task])).toEqual([]);
  });
});

// ⑤ 没发出去也留痕：模型返回空 / 纯拒答、或者只做了副作用没说话时，上游都把任务当成功
// 消费，面板过去无从解释。现在 skip-push 分支写一条 last_skip，两种成因分开记。
describe('没发出去时写 last_skip', () => {
  const runEmptyFire = async (opts: { writeStateFails?: boolean; llmOutputText?: string } = {}) => {
    const { ctx, scratch, writeState } = makeCtx({ writeStateFails: opts.writeStateFails });
    await amsgHooks.onBeforeFire(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: opts.llmOutputText ?? '',
      contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any);
    return { decision: decision as any, writeState };
  };

  it('空输出 → skip-push 且写 last_skip（reason: empty-generation，带任务定位）', async () => {
    const { decision, writeState } = await runEmptyFire();
    expect(decision.decision).toBe('skip-push');

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '应该写过 last_skip').toBeTruthy();
    const skip = JSON.parse(String(call![1][0].value));
    expect(skip.reason).toBe('empty-generation');
    expect(skip.taskUuid).toBe(TASK_UUID);
    expect(skip.occurrenceMs).toBe(Date.parse('2026-07-25T12:00:00.000Z'));
  });

  // 只做事不说话的那一轮：空正文 push 的 banner body 也是空的，用户锁屏会收到一条
  // 只有标题的空横幅、未读 +1、点进去 0 气泡。整条不发，副作用一起放弃。
  it('只有副作用标签没有正文 → skip-push 且写 last_skip（reason: side-effects-only）', async () => {
    const { decision, writeState } = await runEmptyFire({ llmOutputText: '[[ACTION:POKE]]' });
    expect(decision.decision).toBe('skip-push');

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '应该写过 last_skip').toBeTruthy();
    expect(JSON.parse(String(call![1][0].value)).reason).toBe('side-effects-only');
  });

  it('留痕写失败不影响 skip 本身（best-effort）', async () => {
    const { decision } = await runEmptyFire({ writeStateFails: true });
    expect(decision.decision).toBe('skip-push');
  });

  it('正常出正文的 fire 不写 empty-generation', async () => {
    const { ctx, scratch, writeState } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: '在干嘛呢',
      contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any);
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call).toBeUndefined();
  });
});

// 推送横幅上的名字：任务行里那份是排程当天冻进去的，用户改名之后不会跟着变（上游
// update-message 的可写字段里也没有它）。tool_pack 每轮聊天都重新上云，所以以它为准。
describe('推送标题跟着当前角色名', () => {
  it('tool_pack 的 charName 盖过任务行冻结的 contactName', async () => {
    const { ctx, scratch, writeState } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        {
          key: AMSG_TOOL_PACK_KEY,
          value: JSON.stringify({
            v: 1, charName: '夜', xhsEnabled: false, activeMemoryMonths: [], memories: [],
            timeAwarenessEnabled: true,
          }),
        },
      ],
    });
    await amsgHooks.onBeforeFire(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: '睡了吗',
      contactName: 'Nyah',   // 任务行还顶着改名前的旧名字
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any) as any;

    expect(decision.decision).toBe('finish');
    expect(decision.pushPayloads[0].title).toBe('来自 夜');
    expect(decision.pushPayloads[0].contactName).toBe('夜');
  });
});

// ⑥ stale 守卫消费端：上游过期不补发时调 onStaleSkip(task, info)，这里写 last_skip
// 让面板能解释「说好的消息为什么凭空消失」。
describe('stale 跳过留痕（onStaleSkip）', () => {
  const TASK_ROW_UUID = '3637dae1-1461-4444-a747-34e406f67acc';
  type SkipEntry = { key: string; value: string | null };
  const makeWriteState = () => vi.fn(
    async (_namespace: string, _entries: SkipEntry[]) => ({ upserted: 1, skipped: 0, deleted: 0 }));
  const lastSkipOf = (writeState: ReturnType<typeof makeWriteState>) => {
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e) => e.key === AMSG_LAST_SKIP_KEY));
    return call
      ? { namespace: call[0], skip: JSON.parse(String(call[1][0].value)) }
      : null;
  };

  it('charId 取 info.metadata.charId，写 reason: stale + 那一次的名义触发时刻', async () => {
    const writeState = makeWriteState();
    const occurrence = '2026-07-25T09:00:00.000Z';
    await amsgStaleSkip(
      { id: 101, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse(occurrence),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    );
    const written = lastSkipOf(writeState);
    expect(written, '应该写过 last_skip').toBeTruthy();
    expect(written!.namespace).toBe(amsgStateNamespace(CHAR_ID));
    expect(written!.skip.reason).toBe('stale');
    expect(written!.skip.occurrenceMs).toBe(Date.parse(occurrence));
    expect(written!.skip.staleAction).toBe('expired');
  });

  // 循环任务的快进跳过也会调这个 hook。跟一次性任务的过期混为一谈的话，每日提醒断更
  // 一天会被面板说成「已经彻底没了」——而它下一次照常响。
  it('循环任务快进：记 fast_forwarded + 跳过次数 + 快进到的下一次', async () => {
    const writeState = makeWriteState();
    await amsgStaleSkip(
      { id: 102, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'fast_forwarded',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 4,
        nextSendAt: '2026-07-29T09:00:00.000Z',
        writeState,
      },
    );
    const written = lastSkipOf(writeState);
    expect(written!.skip.staleAction).toBe('fast_forwarded');
    expect(written!.skip.skippedCount).toBe(4);
    expect(written!.skip.nextSendAtMs).toBe(Date.parse('2026-07-29T09:00:00.000Z'));
    // 记的是最早被跳过的那一次，不是快进之后的时间。
    expect(written!.skip.occurrenceMs).toBe(Date.parse('2026-07-25T09:00:00.000Z'));
  });

  it('metadata 缺 charId（真异常）→ warn 放弃留痕，不写也不炸', async () => {
    const writeState = makeWriteState();
    await expect(amsgStaleSkip(
      { id: 100, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: null,
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    )).resolves.toBeUndefined();
    expect(lastSkipOf(writeState)).toBeNull();
  });

  // 写口由回执载荷直接给。攒一份 fire 级写口的老做法在 isolate 冷启动后的第一跳是
  // 空的，而服务停摆恢复后的第一波过期，正是这个 hook 最该留下痕迹的时候。
  it('这一跳一次 fire 都没跑过，照样留得下痕', async () => {
    const writeState = makeWriteState();
    await amsgStaleSkip(
      { id: 103, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    );
    expect(lastSkipOf(writeState), 'isolate 冷启动的第一跳也要写得下').toBeTruthy();
  });
});

describe('worker 配置接线', () => {
  it('onAfterSend / onStaleSkip 挂在 config 上（漏接任何一个，发送后回执/过期留痕都静默失效）', () => {
    const cfg = buildWorkerConfig({
      AMSG_MASTER_KEY: 'k'.repeat(64),
      VAPID_EMAIL: 'mailto:a@b.c',
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      DB: {},
    } as any);
    expect(cfg.onFireSettled).toBe(amsgFireSettled);
    expect(cfg.onStaleSkip).toBe(amsgStaleSkip);

    // 同角色的多条任务不并发跑，靠这个分组键。取不到 charId 时返回 null（= 不分组），
    // 别让一批「认不出属于谁」的任务挤成同一组互相堵。
    expect(cfg.serializeBy({ metadata: { charId: 'char-a' } })).toBe('char-a');
    expect(cfg.serializeBy({ metadata: {} })).toBeNull();
    expect(cfg.serializeBy({})).toBeNull();
  });
});
