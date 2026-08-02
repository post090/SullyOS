// utils/amsgStateSync.test.ts
// 编排层守卫：打脏 → 去抖 → 批量冲刷 → 失败退避重传，以及活跃会话租约的起停。
// 关键取舍：云端那份 fire_pack 是角色到点时唯一的上下文来源，传不上去就意味着它带着
// 旧上下文发消息，所以失败的快照必须留在队列里等重传（早期实现发请求前就清空队列，
// 一次网络抖动那份快照就永远没了）。同时也不能变成无限重排，两头都钉住。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    syncCharFirePacks: vi.fn().mockResolvedValue(undefined),
    syncChatPresence: vi.fn().mockResolvedValue(undefined),
    syncToolConfig: vi.fn().mockResolvedValue(undefined),
    listAllTasks: vi.fn().mockResolvedValue([]),
    cancelTask: vi.fn().mockResolvedValue({ uuid: '', alreadyGone: false }),
  },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import {
  AMSG2_PENDING_SYNC_LS_KEY,
  AMSG2_PENDING_TOOL_CONFIG_LS_KEY,
  cancelAllRemoteAmsgTasks,
  flushAmsgState,
  isWorkerUrlCleared,
  markAmsgStateDirty,
  resumePendingAmsgStateSync,
  startAmsgChatPresence,
  stopAmsgChatPresence,
  syncAmsgToolConfig,
} from './amsgStateSync';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { CHAT_PRESENCE_HEARTBEAT_MS } from './amsgChatPresence';
import type { CharacterProfile } from '../types';

const H = 3600_000;
const SYNC_DEBOUNCE_MS = 10_000;

/** 带一个「待触发的 auto 任务」的角色 —— 过同步门的最小形态。 */
const charWithAiTask = (id: string): CharacterProfile => ({
  id, name: id,
  activeMsg2Config: {
    enabled: true,
    tasks: [{
      taskUuid: `${id}-uuid`, mode: 'auto',
      firstSendTime: new Date(Date.now() + H).toISOString(),
      recurrenceType: 'none', source: 'character', status: 'scheduled', createdAt: Date.now(),
    }],
  },
} as unknown as CharacterProfile);

const snapshotOf = (char: CharacterProfile) => ({
  char, userProfile: {} as any, groups: [], realtimeConfig: undefined,
});

let charSeq = 0;
/** 每个用例用独立 charId：模块级 dirty Map 跨用例存活，同 id 会互相干扰。 */
const nextCharId = () => `char-${++charSeq}`;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.removeItem(AMSG2_PENDING_SYNC_LS_KEY);
  localStorage.removeItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  (ActiveMsgClient.syncCharFirePacks as any).mockClear();
  (ActiveMsgClient.syncChatPresence as any).mockClear();
  (ActiveMsgClient.syncToolConfig as any).mockReset();
  (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
  (ActiveMsgClient.listAllTasks as any).mockReset();
  (ActiveMsgClient.listAllTasks as any).mockResolvedValue([]);
  (ActiveMsgClient.cancelTask as any).mockReset();
  (ActiveMsgClient.cancelTask as any).mockResolvedValue({ uuid: '', alreadyGone: false });
  (ActiveMsgStore.getGlobalConfig as any).mockReset();
  (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: 'https://amsg.example.dev' });
});
afterEach(async () => {
  // 待传队列和退避计数都是模块级的：失败用例会留下快照 + 一个重排 timer，
  // 不清干净会串进下一个用例的批次里（batch 长度、退避时长都会对不上）。
  // tool_config 的欠账同理，冲刷会顺手把它带走。
  (ActiveMsgClient.syncCharFirePacks as any).mockResolvedValue(undefined);
  (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
  await flushAmsgState('cleanup');
  await vi.advanceTimersByTimeAsync(1);
  await flushAmsgState('cleanup');
  await vi.advanceTimersByTimeAsync(1);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('markAmsgStateDirty 同步门', () => {
  it('没有待触发 AI 任务的角色直接忽略（零成本，不排 timer 不发请求）', async () => {
    const plain = { id: nextCharId(), name: 'x' } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(plain));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('只有 fixed 任务也忽略（fixed 不需要 fire_pack）', async () => {
    const id = nextCharId();
    const fixedOnly = {
      id, name: id,
      activeMsg2Config: {
        enabled: true,
        tasks: [{
          taskUuid: `${id}-uuid`, mode: 'fixed',
          firstSendTime: new Date(Date.now() + H).toISOString(),
          recurrenceType: 'none', source: 'user', status: 'scheduled', createdAt: Date.now(),
        }],
      },
    } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(fixedOnly));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('enabled=false 忽略', async () => {
    const char = charWithAiTask(nextCharId());
    (char.activeMsg2Config as any).enabled = false;
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('有 AI 任务 → 去抖后冲刷一次；去抖窗口内多次打脏同角色只留最后一份', async () => {
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(5_000);
    markAmsgStateDirty(snapshotOf(char));   // 刷新去抖，不该产生第二次请求
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    const batch = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].char.id).toBe(char.id);
  });

  it('没配 workerUrl → 清空脏标记且不发请求', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    // 没有去处不算「欠着」：底账也一起清，别让下次启动为它白跑一趟补传。
    expect(JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]')).not.toContain(char.id);
  });

  it('冲刷失败 → 快照留在队列里，下次冲刷把同一个角色重传', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await flushAmsgState('test-retry');
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    const retried = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0];
    expect(retried.map((i: any) => i.char.id)).toEqual([char.id]);
  });

  it('失败后自动退避重排（30s），不用干等下一轮聊天', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
  });

  it('重排期间又聊了一轮 → 传新快照，别被回队的旧快照盖回去', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const id = nextCharId();
    const stale = charWithAiTask(id);
    stale.name = '旧快照';
    markAmsgStateDirty(snapshotOf(stale));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);

    const fresh = charWithAiTask(id);
    fresh.name = '新快照';
    markAmsgStateDirty(snapshotOf(fresh));
    await flushAmsgState('test-retry');

    const retried = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0];
    expect(retried).toHaveLength(1);
    expect(retried[0].char.name).toBe('新快照');
  });

  it('连续失败到上限后停止重排（离线时不无限排 timer）', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValue(new Error('offline'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    // 30s → 60s → 120s 三次重排后放手（快照仍留在队列里等下一轮打脏）
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(4);
  });
});

