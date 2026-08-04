import { ActiveMsg2InboxMessage, ActiveMsg2TaskRecord, APIConfig, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ChatPrompts } from './chatPrompts';
import { ActiveMsgStore } from './activeMsgStore';
import { ActiveMsgClient } from './activeMsgClient';
import { AMSG_SELF_LOG_KEY, amsgStateNamespace, parseSelfLog } from './amsgFirePack';
import {
  applyAssistantPostProcessing,
  type PostProcessDirective,
  type XhsCaches,
} from './applyAssistantPostProcessing';
import { runPendingToolCalls } from './instantToolRunner';
import { drainPendingDiaries } from './pendingDiary';
import { applyEmotionEvalRaw } from './emotionApply';
import { CHAT_GEN_EVENTS } from './chatGenEvents';
import { processNewMessages } from './memoryPalace/pipeline';
import { loadMusicHooks } from '../context/MusicContext';
import type { XhsNote } from './realtimeContext';
import { appendDevDebugInstantPushLog, appendDevDebugLog, isCaptureEnabled, makeDebugLogger } from './devDebug';
import { notifyRoleEvent } from './runtime/roleEventNotification';
import { getLastRealUserMessageAt, shouldExpireFire } from './amsg2ExpireGuard';
import { pruneStaleTasks } from './amsg2Tasks';
import { appendInstantTraceEntry } from './instantTraceLog';
import { trackEvent } from './analytics';

// 同一个 category，两个 tag——保持 console 里现有的 [ActiveMsg] / [amsg] 标签，
// 方便用户 / 文档里 grep 历史报错信息。两条 tag 都归 instant-push 一类。
const log = makeDebugLogger('instant-push', 'ActiveMsg');
const logAmsg = makeDebugLogger('instant-push', 'amsg');

let initialized = false;

// 三写：console.info + 无条件 localStorage ring + 用户勾控的 devDebug。
// 参见 instantPushClient.instantTrace 的注释，两边设计一致。
function activeMsgTrace(event: string, details: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    sessionId: typeof details.sessionId === 'string' ? details.sessionId : undefined,
    event,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
    online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
    ...details,
  };
  try {
    console.info('[InstantTrace]', entry);
  } catch { /* ignore */ }
  appendInstantTraceEntry(entry);
  // 也挂进 devDebug 的 instant-push 类目：勾了 IP 后，trace 跟 LLM 交换日志一起被
  // 复制 / 下载导出。gate 由 isCaptureEnabled('instant-push') 自动管，未勾时零成本。
  appendDevDebugLog('instant-push', { label: `trace:${event}`, data: entry });
}

// ─── push 路径模块级 XHS 共享状态 ─────────────────────────────────────────────
//
// 本地 fetch 路径 useChatAI 用 useRef 持有 5 个 cache Map + 单次调用闭包的 lastXhsNotesRef.
// 生命周期 = useChatAI mount 期间 (刷页面 / 切角色 = 清). 跨多次 send / 跨工具调用都共享.
//
// Instant push 路径在 React 之外跑 (SW postMessage → activeMsgRuntime 监听器), 没 useRef.
// 改成模块级单例: 跟本地路径"应用打开期间共享, 刷页面就清"行为字节级对齐.
//
// 跨 round 共享是关键: runXhsBrowse (round 1, 在 instantToolRunner) 填充 lastXhsNotesRef →
// /continue → worker round 2 LLM 输出 [[XHS_SHARE: 序号]] → push 落库 → applyAssistantPostProcessing
// 读同一份 ref. 上一轮笔记列表跨 SW 唤醒不丢 (只要主进程没刷新).
//
// 主进程刷新 / 浏览器关闭 → 清空, 跟本地路径 useChatAI 重 mount 清 useRef 等价.
// 不写 IndexedDB — 行为与本地路径对齐, 不引入持久化代价.
export const pushXhsCaches: XhsCaches = {
  xsecTokenCache: new Map(),
  noteTitleCache: new Map(),
  commentUserIdCache: new Map(),
  commentAuthorNameCache: new Map(),
  commentParentIdCache: new Map(),
};
export const pushLastXhsNotesRef: { current: XhsNote[] } = { current: [] };

// 防穿帮闸·送达判定缓存：一次 fire 的多分段 push 必须同吞同放（不能吞一半），
// 按「任务 + occurrence」记住首段判定。Web Push/FCM 不保证分段按序到达，逻辑
// 上的最后一段可能最先到，所以不能在 messageIndex===totalMessages 时立即删除；
// 保留 5 分钟 TTL，让迟到分段仍复用同一决定。
// （导出仅为让 activeMsgRuntime.test.ts 用真实 TTL 校验重判边界，运行时不消费。）
export const EXPIRE_DECISION_TTL_MS = 5 * 60_000;
type ExpireDecisionEntry = { expired: boolean; expiresAt: number };
const expireDecisionByFire = new Map<string, ExpireDecisionEntry>();

/**
 * 送达判定的 get-or-compute（带 TTL 过期清扫）。从吞没闸里抽出来单测：
 *   - 同一 fireKey 的多次调用只 evaluate 一次——一次 fire 的多分段 push 同吞同放；
 *   - TTL 过后同 key 才允许重新 evaluate（迟到分段仍复用同一决定）。
 * cache 由调用方注入：运行时传模块级 expireDecisionByFire，测试传临时 Map 做隔离。
 * 行为与内联版逐字节对齐（先扫过期、再 get、缺失才 compute-and-set）。
 */
export async function resolveFireExpireDecision(
  cache: Map<string, ExpireDecisionEntry>,
  fireKey: string,
  now: number,
  evaluate: () => Promise<boolean>,
): Promise<boolean> {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  let cached = cache.get(fireKey);
  if (!cached) {
    cached = { expired: await evaluate(), expiresAt: now + EXPIRE_DECISION_TTL_MS };
    cache.set(fireKey, cached);
  }
  return cached.expired;
}

type MemoryPalaceGlobalConfig = {
  embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number };
  lightLLM: { baseUrl: string; apiKey: string; model: string };
};

/** 从 localStorage 读 memoryPalaceConfig — OSContext 同步存的是 os_memory_palace_config key */
const loadMemoryPalaceConfigFromLocalStorage = (): MemoryPalaceGlobalConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_memory_palace_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as MemoryPalaceGlobalConfig;
  } catch {
    return undefined;
  }
};

/** 从 localStorage 读 APIConfig (与 OSContext load 逻辑保持一致, 但这里在 React 之外跑) */
const loadApiConfigFromLocalStorage = (): APIConfig => {
  const fallback: APIConfig = { baseUrl: '', apiKey: '', model: '' };
  try {
    const raw = localStorage.getItem('os_api_config');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || '',
      apiKey: parsed.apiKey || '',
      model: parsed.model || '',
      ...parsed,
    };
  } catch {
    return fallback;
  }
};

/** 从 localStorage 读 RealtimeConfig — 整个 push 路径里我们不会再回连 LLM, 但 ChatParser
 *  及 DIARY 写入(可执行的副作用)需要这些配置, 缺失时返回 undefined 让消费方走 fallback。 */
const loadRealtimeConfigFromLocalStorage = (): RealtimeConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_realtime_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as RealtimeConfig;
  } catch {
    return undefined;
  }
};

/**
 * 用 applyAssistantPostProcessing 把 push 收到的 inbox message 走一遍 13 步管线。
 * skipSecondPassLLM=true: 不回连 LLM (worker 现在还没续跑能力, Phase 2 才解决),
 * 二轮标签 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*) 留在
 * 原文里, 由 ChatParser.sanitize 等步骤兜底剥掉。
 * 副作用类标签 (POKE / TRANSFER / ADD_EVENT / schedule_message / 写日记) 仍会执行。
 * 失败时抛出, 由调用方决定是否重新入队。
 */
/**
 * 取回 worker 旁路存下的 XHS 会话数据（push 装不下时才有，见 offloadOversizedPush）。
 * 落库成功后顺手把云端那份删掉——每任务固定一个键、下次触发会覆盖，及时删只是让
 * D1 更干净，删不掉也不影响正确性。
 *
 * 取不回来就抛错：调用方会把这条消息压回收件箱重试，而不是发一条「说分享了却没有卡片」
 * 的消息出去。
 */
const fetchOffloadedXhsSession = async (message: ActiveMsg2InboxMessage): Promise<any | null> => {
  const ref = (message.metadata as any)?.xhsSessionRef;
  if (typeof ref !== 'string' || !ref) return null;

  const namespace = amsgStateNamespace(message.charId);
  const raw = await ActiveMsgClient.readClientStateValue(namespace, ref);
  if (raw == null) {
    // 键不在了：同任务的下一次触发已经把它覆盖/清掉了，这条 push 是迟到的老消息。
    // 重试也取不回来，按「没有卡片数据」继续——比卡在收件箱里反复重试强。
    log.warn('旁路存储里没有这份 XHS 会话数据（多半被下一次触发覆盖了）', { ref, charId: message.charId });
    return null;
  }

  const parsed = JSON.parse(raw);
  void ActiveMsgClient.clearClientStateValue(namespace, ref)
    .catch((e) => log.warn('清空旁路存储失败（下次触发会覆盖，不影响正确性）', { ref, error: e }));
  return parsed;
};

/**
 * 角色在本地已经不存在了：删角色时远端取消失败留下的残留，或者导入备份之后 id 对不上。
 * 与「暂时读不到」区分开——这种重试多少次都没用，得去把远端那条还在到点跑的任务取消掉。
 */
export class OrphanedCharacterError extends Error {
  constructor(readonly charId: string) {
    super(`character not found for charId=${charId}`);
    this.name = 'OrphanedCharacterError';
  }
}

/** 处理失败重试几次后放弃（放弃 = 退回存原稿保底，见 resolveInboxFailureAction）。 */
export const MAX_INBOX_PROCESS_ATTEMPTS = 3;

export type InboxFailureAction = 'orphan' | 'retry' | 'degrade';

/**
 * 一条 push 处理失败之后该怎么办。
 *
 * 默认是**留着重试**而不是就地存原稿：原稿里的表情 / 卡片 / 转账都还是标记形态，存进
 * 聊天记录后渲染层会把标记剥掉，用户看到的是残缺版，而角色下一轮读历史却会当成
 * 「我已经发过表情、转过账了」——一次暂时的故障就这么变成永久的错误前提。
 * 本地存储的故障通常是暂时的，等一会儿重来一遍就好。
 *
 * 重试到上限还不行，才退回存原稿：那时候多半是真坏了，让用户看到残缺版也好过什么都没有。
 */
