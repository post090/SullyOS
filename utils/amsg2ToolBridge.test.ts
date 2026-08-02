// utils/amsg2ToolBridge.test.ts
// 回归守卫：角色在同一轮工具循环里连续排程/取消/续期时，本地清单必须累加。
// char 是生成开始时的快照，updateCharacter 只更 React state 不回写它——清单要是从
// char 上读写，第二次 schedule 就会读着空清单把第一条覆盖掉（「建俩只显示一个」）。
// 累加由 createAmsg2ToolSession 的本轮局部变量兜住，下面的用例钉的就是这件事。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { scheduleCharacterTask: vi.fn(), cancelTask: vi.fn() },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import { createAmsg2ToolSession, executeAmsg2Tool } from './amsg2ToolBridge';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { ActiveMsgClient } from './activeMsgClient';

const UUIDS = [
  'aaaaaaaa-0000-0000-0000-000000000000',
  'bbbbbbbb-0000-0000-0000-000000000000',
  'cccccccc-0000-0000-0000-000000000000',
];
const shortOf = (uuid: string) => uuid.slice(0, 8);

// 排程接口把角色写的墙钟折成的绝对时刻（上海 2026-08-03 21:00 / 纽约同日 09:00）。
const RESOLVED_ISO = '2026-08-03T13:00:00.000Z';

// 模拟 React：updateCharacter 只记录落盘的 config，绝不回写 char——
// 这样只有「session 自己兜住最新 config」才能让同轮后续调用读到累加结果。
const makeSession = (charOver: Record<string, unknown> = {}) => {
  const char: any = {
    id: 'preset-x', name: 'Nyah', activeMsg2Config: { enabled: true, tasks: [] },
    ...charOver,
  };
  const persisted: any[] = [];
  const updateCharacter = vi.fn((_id: string, updates: any) => {
    if (updates.activeMsg2Config) persisted.push(updates.activeMsg2Config);
  });
  const deps = createAmsg2ToolSession({
    char, userProfile: {} as any, groups: [], realtimeConfig: {} as any,
    apiConfig: {} as any, updateCharacter,
  });
  return { deps, char, persisted };
};

const future = () => new Date(Date.now() + 3600_000).toISOString();
const lastTasks = (persisted: any[]) => persisted[persisted.length - 1]?.tasks ?? [];

describe('amsg2ToolBridge 同一轮多次调用累加', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => {
      const uuid = UUIDS[n++];
      return {
        uuid, clientTaskId: `cid-${uuid.slice(0, 4)}`, anchorMs: 0, replacedCancelFailed: false,
        // 真接口把 send_at 折成绝对时刻后回传，bridge 该存这一份（见下面的时区用例）。
        firstSendAt: RESOLVED_ISO,
      };
    });
    (ActiveMsgClient.cancelTask as any).mockReset();
    (ActiveMsgClient.cancelTask as any).mockResolvedValue({});
  });

  it('一轮内两次 schedule → 本地保留两条（回归：陈旧快照覆盖）', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t: any) => t.taskUuid)).toEqual([UUIDS[0], UUIDS[1]]);
  });

  it('一轮内 schedule×2 后按短 id 取消其一 → 剩下的是另一条', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    await executeAmsg2Tool('cancel_active_message', { task_id: shortOf(UUIDS[1]) }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith(UUIDS[1]);
  });

  it('一轮内 schedule 一次性任务后立刻 renew → 换成新 uuid、旧记录移除、模式沿用', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', {
      send_at: future(), mode: 'prompted', prompt_hint: '问问吃了没',
    }, deps);
    const renewResult = await executeAmsg2Tool('renew_active_message', {
      send_at: future(), task_id: shortOf(UUIDS[0]),
    }, deps);

    // 修复前这里会回「当前角色没有可续期的任务」——renew 也读不到同轮刚建的那条。
    expect(renewResult).not.toContain('没有可续期');
    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[1]);
    expect(tasks[0].mode).toBe('prompted');
    expect(tasks[0].promptHint).toBe('问问吃了没');
    expect(tasks[0].recurrenceType).toBe('none');
    // 旧任务的远端取消由 scheduleCharacterTask 内部「先建后删」负责，bridge 的职责是
    // 把要替换的 uuid 传下去——这里钉的是 bridge 这一侧。
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ replaceTaskUuid: UUIDS[0] }),
    );
  });

  it('一轮内 schedule 后 list → 列得出刚建的那条', async () => {
    const { deps } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    const listed = await executeAmsg2Tool('list_active_messages', {}, deps);

    expect(listed).toContain(shortOf(UUIDS[0]));
    expect(listed).not.toContain('没有任何定时主动消息任务');
  });

  // 回归守卫：循环任务的 renew 一度是整条改期（recurrence 原样透传 + replaceTaskUuid）。
  // 「每天 9:00 的早安」被角色顺手续到 11:00「晚点补上」，从明天起就永久变成 11:00 了，
  // 编号还跟着换一个。现在改成只补当次，原序列一条不动。
  it('循环任务 renew → 原任务留着，另加一条一次性补发', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', {
      send_at: future(), mode: 'prompted', prompt_hint: '道早安', recurrence: 'daily',
    }, deps);
    const renewResult = await executeAmsg2Tool('renew_active_message', {
      send_at: future(), task_id: shortOf(UUIDS[0]),
    }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(2);
    // 原来那条每天的还在，编号和节奏都没变
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(tasks[0].recurrenceType).toBe('daily');
    // 新加的是一次性补发，方向沿用
    expect(tasks[1].taskUuid).toBe(UUIDS[1]);
    expect(tasks[1].recurrenceType).toBe('none');
    expect(tasks[1].promptHint).toBe('道早安');

    const scheduleArgs = (ActiveMsgClient.scheduleCharacterTask as any).mock.calls[1][0];
    expect(scheduleArgs.replaceTaskUuid).toBeUndefined();
    expect(scheduleArgs.task.recurrenceType).toBe('none');
    // 回执得说清楚原节奏没动，否则角色下一轮会跑去把「原来那条」再取消一遍
    expect(renewResult).toContain(shortOf(UUIDS[0]));
    expect(renewResult).toContain('重复节奏不变');
  });

  it('远端取消失败 → 本地记录保留并标错，不留「看不见的幽灵任务」', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    (ActiveMsgClient.cancelTask as any).mockRejectedValueOnce(new Error('worker 503'));
    const result = await executeAmsg2Tool('cancel_active_message', { task_id: shortOf(UUIDS[0]) }, deps);

    expect(result).toContain('失败');
    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(tasks[0].lastError).toBeTruthy();
  });

  it('累加不靠就地改 char：React state 里的角色对象不被写脏', async () => {
    const { deps, char } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);

    // 落盘走 updateCharacter，char 快照本身保持原样（它是 React state 里的对象）。
    expect(char.activeMsg2Config.tasks).toEqual([]);
    // 但 session 读得到累加后的两条。
    expect(deps.getConfig()?.tasks).toHaveLength(2);
  });
});