// 去抖窗口回归守卫：钉住 10s。窗口是「聊完就关 App → 快照没传上去」的裸奔期，
// 曾经是 15s——这条测试在 15s 的旧行为下会挂（10s 出头等不到冲刷）。
describe('去抖窗口（10s）', () => {
  it('打脏 10s 出头就冲刷，不用等到 15s', async () => {
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));

    await vi.advanceTimersByTimeAsync(9_000);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
  });
});

// 脏标记轻量持久化：localStorage 只存 charId 底账（快照本体启动时从 DB 重建）。
// 回归守卫：没有这层持久化时，「打脏 → 去抖窗口内杀进程」那份快照就永远丢了。
describe('脏标记持久化与启动补传', () => {
  const readMarks = (): string[] =>
    JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]');

  it('打脏写入底账，上传成功后移除', async () => {
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    expect(readMarks()).toContain(char.id);

    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).not.toContain(char.id);
  });

  it('过不了同步门的角色不写底账', async () => {
    const plain = { id: nextCharId(), name: 'x' } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(plain));
    expect(readMarks()).not.toContain(plain.id);
  });

  it('上传失败底账保留，等重试 / 下次启动补传', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).toContain(char.id);
  });

  it('杀进程模拟：直接构造底账残留 → 启动补传立即重建上传并清底账', async () => {
    // 上次会话只留下 charId（内存队列已随进程蒸发），启动时用 DB 读回的角色重建快照。
    const char = charWithAiTask(nextCharId());
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify([char.id]));

    resumePendingAmsgStateSync({ characters: [char], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(1); // 补传不等去抖，冲微任务即可

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    const batch = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0];
    expect(batch.map((i: any) => i.char.id)).toEqual([char.id]);
    expect(readMarks()).not.toContain(char.id);
  });

  it('残留角色已删除 / 已关 2.0 → 静默清除底账，不发请求', async () => {
    const disabled = charWithAiTask(nextCharId());
    (disabled.activeMsg2Config as any).enabled = false;
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify(['ghost-已删除', disabled.id]));

    resumePendingAmsgStateSync({ characters: [disabled], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1_000);

    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    expect(readMarks()).toEqual([]);
  });

  it('补传失败底账不丢：留给退避重试 / 再下次启动', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('offline'));
    const char = charWithAiTask(nextCharId());
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify([char.id]));

    resumePendingAmsgStateSync({ characters: [char], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).toContain(char.id);
  });
});

