/**
 * 主动消息 2.0「满血」的前端状态同步层。
 *
 * 打脏入口不止聊完一轮（useChatAI）：改人设 / 改记忆 / 删改消息 / 面板取消任务这些会
 * 改变 fire_pack 内容的落库路径也会调 markAmsgStateDirty（大多汇在 OSContext 的
 * updateCharacter 落库点），去抖后把所有脏角色的 fire_pack 批量上传 worker 的
 * client_state；切后台（visibilitychange→hidden）立即冲刷——iOS 只给几秒存活窗口，
 * 必须一次请求写完。
 *
 * 只对「已排程 AI 模式 amsg2 任务」的角色生效，其余 markDirty 直接忽略。
 *
 * 脏标记有一份极轻量的 localStorage 底账（只存 charId 数组，不存快照本体）：打脏时写入、
 * 上传成功后移除。去抖窗口内被杀进程的话，下次启动 OSContext 调 resumePendingAmsgStateSync
 * 按底账重建快照补传一次——否则那次改动云端永远不知道，角色到点带旧上下文说话。
 *
 * 上传失败会**退避重试**，不能一失败就把快照丢掉：云端那份 fire_pack 是到点时角色
 * 唯一的上下文来源，刷不上去就意味着角色带着旧上下文发消息（提的「最近聊的事」其实是
 * 上一次同步成功时的状态，顺带 lastUserMessageAt 也旧，worker 侧防穿帮闸的锚点判定
 * 跟着失真）。而最容易失败的恰恰是切后台那次冲刷，也正是「睡前聊完 → 关 App → 凌晨
 * 触发」这条最常见的路径。
 *
 * 它和排程时那次上传的区别只在失败的处理方式：排程那次是硬要求（失败就让整个排程失败，
 * 见 activeMsgClient 的 putClientStateOrThrow），这里退避重试几次，实在传不上去就等
 * 下一轮聊天重新打脏标记。
 *
 * 云端还有一份 tool_config（工具凭据 / MCP 服务器 / 代理地址），走的是同一套退避 + 底账，
 * 入口是 syncAmsgToolConfig（见文件下半部分）。它不像 fire_pack 那样每轮聊天重传，
 * 所以那一次传丢了就得靠自己补。
 */

import { CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { hasActiveAiTask } from './amsg2Tasks';
import { AmsgChatPresence, CHAT_PRESENCE_HEARTBEAT_MS } from './amsgChatPresence';
import { trackEvent } from './analytics';

// 10s：比 15s 少一截「聊完就关 App → 快照没传上去」的裸奔窗口，又不至于每个键入都打请求。
const SYNC_DEBOUNCE_MS = 10_000;
/** 失败重试的退避起点，逐次翻倍（30s → 60s → 120s）。 */
const RETRY_BASE_MS = 30_000;
/** 连续失败几次后放手，等下一轮聊天重新打脏标记——避免离线时无限重排。 */
const MAX_RETRIES = 3;
const HEADER = '[AmsgStateSync]';

export interface AmsgSyncSnapshot {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
}

// charId → 最新快照。同角色多轮聊天只留最后一份，flush 永远用最新状态拼模板。
const dirty = new Map<string, AmsgSyncSnapshot>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let lifecycleBound = false;
let retryCount = 0;
/** 「退避打光了还是没传上去」每次会话只上报一次。 */
let staleStateReported = false;

// ─── 脏标记轻量持久化 ───
// 内存队列在「打脏 → 去抖窗口内杀进程」时会整个蒸发，重开 App 也不补传。这里只把
// charId 记进 localStorage 当底账（快照本体下次启动从 DB 重建，存本体只会留一份过期数据）。
export const AMSG2_PENDING_SYNC_LS_KEY = 'amsg2_pending_sync_char_ids';

const readPendingCharIds = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const writePendingCharIds = (ids: string[]) => {
  // 存储满 / 隐私模式写不进去就算了：底账只是兜底，失败不能影响内存队列正常同步。
  try {
    if (ids.length === 0) localStorage.removeItem(AMSG2_PENDING_SYNC_LS_KEY);
    else localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify(ids));
  } catch { /* 见上 */ }
};

const persistDirtyMark = (charId: string) => {
  const ids = readPendingCharIds();
  if (!ids.includes(charId)) writePendingCharIds([...ids, charId]);
};