// ─── 角色级开关 ───
// 设置面板「关闭 2.0」会持久化 activeMsg2Config.enabled=false。工具注入这条路要是只看
// 全局 workerUrl，被关掉的角色照样拿得到 schedule_active_message；再加上落盘时强写
// enabled:true，一次工具调用就把用户显式关掉的功能又打开了。两头都得钉住。
describe('角色级开关 enabled=false', () => {
  const charWith = (config: any) => ({ id: 'preset-x', name: 'Nyah', activeMsg2Config: config } as any);

  it('关掉的角色不给注入工具', () => {
    expect(isAmsg2EnabledForChar(charWith({ enabled: false, tasks: [] }))).toBe(false);
  });

  it('开着的角色照常注入', () => {
    expect(isAmsg2EnabledForChar(charWith({ enabled: true, tasks: [] }))).toBe(true);
  });

  it('从没配过 2.0 的角色算开启（默认可用，不需要先进面板点一下）', () => {
    expect(isAmsg2EnabledForChar(charWith(undefined))).toBe(true);
  });

  it('落盘不把 enabled 改写成 true（工具调用不得替用户重新开启功能）', async () => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
    }));
    const char: any = charWith({ enabled: false, tasks: [] });
    const persisted: any[] = [];
    const deps = createAmsg2ToolSession({
      char, userProfile: {} as any, groups: [], realtimeConfig: {} as any, apiConfig: {} as any,
      updateCharacter: (_id: string, updates: any) => {
        if (updates.activeMsg2Config) persisted.push(updates.activeMsg2Config);
      },
    });
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);

    expect(persisted[persisted.length - 1].enabled).toBe(false);
  });
});

// 回归守卫：角色写的 send_at 是「它那边的墙钟」，不带时区后缀（工具描述里就是这么教的）。
// 原样落盘的话，本地读它的地方一律 new Date() 按设备时区解析——异国角色的任务卡、待触发
// 判定、以及下面这句回话全都差一个时差。排程接口已经按角色时区把它折成绝对时刻了，
// bridge 存的、说的都得是那一份。
describe('角色排程的时间统一存绝对时刻', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
      firstSendAt: RESOLVED_ISO,
    }));
  });

  it('落盘存排程接口折好的绝对时刻，不是角色写的墙钟原串', async () => {
    const { deps, persisted } = makeSession({
      customTimezoneEnabled: true, customTimezone: 'America/New_York',
    });
    await executeAmsg2Tool(
      'schedule_active_message',
      { send_at: '2026-08-03T09:00:00' },   // 纽约角色写的「明早九点」
      deps,
    );

    expect(lastTasks(persisted)[0].firstSendTime).toBe(RESOLVED_ISO);
  });

  it('回话里的时间按角色的钟说，且只折一次', async () => {
    const { deps } = makeSession({
      customTimezoneEnabled: true, customTimezone: 'America/New_York',
    });
    const reply = await executeAmsg2Tool(
      'schedule_active_message',
      { send_at: '2026-08-03T09:00:00' },
      deps,
    );

    // 纽约角色说的九点，回话里就该是 09:00
    expect(reply).toContain('09:00');
    // 折两次（先按设备解析原串、再换算到纽约）会落在别的钟点上
    expect(reply).not.toContain('21:00');
  });
});