// 回归守卫：tool_config（搜索/Notion/飞书/MCP 凭据、代理地址）以前是「单发即忘」——
// 一句 `.catch(() => {})` 就没了，也没有底账。它又不像 fire_pack 那样每轮聊天重传，
// 传丢一次云端就永远是旧的：用户删掉的 MCP 服务器，worker 半夜照旧带着旧 token 直连。
describe('工具凭据（tool_config）的重试与底账', () => {
  const readMark = () => localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  const config = { weatherEnabled: true } as any;

  it('传成功 → 只发一次请求，底账清空', async () => {
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(config);
    expect(readMark()).toBeNull();
  });

  it('传失败 → 底账留存，退避 30s 后自动重传，成功即清账', async () => {
    (ActiveMsgClient.syncToolConfig as any).mockRejectedValueOnce(new Error('worker down'));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(readMark()).toBe('1');

    await vi.advanceTimersByTimeAsync(30_000 + 100);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(2);
    expect(readMark()).toBeNull();
  });

  it('退避打光仍失败 → 底账不丢，下次冲刷接着补', async () => {
    (ActiveMsgClient.syncToolConfig as any).mockRejectedValue(new Error('offline'));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(4);
    expect(readMark()).toBe('1');

    // 网络回来了：下一次 fire_pack 冲刷顺手把它带上去
    (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
    await flushAmsgState('test');
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(5);
    expect(readMark()).toBeNull();
  });

  it('没配 workerUrl → 不发请求，底账也不留（没有去处不算欠着）', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).not.toHaveBeenCalled();
    expect(readMark()).toBeNull();
  });

  it('杀进程模拟：底账残留 → 启动补传用当前配置传一次并清账', async () => {
    localStorage.setItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY, '1');
    resumePendingAmsgStateSync({
      characters: [], userProfile: {} as any, groups: [], realtimeConfig: config,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(config);
    expect(readMark()).toBeNull();
  });

  it('上传期间配置又改了 → 不拿旧那份的成功去清新的欠账', async () => {
    let release: () => void = () => {};
    (ActiveMsgClient.syncToolConfig as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    const newer = { weatherEnabled: false } as any;
    syncAmsgToolConfig(newer);          // 上一次还没回来
    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(readMark()).toBe('1');       // 新的那份还欠着
    await flushAmsgState('test');
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenLastCalledWith(newer);
    expect(readMark()).toBeNull();
  });
});

// 回归守卫：清空 Worker 地址以前是静默存盘。前端这边一切同步停摆，D1 里的任务却一条
// 没少——cron 每分钟照常消费、照烧 LLM 照推送，用户以为自己关掉了一切。
describe('清空 Worker 地址前的收尾', () => {
  it('只有「从非空变空」才触发取消流程', () => {
    expect(isWorkerUrlCleared('https://amsg.example.dev', '')).toBe(true);
    expect(isWorkerUrlCleared('https://amsg.example.dev', '   ')).toBe(true);
    // 换地址、首次填写、本来就空：都不是「关掉」
    expect(isWorkerUrlCleared('https://a.dev', 'https://b.dev')).toBe(false);
    expect(isWorkerUrlCleared('', 'https://b.dev')).toBe(false);
    expect(isWorkerUrlCleared('', '')).toBe(false);
    expect(isWorkerUrlCleared(undefined, undefined)).toBe(false);
  });

  it('逐个取消远端任务，单条失败不拖累其余', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([
      { uuid: 'u1' }, { uuid: 'u2' }, { uuid: 'u3' }, { notAUuid: true },
    ]);
    (ActiveMsgClient.cancelTask as any).mockImplementation(async (uuid: string) => {
      if (uuid === 'u2') throw new Error('worker 503');
      return { uuid, alreadyGone: false };
    });

    const result = await cancelAllRemoteAmsgTasks();

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ total: 3, failed: 1, listed: true });
  });

  it('清单都读不到 → listed:false，交给界面提示「远端可能还挂着」', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('unauthorized'));

    const result = await cancelAllRemoteAmsgTasks();

    expect(result.listed).toBe(false);
    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
  });
});

describe('活跃会话租约', () => {
  it('启动立即写一次，之后按心跳间隔续租；stop 后不再续', async () => {
    const charId = nextCharId();
    startAmsgChatPresence(charId, Date.now());
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS + 100);
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2);

    stopAmsgChatPresence(charId);
    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS * 3);
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2);
  });

  it('同角色重入只刷新时间戳，不叠第二个心跳', async () => {
    const charId = nextCharId();
    startAmsgChatPresence(charId, Date.now());
    startAmsgChatPresence(charId, Date.now());
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2); // 两次立即写

    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS + 100);
    // 只有一个 timer 在跑 → 只多一次，而不是两次
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(3);
    stopAmsgChatPresence(charId);
  });
});