/**
 * 一批快照处理完（上传成功 / 判定无处可传）后清底账。
 * 只清「内存里已经不脏」的：上传期间同角色又被打脏的话，新标记不能被这批的收尾抹掉。
 */
const prunePersistedMarks = (batch: AmsgSyncSnapshot[]) => {
  const settled = new Set(batch.map((s) => s.char.id).filter((id) => !dirty.has(id)));
  if (settled.size === 0) return;
  writePendingCharIds(readPendingCharIds().filter((id) => !settled.has(id)));
};

const bindLifecycleListener = () => {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirty.size > 0) {
      void flushAmsgState('hidden');
    }
  });
};

/** 一轮聊完（或角色资料变更后）打脏标记；非 amsg2 AI 任务角色直接忽略。 */
export const markAmsgStateDirty = (snapshot: AmsgSyncSnapshot) => {
  const config = snapshot.char.activeMsg2Config;
  if (!config?.enabled || !hasActiveAiTask(config)) return;

  dirty.set(snapshot.char.id, snapshot);
  persistDirtyMark(snapshot.char.id);
  bindLifecycleListener();
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void flushAmsgState('debounce'); }, SYNC_DEBOUNCE_MS);
};

/**
 * 全局素材变了（表情库这类不属于某个角色的东西）：每个角色的 fire_pack 里都烤着一份
 * 打包那会儿的快照，所以逐个打脏。门在 markAmsgStateDirty 里，没开主动消息的角色自己会被筛掉。
 *
 * 表情库尤其要紧：角色到点发的 [[SEND_EMOJI]] 引用的是包里那份清单，用户删了 / 改了名字
 * 之后云端还照着旧清单说话，客户端反查不到就只能落降级文本气泡。
 */
export const markAmsgStateDirtyForAll = (scope: {
  characters: CharacterProfile[];
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
}) => {
  for (const char of scope.characters) {
    markAmsgStateDirty({
      char,
      userProfile: scope.userProfile,
      groups: scope.groups,
      realtimeConfig: scope.realtimeConfig,
    });
  }
};

/**
 * 把没传上去的快照放回待传队列。
 * 同角色已经有更新的快照时保留新的——旧快照的唯一价值就是「比云端那份新」，
 * 已经被更新的一份取代后再塞回去只会让下次上传倒退。
 */
const requeue = (batch: AmsgSyncSnapshot[]) => {
  for (const snapshot of batch) {
    if (!dirty.has(snapshot.char.id)) dirty.set(snapshot.char.id, snapshot);
  }
};

/** 把所有脏角色的 fire_pack 批量上传。失败退避重排，快照留在队列里等下次。 */
export const flushAmsgState = async (reason: string): Promise<void> => {
  // 工具凭据欠着的话顺手一起补：它和 fire_pack 一样是「云端那份过时了」，
  // 而且冲刷时机（切后台 / 聊完一轮）正是网络多半又通了的时候。
  void runToolConfigSync(`flush:${reason}`);
  if (flushing) return;
  // 队列空 = 没有欠着的快照，之前那串失败也就翻篇了，退避计数跟着归零。
  if (dirty.size === 0) { retryCount = 0; return; }
  if (debounceTimer != null) { clearTimeout(debounceTimer); debounceTimer = null; }
  flushing = true;
  const batch = [...dirty.values()];
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) {
      // 没配 worker = 这些快照没有去处，不是「传失败」，清掉即可（连底账一起）。
      dirty.clear();
      prunePersistedMarks(batch);
      return;
    }

    dirty.clear();
    await ActiveMsgClient.syncCharFirePacks(batch.map((snapshot) => ({
      char: snapshot.char,
      config: snapshot.char.activeMsg2Config!,
      userProfile: snapshot.userProfile,
      groups: snapshot.groups,
      realtimeConfig: snapshot.realtimeConfig,
    })));
    retryCount = 0;
    // 传上去了才清底账；失败路径不清——底账就是给「重试没等到就被杀」兜底的。
    prunePersistedMarks(batch);
  } catch (error) {
    requeue(batch);
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** retryCount;
      retryCount += 1;
      console.warn(`${HEADER} flush(${reason}) 失败，${Math.round(delay / 1000)}s 后重试（第 ${retryCount}/${MAX_RETRIES} 次）`, error);
      if (debounceTimer != null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void flushAmsgState('retry'); }, delay);
    } else {
      // 重排到头了（多半是离线）。快照留在队列里：下次打脏标记 / 切后台都会再试，
      // 在那之前云端仍是上一份，角色到点会带旧上下文——所以这条要吼出来。
      console.error(`${HEADER} flush(${reason}) 连续 ${MAX_RETRIES} 次失败，云端 fire_pack 仍是上一份（角色到点会用旧上下文）`, error);
      // 用户这一侧完全无感：不报错、不提示，只是角色到点说的话对不上最近发生的事。
      // 每次会话最多报一次（一轮退避打完才会走到这儿，但一次会话可以有好几轮）。
      if (!staleStateReported) {
        staleStateReported = true;
        trackEvent('2.0云端状态同步失败');
      }
      retryCount = 0;
    }
  } finally {
    flushing = false;
  }
};