export const resolveInboxFailureAction = (
  error: unknown,
  attempts: number,
): InboxFailureAction => {
  if (error instanceof OrphanedCharacterError) return 'orphan';
  return attempts < MAX_INBOX_PROCESS_ATTEMPTS ? 'retry' : 'degrade';
};

/**
 * 已经落库的、属于这条 push 的助手消息。
 *
 * 后处理是逐条落库的（十几处 DB.saveMessage），中途失败时前面几条已经在聊天记录里了。
 * 重试是整条从头再跑，不先把这些清掉就会写重——而重复进了聊天记录是永久的。
 * 认领的依据是每条气泡都继承的 metadata.activeMsg2.messageId（每条 push 唯一，
 * 见 processInboxMessageWithPostProcessing 的 mcdInheritMeta）。
 */
export const findInboxArtifacts = <T extends { role: string; metadata?: any }>(
  messages: T[],
  messageId: string,
): T[] => messages.filter((m) =>
  m.role === 'assistant' && m.metadata?.activeMsg2?.messageId === messageId);

/**
 * 清场时可以删的消息类型——只有「渲染型气泡」：正文、表情包、HTML 卡片。
 *
 * 副作用产物（转账卡 / 戳一戳 / 音乐卡 / 新闻卡 / 日程提示 / 生活卡 / 小红书卡…）一律
 * 留在原地：重试那一趟压根不会再产一遍（副作用要么随 directives 走、本轮不重放，要么像
 * XHS 那样被 disabledXhsSideEffects 关掉），删了就是永久少一张卡——而钱和日程是真的。
 *
 * 白名单制，将来新增的类型默认按「不删」处理：宁可重复一条气泡，也不凭空删掉一张卡。
 */
export const PURGEABLE_ARTIFACT_TYPES: ReadonlySet<string> = new Set(['text', 'emoji', 'html_card']);

/**
 * 把这条 push 上一趟写下的**渲染型气泡**从聊天记录里删掉。
 *
 * 返回两个数，别混为一谈：
 *   - removed：这次真删了几条（只数渲染型气泡）；
 *   - evidence：上一趟到底有没有留下过东西（连副作用产物一起数）。副作用要不要重放看它。
 */
export const purgeInboxArtifacts = async (
  message: ActiveMsg2InboxMessage,
): Promise<{ removed: number; evidence: number }> => {
  const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
  const stale = findInboxArtifacts(recent, message.messageId);
  const purgeable = stale.filter((m) => PURGEABLE_ARTIFACT_TYPES.has(m.type));
  if (purgeable.length > 0) await DB.deleteMessages(purgeable.map((m) => m.id));
  return { removed: purgeable.length, evidence: stale.length };
};

/**
 * 重试前的清场：把上一次跑到一半写进去的气泡删掉，并告诉调用方副作用还要不要重放。
 *
 * 后处理的顺序是「先跑副作用（转账 / 加日程 / 戳一戳 / 排程），再渲染气泡」，
 * 所以**只要看到上一趟留下的任何一条消息，就说明副作用那一步上次已经整段跑完了**。
 * 这时重放等于转两次账、加两次日程，比丢内容严重得多——所以这一趟只补渲染，不带 directives。
 * 一条都没留下才说明上次死在副作用途中，那时 directives 还得照常带上，
 * 否则这条消息的副作用就彻底没了。
 *
 * 「凭据」和「删除对象」是两回事：副作用产物（转账卡等）算凭据但不删——它们跟正文气泡
 * 带着同一个 activeMsg2.messageId，删掉又不重放的话，那张卡就永远回不来了。
 */
const prepareInboxRetry = async (
  message: ActiveMsg2InboxMessage,
): Promise<{ replayDirectives: boolean }> => {
  if (!(message.processAttempts && message.processAttempts > 0)) return { replayDirectives: true };
  const { removed, evidence } = await purgeInboxArtifacts(message);
  if (evidence === 0) return { replayDirectives: true };
  log.warn('重试前清掉上次写了一半的气泡（副作用上次已跑完，本轮不重放，产物留在原地）', {
    messageId: message.messageId,
    removed,
    evidence,
  });
  return { replayDirectives: false };
};