/**
 * 启动补传：上次会话打过脏、但没等到上传就被杀进程的角色，按 localStorage 底账重建
 * 快照再传一次。OSContext 在启动数据加载完成后调用，characters 传的就是刚从 DB 读回
 * 的全量角色（快照数据源 = DB），上传复用 markDirty → flush → syncCharFirePacks 原路。
 *
 * 残留的 charId 可能已经删角色 / 关掉 amsg2 / 任务全发完了——这些直接静默清除底账：
 * 找不到的角色没得传，markDirty 的门拒掉的角色也不该再赖在底账里。
 */
export const resumePendingAmsgStateSync = (scope: {
  characters: CharacterProfile[];
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
}) => {
  // 工具凭据的欠账也在这儿补。底账只记「欠着一次」，凭据本体不落 localStorage
  // （那等于把 token 又抄一份到别的地方），补传用启动时这份最新配置——它本来就是
  // 云端此刻该有的那一份。
  if (hasPersistedToolConfigMark()) syncAmsgToolConfig(scope.realtimeConfig);

  const pending = readPendingCharIds();
  if (pending.length === 0) return;

  // 先整个清掉：还该传的角色下面 markDirty 会把 id 重新写回去，不该传的就此了账。
  writePendingCharIds([]);
  for (const charId of pending) {
    const char = scope.characters.find((c) => c.id === charId);
    if (!char) continue; // 角色已删除，静默跳过
    markAmsgStateDirty({
      char,
      userProfile: scope.userProfile,
      groups: scope.groups,
      realtimeConfig: scope.realtimeConfig,
    });
  }
  // 立即冲刷，不等 10s 去抖——这份欠账已经拖了一次进程生死了。
  if (dirty.size > 0) void flushAmsgState('resume');
};

// ─── 同角色活跃会话租约（Heartbeat）───
// 一轮真实用户消息进入生成流程时启动：立即写一次 chat_presence，之后每 15s 续租，
// 成功/失败/中断后停止本地续租，远端值靠 45s TTL 自然失效。它只代表「正在和这个角色
// 交互」，不是 App 在线状态——切后台就停续租，别让一个闲置可见标签页无限续租。

interface ChatPresenceLease {
  timer: ReturnType<typeof setInterval>;
  /** 本轮最新的「最近一条真实用户消息」时间戳；续租时读它，不吃闭包里的陈旧值。 */
  lastUserMessageAt: number | null;
}

// charId → 心跳租约。同一 char 只保留一个 timer（重入只刷新 lastUserMessageAt）。
const chatPresenceLeases = new Map<string, ChatPresenceLease>();

/**
 * 实时感知配置（工具凭据）改动后，把云端的两份状态一起对齐。
 *
 * 云端有两份东西依赖这套凭据，必须同进同退：
 *   1. tool_config —— 凭据本身；
 *   2. fire_pack 里的系统提示词 —— 它是**按当时的配置裁剪过**的，没配的工具连说明都不注入
 *      （见 chatPrompts 的 notionEnabled / feishuEnabled / searchEnabled 门控）。
 *
 * 只更前者会留下一个窗口：云端提示词还在教角色用 Notion 日记，凭据已经被关掉了，角色到点
 * 照着旧提示词调工具，拿回 not_configured。所以两个动作合成一个入口，调用方无法只做一半。
 *
 * 谁需要刷新由 markAmsgStateDirty 内部的门决定（没开 2.0 / 没有待触发 AI 任务的角色直接
 * 忽略），所以这里可以无脑把全部角色递进来。
 */
export const syncAmsgToolConfigAndPrompts = (
  realtimeConfig: RealtimeConfig,
  scope: { characters: CharacterProfile[]; userProfile: UserProfile; groups: GroupProfile[] },
) => {
  // 上传失败不打断保存：本地配置已经生效，云端那份由 syncAmsgToolConfig 自己退避重传，
  // 传不上去也留着底账等下次启动补（fire_pack 那种「下一轮聊天顺手带上」的便车，
  // tool_config 是坐不了的——冲刷只传 fire_pack）。
  syncAmsgToolConfig(realtimeConfig);
  for (const char of scope.characters) {
    markAmsgStateDirty({ char, userProfile: scope.userProfile, groups: scope.groups, realtimeConfig });
  }
  void flushAmsgState('tool-config-change');
};

// ─── 工具凭据（tool_config）的重试与底账 ───
// fire_pack 每轮聊天都会重传，掉一次下一轮就补上；tool_config 不吃这条便车——它只在
// 用户保存配置那一刻传一次，那一次失败就再没有人会补。而它偏偏是有对外副作用的一份：
// 用户删掉的 MCP 服务器、换掉的 token，云端还是旧的，worker 半夜照旧带着旧凭据直连。
// 所以这里给它配上和 fire_pack 同款的退避重试 + localStorage 底账。

export const AMSG2_PENDING_TOOL_CONFIG_LS_KEY = 'amsg2_pending_tool_config';

/** 待上传的那份配置。undefined 也是合法载荷（= 什么都没配），所以另用 flag 表示「欠着」。 */
let pendingToolConfig: RealtimeConfig | undefined;
let hasPendingToolConfig = false;
let toolConfigSyncing = false;
let toolConfigRetryCount = 0;
let toolConfigRetryTimer: ReturnType<typeof setTimeout> | null = null;

const writeToolConfigMark = (pending: boolean) => {
  // 存储满 / 隐私模式写不进去就算了：底账只是给「重试没等到就被杀」兜底的。
  try {
    if (pending) localStorage.setItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY, '1');
    else localStorage.removeItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  } catch { /* 见上 */ }
};

const hasPersistedToolConfigMark = (): boolean => {
  try { return localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY) === '1'; } catch { return false; }
};

const runToolConfigSync = async (reason: string): Promise<void> => {
  if (!hasPendingToolConfig || toolConfigSyncing) return;
  toolConfigSyncing = true;
  // 记下这次传的是哪一份：上传期间用户又改了配置的话，清账不能把新的那份一起清掉。
  const snapshot = pendingToolConfig;
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) {
      // 没配 worker = 这份凭据没有去处，不是「传失败」，连底账一起清掉。
      hasPendingToolConfig = false;
      pendingToolConfig = undefined;
      writeToolConfigMark(false);
      return;
    }
    await ActiveMsgClient.syncToolConfig(snapshot);
    if (pendingToolConfig === snapshot) {
      hasPendingToolConfig = false;
      pendingToolConfig = undefined;
      writeToolConfigMark(false);
    }
    toolConfigRetryCount = 0;
  } catch (error) {
    if (toolConfigRetryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** toolConfigRetryCount;
      toolConfigRetryCount += 1;
      console.warn(`${HEADER} tool_config(${reason}) 上传失败，${Math.round(delay / 1000)}s 后重试（第 ${toolConfigRetryCount}/${MAX_RETRIES} 次）`, error);
      if (toolConfigRetryTimer != null) clearTimeout(toolConfigRetryTimer);
      toolConfigRetryTimer = setTimeout(() => { void runToolConfigSync('retry'); }, delay);
    } else {
      // 退避打光了（多半是离线）。底账留着：下次启动 / 下次冲刷继续补。
      console.error(`${HEADER} tool_config(${reason}) 连续 ${MAX_RETRIES} 次失败，云端仍是上一份工具配置（后台可能带着已被删掉的服务器或旧 token 调工具）`, error);
      toolConfigRetryCount = 0;
    }
  } finally {
    toolConfigSyncing = false;
  }
};