const processInboxMessageWithPostProcessing = async (
  message: ActiveMsg2InboxMessage,
  // 由 flushInboxToChat 按 resolveInboxPersistTimestamp 算好: 离线补收 = sentAt,
  // 在线送达 = undefined (落库走 DB.saveMessage 默认的写库当刻)。
  persistTimestamp?: number,
): Promise<void> => {
  const characters = await DB.getAllCharacters();
  const char = characters.find(c => c.id === message.charId);
  if (!char) {
    // 一个角色都读不到，多半是本地存储本身出了问题，而不是「这个角色被删了」——
    // 按可重试的普通失败处理，别把还在用的任务当孤儿取消掉。
    if (characters.length === 0) {
      throw new Error(`character lookup returned empty for charId=${message.charId}`);
    }
    throw new OrphanedCharacterError(message.charId);
  }

  // 这是不是一次重试？是的话先清掉上次的半成品，并决定副作用要不要再跑一遍。
  const { replayDirectives } = await prepareInboxRetry(message);

  const userProfile: UserProfile = (await DB.getUserProfile())
    ?? { name: 'User', avatar: '', bio: '' };
  // 按角色可见性过滤表情包：后处理落库时靠 emojis.find(e => e.name === name) 反查 URL，
  // 若传全量表情，名字冲突时会把 A 的 [[SEND_EMOJI: x]] 匹配到 B 名下的同名表情，导致
  // A 发出绑定给 B 的表情包。本地聊天路径喂的是 aiVisibleEmojis（已过滤），主动消息路径
  // 之前漏了这步，这里复用同一套过滤收口（与 activeMsgClient.buildCompletePrompt 对齐）。
  const { emojis } = ChatPrompts.filterVisibleEmojis(
    await DB.getEmojis(),
    await DB.getEmojiCategories(),
    message.charId,
  );
  const contextMsgs = await DB.getRecentMessagesByCharId(message.charId, 200);

  const apiConfig = loadApiConfigFromLocalStorage();
  const realtimeConfig = loadRealtimeConfigFromLocalStorage();

  // Phase 1: 副作用 (DIARY 写入等) 会调 DB.saveMessage, 它内部已经 fire 'messages-updated' 事件;
  // 但 OSContext 真正驱动 chat UI 重新 reloadMessages 的是 lastMsgTimestamp, 而那个 state 现在
  // 只由 'active-msg-received' handler 改。为了让 push 路径下的 per-chunk 落库也立刻反映到 UI,
  // 用一个独立的 side-channel 事件 'active-msg-progress': OSContext 监听它后只 setLastMsgTimestamp,
  // 不 fire toast / 不增加未读 / 不 resolve sendInstantPush 的 one-shot promise。
  // 单条 inbox message 进来时 fire 一次 'active-msg-received' 即可保证 toast / 未读 / 通知一次发生。
  const dispatchProgress = () => {
    window.dispatchEvent(new CustomEvent('active-msg-progress', {
      detail: { charId: message.charId },
    }));
  };

  // Phase 2 Round 2: 如果 worker 自动发的 ReasoningPush 已经被 SW 写到 reasoning_buffer,
  // 在处理"这个 sessionId 的第一条 content"时把 reasoning_content 反取出来挂到 ctx, 让 thinking
  // chain 卡片渲染到第一条 assistant message 的 metadata.thinkingChain.
  // Round 1 worker 在 0.6 one-shot 时不发 reasoning push, claimReasoning 始终返回 null — 无副作用.
  // messageIndex 来源: SW 在 saveContentToInbox 把 payload.messageIndex 写到 metadata. Round 2
  // worker 用 1-based (buildContentPush 第 1 条 → messageIndex=1); 老 worker 没这个字段, ?? 0 fallback.
  // 只对 first content claim (避免 N 条 push 同 session 时重复读 / 第 2 条挂错 metadata).
  const sessionId: string | undefined = (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
  const messageIndex: number = (message as any).messageIndex
    ?? (message.metadata && (message.metadata as any).messageIndex)
    ?? 0;
  let reasoningContent: string | undefined;
  if (sessionId && messageIndex <= 1) {
    try {
      const buffered = await ActiveMsgStore.claimReasoning(sessionId);
      reasoningContent = buffered?.reasoningContent;
    } catch (e) {
      console.warn('[ActiveMsg] claimReasoning failed', sessionId, e);
    }
  }

  // amsg2 满血 v2: round 1 的 XHS 工具在 worker 里跑, 客户端没有 instantToolRunner 那次
  // saveXhsSessionNotes 落库. worker 把 directive 引用到的笔记/xsecToken 随最后一条 push 的
  // metadata.xhsSession 带回来 (稀疏 {idx, note}, idx 1-based, 见 worker/amsg/src/agentic.ts
  // buildXhsSessionPayload), 这里重建成按序号取卡的数组先落库, 下面的恢复块照旧读回内存单例
  // ——与 instant 路径共用同一条恢复路, XHS_SHARE / 点赞 / 评论重放不再 available:0.
  // 装不进一条 push（4KB 密文上限）的时候 worker 会把整份挪进 client_state、只在
  // metadata 留一个 xhsSessionRef 指过来（见 worker/amsg/src/index.ts 的
  // offloadOversizedPush）。这里按键取回，取到就跟内联那份走同一条落库路径。
  // 取不回来时抛错交给上层重试——静默跳过的话，角色说分享了几张、卡片却少几张。
  const xhsSession = (message.metadata && (message.metadata as any).xhsSession)
    || await fetchOffloadedXhsSession(message);
  if (sessionId && xhsSession && Array.isArray(xhsSession.notes) && xhsSession.notes.length > 0) {
    try {
      const maxIdx = Math.max(...xhsSession.notes.map((e: any) => Number(e?.idx) || 0));
      const rebuilt: Array<XhsNote | null> = new Array(Math.max(0, maxIdx)).fill(null);
      for (const entry of xhsSession.notes) {
        const i = Number(entry?.idx);
        if (Number.isInteger(i) && i >= 1 && entry?.note) rebuilt[i - 1] = entry.note as XhsNote;
      }
      await ActiveMsgStore.saveXhsSessionNotes(sessionId, {
        notes: rebuilt as XhsNote[],
        xsecTokens: Array.isArray(xhsSession.xsecTokens) ? xhsSession.xsecTokens : [],
      });
    } catch (e) {
      console.warn('[ActiveMsg] persist xhsSession from push failed', sessionId, e);
    }
  }

  // 恢复本 session round 1 工具抓到的 XHS 笔记: instantToolRunner 落了库, 这里读回内存单例.
  // 跨 SW 唤醒 / 页面回收后内存 ref 被清空, 不恢复的话 round 2 的 [[XHS_SHARE]] / 评论 / 点赞
  // 会因 lastXhsNotesRef 为空而静默掉卡片. 持久化优先于内存 (同 session 时两者等价, 重载后只剩持久化).
  if (sessionId) {
    try {
      const persisted = await ActiveMsgStore.getXhsSessionNotes(sessionId);
      if (persisted?.notes?.length) {
        pushLastXhsNotesRef.current = persisted.notes as XhsNote[];
        for (const [noteId, token] of (persisted.xsecTokens || [])) {
          pushXhsCaches.xsecTokenCache.set(noteId, token);
        }
      }
    } catch (e) {
      console.warn('[ActiveMsg] restore xhs session notes failed', sessionId, e);
    }
  }

  await applyAssistantPostProcessing(message.body || '', {
    char,
    userProfile,
    emojis,
    realtimeConfig,
    contextMsgs,
    // fullMessages / initialData: worker 不会传过来 (Phase 2 才有续跑), 二轮 LLM 又被关掉,
    // 这两个字段在 skipSecondPassLLM=true 时实际上不会被消费; 给个最小占位避免 undefined NPE。
    fullMessages: [],
    initialData: null,
    historyMsgCount: contextMsgs.length,
    // 把 source / activeMsg2 元数据通过 mcdInheritMeta 继承到每条 assistant message, 这样
    // UI 还能区分 "这条是 push 来的"。
    mcdInheritMeta: {
      source: 'active_msg_2',
      activeMsg2: {
        messageId: message.messageId,
        taskId: message.taskId,
        messageType: message.messageType,
        messageSubtype: message.messageSubtype,
        avatarUrl: message.avatarUrl,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
      },
      ...(message.metadata || {}),
    },
    xhsCaches: pushXhsCaches,
    lastXhsNotesRef: pushLastXhsNotesRef,
    api: {
      baseUrl: apiConfig.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiConfig.apiKey ? { Authorization: `Bearer ${apiConfig.apiKey}` } : {}),
      },
      // effectiveApi 在 push 路径里没人读 — skipSecondPassLLM=true 把所有二轮 LLM 入口都堵了。
      // 留着只为满足 ctx 类型形状; Phase 2 worker 走续跑时也不会让客户端再发 LLM 请求, 所以这里
      // 长期就是个空架子, 不要花精力同步 os_api_presets / os_available_models 等运行时切换。
      effectiveApi: {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
      },
    },
    hooks: {
      // setMessages 在 React 外面跑, 没法直接 setState, 只 fire 一次 progress 事件让
      // OSContext 推 lastMsgTimestamp, 然后 Chat.tsx 自然 reloadMessages 重新读库。
      setMessages: () => { dispatchProgress(); },
      // push 路径 deliberately 静默 toast — 避免在用户没在 chat 这个角色时狂弹 toast。
      // 如果真要给用户可见反馈, 应该走 'active-msg-received' 那条线 (toast / 未读 / 通知)。
      addToast: (msg: string, type: 'info' | 'success' | 'error') => {
        console.log('[push:toast]', type, msg);
      },
      // musicHooks: 由 MusicProvider 注册到模块级 slot, 与 useChatAI 同一份, 见 MusicContext.loadMusicHooks.
      // slot 未填充时 (理论上 MusicProvider 未 mount, 实际单页应用不会发生) 退化为 undefined,
      // ChatParser 会静默丢弃 MUSIC_ACTION 标签 — 跟 Phase 1 老行为兜底一致, 不会引入新 failure mode.
      // 注意 snapshot 时序: 这里读取的是 push 送达时的 current song, 而不是 AI 当时看到的那帧.
      // 本地 fetch 路径也有相同窗口 (LLM 响应耗时内 current 可能漂移), 接受同一 trade-off.
      musicHooks: loadMusicHooks() ?? undefined,
    },
    skipSecondPassLLM: true,
    // 把 worker hook 塞进 metadata.directives 的副作用结构化重放出来 (POKE/TRANSFER/ADD_EVENT/
    // schedule_message/MUSIC_ACTION/XHS_*). applyAssistantPostProcessing 会反向拼回 tag 喂给
    // chatParser + 内联 XHS handler.
    // amsg-instant 0.8+ 一个 user turn 可能产 N 条 push, directives 只应该
    // replay 一次. worker buildPushDecision 把 directives 挂在最后一条 push 上,
    // 这里加 isLastChunk 守卫双保险, 防未来 worker bug 在多条 push 都塞 directives.
    // 老 worker (无 messageIndex/totalMessages 字段) ?? 0 fallback, 0===0 也算 last.
    // replayDirectives=false = 这是重试、且上次已经把副作用跑完了（见 prepareInboxRetry）。
    directives: replayDirectives && isLastChunk(message) ? extractDirectives(message) : [],
    reasoningContent,
    // 这条 push 拆出的每条气泡共用一个时间戳 (跟降级存原稿路径同口径), 见
    // resolveInboxPersistTimestampForMessage。
    messageTimestamp: persistTimestamp,
    // 补收的消息跳过拟人打字延迟, 一次性回填: 内容几小时前就在云端生成完了, 再一条条
    // 慢放只会让用户干等, 期间他插的话还会把时间戳倒挂的口子撑开。实时收到的照旧慢放。
    instantRender: !isFreshInboxDelivery(message.receivedAt, Date.now()),
  });

  // ─── Phase 2 Round 2 (2f): push 尾段 ───
  // Memory Palace 缓冲区处理仍在这里 (跟本地 fetch 路径 finally 段对齐, 不依赖 React).
  // 情绪评估**不再这里跑** — push-tail 用 char.systemPrompt + 50 条聊天的 degraded ctx,
  // 会污染 useChatAI line 613 用 full ctx 算的 buff 状态. 改为 Option B:
  //   - 写一条 pending 标记到 KV (charId → lastPushMsgId)
  //   - dispatch 'post-push-emotion-eval' 事件
  //   - useChatAI listener 接 (char.id 匹配时) → 用当前 React state 调 buildChatRequestPayload
  //     重建 full ctx → evaluateEmotionBackground → setEvolvedNarrative + DB.saveCharacter
  //   - useChatAI mount 时 useEffect 兜底 drain (应用关 / 切其他 char 期间 push 累积的)
  // 见 hooks/useChatAI.ts 的 'post-push-emotion-eval' useEffect.
  await runPushTailPipeline(message, char, userProfile);
};

/**
 * 这条 inbox message 是不是它所在 session 的**最后一条 chunk**.
 * messageIndex == totalMessages → 最后一条 ✓
 * 都缺失 (老 worker / proactive push 单 push) → 0 === 0 也认 last
 */
function isLastChunk(message: ActiveMsg2InboxMessage): boolean {
  const mi = Number(message.metadata?.messageIndex ?? 0);
  const tm = Number(message.metadata?.totalMessages ?? 0);
  return mi === tm;
}

/**
 * 送达时的作废判定（防穿帮闸·客户端兜底层）。worker onBeforeFire 已做同一
 * 判定，但它读的 fire_pack 随 amsgStateSync 最多滞后 15s+，且判定通过后还有
 * 10-30s 生成窗口，期间用户又说话就会撞车——这里用本地全量历史再判一次。
 * 判定所需字段全部来自 push 自己带的，不依赖本地 config——push 在途期间任务被 renew
 * 换锚也不会误判。其中 recurrenceType / occurrenceMs 读 push 顶层那份（库盖的，两条
 * 排程路径同源）；策略与锚点是应用自己的语义，仍在任务 metadata 里。
 *
 * **读不到聊天记录时抛错，不猜。** 拿不准就先别开口：调用方会把消息压回收件箱、
 * 过一会儿等本地存储缓过来再判一次（见 flushInboxToChatImpl 的 expire-unknown 分支）。
 * 猜「放行」的代价是角色可能当着正在聊天的用户冒出一句定时问候，一眼假。
 */
async function evaluateScheduledPushExpired(message: ActiveMsg2InboxMessage): Promise<boolean> {
  const meta = (message.metadata || {}) as Record<string, any>;
  const messages = await DB.getRecentMessagesByCharId(message.charId, 200);
  return shouldExpireFire({
    policy: meta.amsgExpirePolicy,
    recurrenceType: message.recurrenceType ?? undefined,
    anchorMs: meta.amsgAnchorMs,
    lastUserMessageAt: getLastRealUserMessageAt(messages),
    nowMs: Date.now(),
    // 循环任务的窗口锚定到点时刻而不是送达时刻：生成+送达可能比到点晚十几分钟，
    // 拿 Date.now() 算 10 分钟窗会把撞上对话的消息误放行。
    occurrenceMs: message.occurrenceMs ?? undefined,
  });
}

/**
 * 云端自述日志里这条 push 对应的条目 id。
 *
 * 格式跟 worker 写日志时用的那一份对齐（`<clientTaskId>@<触发时刻>`，见 amsgFirePack
 * 的 AmsgSelfLogEntry.id 与 worker/amsg/src/index.ts 的 amsgFireSettled）——两边拼法
 * 必须一模一样，差一个字符就对不上号。缺任务归属键时 worker 用的是字面量 'task'。
 * 触发时刻缺失（老 push 不带）返回 null：没有 id 就没法精确认领，宁可不动。
 */
export const buildSelfLogEntryId = (message: ActiveMsg2InboxMessage): string | null => {
  const occurrenceMs = message.occurrenceMs;
  if (typeof occurrenceMs !== 'number' || !Number.isFinite(occurrenceMs)) return null;
  const clientTaskId = (message.metadata as any)?.amsgClientTaskId;
  const owner = typeof clientTaskId === 'string' && clientTaskId ? clientTaskId : 'task';
  return `${owner}@${occurrenceMs}`;
};