/**
 * 工具凭据上云的唯一入口（实时感知保存、MCP 配置变更、代理地址改动都走它）。
 * 立即传一次，失败退避重试，并在 localStorage 留底账等启动 / 下次冲刷补传。
 */
export const syncAmsgToolConfig = (realtimeConfig: RealtimeConfig | undefined): void => {
  pendingToolConfig = realtimeConfig;
  hasPendingToolConfig = true;
  toolConfigRetryCount = 0;
  if (toolConfigRetryTimer != null) { clearTimeout(toolConfigRetryTimer); toolConfigRetryTimer = null; }
  writeToolConfigMark(true);
  void runToolConfigSync('change');
};

// ─── 清空 Worker 地址前的收尾 ───

/**
 * 「Worker 地址被清空」的判定。
 *
 * 地址一空，前端这边的同步全停了，但 D1 里的任务还在：cron 每分钟照常消费、照烧 LLM
 * 照推送（推送订阅也还在），只是内容越来越对不上——用户以为自己关掉了一切，实际只是
 * 把自己变成了看不见的那一方。所以这一步不能静悄悄地存下去。
 */
export const isWorkerUrlCleared = (prevUrl: string | undefined, nextUrl: string | undefined): boolean =>
  Boolean(prevUrl?.trim()) && !nextUrl?.trim();

/**
 * 取消远端**全部**任务（清空 Worker 地址时用，此时还没换地址，读写的都是旧那台）。
 *
 * 尽力而为：逐条取消，单条失败记数继续跑完其余的；清单都读不到（网络 / 鉴权）就
 * 回 listed:false，交给调用方提示用户「远端可能还挂着」。
 */
export const cancelAllRemoteAmsgTasks = async (): Promise<{
  total: number; failed: number; listed: boolean;
}> => {
  let uuids: string[];
  try {
    uuids = (await ActiveMsgClient.listAllTasks())
      .map((task: { uuid?: unknown }) => task?.uuid)
      .filter((uuid): uuid is string => typeof uuid === 'string' && !!uuid);
  } catch (error) {
    console.warn(`${HEADER} 清空地址前读不到远端任务清单，无法确认还剩几条`, error);
    return { total: 0, failed: 0, listed: false };
  }
  let failed = 0;
  for (const uuid of uuids) {
    try { await ActiveMsgClient.cancelTask(uuid); } catch { failed += 1; }
  }
  return { total: uuids.length, failed, listed: true };
};

const writeChatPresence = (charId: string, lastUserMessageAt: number | null) => {
  const presence: AmsgChatPresence = {
    v: 1,
    charId,
    activeAt: Date.now(),
    lastUserMessageAt,
  };
  // 写入失败只 warn：心跳故障不能打断正常聊天，下一次 interval 继续尝试；远端 45s TTL 兜底。
  ActiveMsgClient.syncChatPresence(charId, presence).catch((error) => {
    console.warn(`${HEADER} 活跃会话租约写入失败（45s TTL 自然失效）`, error);
  });
};

/** 一轮真实用户消息进入生成流程时启动租约：立即写一次，之后每 15s 续租。 */
export const startAmsgChatPresence = (charId: string, lastUserMessageAt: number | null) => {
  writeChatPresence(charId, lastUserMessageAt);

  const existing = chatPresenceLeases.get(charId);
  if (existing) {
    // 已有 timer：只刷新本轮最新的 lastUserMessageAt，复用同一个心跳。
    existing.lastUserMessageAt = lastUserMessageAt;
    return;
  }

  const timer = setInterval(() => {
    // 切后台不再续租：一个闲置可见标签页不该无限续租；回前台下一轮真实消息重建。
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const lease = chatPresenceLeases.get(charId);
    if (!lease) return;
    writeChatPresence(charId, lease.lastUserMessageAt);
  }, CHAT_PRESENCE_HEARTBEAT_MS);
  chatPresenceLeases.set(charId, { timer, lastUserMessageAt });
};

/** 停止本地续租（不发「离线」写入，远端靠 45s TTL 自然失效）。 */
export const stopAmsgChatPresence = (charId: string) => {
  const lease = chatPresenceLeases.get(charId);
  if (lease) {
    clearInterval(lease.timer);
    chatPresenceLeases.delete(charId);
  }
};