/**
 * 被兜底闸吞掉的这条，顺手把云端「我说过什么」里对应的那条也撤掉。
 *
 * 不撤的话：worker 发完就把正文记进了 client_state 的 self_log，而这条消息在客户端被吞、
 * 用户一个字都没看到；下一次到点的 prompt 里【这之后你又主动发过】赫然列着它，角色接着
 * 往下说一句没人看过的话。
 *
 * 只摘被吞的那一条，其余原样留着：日志里别的条目是用户真收到过的话，跟着一起抹掉的话
 * 角色反而会把说过的再说一遍；角色自排的任务清单同理，缺一块下次就会把同一件事再排一遍。
 * 摘完整份空了（没有条目也没有任务）就直接写空串——空日志和没有日志对 worker 是同一件事
 * （parseSelfLog 拿不到 → 重新建一份空的），比留一份空壳 JSON 省事。
 *
 * 值是裸 JSON，跟 worker 写这份时的口径一致（amsgFireSettled 里也是 JSON.stringify 直传，
 * 不走 fire_pack 那套压缩）。
 *
 * best-effort：读写失败只留 warn，不影响「吞」这个动作本身（与 worker 侧 writeLastSkip 同语义）。
 */
export const revokeSwallowedSelfLogEntry = async (
  charId: string,
  entryId: string,
): Promise<'no-log' | 'not-found' | 'cleared' | 'rewritten'> => {
  const namespace = amsgStateNamespace(charId);
  const raw = await ActiveMsgClient.readClientStateValue(namespace, AMSG_SELF_LOG_KEY);
  const selfLog = parseSelfLog(raw ?? '');
  if (!selfLog) return 'no-log';
  if (!selfLog.entries.some((e) => e.id === entryId)) return 'not-found';

  const rest = selfLog.entries.filter((e) => e.id !== entryId);
  if (rest.length === 0 && selfLog.tasks.length === 0) {
    await ActiveMsgClient.clearClientStateValue(namespace, AMSG_SELF_LOG_KEY);
    return 'cleared';
  }
  await ActiveMsgClient.writeClientStateValue(
    namespace,
    AMSG_SELF_LOG_KEY,
    JSON.stringify({ ...selfLog, entries: rest }),
  );
  return 'rewritten';
};

/**
 * 认领到新任务之后广播的事件名。detail 只带 charId，监听方（OSContext）自己重读角色、
 * 把新任务合并进内存清单并打脏。事件名和 detail 形状是两侧的约定，改这里要同步改那边。
 */
export const AMSG2_TASKS_ADOPTED_EVENT = 'amsg2-tasks-adopted';

/**
 * 把 worker 带回来的「角色自排任务」补进该角色的本地清单。
 *
 * 幂等: 同 uuid 已经在清单里就不重复加(同一条 push 重放、或者 fire 重跑发了两次都可能撞上).
 * best-effort: 写不进去不影响这条消息本身——任务在远端好好的, 下次面板拉远端清单还能看见,
 * 只是这一刻本地少一行. 为它抛错会把已经收到的消息一起搞挂.
 *
 * 落库之后要广播一声: 这里跑在 React 之外, 只写 IndexedDB 的话内存里那份角色清单还是旧的,
 * 任务面板列不出这条、按任务数 / 凭据 / 订阅这几道门做判断的地方也都看不见它。
 */
async function adoptSelfScheduledTasks(message: ActiveMsg2InboxMessage): Promise<void> {
  const incoming = (message.metadata as any)?.amsgSelfScheduled;
  if (!Array.isArray(incoming) || incoming.length === 0) return;
  const charId = (message.metadata as any)?.charId;
  if (typeof charId !== 'string' || !charId) return;

  try {
    const char = (await DB.getAllCharacters()).find((c) => c.id === charId);
    if (!char) return;
    const existing = char.activeMsg2Config?.tasks ?? [];
    const known = new Set(existing.map((t: ActiveMsg2TaskRecord) => t.taskUuid));
    const added = incoming.filter((t: any) => t?.taskUuid && !known.has(t.taskUuid));
    if (added.length === 0) return;

    await DB.saveCharacter({
      ...char,
      activeMsg2Config: {
        ...(char.activeMsg2Config ?? { enabled: true }),
        tasks: pruneStaleTasks([...existing, ...added], Date.now()),
      },
    });
    console.log('[ActiveMsg] 认领角色自排任务', added.map((t: any) => t.taskUuid));
    // 只在真的新增了任务时才广播（上面 added.length === 0 已经提前 return），
    // 免得同一条 push 重放时白白让 UI 重读一遍角色。
    try {
      window.dispatchEvent(new CustomEvent(AMSG2_TASKS_ADOPTED_EVENT, { detail: { charId } }));
    } catch { /* SSR-safe / not browser, ignore */ }
  } catch (e) {
    console.warn('[ActiveMsg] adopt self-scheduled tasks failed', charId, e);
  }
}

/** 把 worker 推给的 directives 从 inbox message metadata 里挖出来; 没有就空数组. */
function extractDirectives(message: ActiveMsg2InboxMessage): PostProcessDirective[] {
  const raw = message.metadata && (message.metadata as any).directives;
  if (!Array.isArray(raw)) return [];
  // 字段形状由 worker classifier 保证 (跟 PostProcessDirective union 一致); 这里只做轻量校验
  // 防 metadata 被改坏. 不识别的 type 不抛错, applyAssistantPostProcessing 内部 default 分支会 warn.
  return raw.filter((d) => d && typeof d === 'object' && typeof (d as any).type === 'string');
}

function getInstantSessionId(message: ActiveMsg2InboxMessage): string | undefined {
  return (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
}

function getInstantMessageIndex(message: ActiveMsg2InboxMessage): number {
  return Number((message as any).messageIndex ?? (message.metadata as any)?.messageIndex ?? 0);
}

function getInstantTotalMessages(message: ActiveMsg2InboxMessage): number {
  return Number((message as any).totalMessages ?? (message.metadata as any)?.totalMessages ?? 0);
}

function toChatCompletionsUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || '').trim();
  if (!trimmed) return 'instant-push';
  if (/\/chat\/completions\/?$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/, '')}/chat/completions`;
}

async function logInstantPushLlmExchange(message: ActiveMsg2InboxMessage): Promise<void> {
  if (!isCaptureEnabled('instant-push')) return;

  const sessionId = getInstantSessionId(message);
  if (!sessionId) return;

  try {
    const session = await ActiveMsgStore.getOutboundSession(sessionId);
    appendDevDebugInstantPushLog({
      url: toChatCompletionsUrl(session?.apiCredentials?.baseUrl),
      method: 'POST',
      status: 200,
      requestBody: session
        ? {
            transport: 'instant-push',
            sessionId,
            model: session.apiCredentials.model,
            messages: session.messages,
          }
        : {
            transport: 'instant-push',
            sessionId,
            requestUnavailable: 'outbound session not found',
          },
      response: {
        transport: 'instant-push',
        sessionId,
        messageId: message.messageId,
        messageIndex: getInstantMessageIndex(message),
        totalMessages: getInstantTotalMessages(message),
        raw_content: message.body,
        metadata: message.metadata,
      },
    });
  } catch (e) {
    console.warn('[DevDebug] instant-push LLM log failed', sessionId, e);
  }
}

/**
 * 跑 push 路径的尾段: Memory Palace 缓冲区处理 + 情绪 eval pending 标记.
 *
 * Memory Palace 直接在这里跑 (pipeline 内部 self-contained, 不依赖 React state).
 * 情绪评估走 Option B:
 *   - 写 KV pending 标记 (charId → lastPushMsgId); 用户切回这个 chat 时 useChatAI useEffect drain
 *   - 同时 dispatch 'post-push-emotion-eval' 事件; 如果 useChatAI 已 mount 这个 char 就立即跑
 *   - 不管在线/离线, eval 最终用 useChatAI 内 buildChatRequestPayload 的 full ctx 跑 — 不再 degraded.
 */
async function runPushTailPipeline(
  message: ActiveMsg2InboxMessage,
  char: import('../types').CharacterProfile,
  userProfile: UserProfile,
): Promise<void> {
  // 1. Memory Palace
  const mpConfig = loadMemoryPalaceConfigFromLocalStorage();
  const mpEmb = mpConfig?.embedding;
  const mpLLMConfigured = mpConfig?.lightLLM;
  const apiConfig = loadApiConfigFromLocalStorage();
  const mpLLM = (mpLLMConfigured?.baseUrl)
    ? mpLLMConfigured
    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };

  if ((char as any).memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
    try {
      const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
      // fire-and-forget: pipeline 内部有并发锁 + 水位线检查, 不会抢着跑两份
      void processNewMessages(
        recentMsgs,
        char.id,
        char.name,
        mpEmb,
        mpLLM,
        userProfile?.name || '',
        false,
        (stage) => { console.log('[push:memory-palace]', stage); },
      ).catch((e) => {
        console.warn('[push:memory-palace] processNewMessages failed', e);
      });
    } catch (e) {
      console.warn('[push:memory-palace] tail kickoff failed', e);
    }
  }

  // 2. 情绪评估 — 已迁到 worker (副 API): worker 跑完主回复后跑 eval, 推 emotion_update push,
  // flushInboxToChat 看到 messageType==='emotion_update' 调 applyEmotionEvalRaw 落 buff.
  // 所以这里不再触发客户端 eval (否则 worker + 客户端双跑双扣费). 见 worker/instant-push + useChatAI.

  // 顺手通过 message 触发 'emotion-updated' (跟 useChatAI line 382 一致), 让 UI 重新读 char.
  // 注意: 这里的 emotion-updated 是给 ChatHeader 的 buff 显示信号, 不是情绪 eval 完成信号 —
  // 真正的 eval 完成由 useChatAI 内 evaluateEmotionBackground 自己 dispatch 同名事件.
  try {
    window.dispatchEvent(new CustomEvent('emotion-updated', { detail: { charId: char.id } }));
  } catch { /* SSR-safe / not browser, ignore */ }
}

/**
 * 「刚送达」与「补收」的分界（毫秒），只用来决定**要不要慢放拟人打字节奏**。
 *
 * 后处理管线每条气泡之间夹 0.5~2 秒 setTimeout，模拟角色正在打字。实时收到时这是对的；
 * 补收的消息早在几小时前就在云端生成完了，再慢放一遍只会让用户干等着一条条冒，
 * 而且这段时间里用户来得及插话，把时间戳倒挂的口子撑开（见 resolveBackfillTimestamp）。
 *
 * 取 2 分钟：前台连收几条排队处理最多几十秒，仍算刚到；而「看到通知再点进来」通常
 * 好几分钟起步，会落到补收那一侧。
 */
export const INBOX_FRESH_DELIVERY_WINDOW_MS = 2 * 60_000;

/**
 * 这条 inbox 消息是不是刚落到设备上的（true = 保留打字节奏，false = 一次性回填）。
 *
 * 判据用 receivedAt（消息落到这台设备的时刻）而不是 sentAt：它剔除了云端到设备之间的
 * 网络延迟，问的正是「这条在收件箱里躺了多久没人消费」。receivedAt 缺失/非法时按刚到
 * 处理——宁可多慢放一条补收的，也别把用户正看着的实时消息一次性刷出来。
 * 纯函数，边界值见 activeMsgRuntime.test.ts。
 */
export const isFreshInboxDelivery = (
  receivedAt: number | undefined,
  now: number,
): boolean => {
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) return true;
  return now - receivedAt <= INBOX_FRESH_DELIVERY_WINDOW_MS;
};

/**
 * 算一条 inbox 消息落库该用的时间戳：一律取 sentAt（云端真正把这句话发出去的那一刻）。
 * 返回 undefined = 不指定，走 DB.saveMessage 默认的写库当刻（Date.now()）。
 *
 * 为什么不按「消息够不够新」二选一：那个判据回答不了「用户在不在场」——到点弹的通知，
 * 用户隔几分钟才点进来，消息就会被标成他点进来的那一刻。而在线送达时 sentAt 距落库
 * 只有几秒，标 sentAt 一样显示「刚刚」，观感没有差别。
 *
 * 标 sentAt 不会打乱聊天流的顺序：气泡位置只看自增 id（db.ts 按 charId 索引游标读、
 * Chat.tsx 的 displayMessages 不排序），timestamp 只决定气泡上显示的那个数字。
 * 唯一要防的是「位置在下、数字往回走」的倒挂，那个交给 resolveBackfillTimestamp
 * 精确判定，实际落库口径以 resolveInboxPersistTimestampForMessage 为准。
 *
 * 为什么不用「用户设定的触发时刻」（occurrenceMs）：云端喂给模型的「现在是几点」用的是
 * 实际开跑那一刻（worker/amsg/src/index.ts），角色正文里提到的时间跟 sentAt 对齐；
 * 云端那份自述日志记的也是 sentAt 口径。
 *
 * 主路径（applyAssistantPostProcessing 逐条落库）与降级存原稿路径共用这一个口径，
 * 别再各算各的。sentAt 缺失/非法（老 push 可能不带）返回 undefined。
 * 纯函数，边界值见 activeMsgRuntime.test.ts。
 */
export const resolveInboxPersistTimestamp = (
  sentAt: number | undefined,
  now: number,
): number | undefined => {
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt <= 0) return undefined;
  // 时钟偏差导致 sentAt 跑到未来时不采用——别把气泡标到还没到的时间。
  return sentAt > now ? undefined : sentAt;
};

/**
 * 补收的时间戳还能不能用（本地已经有更晚的消息就不能）。
 *
 * 「打开 App」和「后台补投的 push 送到」之间隔着好几秒，用户来得及先说一句。这时候把
 * 补收的消息按 sentAt 落库，聊天流里就会出现：08:01 用户说「早安」，下面紧跟着一条标着
 * 昨晚 23:00 的角色消息（显示顺序按自增 id，时间戳却在往回走）。
 * 本地已有比它更晚的消息 → 退回写库当刻，时间戳跟着显示顺序走，不倒挂。
 * 纯函数，两个方向见单测。
 */
export const resolveBackfillTimestamp = (
  persistTimestamp: number | undefined,
  latestLocalMessageAt: number | undefined,
): number | undefined => {
  if (persistTimestamp === undefined) return undefined;
  if (typeof latestLocalMessageAt !== 'number' || !Number.isFinite(latestLocalMessageAt)) {
    return persistTimestamp;
  }
  return latestLocalMessageAt > persistTimestamp ? undefined : persistTimestamp;
};

/**
 * 一条 inbox 消息最终的落库时间戳：先取 sentAt，再看本地有没有更晚的消息（有就退回
 * 写库当刻，防时间戳倒挂）。
 *
 * 每条都要查一次近史——后处理管线随后也会读同一份（contextMsgs），多这一次游标读可忽略。
 * 查不到近史时沿用 sentAt（宁可标 sentAt，也别把隔夜的消息标成现在）。
 */
const resolveInboxPersistTimestampForMessage = async (
  message: ActiveMsg2InboxMessage,
  now: number,
): Promise<number | undefined> => {
  const persistTimestamp = resolveInboxPersistTimestamp(message.sentAt || message.receivedAt, now);
  if (persistTimestamp === undefined) return undefined;
  try {
    const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
    // 取最大值而不是最后一条：本地消息按自增 id 排，时间戳本来就可能不是单调的。
    const latest = recent.reduce(
      (max, m) => (typeof m.timestamp === 'number' && m.timestamp > max ? m.timestamp : max),
      0,
    );
    return resolveBackfillTimestamp(persistTimestamp, latest || undefined);
  } catch (e) {
    log.warn('查不到本地最新消息时刻，补收时间戳按 sentAt 落', { messageId: message.messageId, error: e });
    return persistTimestamp;
  }
};

/** 重试前等多久。本地存储的抖动一般几秒就过去了，30s 足够缓过来又不至于让用户干等。 */
const INBOX_RETRY_DELAY_MS = 30_000;
let inboxRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 排一次自动重试。
 * 「等下次打开 App」不能当作重试时机——用户不会为一条没出现的消息去重启，
 * 在他一直开着 App 聊天的时候，那条消息就永远躺在收件箱里了。
 */
const scheduleInboxRetry = () => {
  if (inboxRetryTimer != null) return;   // 已经排了就不重复排，一次重试会带上全部积压
  inboxRetryTimer = setTimeout(() => {
    inboxRetryTimer = null;
    void flushInboxToChat();
  }, INBOX_RETRY_DELAY_MS);
};

/** 写回收件箱等下次处理（带上失败次数），并排一次自动重试。 */
const requeueForRetry = async (message: ActiveMsg2InboxMessage, attempts: number): Promise<void> => {
  try {
    await ActiveMsgStore.saveInboxMessage({ ...message, processAttempts: attempts });
    scheduleInboxRetry();
  } catch (reputErr) {
    // 写回也失败，大概率同一根因（存储关停 / 配额满）。消息到此为止，留个明确的日志。
    log.error('requeue failed, message lost', { messageId: message.messageId, error: reputErr });
  }
};

// ─── 多段消息的等齐守卫 ───
//
// 一次生成可能拆成好几条 push（metadata.messageIndex 从 1 数起），Web Push 不保证按序
// 到达。App 开着时每收到一条就 flush 一次，两段落进两批的话 consumeInboxMessages 那次
// 「同批按段序排」根本够不着——聊天记录的显示顺序 = IndexedDB 自增 id = 落库先后，后段
// 先到就永久颠倒，用户看到的是「后半句 + 前半句」。
//
// 所以段序靠后的消息落库前先看一眼：更小的段序是不是都有着落了（在本批里，或者已经
// 落过库）。没有就写回收件箱等几秒再来一次。**必须有上限**——前段真丢了（worker 只发了
// 一半 / 那条 push 被系统丢掉）不能永远扣着后段不给用户看。

/** 段序靠后的消息最多扣住几次；超了按现状放行（顺序可能是乱的，但至少不会消失）。 */
export const MAX_INBOX_ORDER_HOLDS = 3;
/** 扣住之后隔多久再看一眼。前一段通常就在路上，几秒足够。 */
const INBOX_ORDER_HOLD_DELAY_MS = 3_000;

/** messageId → 已经扣住几次。释放（落库 / 放行）时删掉，不会无界增长。 */
const inboxOrderHolds = new Map<string, number>();
let inboxOrderHoldTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleInboxOrderRecheck = () => {
  if (inboxOrderHoldTimer != null) return;   // 已经排了就不重复排，一次重看会带上全部积压
  inboxOrderHoldTimer = setTimeout(() => {
    inboxOrderHoldTimer = null;
    void flushInboxToChat();
  }, INBOX_ORDER_HOLD_DELAY_MS);
};

/**
 * 近史里这个 session 已经落过库的段序。
 *
 * 认领依据跟 findInboxArtifacts 同款——都是后处理落库时由 mcdInheritMeta 继承下来的
 * metadata（这里用 sessionId + messageIndex，那里用 activeMsg2.messageId）。
 * 一条 push 会被拆成好几个气泡，段序相同，去重后返回。
 */
export const findPersistedChunkIndexes = <T extends { role: string; metadata?: any }>(
  messages: T[],
  sessionId: string,
): Set<number> => {
  const indexes = new Set<number>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.metadata?.sessionId !== sessionId) continue;
    const idx = Number(m.metadata?.messageIndex ?? 0);
    if (Number.isFinite(idx) && idx > 0) indexes.add(idx);
  }
  return indexes;
};

/** 这条消息前面还缺哪几段（1 数到 messageIndex-1，凡是没着落的都算）。 */
export const findMissingChunkIndexes = (messageIndex: number, seen: Set<number>): number[] => {
  const missing: number[] = [];
  for (let i = 1; i < messageIndex; i += 1) {
    if (!seen.has(i)) missing.push(i);
  }
  return missing;
};

/**
 * 前面的分段还没着落 → 写回收件箱、过几秒再看，返回 true 表示这条这次先不处理。
 *
 * 三种情况一律放行（返回 false）：没有 session / 本来就是第一段、前面的段都齐了、
 * 扣到上限了。查近史或写回收件箱失败也放行——扣住的代价是消息迟迟不出现，比顺序错更重。
 */
const holdUntilEarlierChunksLand = async (
  message: ActiveMsg2InboxMessage,
  batch: ActiveMsg2InboxMessage[],
): Promise<boolean> => {
  const sessionId = getInstantSessionId(message);
  const messageIndex = getInstantMessageIndex(message);
  if (!sessionId || messageIndex <= 1) return false;

  let missing: number[];
  try {
    const seen = new Set<number>();
    for (const other of batch) {
      if (other.messageId !== message.messageId && getInstantSessionId(other) === sessionId) {
        seen.add(getInstantMessageIndex(other));
      }
    }
    const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
    for (const idx of findPersistedChunkIndexes(recent, sessionId)) seen.add(idx);
    missing = findMissingChunkIndexes(messageIndex, seen);
  } catch (e) {
    log.warn('等齐守卫查不到近史，这条照常落库', { messageId: message.messageId, error: e });
    inboxOrderHolds.delete(message.messageId);
    return false;
  }

  if (missing.length === 0) {
    inboxOrderHolds.delete(message.messageId);
    return false;
  }

  const holds = (inboxOrderHolds.get(message.messageId) ?? 0) + 1;
  if (holds > MAX_INBOX_ORDER_HOLDS) {
    inboxOrderHolds.delete(message.messageId);
    log.warn('前面的分段一直没来，按现状放行（顺序可能是乱的）', {
      messageId: message.messageId, sessionId, messageIndex, missing,
    });
    activeMsgTrace('runtime-chunk-hold-giveup', {
      sessionId, messageId: message.messageId, messageIndex, missing,
    });
    return false;
  }

  try {
    // 原样写回（不动 processAttempts）——「前面那段还没来」不是处理失败。
    await ActiveMsgStore.saveInboxMessage(message);
  } catch (e) {
    log.warn('等齐守卫写回收件箱失败，这条照常落库', { messageId: message.messageId, error: e });
    inboxOrderHolds.delete(message.messageId);
    return false;
  }
  inboxOrderHolds.set(message.messageId, holds);
  scheduleInboxOrderRecheck();
  activeMsgTrace('runtime-chunk-hold', {
    sessionId, messageId: message.messageId, messageIndex, missing, holds,
  });
  return true;
};

/**
 * 告诉用户「有条消息没能正常显示」。
 * push 路径平时是故意不弹 toast 的（用户没在看这个角色时会很吵），但这里是失败提醒，
 * 频率极低且用户需要知道，所以照发——由 OSContext 那侧统一节流。
 */
const notifyInboxProcessFailed = (
  message: ActiveMsg2InboxMessage,
  kind: 'retrying' | 'degraded' | 'swallowed',
) => {
  // 送达端唯一的埋点，而且只报失败：成功那条不报，免得攒出一份「谁几点收到过消息」的
  // 时间线（跟「发消息本身不打点」同一条口径，见 docs/analytics.md）。
  // 三个代号都是这个函数入参上写死的取值，角色名 / 内容 / messageId 一概不带。
  trackEvent('主动消息送达失败', {
    kind: kind === 'degraded' ? '原文降级' : kind === 'swallowed' ? '被跳过' : '重试中',
  });
  try {
    window.dispatchEvent(new CustomEvent('active-msg-process-failed', {
      detail: { charId: message.charId, charName: message.charName, kind },
    }));
  } catch { /* SSR-safe */ }
};

/**
 * 角色已经不在本地了，把它留在远端的任务清掉——否则这条任务会一直到点触发、
 * 一直推给一个不存在的角色。取消不掉也不要紧（网络问题），下一条推过来时还会再试一次。
 */
const cancelOrphanedRemoteTasks = async (charId: string): Promise<void> => {
  try {
    const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(charId, []);
    log.warn('清理远端孤儿任务', { charId, targets: targets.length, failed: failed.size });
  } catch (e) {
    log.warn('清理远端孤儿任务失败（下次收到同角色 push 时会再试）', { charId, error: e });
  }
};

const flushInboxToChatImpl = async () => {
  const pendingMessages = await ActiveMsgStore.consumeInboxMessages();
  activeMsgTrace('runtime-flush-start', { count: pendingMessages.length });
  // consumeInboxMessages 是 "先 ack 后处理" 语义 —— inbox 已经原子地清空。
  // 这里 per-message try/catch: 单条处理抛错 (quota / DB 故障 / postprocess 异常) 不连累
  // 后续条目。Phase 1 改成: 先尝试走 applyAssistantPostProcessing (与本地 fetch 路径
  // 行为对齐 — emoji / 翻译 / HTML / 引用 / chunking 全部复用同一管线); 如果走管线失败,
  // 降级回原来的 "原文一次性 saveMessage" 防止消息丢失。dispatchEvent 始终 fire 一次,
  // 保证 toast / 未读 / 通知 / sendInstantPush resolver 语义不变。
  for (const message of pendingMessages) {
    // 'active-msg-received' 事件里的 sentAt 维持原口径（发送时刻优先）：
    // 它只喂 toast / 未读预览，不进聊天记录，别跟落库口径搅在一起。
    const eventSentAt = message.sentAt || message.receivedAt || Date.now();
    activeMsgTrace('runtime-inbox-message', {
      sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
      messageId: message.messageId,
      charId: message.charId,
      messageType: message.messageType,
      bodyChars: typeof message.body === 'string' ? message.body.length : undefined,
    });

    // emotion_update: worker 跑完副 API 情绪评估后推回的 buff 结果. 不渲染成聊天消息, 直接落 buff +
    // 广播 innerState (useChatAI 监听 'emotion-innerstate-updated' → setEvolvedNarrative 喂下一轮).
    // 识别条件用 messageType==='emotion_update' 或 metadata.emotionRaw 存在 —— 后者兜底旧 SW
    // (<1.8.0 不认 emotion_update messageKind, 会把它当 content 存进 inbox, 但 metadata.emotionRaw
    // 仍被 saveContentToInbox 透传进来). 这样情绪落地不依赖 SW 是否升级.
    if (message.messageType === 'emotion_update' || (message.metadata as any)?.emotionRaw) {
      const emotionRaw = (message.metadata as any)?.emotionRaw;
      if (emotionRaw) {
        try {
          const chars = await DB.getAllCharacters();
          const ch = chars.find((c) => c.id === message.charId);
          if (ch) {
            const innerState = await applyEmotionEvalRaw(String(emotionRaw), ch);
            if (innerState) {
              window.dispatchEvent(new CustomEvent('emotion-innerstate-updated', {
                detail: { charId: message.charId, innerState },
              }));
            }
          }
        } catch (e) {
          console.warn('[flush:emotion_update] apply failed', e);
        }
      } else {
        // worker 端评估失败/空结果时 emotionRaw 是空串（worker 无论成败都推一条用来熄灯）。
        // 过去这里静默跳过 —— 用户只看到「情绪更新中」灭了、情绪没变、无任何报错（真实反馈）。
        // 派发失败事件让 OSContext 弹 toast。2026-07-17+ 的 worker 会把具体原因带在
        // metadata.emotionError（副 API HTTP 状态等）；旧 worker 没这字段就给通用文案。
        const workerReason = (message.metadata as any)?.emotionError;
        try {
          window.dispatchEvent(new CustomEvent(CHAT_GEN_EVENTS.emotionFailed, {
            detail: {
              charId: message.charId, charName: '',
              reason: typeof workerReason === 'string' && workerReason
                ? `云端评估失败——${workerReason}`
                : '云端情绪评估无输出（副 API 报错或模型没返回内容，可查 worker 日志）',
            },
          }));
        } catch { /* SSR-safe */ }
      }
      // 无论成功与否都通知 useChatAI 熄灭 "情绪更新中" 徽章 (buff 已落 / 或这轮没结果).
      try {
        window.dispatchEvent(new CustomEvent('instant-emotion-done', { detail: { charId: message.charId } }));
      } catch { /* SSR-safe */ }
      activeMsgTrace('runtime-emotion-done', {
        sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
        messageId: message.messageId,
        charId: message.charId,
      });
      continue;
    }

    // 角色到点自己给自己排的任务：worker 直接在 D1 建了行，客户端这边并不知道它存在。
    // 记账排在防穿帮闸**之前**——「这条消息该不该说出口」和「这条任务存不存在」是两回事。
    // 排在闸后面的话，被吞的那条 push 会把任务认领一起带走：面板列不出来、用户取消不掉，
    // 而它照常到点触发；订阅登记和凭据刷新也都够不着它，成了推不出去又删不掉的幽灵。
    await adoptSelfScheduledTasks(message);

    // ─── 防穿帮闸·客户端兜底 ───
    // 只拦定时任务的 push（source==='scheduled' 且带策略字段）；instant 聊天
    // 回复 source==='instant'，与这道闸无关。吞掉 = 不进聊天流、不重放
    // directives（作废消息的副作用一并作废）；生成 token 浪费掉，换不穿帮。
    // 系统通知层面：content push 默认可能在前台/后台先展示；页面线程无权追回
    // 已弹通知。防通知主力是 worker 预检 + chat_presence 活跃会话租约。
    // 排程现状块不在这里记——useChatAI 组请求时独立检出，两侧结论一致。
    if (message.source === 'scheduled' && (message.metadata as any)?.amsgExpirePolicy) {
      // 缓存键必须含 occurrence（Codex #2）：sessionId 对循环任务的每次 occurrence、
      // 对同一次的每次重试都可能重复——裸 sessionId 会把上次的判定串给下一次
      // （第一次放行 → 后续永远放行；第一次吞 → 后续全吞）。occurrence 读 push 顶层
      // 那份（库盖的，每条任务 push 都有），归属键仍是应用自己写的 clientTaskId。
      const meta = (message.metadata || {}) as Record<string, any>;
      const fireKey = `${meta.amsgClientTaskId}:${message.occurrenceMs ?? ''}`;
      const now = Date.now();
      // 多分段 push 的一次 fire 共用一个决定（同吞同放）：get-or-compute + TTL 清扫
      // 抽进 resolveFireExpireDecision，见其单测。
      let expired: boolean;
      try {
        expired = await resolveFireExpireDecision(
          expireDecisionByFire,
          fireKey,
          now,
          () => evaluateScheduledPushExpired(message),
        );
      } catch (gateErr) {
        // 判不出来「用户此刻是不是正在跟这个角色聊天」。压回收件箱等本地存储缓过来再判，
        // 别猜——猜错的那一面是角色当着正在进行的对话冒出一句定时问候。
        // （evaluate 抛错时 resolveFireExpireDecision 不写缓存，所以下次是真的重判。）
        const attempts = (message.processAttempts ?? 0) + 1;
        if (attempts < MAX_INBOX_PROCESS_ATTEMPTS) {
          log.warn('防穿帮闸判定失败，压回收件箱稍后重判', { messageId: message.messageId, attempts, error: gateErr });
          await requeueForRetry(message, attempts);
          notifyInboxProcessFailed(message, 'retrying');
          continue;
        }
        // 压到上限还是判不了：本地存储这时候基本是真出问题了，让角色继续冒新消息只会更乱。
        // 按吞掉处理（与闸判定为「已作废」同一个出口），但要明确告诉用户有这么一条被跳过了。
        log.error('防穿帮闸重试到上限仍判不了，按作废吞掉', { messageId: message.messageId, attempts, error: gateErr });
        activeMsgTrace('runtime-expire-swallow-unknown', {
          sessionId: fireKey,
          messageId: message.messageId,
          charId: message.charId,
          taskId: message.taskId,
        });
        notifyInboxProcessFailed(message, 'swallowed');
        continue;
      }
      if (expired) {
        activeMsgTrace('runtime-expire-swallow', {
          sessionId: fireKey,
          messageId: message.messageId,
          charId: message.charId,
          taskId: message.taskId,
        });
        // 吞掉的是「这次要说的话」，云端那份「我说过什么」也得跟着撤，否则下一次到点
        // 角色会接着一句没人看过的话往下说。不 await：这是一次网络往返，不能让它拖住
        // 收件箱里后面几条的落库；失败只 warn（见 revokeSwallowedSelfLogEntry）。
        const selfLogEntryId = buildSelfLogEntryId(message);
        if (selfLogEntryId) {
          void revokeSwallowedSelfLogEntry(message.charId, selfLogEntryId)
            .catch((e) => log.warn('撤销云端自述日志条目失败（下次重传 fire_pack 时整份作废）', {
              charId: message.charId, entryId: selfLogEntryId, error: e,
            }));
        }
        continue;
      }
    }

    // 多段消息的等齐守卫：前面的段还没着落就先扣住这条（见 holdUntilEarlierChunksLand）。
    // 排在防穿帮闸后面——这次 fire 整个被吞掉的话，没必要为它的后半段白等几秒。
    if (await holdUntilEarlierChunksLand(message, pendingMessages)) continue;

    // 落库时间戳按「在线送达 vs 离线补收」二选一（undefined = 交给 DB.saveMessage 默认取
    // 写库当刻），主路径与下面的降级存原稿路径共用这一个值，两条路一个口径。
    // sentAt 缺失时退到 receivedAt（老 worker 的 push 可能不带 sentAt）。
    const persistTimestamp = await resolveInboxPersistTimestampForMessage(message, Date.now());

    // 白名单制: AI 文本类型基本封闭 (amsg-shared MESSAGE_TYPE 4 个 + SullyOS 3 个 legacy 别名);
    // 非 AI 类型 (forum / event / system / 未来扩展) 不可枚举, 不进 post-processing 防把它们当 AI 输出乱解析.
    // Phase 1 老白名单只列了 text/assistant/normal, 漏了整个 amsg-shared 集合, 导致所有 push 都
    // 走 raw fallback (post-processing / directive 重放 / emoji / chunking 全部跳过). Round 2 补全.
    const ASSISTANT_TEXT_TYPES = new Set([
      // SullyOS legacy
      'text', 'assistant', 'normal',
      // amsg-shared MESSAGE_TYPE union (instant/fixed/prompted/auto) — 全是 LLM 输出
      'instant', 'fixed', 'prompted', 'auto',
    ]);
    const looksLikeAssistantText = !message.messageType
      || ASSISTANT_TEXT_TYPES.has(message.messageType);

    let routed = false;

    if (looksLikeAssistantText) {
      try {
        await logInstantPushLlmExchange(message);
        await processInboxMessageWithPostProcessing(message, persistTimestamp);
        routed = true;
      } catch (postErr) {
        const attempts = (message.processAttempts ?? 0) + 1;
        const action = resolveInboxFailureAction(postErr, attempts);

        if (action === 'orphan') {
          // 角色都不在了，这条消息没有落点，提醒用户也没有意义。真正该处理的是远端那条
          // 还在到点跑的任务——不取消掉它，以后每到点都会再推一条（而且每次真烧一轮 LLM）。
          log.warn('inbox message 的角色已不存在，丢弃并清理远端孤儿任务', { messageId: message.messageId, charId: message.charId });
          await cancelOrphanedRemoteTasks(message.charId);
          continue;
        }

        if (action === 'retry') {
          // 不就地存原稿：残缺版进了聊天记录是永久的，而这类故障通常是暂时的。
          log.warn('post-processing failed, requeue for retry', { messageId: message.messageId, attempts, error: postErr });
          await requeueForRetry(message, attempts);
          notifyInboxProcessFailed(message, 'retrying');
          continue;
        }

        // 重试到头，退回存原稿保底：用户至少看得到内容，代价是表情 / 卡片 / 副作用都没了，
        // 所以这条要明确告诉用户「可能不完整」，别让它悄悄混进历史。
        // 存原稿前也要清一遍：这一趟同样可能写了几条气泡才挂，不清的话原稿会跟它们并排出现。
        log.error('post-processing failed，重试到上限，退回存原稿', { messageId: message.messageId, attempts, error: postErr });
        try {
          await purgeInboxArtifacts(message);
        } catch (purgeErr) {
          log.warn('存原稿前清理半成品失败（原稿照存，可能与残留气泡并存）', { messageId: message.messageId, error: purgeErr });
        }
        notifyInboxProcessFailed(message, 'degraded');
      }
    }

    if (!routed) {
      try {
        const existing = await DB.getRecentMessagesByCharId(message.charId, 200);
        const alreadySaved = existing.some(saved => saved.metadata?.activeMsg2?.messageId === message.messageId);
        if (alreadySaved) {
          routed = true;
        } else {
          await DB.saveMessage({
          charId: message.charId,
          role: 'assistant',
          type: 'text',
          content: message.body,
          timestamp: persistTimestamp,
          metadata: {
            source: 'active_msg_2',
            activeMsg2: {
              messageId: message.messageId,
              taskId: message.taskId,
              messageType: message.messageType,
              messageSubtype: message.messageSubtype,
              avatarUrl: message.avatarUrl,
              sentAt: message.sentAt,
              receivedAt: message.receivedAt,
            },
            ...(message.metadata || {}),
          },
        });
        }
      } catch (e) {
        log.warn('saveMessage failed, requeue to inbox', { messageId: message.messageId, error: e });
        try {
          await ActiveMsgStore.saveInboxMessage(message);
        } catch (reputErr) {
          // re-put 也挂了 (大概率同一根因, 比如 quota / DB 关停), 没救了, 至少留个日志
          log.error('requeue failed, message lost', { messageId: message.messageId, error: reputErr });
        }
        // requeue 后跳过这条消息的 dispatchEvent —— UI 不该误以为收到了
        continue;
      }
    }

    // 不管走 post-processing 还是 raw fallback, 单条 inbox message 触发一次 'active-msg-received',
    // 保留原有 toast / 未读 / 通知 / sendInstantPush resolver 语义。body 用原文做预览即可。
    // sessionId 必须带出来: instantPushClient 的 observed listener 用它做 receipt identity 匹配,
    // 杜绝同 char 多轮并发 / 延迟到达的旧 push 被新一轮 send 误判为 delivered。
    window.dispatchEvent(new CustomEvent('active-msg-received', {
      detail: {
        sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
        charId: message.charId,
        charName: message.charName,
        body: message.previewBody || message.body,
        avatarUrl: message.avatarUrl,
        sentAt: eventSentAt,
      },
    }));
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      void notifyRoleEvent({
        charName: message.charName,
        kind: 'message',
        preview: message.previewBody || message.body,
        tag: `active-msg-${message.messageId}`,
        route: message.charId,
      }).catch(err => log.warn('native role notification failed', { messageId: message.messageId, error: err }));
    }
    activeMsgTrace('runtime-active-msg-received-dispatched', {
      sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
      messageId: message.messageId,
      charId: message.charId,
    });
  }
};

// 串行化所有 flush. 两个原因:
//   1. 防并发 flush 交错 saveMessage —— 显示顺序 = IndexedDB 自增 id = saveMessage 调用先后
//      (见 db.ts getRecentMessagesByCharId 按 charId 索引游标取, 即 id 顺序), 并发就会乱序.
//   2. 返回的 promise 在"本次及之前排队的 flush"全部完成后才 resolve, 这样调用方能
//      await flushInboxToChat() 保证 round-1 旁白已落库, 再去跑 tool runner (它会触发 round-2),
//      从根上消除跨轮 B 抢在 A 前面入库 (用户看到的 "B+A").
// 每段都吞掉自身异常, 保证链不被一个失败的 flush 卡死.
let flushChain: Promise<void> = Promise.resolve();
// （导出仅为让 activeMsgRuntime.test.ts 走真库钉「主路径 / 降级路径落库时间戳同口径」，
//   运行时入口仍是 ActiveMsgRuntime.init 挂的监听器。）
export const flushInboxToChat = (): Promise<void> => {
  const next = flushChain.then(async () => {
    try {
      await flushInboxToChatImpl();
    } catch (e) {
      log.warn('flushInboxToChat failed', { error: e });
    }
  });
  flushChain = next;
  return next;
};

// Phase 2 Round 2: 真实 tool runner. 启动时排空 + SW postMessage 触发. 失败诊断在 instantToolRunner 内.
const runPendingToolCallsSafely = async () => {
  try {
    await runPendingToolCalls();
  } catch (e) {
    console.warn('[instant-push] runPendingToolCalls failed', e);
  }
};

/**
 * 思维链(心象)回填: SW 收到 reasoning push 写完 buffer 后会 fire 'active-msg-reasoning'.
 *
 * 正常情况 worker 先发 reasoning 再发 content, reasoning 先落 buffer, content flush 时
 * claimReasoning 取到并挂上 thinkingChain. 但 reasoning / content 是两条独立 Web Push,
 * 弱网/移动端到达或处理顺序可能反转: content 抢先 flush 时 claimReasoning 拿到 null, 首条
 * 回复落库时没有 thinkingChain, 之后到的 reasoning 永远不再被 claim → 思维链丢失.
 *
 * 这里在 reasoning 到达后补一刀: 若该 session 的首条 assistant 回复已落库且还没挂 thinkingChain,
 * 就 claim 出 reasoning 回填到那条消息的 metadata, 再 fire progress 让 Chat 重渲染.
 * 若首条回复还没落库 (reasoning 先到的正常情形), 不 claim、留 buffer 给正常路径, 这里是 no-op.
 */
const backfillReasoningSafely = async (sessionId?: string, charId?: string): Promise<void> => {
  if (!sessionId || !charId) return;
  try {
    const msgs = await DB.getRecentMessagesByCharId(charId, 200);
    const sessionMsgs = msgs
      .filter((m) => m.role === 'assistant' && (m.metadata as any)?.sessionId === sessionId)
      .sort((a, b) => ((a as any).id ?? 0) - ((b as any).id ?? 0));
    if (sessionMsgs.length === 0) return; // content 还没落库, 留给正常 claim 路径
    const first = sessionMsgs[0] as any;
    if (first.metadata?.thinkingChain) {
      // 正常 claim 已挂上 —— 清掉 buffer 残留, 否则孤儿清扫每次启动都会重扫这条死条目
      await ActiveMsgStore.clearReasoning(sessionId).catch(() => {});
      return;
    }
    if (typeof first.id !== 'number') return;

    const buffered = await ActiveMsgStore.claimReasoning(sessionId);
    const reasoning = buffered?.reasoningContent;
    if (!reasoning) return;

    await DB.updateMessageMetadata(first.id, (prev: any) => ({ ...(prev || {}), thinkingChain: reasoning }));
    window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
  } catch (e) {
    console.warn('[ActiveMsg] backfill reasoning failed', sessionId, e);
  }
};

/**
 * 孤儿思维链清扫: backfillReasoningSafely 依赖 SW 的 'active-msg-reasoning' postMessage 触发,
 * 但 reasoning push 到达时页面被杀/冻结的话那条 postMessage 进空气 —— buffer 里的思维链
 * 永远没人认领, 首条回复也就永远没有 thinkingChain (用户看到的"主动消息不带思维链").
 * 这里在启动 / 回前台时全量扫一遍 buffer 残留会话逐个补回填.
 * 太新的条目 (5s 内) 跳过 —— 可能 content push 正在路上, 留给正常 claim 路径, 避免抢跑.
 */
const sweepOrphanReasoningSafely = async (): Promise<void> => {
  try {
    const sessions = await ActiveMsgStore.listReasoningSessions();
    const now = Date.now();
    for (const s of sessions) {
      if (now - s.receivedAt < 5000) continue;
      await backfillReasoningSafely(s.sessionId, s.charId);
    }
  } catch (e) {
    console.warn('[ActiveMsg] sweep orphan reasoning failed', e);
  }
};

// ─── 订阅变化标记（SW 写，这里读/清）────────────────────────────────────────
// 浏览器换掉推送订阅时 SW 的 pushsubscriptionchange 会往 ActiveMsg 库 kv store 写
// 一条固定 key 的标记（见 worker/sw-keep-alive.ts，key 与记录形状两边必须一致）。
// 这里在启动 / 收到 SW 通知时消费它：把新订阅登记到 worker 上那一份用户级订阅
// （ActiveMsgClient.registerPushSubscription），成功才清标记，失败留着下次再试。
// 一次覆盖写就覆盖了全部任务——包括角色自排的那些客户端不知道的任务。

export const PUSH_SUBSCRIPTION_CHANGED_KV_ID = 'push_subscription_changed_v1';
const ACTIVE_MSG_DB_NAME = 'ActiveMsg';
const ACTIVE_MSG_KV_STORE = 'kv';

/**
 * 不带版本号打开 ActiveMsg 库（跟着现有版本走，永不触发升级/降级冲突）。
 * 打开前先让 ActiveMsgStore 把 schema 建到当前版本——对一个不存在的库做无版本号
 * open 会建出没有任何 store 的 v1 空壳，谁先按版本升级谁说了算，kv 可能就没了。
 * 用完即关：这是一条一次性的旁路连接，别跟单例连接池抢着常驻（连接风暴前科见
 * activeMsgStore.ts 注释）。
 */
const withActiveMsgKv = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  await ActiveMsgStore.getGlobalConfig();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ACTIVE_MSG_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(ACTIVE_MSG_KV_STORE, mode);
      const request = run(tx.objectStore(ACTIVE_MSG_KV_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || request.error);
      tx.onabort = () => reject(tx.error || new Error('ActiveMsg kv tx aborted'));
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
};

const hasPushSubscriptionChangeMarker = async (): Promise<boolean> =>
  Boolean(await withActiveMsgKv('readonly', (store) => store.get(PUSH_SUBSCRIPTION_CHANGED_KV_ID)));

const clearPushSubscriptionChangeMarker = async (): Promise<void> => {
  await withActiveMsgKv('readwrite', (store) => store.delete(PUSH_SUBSCRIPTION_CHANGED_KV_ID));
};

/**
 * 有「订阅已变化」标记就把新订阅登记上去；返回值只为单测断言。
 *   - 'no-marker'：没有标记（或读标记本身失败——那就等下次，别为一句自检拦启动）；
 *   - 'refreshed'：登记成功，标记已清；
 *   - 'kept'：抛错，标记保留，下次启动或下次 SW 通知再试。
 */
export const refreshPushSubscriptionIfMarked = async (): Promise<'no-marker' | 'refreshed' | 'kept'> => {
  let marked = false;
  try {
    marked = await hasPushSubscriptionChangeMarker();
  } catch (e) {
    log.warn('读取订阅变化标记失败，跳过本次订阅自检', { error: e });
    return 'no-marker';
  }
  if (!marked) return 'no-marker';

  try {
    await ActiveMsgClient.registerPushSubscription();
    await clearPushSubscriptionChangeMarker();
    log.info('订阅变化已登记到 worker');
    return 'refreshed';
  } catch (e) {
    log.warn('登记新的推送订阅失败，标记保留下次再试', { error: e });
    // 订阅换了却登记不上去 = 之后所有到点推送都石沉大海，而用户这侧一点感觉都没有
    // （角色就是不说话了）。只报「发生了」，错误原文里可能带 push endpoint，不带。
    trackEvent('2.0推送订阅自检失败');
    return 'kept';
  }
};

const handleDeepLink = () => {
  const currentUrl = new URL(window.location.href);
  const charId = currentUrl.searchParams.get('activeMsgCharId');
  const openApp = currentUrl.searchParams.get('openApp');

  if (openApp === 'chat' && charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', {
      detail: { charId },
    }));
  }

  // 参数只要出现过就从地址栏清掉，不管齐不齐——角色 id 留在 URL 里，
  // 收藏、分享、截图都会把它带出去。统计侧另有 data-exclude-search 兜底
  // （见 utils/analytics.ts），这里管的是地址栏本身。
  if (charId !== null || openApp !== null) {
    currentUrl.searchParams.delete('openApp');
    currentUrl.searchParams.delete('activeMsgCharId');
    window.history.replaceState({}, '', currentUrl.toString());
  }
};

export const ActiveMsgRuntime = {
  async init() {
    if (initialized) return;
    initialized = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type) {
          activeMsgTrace('runtime-sw-message', {
            type,
            sessionId: event.data?.sessionId,
            charId: event.data?.charId,
          });
        }
        if (type === 'active-msg-received') {
          void flushInboxToChat();
          return;
        }

        if (type === 'active-msg-reasoning') {
          // 先确保已到的 content 落库 (flush 链串行), 再尝试把思维链回填到首条回复上.
          void flushInboxToChat().then(() =>
            backfillReasoningSafely(event.data?.sessionId, event.data?.charId),
          );
          return;
        }

        // SW 的 pushsubscriptionchange 写完标记后会通知一声：页面开着就立刻消费，
        // 不用等下次启动。真正的判定/清理都在 refreshPushSubscriptionIfMarked 里，
        // 通知丢了也没关系（启动兜底会再查一遍标记）。
        if (type === 'active-msg-subscription-change') {
          void refreshPushSubscriptionIfMarked();
          return;
        }

        if (type === 'REI_AMSG_PUSH') {
          const subEvent = event.data?.event;
          const payload = event.data?.payload;

          if (subEvent === 'rei-amsg-multipart-expired') {
            logAmsg.warn('multipart expired', payload);
            window.dispatchEvent(new CustomEvent('active-msg-error', {
              detail: { message: '消息接收不完整，部分内容可能丢失' }
            }));
          }
          return;
        }

        // Phase 2 Round 2: SW 收到 tool_request push 且当前 window visible → 跑 runner.
        // 不 visible 时 SW 发的是 showNotification, 用户点击后落到 active-msg-open 分支,
        // ActiveMsgRuntime.init 时这里的启动消费会兜底 (runPendingToolCallsSafely).
        // 先 flush 再跑 runner: 同一轮的旁白 (round-1 prefix) 是单独的 content push, 必须保证
        // 它先入库, 再让 runner 触发 round-2, 否则 round-2 回复可能抢在旁白前面 ("B+A").
        if (type === 'instant-tool-request') {
          void flushInboxToChat().then(() => runPendingToolCallsSafely());
          return;
        }

        if (type === 'active-msg-open') {
          // 严格串行: 先把 inbox 里的 round-1 旁白落库, 再跑 tool runner (它会触发 round-2),
          // 保证用户回到界面时先看到旁白, 且 round-2 回复排在旁白之后.
          void (async () => {
            await flushInboxToChat();
            window.dispatchEvent(new CustomEvent('active-msg-open', {
              detail: { charId: event.data?.charId },
            }));
            await runPendingToolCallsSafely();
          })();
        }
      });
    }

    // 回到前台兜底: 后台期间 SW 收到 push 写进 inbox 后会 postMessage 触发 flushInboxToChat,
    // 但页面被冻结 (iOS PWA / 移动端后台) 时那条 postMessage 可能丢失, 导致回前台后消息卡在 inbox
    // 里不刷新 ("离开后台消息不返回"). 这里 visibilitychange→visible 主动 flush 一次兜底.
    // 同时排空"待写日记"队列 (写 Notion/飞书的网络 fetch 后台会被冻结打断, 预写进 pendingDiary,
    // 回前台 fetch 可靠时补打) + pending tool calls.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        // 先 await flush 落库 round-1 旁白, 再跑 runner 触发 round-2, 避免 "B+A".
        void (async () => {
          await flushInboxToChat();
          await sweepOrphanReasoningSafely();
          void drainPendingDiaries(loadRealtimeConfigFromLocalStorage(), (charId) => {
            window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
          });
          void runPendingToolCallsSafely();
        })();
      });
    }

    // 订阅自检兜底：后台期间 SW 收到 pushsubscriptionchange 写了标记、而通知丢失
    // （页面没开着）时，启动这里把它消费掉。fire-and-forget——它要打网络请求，
    // 不能拦着下面的 inbox flush。
    void refreshPushSubscriptionIfMarked();

    // 启动兜底: 先 flush 落库 (含上次被杀进程时卡在 inbox 的 round-1 旁白), 再跑 runner
    // 触发 round-2, 保证冷启动恢复时旁白也排在 round-2 回复之前.
    await flushInboxToChat();
    await sweepOrphanReasoningSafely();
    await runPendingToolCallsSafely();
    void drainPendingDiaries(loadRealtimeConfigFromLocalStorage(), (charId) => {
      window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
    });
    handleDeepLink();
  },
};
