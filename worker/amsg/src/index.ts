/**
 * SullyOS 主动消息 2.0（amsg2）— 单用户 Cloudflare Worker 入口。
 *
 * 定时任务存 D1（binding 名固定 `DB`），到点投递由 Cron Trigger 触发
 * scheduled()，没有 send-notifications 这类 HTTP 投递端点。
 *
 * 部署走「Dashboard 粘贴」：`pnpm build:workers` 把这份入口打成
 * worker/amsg/worker.bundle.js（+ public/amsg-worker.bundle.js 供设置页
 * 「复制 Worker 代码」按钮读取），整份粘进 CF Dashboard 的 Edit code 即可。
 * amsg-server 2.6.0-next.2 起全 Web Crypto，无需 nodejs_compat flag。
 *
 * Worker 侧要配的东西（都在 CF Dashboard 的 Settings 里）：
 *   - D1 binding:  变量名 `DB`（库随便建一个，表由前端「连接」时 POST /init-tenant 幂等创建）
 *   - Cron Trigger: `* * * * *`（每分钟查一次到点任务，UTC）
 *   - env: AMSG_MASTER_KEY（64 位 hex）+ VAPID_EMAIL / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
 *          + 可选 AMSG_SERVER_TOKEN（配了则所有端点强制校验 X-Client-Token）
 *
 * 上面这些漏了哪样，`GET /config-check` 会直接列出来（见 inspectWorkerEnv），
 * 前端「连接并验证」也会读它，不用去翻 Cloudflare 的日志。排障时还有个信息更全的
 * `GET /debug`：配置 + 库的 schema + cron 有没有在按时处理任务，全只读、不带敏感信息，
 * 隔着屏幕帮人看部署时用它。
 *
 * VAPID 必须和 SullyOS「推送凭据 (VAPID)」面板里的是同一对：整个站点
 * 共用一个浏览器 push 订阅，worker 用别的密钥对签推送会 403。
 */

import {
  createSingleUserCloudflareWorker,
  createWebCryptoWebPush,
  measurePushPayload,
} from '@rei-standard/amsg-server/cloudflare';
import { stripReasoningTags } from '@rei-standard/amsg-shared';
import type { UserProfile } from '../../../types';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_LAST_SKIP_KEY,
  AMSG_SELF_LOG_KEY,
  type AmsgLastSkip,
  type AmsgSelfLog,
  type AmsgTzRef,
  amsgStateNamespace,
  amsgXhsSessionKey,
  appendSelfLogEntry,
  appendSelfLogTask,
  createSelfLog,
  describeFirePackVersion,
  parseFirePack,
  parseSelfLog,
  renderFirePack,
  selfLogMatchesPack,
  unpackStateValue,
} from '../../../utils/amsgFirePack';
import { resolveFireSceneSong } from '../../../utils/amsgFireScene';
import { shouldExpireFire } from '../../../utils/amsg2ExpireGuard';
import { buildFireTaskListBlock, MAX_ACTIVE_TASKS_PER_CHAR } from '../../../utils/amsg2Tasks';
import {
  AMSG_FIRE_SCHEDULE_TOOL,
  buildFireScheduleBlock,
  buildFireScheduleTool,
  MAX_FIRE_SCHEDULES,
  parseFireScheduleArgs,
  buildTaskInstruction,
} from '../../../utils/amsgFireSchedule';
import {
  AMSG_CHAT_PRESENCE_KEY,
  isFreshChatPresence,
  parseAmsgChatPresence,
} from '../../../utils/amsgChatPresence';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  parseToolConfig,
  parseToolPack,
  type AmsgToolConfig,
  type AmsgToolPack,
} from '../../../utils/amsgToolPack';
import { buildRealtimeWorldBlock } from './realtimeWorld';
import {
  buildMcpDirectHeaders,
  buildMcpFireBlock,
  buildMcpFireTools,
  buildMcpNameMap,
  callMcpToolCore,
  createMcpSessionState,
  filterMcpServersForChar,
  formatMcpToolResult,
  MCP_FIRE_NAME_BUDGET,
  MCP_FIRE_NAME_PREFIX,
  type McpResolvedToolCore,
  type McpSessionState,
} from '../../../utils/mcpFireCore';
import { dispatchAgenticTool, type AgenticToolChar, type AgenticToolCtx } from '../../../utils/agenticTools';
import {
  buildDuplicateToolMessage,
  buildToolResultMessage,
  toolCallFingerprint,
} from '../../../utils/agenticToolFeedback';
import { setProxyWorkerUrlOverride } from '../../../utils/proxyWorker';
import { XhsMcpClient } from '../../../utils/xhsMcpClient';
// type-only：编译期擦除，classifier 的实现不会因为这行被拉进 bundle。
import type { ToolCall } from '../../instant-push/src/classifier';
import {
  createFireSessionState,
  MAX_TOOL_ITERATIONS,
  processLLMRound,
  type FireSessionState,
} from './agentic';
import type { ActiveMsg2TaskRecord } from '../../../types';

interface Env {
  AMSG_MASTER_KEY: string;
  VAPID_EMAIL: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** 可选共享密钥；配了才校验 X-Client-Token，不配则端点全开。 */
  AMSG_SERVER_TOKEN?: string;
  /** D1 binding（factory 默认 createD1Adapter(env.DB)，这里只是标注存在）。 */
  DB: unknown;
}

// ─── 满血 fire-time hooks（amsg-server 2.6.0-next.4+：含 ctx.scratch / 存储层大值分块） ───
//
// AI 任务的 prompt 到点才组装：读前端同步上来的 fire_pack（client_state 表，见
// utils/amsgFirePack.ts + utils/amsgStateSync.ts），在 fire 时刻现算时间填槽 →
// 上下文永远是「用户最后一次聊天时」的状态。任务体里没有第二份 prompt——排程链保证
// 「先传云端状态、成功了再建任务」（activeMsgClient 的 putClientStateOrThrow），
// 所以读不到 fire_pack 就是异常，直接抛错，不降级（见 fireStateError）。
//
// v2 服务端工具循环：LLM 输出经 instant 同款业务标签 classifier 分类
// （见 ./agentic.ts），数据标签由 executeToolCalls 在 worker 内就地执行
// （recall 读 tool_pack 里的月度总结，搜索 / Notion / 飞书 / XHS 用 tool_config
// 里的凭据直调，全程不需要客户端在线）；副作用标签结构化成 directives 挂
// 最后一条 push，客户端收到时重放。tool_pack / tool_config 与 fire_pack 同批上传，
// 所以和它一样按「读不到就是异常」处理；没配凭据的工具自己会回 not_configured。
//
// 刻意只发 content push、不发 reasoning push：hook 路径的 sendHookPushPayloads
// 会把 pushPayloads 数组整体编号（messageIndex/totalMessages），reasoning 一旦混进
// 数组，第一条 content 的 messageIndex 就变 2，前端 activeMsgRuntime「index<=1 才
// claim reasoning」的判定会静默丢 thinking chain 卡片。content-only 时编号和老链路
// 完全一致，收侧（与 instant push 共用）零改动。reasoning 内容直接丢弃，正文里的
// <think> 标签照旧 strip 防泄漏。

interface FireCtx {
  task: {
    id?: string | number | null;
    /** 任务行 uuid（客户端清单里的那个）；跳过时留痕要拿它对上是哪一条。 */
    uuid?: string | null;
    contactName?: string;
    recurrenceType?: string;
    nextSendAt?: string | null;
    metadata?: Record<string, unknown>;
  };
  userId: string;
  readState: (namespace: string) => Promise<Array<{ key: string; value: string }>>;
  /** 与每轮 sessionCtx 上那个是同一套写口（防穿帮闸跳过时用它留一句原因）。 */
  writeState?: WriteState;
  scheduleTask?: ScheduleTask;
  now: Date;
  /**
   * 单次 fire 的宿主便签（amsg-server 2.6.0-next.4+）：与同一次 fire 每轮的
   * sessionCtx.scratch 是同一个对象引用，fire 结束随调用栈丢弃，库不读不写。
   */
  scratch: Record<string, unknown>;
}

/** client_state 的写入口（amsg-server 2.6.0-next.7+）；value 传 null 即删除该 key。 */
type WriteState = (
  namespace: string,
  entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
) => Promise<{ upserted: number; skipped: number; deleted: number }>;

/**
 * 在这次 fire 里再建一条定时任务（amsg-server 2.6.0-next.9+）。
 * 凭据与投递配置由库从当前任务继承，这里只说「什么时候、说什么方向」。
 * uuid 撞车不抛错，回 { created: false } 外带已存在那行的脱敏投影（不含任何凭据）
 * ——fire 重跑时靠确定性 uuid 天然幂等，投影让重跑那一轮也能把账记下来。
 */
type ScheduleTask = (options: {
  firstSendTime: string;
  recurrenceType?: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
  uuid?: string;
  /** 任务的时间参照系（IANA），daily / weekly 按这个时区的墙钟推进。 */
  tzId?: string | null;
}) => Promise<
  | { created: true; id: number | null; uuid: string; nextSendAt: string }
  | {
      created: false;
      reason: 'duplicate';
      uuid: string;
      task: {
        nextSendAt?: string | null;
        recurrenceType?: string | null;
        messageType?: string | null;
        clientTaskId?: string | null;
      } | null;
    }
>;

interface SessionCtx {
  /** 日志与去重用的不透明串。任务身份读下面三个字段，别拿它切。 */
  sessionId: string;
  llmResponse: unknown;
  llmOutputText: string;
  contactName: string;
  avatarUrl?: string;
  metadata: Record<string, unknown>;
  scratch?: Record<string, unknown>;
  writeState?: WriteState;
  scheduleTask?: ScheduleTask;
  /** 本次 fire 的第几轮 LLM（0-based）。最后一轮不再放行工具请求，见 MAX_TOOL_ITERATIONS。 */
  iteration?: number;
  /** 任务行 id；没有任务行的 in-server instant 路径为 null。 */
  taskId: number | string | null;
  /** 任务行 uuid。 */
  taskUuid: string | null;
  /** 本次触发的名义时刻（epoch 毫秒）。 */
  occurrenceMs: number | null;
}

/** 一次 fire 的跨轮状态：工具执行上下文 + 旁白累积。挂在 ctx.scratch.fire 上。 */
interface FireStash {
  session: FireSessionState;
  toolCtx: AgenticToolCtx;
  proxyWorkerUrl: string | null;
  xhsCookie: string;
  /** 本次触发时刻（任务行 next_send_at）；透传给每条 push 的 metadata.amsgOccurrenceMs。 */
  occurrenceMs: number;
  /**
   * 「角色自己发过什么」的当前版本（已跟本次 fire_pack 对齐过；对不上就是空的一份）。
   * onBeforeFire 读进来注入 prompt，onLLMOutput 发完在它上面追加一条写回云端。
   */
  selfLog: AmsgSelfLog;
  /**
   * selfLog 上有没有还没落盘的改动。收尾时（amsgFireSettled）据此决定要不要写一次库。
   *
   * 「角色给自己排了任务」这件事必须靠它落账：任务在 ctx.scheduleTask 那一刻就真的
   * 建进 D1 了，但如果这轮最终没有正文可发（只做了副作用 / 空生成），账没记下来的话
   * 客户端认领不到、面板看不见，用户永远取消不掉它，而它会一直按时发下去。
   */
  selfLogDirty: boolean;
  /** 通用 MCP：暴露名 → 服务器/工具。tool_config 里没配（或对该角色不可见）时为 null。 */
  mcpResolve: Map<string, McpResolvedToolCore> | null;
  /** 每服务器一份连接会话，单次 fire 内跨轮复用，fire 结束随 scratch 丢弃。 */
  mcpSessions: Map<string, McpSessionState>;
  /** 本次 fire 已经花在 MCP 调用上的毫秒数，见 MCP_TOTAL_BUDGET_MS。 */
  mcpSpentMs: number;
  /** 打包那一刻客户端已知的待触发任务，用来算「还能不能再排」。 */
  pendingTaskCount: number;
  /** 角色本次 fire 已经排成功的任务（也是要随 push 带回客户端认领的那些）。 */
  scheduledTasks: ActiveMsg2TaskRecord[];
  /** 本次触发用到的角色 id / 任务归属键，排程时要写进新任务的 metadata。 */
  charId: string;
  /** 防穿帮闸锚点：这份 fire_pack 记的「用户最后一次开口」。 */
  anchorMs: number;
  /**
   * 角色的时间参照系（fire_pack 的 tzId）。worker 里一切「给角色看的时间」
   * ——当前时间槽、self_log 时间戳、排程清单、send_at 解析与打回文案——都从这一份出。
   */
  tz: AmsgTzRef;
  /** 任务行 uuid（skip 留痕要对上是哪一条；拿不到为 null）。 */
  taskUuid: string | null;
  /** 任务行 id（字符串化）；日志与自排任务的 metadata 用。 */
  taskRowId: string | null;
  /** 客户端给这条任务起的归属键，self_log 的条目 id 用它。 */
  clientTaskId: string;
  /**
   * 这次生成的各段正文，等推送发完由 onAfterSend 按真送出去的段数写进 self_log。
   * 没生成、或者已经写过一次时为 null。
   */
  selfLogTexts: string[] | null;
  /**
   * prompt 里那句「你此刻在听：《X》」写的是哪一首（这一段没渲染时为 null）。
   *
   * 在 onBeforeFire 就定下来，用的是填槽那一刻的时间：角色写的 MUSIC_ACTION 说的正是
   * 它读到的那首歌，onLLMOutput 把它冻进 directive 带给客户端（见 agentic.attachSceneSong）。
   */
  sceneSong: { id?: number; name: string; artists: string } | null;
}

const getFireStash = (scratch: Record<string, unknown> | undefined): FireStash | undefined =>
  scratch?.fire as FireStash | undefined;

/** 两个时间戳取较新的那个；两个都没有为 null。 */
const laterOf = (a: number | null, b: number | null): number | null =>
  (a == null ? b : b == null ? a : Math.max(a, b));

/**
 * 用云端 tool_pack / tool_config 拼 dispatchAgenticTool 要的 ctx。
 *
 * 纯构造：解析与「解析不出来怎么办」都留在 onBeforeFire（它才知道 taskId / charId 这些
 * 报错上下文），这里只管把两份已经验好的数据装成 ctx。
 */
const buildToolCtx = (
  pack: AmsgToolPack,
  config: AmsgToolConfig,
): { toolCtx: AgenticToolCtx; proxyWorkerUrl: string | null; xhsCookie: string } => {
  // AgenticToolChar 就是 agenticTools 真正会读的那几个字段（runRecall / resolveXhsConfig /
  // 日记按角色名查）。用它当类型而不是硬转 CharacterProfile：那边多读一个字段这里就编译不过，
  // 不会等到 worker 到点才拿到 undefined。
  const char: AgenticToolChar = {
    name: pack.charName,
    xhsEnabled: pack.xhsEnabled,
    activeMemoryMonths: pack.activeMemoryMonths,
    memories: pack.memories,
  };

  return {
    toolCtx: {
      char,
      userProfile: {} as UserProfile,
      // AmsgToolConfig 的凭据字段就是 AgenticToolRealtimeConfig，结构化直接满足——
      // 不用逐字段抄一遍再强转，那样 buildToolConfig 加字段这里不会报错。
      realtimeConfig: config,
      // XHS 多步流程（search → detail 的 xsecToken 缓存）在同一次 fire 内共享。
      xhsCaches: {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
      },
      lastXhsNotesRef: { current: [] },
    },
    proxyWorkerUrl: config.proxyWorkerUrl ?? null,
    xhsCookie: config.xhsMcpConfig?.cookie ?? '',
  };
};

/**
 * fire 前置状态不完整时抛这个 —— 不降级。
 *
 * 排程链已经保证「先传云端状态、成功了再建任务」（见 activeMsgClient 的
 * putClientStateOrThrow），所以到点读不到 fire_pack 只有三种可能：云端状态被删了、
 * 数据坏了、任务是开发期的旧格式。都是异常，不是能悄悄降级的正常分支。
 *
 * 为什么抛错而不是 { skip: true }：skip 是「这次故意不发」的出口（防穿帮闸在用），
 * 用它表达「坏了」会把两件事混在一起，而且循环任务会天天静默不响、只有 worker 日志
 * 里看得见。抛错走库的投递失败路径（重试 3 次后把任务标 failed），至少留下痕迹。
 */
const fireStateError = (reason: string, detail: Record<string, unknown>): Error => {
  console.error('[amsg:fire-state-missing]', { reason, ...detail });
  return new Error(`AMSG2_FIRE_STATE_MISSING: ${reason}`);
};

// 体积判定按「库补完信封字段之后」的尺寸算：hook 交还 payload 之后，库还会补
// messageId / sessionId / timestamp / messageIndex / totalMessages 和四个任务身份
// 字段。卡着上限判的话，量出来「刚好装得下」的那一档补完就超了——既没走旁路存储、
// 也发不出去，整条消息丢掉，而且每次重试都卡在同一处。余量由库导出
// （PUSH_ENVELOPE_RESERVED_BYTES），跟着它自己补的字段走，不用这边手猜。

/**
 * 一条 push 装不下时，把 XHS 会话数据旁路存进 client_state，payload 里只留引用键。
 *
 * Web Push 的 payload 上限是 4096 字节密文（明文 3993，见 measurePushPayload），
 * 一张笔记连标题带摘要就六七百字节。过去的做法是硬砍到 4 张，于是角色说「分享了 6 张」
 * 而只出来 4 张卡——话和内容对不上，一眼假。现在改成按真实字节算：装得下就照装
 * （日常 1-3 张走的就是这条，行为不变），装不下才把整份挪到 client_state，
 * 客户端上线后按 `metadata.xhsSessionRef` 取回，一张不少。
 *
 * 存不进去时**抛错**而不是砍内容：抛错走投递失败重试，砍内容则是当场穿帮且无从察觉。
 */
export const offloadOversizedPush = async (
  payload: Record<string, unknown>,
  writeState: WriteState | undefined,
  charId: string,
  clientTaskId: string,
): Promise<Record<string, unknown>> => {
  if (measurePushPayload(JSON.stringify(payload), { reserveEnvelope: true }).withinLimit) {
    return payload;
  }

  const meta = (payload.metadata ?? {}) as Record<string, unknown>;
  if (!meta.xhsSession) return payload;   // 没有可旁路的东西，交给库抛 PUSH_PAYLOAD_TOO_LARGE

  if (typeof writeState !== 'function') {
    // 老部署（amsg-server < 2.6.0-next.7）没有写入口。不静默砍卡片——抛错让这次投递
    // 失败重试，设置页的版本门槛会提示用户重新粘贴部署。
    throw new Error('AMSG2_WRITE_STATE_UNSUPPORTED: push 超限需要旁路存储，请在设置页重新粘贴部署 worker');
  }

  const key = amsgXhsSessionKey(clientTaskId);
  await writeState(amsgStateNamespace(charId), [
    { key, value: JSON.stringify(meta.xhsSession) },
  ]);
  const { xhsSession: _offloaded, ...restMeta } = meta;
  const slimmed = { ...payload, metadata: { ...restMeta, xhsSessionRef: key } };
  console.log('[amsg:agentic] XHS 会话数据旁路存储', {
    key,
    charId,
    beforeBytes: measurePushPayload(JSON.stringify(payload)).bytes,
    afterBytes: measurePushPayload(JSON.stringify(slimmed)).bytes,
  });
  return slimmed;
};

/**
 * 防穿帮闸跳过一次触发时，留一句「为什么没响」给客户端。
 *
 * 闸是静默工作的：判定该让路就直接跳过，一条 push 都不发，而远端那行任务两种情况下
 * （真发出去了 / 被闸拦下）都会被消费掉。客户端事后看到的一模一样，用户只会觉得
 * 「说好的消息呢」。留一条记录，面板就能照实说明。
 *
 * best-effort：写不进去不能连累这次 skip 本身——闸该拦还是要拦，少一句解释而已。
 */
const writeLastSkip = async (
  writeState: WriteState | undefined,
  charId: string,
  skip: AmsgLastSkip,
): Promise<void> => {
  if (typeof writeState !== 'function') return;
  try {
    await writeState(amsgStateNamespace(charId), [
      { key: AMSG_LAST_SKIP_KEY, value: JSON.stringify(skip) },
    ]);
  } catch (error) {
    console.warn('[amsg:skip] 跳过原因写入失败（跳过本身照常生效，只是面板少一句说明）', error);
  }
};

const recordSkip = async (
  ctx: FireCtx,
  charId: string,
  reason: AmsgLastSkip['reason'],
  occurrenceMs: number,
): Promise<void> =>
  writeLastSkip(ctx.writeState, charId, {
    v: 1,
    taskUuid: typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null,
    occurrenceMs,
    reason,
    skippedAt: ctx.now.getTime(),
  });

// ─── self_log 的发送后回写（⑥）───
//
// 过去 recordSelfLog 在 onLLMOutput 里、推送发出**之前**调用——LLM 成功但推送全挂时
// 云端记了「说过」而用户一个字没收到，下次 fire 角色会接着一句不存在的话往下说。
// 现在改成：onLLMOutput 只把各段正文挂在本次 fire 的 scratch 上，等库发完（或发挂）
// 之后调 config 级 hook onAfterSend，只把**前 sentCount 段**写进 self_log，entry.at
// 用实际发送时刻。sentCount=0（一段都没出去）不写——重试的下一条 fire 会重新生成。
//
// scratch 是这一次 fire 独有的对象，onBeforeFire / onLLMOutput / onAfterSend 拿到的
// 是同一个引用，所以并发的几个 fire 天然互不串台，也不需要按任务行 id 自建登记表。

/**
 * 一次 fire 收尾时把云端自述日志落盘（config 级 hook onFireSettled，见 buildWorkerConfig）。
 *
 * 挂在 onFireSettled 而不是 onAfterSend 上，因为后者只在「真发出去了」那条路被调用：
 * skip-push（这轮只做了副作用 / 空生成）、防穿帮闸 skip、中途抛错三条路都不调。而角色
 * 用工具给自己排的任务在 ctx.scheduleTask 那一刻就已经建进 D1 了——账没落下来的话，
 * 客户端认领不到、面板看不见、用户取消不掉，它却会一直按时发下去。
 *
 * 正文只在真送出去时才记：sentCount 是「实际送达几段」，部分失败时后面几段用户没收到，
 * 记进去下一次角色就会以为自己说过。
 *
 * entry.at 用实际发送时刻（不是名义 occurrenceMs）：日志给角色读的是「我几点几分真的
 * 说了这句」，cron 延迟半小时时名义时刻是句谎话。id 仍是 `clientTaskId@occurrenceMs`
 * ——去重语义（同一次触发重跑同 id 覆盖）靠它，不动。
 *
 * best-effort：写不进去不能连累投递结果，但下一次到点角色就不知道自己说过这句，要吼一声。
 */
export const amsgFireSettled = async (
  info: {
    /** sent / skipped / failed / not-handled；这里只用它区分「有没有真发出去」。 */
    status?: string;
    sentCount?: number;
    scratch: Record<string, unknown>;
    writeState: WriteState;
  },
): Promise<void> => {
  const stash = getFireStash(info.scratch);
  if (!stash) return;   // onBeforeFire 没走到挂 stash 那步（比如取 fire_pack 就失败了）

  const texts = stash.selfLogTexts;
  stash.selfLogTexts = null;   // 认领掉，重复调用不会记两遍
  const sentCount = info.sentCount ?? 0;
  if (texts && sentCount > 0) {
    // 多段消息在用户那边是连着的几条气泡，对角色而言是一次「我说了这些」，合成一条记。
    // 只取前 sentCount 段：部分失败时没送出去的正文绝不能进日志。
    const text = texts
      .slice(0, sentCount)
      .filter((message) => message.trim())
      .join('\n');
    const next = appendSelfLogEntry(stash.selfLog, {
      id: `${stash.clientTaskId || 'task'}@${stash.occurrenceMs}`,
      at: Date.now(),
      text,
    });
    // 整段只有副作用标签（正文为空）时 append 原样返回——没有话可记。
    if (next !== stash.selfLog) {
      stash.selfLog = next;
      stash.selfLogDirty = true;
    }
  }

  if (!stash.selfLogDirty) return;   // 这次 fire 什么也没添进日志，不必写库
  stash.selfLogDirty = false;

  try {
    await info.writeState(amsgStateNamespace(stash.charId), [
      { key: AMSG_SELF_LOG_KEY, value: JSON.stringify(stash.selfLog) },
    ]);
  } catch (error) {
    console.warn('[amsg:self-log] 写入失败（这次照常发送，但下一次到点角色不会知道说过这句）', error);
  }
};

// ─── stale 守卫的消费端（⑥）───
//
// 上游 run-tick 的补发新鲜度守卫：任务错过触发时刻太久（服务停摆后恢复）不再补发，
// 并调 config 级 hook onStaleSkip(task, info)。不接这个 hook 的话，用户看到的就是
// 「说好的消息凭空消失」——这里把它写成 last_skip，面板照实说明。
//
// info.action 分两种，面板文案也分两种：
//   expired        一次性任务，行已标 failed，这一次永远不会补发了
//   fast_forwarded 循环任务，攒下的这几次都跳过，排期已快进到 nextSendAt，下次照常
// 混为一谈的话，每日提醒断更一天会被说成「已经彻底没了」。
//
// task 是 D1 任务行原样，charId 在 encrypted_payload 里解不开：上游把解密后的
// payload.metadata 递进 info（只透传 metadata，凭据不外漏），charId 从那里取。两条
// 排程路径（客户端排 / 角色自排）建任务时都写了 metadata.charId，取不到就是真异常，
// 只能放弃留痕。写口由 info 直接给，不用攒——攒下来的那份在 isolate 冷启动后的第一
// 跳是空的，而「服务停摆恢复」正是这个 hook 最该留痕的时候。

/** config 级 stale 回执 hook（见 buildWorkerConfig）。export 只为单测。 */
export const amsgStaleSkip = async (
  task: { id?: unknown; uuid?: unknown } | null | undefined,
  info: {
    reason: string;
    action: 'expired' | 'fast_forwarded';
    metadata: unknown;
    occurrenceMs: number | null;
    skippedCount: number;
    nextSendAt: string | null;
    writeState: WriteState;
  },
): Promise<void> => {
  const meta = (info.metadata ?? {}) as Record<string, unknown>;
  const charId = typeof meta.charId === 'string' && meta.charId ? meta.charId : null;
  if (!charId) {
    console.warn('[amsg:stale-skip] 任务 metadata 缺 charId，这次过期跳过没法留痕', { taskId: task?.id ?? null });
    return;
  }
  const nextSendAtMs = Date.parse(String(info.nextSendAt ?? ''));
  await writeLastSkip(info.writeState, charId, {
    v: 1,
    taskUuid: typeof task?.uuid === 'string' ? task.uuid : null,
    // 名义触发时刻由上游给——它知道被跳过的是哪一次。任务行上的 next_send_at 在循环
    // 任务快进之后已经是「下一次」了，拿它当被跳过的时刻会差出一整轮。
    occurrenceMs: info.occurrenceMs ?? Date.now(),
    reason: 'stale',
    skippedAt: Date.now(),
    staleAction: info.action,
    skippedCount: info.skippedCount,
    nextSendAtMs: Number.isFinite(nextSendAtMs) ? nextSendAtMs : null,
  });
};

/**
 * 把角色这次给自己排下的任务挂到最后一条 push 上，客户端收到时补进本地清单。
 *
 * 为什么要带回去：任务是在 D1 里建的，客户端那份清单并不知道它存在——面板不显示、
 * 用户想取消也找不到。任务本身照常触发（这正是自排的意义：不依赖客户端在线），
 * 客户端上线认领只是把账对上。
 *
 * 挂在**最后一条**：与 directives 同一个位置，收侧的 isLastChunk 守卫保证只重放一次。
 * 一条 push 都没有（整段被判空）时原样返回——那种情况下这次本来也没东西发出去。
 */
export const attachScheduledTasks = (
  pushPayloads: Array<Record<string, unknown>>,
  tasks: ActiveMsg2TaskRecord[],
): Array<Record<string, unknown>> => {
  if (tasks.length === 0 || pushPayloads.length === 0) return pushPayloads;
  const lastIdx = pushPayloads.length - 1;
  return pushPayloads.map((payload, i) => (i === lastIdx
    ? {
      ...payload,
      metadata: { ...(payload.metadata as Record<string, unknown> ?? {}), amsgSelfScheduled: tasks },
    }
    : payload));
};

/**
 * 执行一次「给自己排下一条」。永不抛错——参数写歪、排满了都以 ok:false 回喂让模型改口，
 * 跟别的工具一个语义（fire 抛错 = 整条任务重跑 = 用户这次一个字都收不到）。
 *
 * 幂等：任务 uuid 由「本次触发 + 第几条」推出来，fire 重跑时上游认出撞车、回 created:false，
 * 不会每重试一次多排一条。
 */
export const runFireScheduleTool = async (
  stash: FireStash,
  scheduleTask: ScheduleTask | undefined,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<Record<string, unknown>> => {
  if (typeof scheduleTask !== 'function') {
    // 老 worker 部署（amsg-server < 2.6.0-next.9）没有这个口子。设置页的版本门槛会提示
    // 重新粘贴，这里只需要让角色别以为排上了。
    return { ok: false, reason: 'not_supported', message: '当前后台版本还不支持给自己排后续，这次就把话说完吧。' };
  }
  if (stash.scheduledTasks.length >= MAX_FIRE_SCHEDULES) {
    return {
      ok: false,
      reason: 'fire_limit',
      message: `这次已经排了 ${MAX_FIRE_SCHEDULES} 条，够了，剩下的话直接写进这条消息里。`,
    };
  }
  const live = stash.pendingTaskCount + stash.scheduledTasks.length;
  if (live >= MAX_ACTIVE_TASKS_PER_CHAR) {
    return {
      ok: false,
      reason: 'task_limit',
      message: `你同时挂着的任务已经有 ${live} 个（上限 ${MAX_ACTIVE_TASKS_PER_CHAR}），这次别再排了。`,
    };
  }

  // 裸 send_at 按角色的时间参照系解析（③）：角色在 prompt 里看到的钟是它自己时区的，
  // worker 跑在 UTC，不带 tz 的话「明早 9 点」会整整差一个时差。
  const parsed = parseFireScheduleArgs(args, nowMs, stash.tz);
  if ('ok' in parsed) return parsed as unknown as Record<string, unknown>;

  // 同一次触发内第几条 —— 连同触发时刻构成确定性 uuid，重跑对得上。
  const seq = stash.scheduledTasks.length;
  const uuid = `amsgself-${stash.charId}-${stash.occurrenceMs}-${seq}`;
  const clientTaskId = `${uuid}-c`;

  let result;
  try {
    result = await scheduleTask({
      firstSendTime: parsed.sendAt,
      recurrenceType: parsed.recurrence,
      messageType: parsed.mode,
      uuid,
      // 角色自排的循环任务也按角色所在时区的墙钟推进，跟用户在面板排的同一套。
      tzId: stash.tz.tzId,
      metadata: {
        charId: stash.charId,
        source: 'active_msg_2',
        amsgMode: parsed.mode,
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: parsed.expirePolicy,
        // 防穿帮闸锚点：这条排下去之后，用户再开口就算「对话往前走了」。
        amsgAnchorMs: stash.anchorMs,
        amsgTaskInstruction: buildTaskInstruction(parsed.mode, parsed.promptHint),
      },
    });
  } catch (error) {
    // 上游的护栏（时间太近、类型不对、超上限）都抛错。转成回喂，让模型换个时间再试。
    return {
      ok: false,
      reason: 'schedule_rejected',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // 撞车 = 这一条在上一次重跑里已经建过了（投递失败重试会重跑整个 fire）。任务确实在
  // D1 里排着，但这一轮要是什么账都不记，它就只活在 D1 里：随 push 带不回客户端、面板
  // 看不到、用户也取消不掉。以远端那一行为准记账——这一轮模型给的时间未必和第一次一样，
  // 而真正会响的是第一次写进去的那个。
  const remote = result.created ? null : result.task;
  const sendAt = remote?.nextSendAt || parsed.sendAt;
  const record: ActiveMsg2TaskRecord = {
    taskUuid: result.uuid,
    clientTaskId: remote?.clientTaskId || clientTaskId,
    mode: (remote?.messageType as ActiveMsg2TaskRecord['mode']) || parsed.mode,
    firstSendTime: sendAt,
    recurrenceType: (remote?.recurrenceType as ActiveMsg2TaskRecord['recurrenceType'])
      || parsed.recurrence,
    ...(parsed.promptHint ? { promptHint: parsed.promptHint } : {}),
    expirePolicy: parsed.expirePolicy,
    anchorLastUserMsgAt: stash.anchorMs,
    source: 'character',
    status: 'scheduled',
    createdAt: nowMs,
  };

  // 幂等：同一轮里两次调到同一个 uuid 不重复记账。
  if (!stash.scheduledTasks.some((t) => t.taskUuid === record.taskUuid)) {
    stash.scheduledTasks.push(record);
    stash.selfLog = appendSelfLogTask(stash.selfLog, record);
    stash.selfLogDirty = true;
  }
  console.log('[amsg:self-schedule]', {
    uuid: result.uuid,
    sendAt,
    mode: record.mode,
    duplicate: !result.created,
  });

  if (!result.created) {
    // 对模型来说结果一样：那条确实排上了。时间报远端的真实值，别报它这次想改成的。
    return { ok: true, already_scheduled: true, send_at: sendAt };
  }

  return {
    ok: true,
    task_id: result.uuid.slice(0, 8),
    send_at: sendAt,
    message: '排好了。到点你会知道自己这次说了什么，接着说就行，现在不用剧透。',
  };
};

/**
 * 倒数第二轮的工具回喂末尾追加的一句。
 *
 * 这批结果喂进去之后就是最后一轮了，模型再请求工具只会被硬收尾（processLLMRound 那道
 * 闸），它写的「等我再查查」会被丢掉。先把话说在前面，让它自己把内容写完——软提示不管用
 * 时还有硬收尾兜着，两层都在。
 */
const FINAL_ROUND_NOTICE = '（提醒：这是最后一轮了，不要再调用任何工具，直接把想说的话写完。）';

/** 本轮的工具结果是不是喂给最后一轮的（ctx.iteration 缺失的老部署不提示）。 */
const feedsFinalRound = (iteration: number | undefined): boolean =>
  typeof iteration === 'number' && iteration >= MAX_TOOL_ITERATIONS - 2;

/**
 * 单个 MCP 调用的超时。总 fire 预算 240s / 最多 5 轮，一个慢服务器不能吃光
 * 整条链（浏览器侧是 60s，那边没有轮次预算压力）。
 *
 * 单次上限之外还有下面那条共享总预算：native FC 一轮可以吐好几个调用，
 * executeToolCalls 是串行 await 的，只卡单次的话 25s × N 照样能顶穿 240s。
 */
const MCP_CALL_TIMEOUT_MS = 25_000;

/**
 * 单次 fire 内全部 MCP 调用共享的时间预算。总 fire 240s，扣掉 LLM 往返，
 * MCP 最多吃一半——预算尽了让后续调用早退（ok:false 回喂），比转到轮次上限
 * 整条任务重跑便宜得多（重跑的代价见 agenticToolFeedback 头注释）。
 */
const MCP_TOTAL_BUDGET_MS = 120_000;

/**
 * 执行一个带 MCP_FIRE_NAME_PREFIX 的工具调用。永不抛错——失败也以 ok:false 回喂给 LLM
 * 圆场（与 dispatchAgenticTool 的失败语义对齐，见 executeToolCalls 注释）。
 * export 只为单测。
 */
export const runMcpFireTool = async (
  stash: Pick<FireStash, 'mcpResolve' | 'mcpSessions' | 'mcpSpentMs'>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const exposed = name.slice(MCP_FIRE_NAME_PREFIX.length);
  const hit = stash.mcpResolve?.get(exposed);
  if (!hit) {
    return { ok: false, reason: 'unknown_tool', message: `未配置的 MCP 工具: ${exposed}` };
  }
  // 预算尽了就不再发请求，直接把「别调了，收尾吧」回喂给模型——继续排队等超时只会
  // 把 fire 拖过总预算，那是整条任务重跑，比少查一次贵得多。
  const remaining = MCP_TOTAL_BUDGET_MS - stash.mcpSpentMs;
  if (remaining <= 0) {
    return {
      ok: false,
      reason: 'mcp_budget_exhausted',
      source: hit.server.name,
      message: 'MCP 调用时间预算已用完，这轮别再调外部工具了，用手上已有的信息收尾。',
    };
  }
  // 每台服务器一份会话，单次 fire 内跨轮复用：一次 fire 最多五轮，每轮重握手就是白烧往返。
  let session = stash.mcpSessions.get(hit.server.id);
  if (!session) {
    session = createMcpSessionState();
    stash.mcpSessions.set(hit.server.id, session);
  }
  const started = Date.now();
  const result = await callMcpToolCore(
    // worker 侧 fetch 没有 CORS，直连用户配的地址，不经代理。
    { url: hit.server.url, headers: (sid) => buildMcpDirectHeaders(hit.server, sid) },
    session,
    hit.toolName,
    args as Record<string, any>,
    {
      // 剩余预算比单次上限还少时按剩余的来，最后一个调用不会越过总线。
      timeoutMs: Math.min(MCP_CALL_TIMEOUT_MS, remaining),
      inputSchema: hit.tool.inputSchema,
      serverLabel: hit.server.name,
    },
  );
  // 失败/超时的耗时同样记账——烧掉的墙钟时间不因为结果不好就不算。
  stash.mcpSpentMs += Date.now() - started;
  return result.success
    ? { ok: true, source: hit.server.name, data: formatMcpToolResult(result.data) }
    : { ok: false, reason: 'mcp_error', source: hit.server.name, message: result.error };
};

// export 只为单测（见 index.test.ts）：onBeforeFire 的四道门顺序是这个功能最关键的
// 决策路径，一个判断写错位就是「该拦的没拦」或「全都不发」，必须有回归守卫钉住。
export const amsgHooks = {
  async onBeforeFire(ctx: FireCtx) {
    const charId = ctx.task?.metadata?.charId;
    if (typeof charId !== 'string' || !charId) {
      throw fireStateError('task metadata 缺 charId', { taskId: ctx.task.id });
    }
    // 下面每道门的报错都带同一套定位信息，绑一次就好——逐处手抄 detail 的话，
    // 加一道门就要再抄一遍，漏了就是一条查不到是谁的错误日志。
    const fail = (reason: string, extra?: Record<string, unknown>) =>
      fireStateError(reason, { taskId: ctx.task.id, charId, ...extra });

    // 前端上传的云端状态可能被 packStateValue 压过（值以 gz1: 开头），读回来统一先过
    // 一遍解压——没压过的原样穿过去，读侧不用赌客户端到底压了哪几份。带月度总结的
    // tool_pack 就在压缩量级上，漏掉这一步整条 fire 链会卡死在「解析失败」。
    // 解压失败说明数据真损坏了，和解析失败同款硬失败语义。
    const unpackOrFail = async (label: string, value: string): Promise<string> => {
      try {
        return await unpackStateValue(value);
      } catch (error) {
        throw fail(`${label} 解压失败（数据损坏）`, { error: String(error) });
      }
    };

    const charRows = await ctx.readState(amsgStateNamespace(charId));

    const taskMeta = (ctx.task.metadata ?? {}) as Record<string, unknown>;
    const policy = typeof taskMeta.amsgExpirePolicy === 'string'
      ? taskMeta.amsgExpirePolicy : undefined;

    // 同角色活跃会话租约：一轮对话生成期间客户端每 15s 续租，45s TTL。
    // 这是 worker 防通知的第一道快速门；缺失/过期/坏数据就继续走 fire_pack 规则。
    // 保持在 fire_pack 检查之前：用户正在聊天时应该直接 skip，既省一次状态读，
    // 也让「状态不完整」的异常任务在用户正忙时安静跳过、而不是抛错刷失败计数。
    const presence = parseAmsgChatPresence(
      charRows.find((r) => r.key === AMSG_CHAT_PRESENCE_KEY)?.value,
    );
    if (policy === 'expire' && isFreshChatPresence(presence, charId, ctx.now.getTime())) {
      console.log('[amsg:expire-skip]', {
        taskId: ctx.task.id,
        reason: 'active-chat-presence',
        presenceActiveAt: presence?.activeAt,
      });
      // 这道门在解析 fire_pack 之前，拿不到 occurrenceMs，用任务行的名义时刻。
      await recordSkip(
        ctx, charId, 'active-chat-presence',
        Date.parse(String(ctx.task.nextSendAt)) || ctx.now.getTime(),
      );
      return { skip: true } as const;
    }

    const packRow = charRows.find((r) => r.key === AMSG_FIRE_PACK_KEY);
    if (!packRow) throw fail('云端没有这个角色的 fire_pack');

    // 大值分块由 amsg-server 2.6.0-next.4+ 在存储层透明处理，readState 拿到的已是拼回的原文。
    const packJson = await unpackOrFail('fire_pack', packRow.value);
    const pack = parseFirePack(packJson);
    // 失败原因写清楚：升 fire_pack 版本要 worker bundle 和前端一起动，而设置页的版本门槛
    // 读的是上游 amsg-server 库的版本号，只改 SullyOS 自己这份 worker 代码时它不会亮。
    // 面板上的 lastError 是用户唯一能看到的线索，得直接说出该做什么。
    if (!pack) throw fail(`fire_pack 解析失败：${describeFirePackVersion(packJson)}`);

    // 本次触发时刻：任务行 next_send_at（NOT NULL，buildHookTask 已摊平提供）。防穿帮闸的
    // 循环判定要拿它当窗口锚点，之后又经 scratch 透传给每条 push 的 metadata.amsgOccurrenceMs
    // （客户端兜底闸的循环判定与吞放缓存键都要它）。解析不出来说明上游任务行的时间格式变了，
    // 按状态异常硬失败。
    const occurrenceMs = Date.parse(String(ctx.task.nextSendAt));
    if (!Number.isFinite(occurrenceMs)) {
      throw fail('任务行 next_send_at 解析不出触发时刻', { nextSendAt: ctx.task.nextSendAt });
    }

    // 防穿帮闸·worker 主判定：一次性任务创建后对话已前进 / 循环任务到点时用户
    // 正在热聊 → { skip: true } 跳过本次 fire（amsg-server skip 出口，任务照常
    // 推进/删除），一个生成 token 都不花。fire_pack.lastUserMessageAt 随
    // amsgStateSync 去抖同步、最多滞后十几秒；剩余竞态由客户端送达兜底闸兜住
    // （activeMsgRuntime 的 runtime-expire-swallow）。缺策略字段的任务不拦。
    //
    // 「用户最后一次开口」取 fire_pack 和 presence 两份里较新的：presence 行是每轮聊天
    // 一开场就写的小值，fire_pack 要等去抖 10s + 整包上传才落地，慢得多。presence 过期
    // （TTL 45s，上面那道门用的就是它）只说明用户此刻不在等回复，不影响「他最后一次开口
    // 是几点」这个事实，所以这里不看新鲜度，只保留 charId 校验——别拿别的角色的对话当锚点。
    const presenceLastUserMessageAt = presence?.charId === charId ? presence.lastUserMessageAt : null;
    const expireInput = {
      policy,
      recurrenceType: ctx.task.recurrenceType,
      anchorMs: typeof taskMeta.amsgAnchorMs === 'number' ? taskMeta.amsgAnchorMs : null,
      lastUserMessageAt: laterOf(pack.lastUserMessageAt ?? null, presenceLastUserMessageAt),
      nowMs: ctx.now.getTime(),
      occurrenceMs,
    };
    if (shouldExpireFire(expireInput)) {
      console.log('[amsg:expire-skip]', { taskId: ctx.task.id, ...expireInput });
      await recordSkip(ctx, charId, 'conversation-moved-on', occurrenceMs);
      return { skip: true } as const;
    }

    // 任务指令缺失（开发期旧格式任务）：不能用默认 auto 指令凑一个渲染——那会把
    // prompted 任务的方向偷换掉，发出去的内容和用户当初排的不是一回事。
    if (typeof taskMeta.amsgTaskInstruction !== 'string') {
      throw fail('任务 metadata 缺 amsgTaskInstruction（旧格式任务）');
    }

    // 工具数据与 prompt 同拍装好，挂 ctx.scratch 给同一次 fire 的
    // onLLMOutput / executeToolCalls（库保证同引用、fire 结束即丢，
    // 不需要自维护 sessionId → 状态的 Map 和防泄漏水位）。
    const globalRows = await ctx.readState(AMSG_GLOBAL_NAMESPACE);
    const toolPackRow = charRows.find((r) => r.key === AMSG_TOOL_PACK_KEY);
    const toolConfigRow = globalRows.find((r) => r.key === AMSG_TOOL_CONFIG_KEY);
    if (!toolPackRow) throw fail('云端没有这个角色的 tool_pack');
    if (!toolConfigRow) throw fail('云端没有 tool_config');

    // 两份数据和 fire_pack 同批原子上传（activeMsgClient 的 putClientStateOrThrow），
    // 所以走到这里必然都在；和 fire_pack 一样先解压再解析（tool_pack 攒上几条月度总结
    // 就会被前端压缩）。解析不出来就是云端状态坏了，硬失败不降级。
    const toolPack = parseToolPack(await unpackOrFail('tool_pack', toolPackRow.value));
    if (!toolPack) throw fail('tool_pack 解析失败（格式不对或数据损坏）');
    const toolConfig = parseToolConfig(await unpackOrFail('tool_config', toolConfigRow.value));
    if (!toolConfig) throw fail('tool_config 解析失败（格式不对或数据损坏）');

    // 通用 MCP：提示词块 / tools 数组与凭据同源同拍（都来自这一行 tool_config），
    // 不存在「教了角色用、凭据却没到」的窗口。charIds 过滤与前台同语义。
    // mcpUseNativeTools=false = 用户的中转拒 tools（前台兼容模式同款开关），
    // 请求不带 tools 参数、提示词块教正文协议，识别走 processLLMRound 第二层。
    const mcpServers = filterMcpServersForChar(toolConfig.mcpServers, charId);
    // 暴露名后面要拼 MCP_FIRE_NAME_PREFIX，长度预算得先把前缀那几个字符扣掉。
    const mcpResolve = mcpServers.length
      ? buildMcpNameMap(mcpServers, { maxNameLen: MCP_FIRE_NAME_BUDGET })
      : null;
    const mcpNative = toolConfig.mcpUseNativeTools !== false;

    // 角色上次到点自己说了什么：跟这份 fire_pack 对得上才算数，对不上就当没有、从空的一份
    // 重新开始攒。判定与「丢弃」的理由见 amsgFirePack 的 selfLogMatchesPack。
    const storedSelfLog = parseSelfLog(charRows.find((r) => r.key === AMSG_SELF_LOG_KEY)?.value ?? '');
    const selfLog = selfLogMatchesPack(storedSelfLog, pack)
      ? storedSelfLog as AmsgSelfLog
      : createSelfLog(pack.builtAt);

    // 客户端记录的（打包那一刻的快照）+ 角色自己在之前几次 fire 里排下、客户端还没认领的。
    // 后者不补上的话，角色排完一条、下次到点又看不见它，很容易把同一件事再排一遍。
    const livePendingTasks = [...pack.pendingTasks, ...selfLog.tasks];

    // 老 worker 部署（amsg-server < 2.6.0-next.9）没有这个口子。教了也排不成，
    // 只会让角色说「我等下再找你」然后没有下文——干脆不教。
    const canSelfSchedule = typeof ctx.scheduleTask === 'function';

    // 角色的时间参照系：fire_pack 的 tzId（parseFirePack 保证非空，Intl 管夏令时）。
    const tz: AmsgTzRef = { tzId: pack.tzId };

    // 任务归属键：self_log 的条目 id、以及「排程清单里排除掉自己这条」都用它。
    const clientTaskId = typeof taskMeta.amsgClientTaskId === 'string' ? taskMeta.amsgClientTaskId : '';

    const { toolCtx, proxyWorkerUrl, xhsCookie } = buildToolCtx(toolPack, toolConfig);
    ctx.scratch.fire = {
      session: createFireSessionState(),
      toolCtx,
      proxyWorkerUrl,
      xhsCookie,
      occurrenceMs,
      selfLog,
      selfLogDirty: false,
      mcpResolve,
      mcpSessions: new Map(),
      mcpSpentMs: 0,
      // 「还能不能再排」按客户端已知的 + 角色自己排过还没被认领的一起算，
      // 不然角色离线期间连排几次就能绕过每角色的任务上限。
      pendingTaskCount: livePendingTasks.length,
      scheduledTasks: [],
      charId,
      anchorMs: pack.lastUserMessageAt ?? 0,
      tz,
      taskUuid: typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null,
      taskRowId: ctx.task.id != null ? String(ctx.task.id) : null,
      clientTaskId,
      selfLogTexts: null,
      // 跟下面 renderFirePack 填「你此刻在听」用的是同一个时刻、同一份 scene、同一个种子
      // （resolveFireSceneSong 与 renderFireSceneBlock 共用判定），冻的必然是正文里那首。
      sceneSong: resolveFireSceneSong(pack.scene, ctx.now.getTime(), tz),
    } satisfies FireStash;

    // 「你还挂着这些排程」：客户端记录的（打包那一刻的快照）+ 角色自己在之前几次 fire 里
    // 排下、客户端还没认领的那些。后者不补上的话，角色排完一条、下次到点又看不见它，
    // 很容易把同一件事再排一遍。
    const taskListBlock = buildFireTaskListBlock(livePendingTasks, {
      nowMs: ctx.now.getTime(),
      tzId: pack.tzId,
      excludeClientTaskId: clientTaskId || undefined,
    });

    // 「外面的世界此刻什么样」：今日节日 + 实时天气 + 热搜，到点现拉现填。
    // 拉不到 / 超时都只是返回空串，那一段整个消失，这次触发照常往下走。
    const realtimeWorldBlock = await buildRealtimeWorldBlock({
      toolConfig,
      timeAwarenessEnabled: toolPack.timeAwarenessEnabled,
      tzId: pack.tzId,
      nowMs: ctx.now.getTime(),
      globalRows,
      globalNamespace: AMSG_GLOBAL_NAMESPACE,
      writeState: ctx.writeState,
    });

    // fire_pack v3：「本次任务」指令随任务 metadata 走，这里填槽。
    // MCP 块拼在渲染好的 prompt 之后（同一条 user 消息）。
    const prompt = renderFirePack(pack, ctx.now.getTime(), taskMeta.amsgTaskInstruction, {
      selfLog,
      taskListBlock,
      realtimeWorldBlock,
    })
      + (mcpResolve ? buildMcpFireBlock(mcpResolve, { mode: mcpNative ? 'native' : 'text' }) : '')
      // 「给自己排下一条」的说明。跟 MCP 共用一个 native/text 判断：用户的中转拒 tools 时
      // 两边都得改教正文协议，不然一边声明成 tools、一边教语法，模型会两种都写一遍。
      // 时间上下文让 send_at 的示例是「明天这个点」的裸墙钟，别再教模型写 offset。
      + (canSelfSchedule
        ? buildFireScheduleBlock(mcpNative ? 'native' : 'text', { nowMs: ctx.now.getTime(), tz })
        : '');
    const fireTools = [
      ...(mcpResolve && mcpNative ? buildMcpFireTools(mcpResolve) : []),
      ...(canSelfSchedule && mcpNative
        ? [buildFireScheduleTool({ nowMs: ctx.now.getTime(), tz })]
        : []),
    ];
    return {
      messages: [{ role: 'user' as const, content: prompt }],
      // 轮次上限显式给一份：worker 要靠同一个数判「这是最后一轮了」（见 onLLMOutput），
      // 而上游只有内部默认值、没导出常量，各写各的迟早对不上。
      maxToolIterations: MAX_TOOL_ITERATIONS,
      // amsg-server 带 agentic-fire-tools feature 的版本起透传给每轮 LLM 请求；
      // 老 bundle 里不会走到这（tools 是随本次 bundle 一起升上去的）。
      ...(fireTools.length ? { tools: fireTools } : {}),
    };
  },

  async onLLMOutput(ctx: SessionCtx) {
    const content = stripReasoningTags(ctx.llmOutputText || '').trim();

    // 任务身份直接从 ctx 上读（sessionId 是给日志和去重用的不透明串，不拿它切）。
    const taskId = ctx.taskId != null ? String(ctx.taskId) : null;
    if (taskId == null) {
      // 没有任务行的路径（in-server instant）才该是 null。定时任务走到这里说明上游没
      // 给身份，而后果是静默的：送达消息的 metadata.activeMsg2.taskId 会是 null →
      // 客户端 hasDeliveredProactiveNear 判定「这次没送达过」→ 排程现状块给角色注入
      // 一条假的「已作废」回执，角色可能把已经发出去的事又当没发生。留个日志。
      console.warn('[amsg:agentic] ctx 上没有 taskId，送达归属会失效', ctx.sessionId);
    }
    const messageType = typeof ctx.metadata?.amsgMode === 'string' ? ctx.metadata.amsgMode : 'auto';

    // onBeforeFire 要么抛错、要么 skip、要么在返回 messages 之前把 stash 挂上，所以
    // 走到这里 stash 必然存在（库保证 fireCtx.scratch 与每轮 sessionCtx.scratch 同引用）。
    // 真缺了就是这个前提被打破（比如库不再共享 scratch）——响亮地失败，别静默丢旁白。
    const stash = getFireStash(ctx.scratch);
    if (!stash) {
      throw new Error('AMSG2_FIRE_STASH_MISSING: onLLMOutput 读不到 ctx.scratch.fire，检查 amsg-server 是否仍共享 scratch');
    }
    const session = stash.session;

    // native tool_calls：只认 tools 数组里声明过的 MCP 名字。模型幻觉出的
    // 未声明调用（比如给 tag 工具编一个 native 调用）丢弃并留日志——直接透传
    // 会让 executeToolCalls 撞上没有 stash 映射的名字。日志带上当时声明了哪些，
    // 「模型编的」和「名字映射建歪了」一眼能分开。
    const rawToolCalls = (ctx.llmResponse as { choices?: Array<{ message?: { tool_calls?: unknown } }> })
      ?.choices?.[0]?.message?.tool_calls;
    const allNativeCalls = (Array.isArray(rawToolCalls) ? rawToolCalls : []) as ToolCall[];
    const nativeScheduleCalls = allNativeCalls.filter(
      (tc) => tc?.function?.name === AMSG_FIRE_SCHEDULE_TOOL,
    );
    const nativeMcpCalls = allNativeCalls.filter((tc): tc is ToolCall => {
      const n = (tc as ToolCall | undefined)?.function?.name;
      if (n === AMSG_FIRE_SCHEDULE_TOOL) return false;   // 排程工具走上面那条，不算 MCP
      const hit = typeof n === 'string'
        && n.startsWith(MCP_FIRE_NAME_PREFIX)
        && !!stash.mcpResolve?.has(n.slice(MCP_FIRE_NAME_PREFIX.length));
      if (!hit) {
        console.warn('[amsg:agentic] 丢弃未声明的 native tool_call', {
          sessionId: ctx.sessionId,
          name: n ?? null,
          declared: [...(stash.mcpResolve?.keys() ?? [])],
        });
      }
      return hit;
    });

    let decision = processLLMRound(session, content, {
      // 名字取 tool_pack 里的那份：它跟着每轮聊天重新上云，改名当天就是新的。
      // ctx.contactName 是排程那一刻冻进任务行的快照，用户改完名字之后，之前排的
      // 任务推送出来横幅还顶着旧名字（上游 update-message 也不让改这个字段）。
      // tool_pack 里没名字时退回任务行那份，别让标题变成「来自 」。
      contactName: stash.toolCtx.char.name || ctx.contactName,
      avatarUrl: ctx.avatarUrl ?? null,
      taskId,
      messageType,
      metadata: ctx.metadata,
      occurrenceMs: stash.occurrenceMs,
      // round 1 XHS 工具抓到的笔记 / xsecToken 快照：finish 时按 directive 引用
      // 挑选后随最后一条 push 带回客户端（客户端离线跑不了 round 1，缺这份
      // [[XHS_SHARE]] / 点赞 / 评论重放必然 available:0 掉卡片）。
      xhsNotes: stash.toolCtx.lastXhsNotesRef?.current,
      xhsXsecTokens: stash.toolCtx.xhsCaches
        ? Array.from(stash.toolCtx.xhsCaches.xsecTokenCache.entries())
        : undefined,
      // 角色写了 MUSIC_ACTION 的话，把它读到的那首歌一起带给客户端：标签里只有歌单名，
      // 没有这一份的话客户端只能拿「用户此刻在听的那首」凑（补收时多半是空的）。
      sceneSong: stash.sceneSong,
    },
    stash.mcpResolve ? { resolve: stash.mcpResolve, nativeToolCalls: nativeMcpCalls } : null,
    // 传 null = 这次不认排程（老部署没这口子），正文里写了也不当调用。
    typeof ctx.scheduleTask === 'function' ? { nativeToolCalls: nativeScheduleCalls } : null,
    // 最后一轮不再放行工具请求，改成用手上的内容收尾（见 agentic.ts 的 MAX_TOOL_ITERATIONS）。
    ctx.iteration);

    if (decision.decision === 'tool-request') {
      console.log('[amsg:agentic]', {
        type: 'tool_request',
        sessionId: ctx.sessionId,
        tools: decision.toolCalls.map((tc) => tc.function.name),
      });
    } else {
      // finish / skip-push：这次 fire 到头，scratch 随调用栈丢弃，无需手动回收。
      console.log('[amsg:agentic]', {
        type: decision.decision,
        sessionId: ctx.sessionId,
        pushes: decision.decision === 'finish' ? decision.pushPayloads.length : 0,
      });
    }

    if (decision.decision === 'skip-push') {
      // ⑤ 没发出去也留痕：模型返回空/纯拒答、或者只做了副作用没说话时，上游把任务
      // 当成功消费，用户看到的就是「说好的消息凭空消失」。写一条 last_skip，面板能
      // 照实解释是哪种。best-effort，写不进去不影响 skip 本身。
      await writeLastSkip(ctx.writeState, stash.charId, {
        v: 1,
        taskUuid: stash.taskUuid,
        occurrenceMs: stash.occurrenceMs,
        reason: decision.reason,
        skippedAt: Date.now(),
      });
    }

    if (decision.decision === 'finish') {
      // 「我这次说了什么」不在这里写库（这里还没发出去），只把各段正文挂到本次 fire 的
      // scratch 上，等 onAfterSend 按真正送出去的段数落盘。
      stash.selfLogTexts = decision.pushPayloads.map(
        (p) => (typeof p.message === 'string' ? p.message : ''));

      // 角色这次给自己排的任务，随最后一条 push 带回客户端认领——不然它们只活在 D1 里，
      // 面板看不到、用户也没法取消。任务本身照常触发，客户端上线补进清单即可。
      const withScheduled = attachScheduledTasks(decision.pushPayloads, stash.scheduledTasks);
      decision = { ...decision, pushPayloads: withScheduled };

      // 发之前按真实字节预算过一遍：装不下的 XHS 会话数据旁路存起来，push 只留引用键。
      // clientTaskId 当存储键（每任务一份、下次触发覆盖），缺了就没法旁路——那时超限会
      // 由库抛 PUSH_PAYLOAD_TOO_LARGE，照样不会静默丢消息。
      if (stash.clientTaskId && stash.charId) {
        const budgeted = [];
        for (const payload of decision.pushPayloads) {
          budgeted.push(await offloadOversizedPush(
            payload, ctx.writeState, stash.charId, stash.clientTaskId));
        }
        return { ...decision, pushPayloads: budgeted };
      }
    }

    return decision;
  },

  /**
   * 服务端工具执行：客户端在 fire 时刻离线，数据工具全部在 worker 内跑完。
   * 单个工具失败（含抛错）都以失败 JSON 回填给 LLM 让它圆场，不失败整条链。
   */
  async executeToolCalls(
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
    ctx: SessionCtx,
  ) {
    const stash = getFireStash(ctx.scratch);
    if (!stash) {
      throw new Error('AMSG2_FIRE_STASH_MISSING: executeToolCalls 读不到 ctx.scratch.fire，检查 amsg-server 是否仍共享 scratch');
    }
    // 搜索/Notion/飞书经代理 worker 转发；地址来自前端同步的 tool_config。XHS Lite cookie 同拍注入。
    //
    // 这两个注入写的是 isolate 级全局，而库到点最多并发跑 8 个任务（MAX_CONCURRENT=8）。
    // 现在安全的前提是：两个值都来自全局 namespace 的 tool_config，所有角色同一份，
    // 并发写的是同一个值。缺值时不覆盖——tool_config 瞬时读失败的那个 fire 不该把并发中
    // 另一个 fire 已经注入好的值清成空。
    //
    // TODO(按角色配凭据)：应用层目前不支持（realtimeConfig 是全局单份，按角色的只有
    // char.xhsEnabled 这个开关）。哪天凭据改成按角色配，这里必须改成显式传参——否则
    // 同一分钟并发的两个角色会互相串凭据，而且不会报错。
    if (stash.proxyWorkerUrl) setProxyWorkerUrlOverride(stash.proxyWorkerUrl);
    if (stash.xhsCookie) XhsMcpClient.setCookie(stash.xhsCookie);

    const results = [];
    for (const toolCall of toolCalls) {
      const name = toolCall?.function?.name || '';
      let content: string;
      try {
        const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        const fingerprint = toolCallFingerprint(name, args);

        // 同名同参第二次直接打回，一次请求都不发。软提示（下面那段回喂）挡不住时靠它兜底：
        // 转满上限会抛 AGENTIC_LOOP_EXCEEDED，任务不出清、下一分钟整条从头重跑，代价远大于
        // 少查一次。只拦完全一样的调用——换月份、换关键词照常放行，多轮能力不受影响。
        if (stash.session.toolCalls.some((r) => r.fingerprint === fingerprint)) {
          // 计数交给 processLLMRound：连着重复到阈值就直接收尾，不陪它转到轮次上限
          // （上限一到整条任务失败重跑，用户一个字都收不到）。
          stash.session.duplicateToolCalls += 1;
          console.log('[amsg:agentic]', {
            type: 'tool_duplicate',
            sessionId: ctx.sessionId,
            tool: name,
            count: stash.session.duplicateToolCalls,
          });
          results.push({
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: buildDuplicateToolMessage(name),
          });
          continue;
        }

        // 三条去处，失败语义一致（都回 ok:false，不抛），回喂 / 记账 / 日志共用下面这段：
        //   排程 → 在 D1 里建下一条任务；MCP → 直连用户配的服务器；其余 → 内置数据工具。
        const result = name === AMSG_FIRE_SCHEDULE_TOOL
          ? await runFireScheduleTool(stash, ctx.scheduleTask, args, Date.now())
          : name.startsWith(MCP_FIRE_NAME_PREFIX)
            ? await runMcpFireTool(stash, name, args)
            : await dispatchAgenticTool(name, args, stash.toolCtx);
        stash.session.toolCalls.push({ name, fingerprint });
        // 不再回裸 JSON：模型从裸 JSON 里看不出「这一步已经做完了」，提示词里但凡有一句
        // 常驻的「先去查 X」就会每轮照做。这段话跟前台说的是同一套（见 agenticToolFeedback）。
        content = buildToolResultMessage({ name, result, history: stash.session.toolCalls });
        console.log('[amsg:agentic]', { type: 'tool_done', sessionId: ctx.sessionId, tool: name });
      } catch (error) {
        content = JSON.stringify({
          ok: false,
          reason: 'tool_error',
          message: error instanceof Error ? error.message : String(error),
        });
        console.warn('[amsg:agentic]', { type: 'tool_failed', sessionId: ctx.sessionId, tool: name, error: String(error) });
      }
      results.push({ tool_call_id: toolCall.id, role: 'tool' as const, content });
    }

    // 只挂在最后一条 tool 消息末尾（离模型下一次输出最近），不逐条重复刷屏。
    if (feedsFinalRound(ctx.iteration) && results.length > 0) {
      const last = results[results.length - 1];
      last.content = `${last.content}\n${FINAL_ROUND_NOTICE}`;
    }
    return results;
  },
};

/**
 * VAPID JWT 的 sub 字段：推送服务只要求它是个合法的 mailto: / https: 联系方式，
 * 内容不参与签名校验。但 scheduled() 一旦发现 email 为空就会整轮 return（一条任务
 * 都不处理、前端毫无提示），而「推送凭据」面板复制出来的 env 里 VAPID_EMAIL 是注释
 * 掉的可选项——照着部署必然缺它。所以这里给个缺省值兜底，配了就用用户配的。
 * （instant-push worker 一直是这个做法。）
 */
export const resolveVapidEmail = (raw: string | undefined): string =>
  raw?.trim() || 'mailto:noreply@sullyos.app';

/** worker 运行配置；导出便于单测钉住 VAPID 兜底。 */
export const buildWorkerConfig = (env: Env) => {
  // vapid 与 webpush 必须同源同一份：两处各读一次 env 时，改了一处漏另一处
  // 会变成「签名用兜底、校验用空值」这类只在真发推送时才暴露的坑。
  const vapid = {
    email: resolveVapidEmail(env.VAPID_EMAIL),
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  return {
    // db 缺省时 factory 自动用 createD1Adapter(env.DB)
    masterKey: env.AMSG_MASTER_KEY,
    serverToken: env.AMSG_SERVER_TOKEN,
    vapid,
    webpush: createWebCryptoWebPush(vapid),
    // 前端和 Worker 不同源，带自定义头的请求会先发 CORS 预检，必须放行。
    // 单用户自用默认全开；想收紧就把 '*' 换成自己的 SullyOS 站点 origin。
    cors: { origin: '*' },
    // 满血 fire-time hooks（onBeforeFire 现场填槽 + onLLMOutput 分类 +
    // executeToolCalls 服务端工具循环）；轮数/超时用库默认（5 轮 / 240s）。
    hooks: amsgHooks,
    // 收尾回执 + 过期跳过回执（config 级 hook）。
    // onFireSettled: 无论这次 fire 是发出去了、跳过了还是抛错了都会调一次，self_log
    //   在这里统一落盘（见 amsgFireSettled）。不用 onAfterSend——它只在真发出去那条路
    //   触发，角色自排任务碰上「只做了副作用没说话」就会漏账变成幽灵任务。
    // onStaleSkip: 过期不补发时给面板留一句「为什么没响」（见 amsgStaleSkip）。
    onFireSettled: amsgFireSettled,
    onStaleSkip: amsgStaleSkip,
    // 同一个角色的多条任务不并发跑：两条撞在一起时用户会收到两条互不知情的消息，
    // 而且 self_log 是读-改-写整份，后写的会盖掉先写的那条「我说过什么」。分组键取
    // 角色 id，上游按它同跳去重 + 跨跳看租约，被拦下的任务一个字段都不动，下一跳原样再来。
    serializeBy: (task: { metadata?: Record<string, unknown> | null }) =>
      (typeof task.metadata?.charId === 'string' ? task.metadata.charId : null),
  };
};

/** 环境自检的结论。missing 为空就能正常干活，warnings 是「能跑但有一块是哑的」。 */
export interface WorkerEnvReport {
  ok: boolean;
  /** 缺失项的变量名，`DB` 指 D1 绑定。给机器读的。 */
  missing: string[];
  /** 给人读的整句，含「去哪儿补」，前端直接显示。 */
  message: string;
  warnings: { code: string; message: string }[];
}

/** 缺了就一个请求都处理不了的两样东西，各自带一句「去哪儿补」。 */
const REQUIRED_ENV = [
  {
    key: 'DB',
    label: 'D1 数据库绑定',
    // D1 绑定不在 Variables and Secrets 那一栏，指错地方比不指还费时间。
    how: '在 Settings → Bindings 里加一条 D1 database，变量名填 DB',
    isMissing: (env: Env) =>
      typeof (env.DB as { prepare?: unknown } | null | undefined)?.prepare !== 'function',
  },
  {
    key: 'AMSG_MASTER_KEY',
    label: 'AMSG_MASTER_KEY',
    how: '在 Settings → Variables and Secrets 里加，类型选 Secret',
    isMissing: (env: Env) => !env.AMSG_MASTER_KEY?.trim(),
  },
] as const;

/**
 * 进上游库之前先看一眼 env 齐不齐。
 *
 * 存在的理由：这两样缺任何一样，上游都是在建配置那一步抛异常，被它的全局 catch
 * 吞成一句「服务器内部错误」，而那个响应还不带 CORS 头——浏览器于是连这句话都不
 * 让前端读，控制台只剩一个 "Failed to fetch"。用户拿着它既分不清是 D1 没绑还是
 * 密钥没配，也分不清是不是自己网断了。所以缺什么在这儿就说什么。
 */
export const inspectWorkerEnv = (env: Env): WorkerEnvReport => {
  const absent = REQUIRED_ENV.filter((item) => item.isMissing(env));
  const warnings: WorkerEnvReport['warnings'] = [];

  // 上游把 masterKey 当普通字符串做 SHA-256（deriveUserEncryptionKey），长度不对
  // 照样跑得动，所以只提醒不拦——拦了会把已经在正常工作的实例打挂。真正的风险是
  // 它一旦和当初不一致，之前加密存进 D1 的任务就再也解不开了。
  const masterKey = env.AMSG_MASTER_KEY?.trim();
  if (masterKey && !/^[0-9a-f]{64}$/i.test(masterKey)) {
    warnings.push({
      code: 'MASTER_KEY_FORMAT',
      message: 'AMSG_MASTER_KEY 不是 64 位十六进制，可能是粘贴时少了几位。它必须和当初生成的那一串完全一致，换一串的话已存的任务就解不开了。',
    });
  }
  // VAPID 缺了不影响读写任务，但 scheduled() 每分钟会整轮 return，到点消息一条
  // 都发不出来——而界面上一切正常，这是最难自己查出来的一种坏法。
  if (!env.VAPID_PUBLIC_KEY?.trim() || !env.VAPID_PRIVATE_KEY?.trim()) {
    warnings.push({
      code: 'VAPID_MISSING',
      message: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 没配齐，到点消息不会推送出去。这两个要和站点「推送凭据 (VAPID)」面板里的是同一对。',
    });
  }
  if (!env.AMSG_SERVER_TOKEN?.trim()) {
    warnings.push({
      code: 'SERVER_TOKEN_MISSING',
      message: '没设 AMSG_SERVER_TOKEN，这个 Worker 地址对公网开放，知道地址的人都能读写你的任务。',
    });
  }

  return {
    ok: absent.length === 0,
    missing: absent.map((item) => item.key),
    message: absent.length
      ? `Worker 配置不完整：${absent.map((item) => `缺 ${item.label}（${item.how}）`).join('；')}。`
      : 'Worker 配置齐全。',
    warnings,
  };
};

// 跟上游 corsHeadersFor 放行的那一份保持一致：预检放行的头少一个，正式请求就会被
// 浏览器拦下，而拦下的表现同样是没有下文的 "Failed to fetch"。
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, X-User-Id, X-Payload-Encrypted, X-Encryption-Version, X-Response-Encrypted, X-Client-Token',
  'Access-Control-Max-Age': '86400',
};

const jsonWithCors = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });

// cron 触发时 CF 传进来的事件，只往上游转手，没必要为它引 workers-types。
type CfScheduledEvent = { scheduledTime: number; cron: string };

/** 上游 initSchema 建的表。少一张就说明「连接并验证」那步没跑成。 */
const EXPECTED_TABLES = ['scheduled_messages', 'client_state', 'push_subscriptions'];

/**
 * 上游后加的列（amsg-server 2.6.0 的三个迁移）。
 *
 * 这是最值得单独查一眼的一项：换了新 bundle 却没重新点「连接并验证」时，已经存在的
 * 表不会自己长出新列，而 cron 每分钟都会因为读不到这些列而挂——前端一切正常、任务
 * 列表也在，就是一条都不发。缺列时这里会直接点名，省得对着「都正常啊」发呆。
 */
const EXPECTED_TASK_COLUMNS = ['lease_until', 'retry_after', 'serialize_group'];

/** 到点多久还没被处理就算 cron 那侧出了问题。cron 每分钟一跳，留足重试余量。 */
const TICK_STALL_MINUTES = 5;

type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
};

/**
 * 只读地看一眼库里的状况：表齐不齐、列全不全、有没有到点却没人处理的任务。
 *
 * 全程不写库，也不读任何一条任务的内容——只数数和比对 schema。数出来的东西
 * （待发条数、最老的一条过期了多久）不指向任何角色、时间点或正文。
 */
const inspectStorage = async (env: Env) => {
  const db = env.DB as D1Like | undefined;
  if (typeof db?.prepare !== 'function') return { reachable: false as const };

  try {
    const tables = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all<{
      name: string; sql: string | null;
    }>();
    const rows = tables.results || [];
    const present = new Set(rows.map((row) => row.name));
    // ALTER TABLE ADD COLUMN 会把新列写回 sqlite_master 的建表语句，所以照着它比对
    // 就能看出迁移跑没跑，不用依赖 D1 对 PRAGMA 的支持程度。
    const taskSql = rows.find((row) => row.name === 'scheduled_messages')?.sql || '';

    const missingTables = EXPECTED_TABLES.filter((name) => !present.has(name));
    const missingColumns = present.has('scheduled_messages')
      ? EXPECTED_TASK_COLUMNS.filter((column) => !taskSql.includes(column))
      : [];

    if (missingTables.includes('scheduled_messages')) {
      return { reachable: true as const, missingTables, missingColumns, schemaReady: false };
    }

    const nowIso = new Date().toISOString();
    const stats = await db
      .prepare(
        `SELECT COUNT(*) AS pending,
                SUM(CASE WHEN next_send_at <= ? THEN 1 ELSE 0 END) AS overdue,
                MIN(CASE WHEN next_send_at <= ? THEN next_send_at END) AS oldest
           FROM scheduled_messages WHERE status = 'pending'`,
      )
      .bind(nowIso, nowIso)
      .first<{ pending: number; overdue: number | null; oldest: string | null }>();

    const pushRow = present.has('push_subscriptions')
      ? await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>()
      : null;

    return {
      reachable: true as const,
      schemaReady: missingTables.length === 0 && missingColumns.length === 0,
      missingTables,
      missingColumns,
      // 单用户 worker 只存一行。到点却发不出去最常见的原因就是这行是空的——
      // 换了一台 worker 之后云端订阅是空的，而浏览器那侧的订阅一个字都没变。
      pushSubscriptionRegistered: (pushRow?.n ?? 0) > 0,
      pendingTasks: stats?.pending ?? 0,
      overdueTasks: stats?.overdue ?? 0,
      oldestOverdueMinutes: stats?.oldest
        ? Math.floor((Date.now() - Date.parse(stats.oldest)) / 60000)
        : null,
    };
  } catch (error) {
    // 报错类型而不是原文：原文可能带 SQL 片段，而这个端点是不设防的。
    return { reachable: false as const, error: (error as Error)?.name || 'QueryFailed' };
  }
};

/**
 * cron 到底在不在跑。
 *
 * 不写心跳，靠「有没有到点了还没被处理的任务」反推——心跳要往用户库里建表、每分钟
 * 写一次，而这个判断纯读、零副作用，问的还正好是用户真正关心的那件事（任务有没有
 * 被按时处理），比「tick 有没有触发」更贴。代价是手上没有待发任务时无从判断，那种
 * 情况下 cron 停没停也确实不影响什么。
 */
const judgeTick = (storage: Awaited<ReturnType<typeof inspectStorage>>) => {
  if (!storage.reachable || !('pendingTasks' in storage)) return 'unknown';
  if (!storage.pendingTasks) return 'idle';
  const overdueMinutes = storage.oldestOverdueMinutes;
  if (overdueMinutes === null || overdueMinutes < TICK_STALL_MINUTES) return 'healthy';
  return 'stalled';
};

const upstream = createSingleUserCloudflareWorker(buildWorkerConfig);

/**
 * 版本号只有上游的 capabilities 才给，转手问它一次；问不到不算错，报 null。
 * 配置不全时直接不问：那一问必然失败，还会在 Cloudflare 日志里留一条
 * 「fetch() unhandled error」——排障的人正盯着日志看，别给他添噪音。
 */
const readServerVersion = async (request: Request, env: Env) => {
  if (!inspectWorkerEnv(env).ok) return null;
  try {
    const url = new URL(request.url);
    url.pathname = '/capabilities';
    url.search = '';
    const response = await upstream.fetch(new Request(url.toString(), { headers: request.headers }), env);
    if (response.status !== 200) return null;
    const body = await response.json() as { serverVersion?: string; features?: string[] };
    return { version: body.serverVersion ?? null, featureCount: body.features?.length ?? 0 };
  } catch {
    return null;
  }
};

/**
 * 在上游 worker 外面包一层配置自检。多出来的三个行为：
 *   GET /config-check  配置齐不齐（只读 env，前端「连接并验证」用的就是它）
 *   GET /debug         上面那些再加库和 cron 的状况，给隔着屏幕帮人排障用
 *   其它请求           配置不全时直接 503 + 说明缺什么，不进上游
 */
// 两个 handler 都不往上游传 ctx —— 上游的签名只收 (request/event, env)，多传一个
// 参数运行时无害，但类型对不上。CF 传给我们的那份直接丢掉即可。
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (pathname.endsWith('/config-check')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      // 刻意不校验 X-Client-Token：worker 配了口令而前端没填正是要诊断的情形之一，
      // 校验了就查不出来。作为交换，这里只回「配没配」，不回任何值。
      return jsonWithCors(200, { success: true, data: inspectWorkerEnv(env) });
    }

    if (pathname.endsWith('/debug')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      // 全只读、也不设防，所以能报什么是有边界的：只有配置齐不齐、schema 对不对、
      // 数出来的条数，以及本来就公开的 VAPID 公钥。密钥的值、用户标识、任务正文、
      // 推送 endpoint 一概不出现——不是没取到，是刻意不取。
      const storage = await inspectStorage(env);
      return jsonWithCors(200, {
        success: true,
        data: {
          now: new Date().toISOString(),
          config: inspectWorkerEnv(env),
          server: await readServerVersion(request, env),
          storage,
          tick: judgeTick(storage),
          vapidPublicKey: env.VAPID_PUBLIC_KEY?.trim() || null,
        },
      });
    }

    const report = inspectWorkerEnv(env);
    if (!report.ok) {
      // 预检也得放行：带自定义头的请求会先发 OPTIONS，这一步被挡住的话正式请求
      // 根本发不出去，下面那句 503 用户就永远看不到。
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      return jsonWithCors(503, {
        success: false,
        error: { code: 'WORKER_CONFIG_MISSING', message: report.message, missing: report.missing },
      });
    }

    return upstream.fetch(request, env);
  },

  async scheduled(event: CfScheduledEvent, env: Env): Promise<void> {
    // 定时任务这条路没人看得见，配置不全时上游只会抛一个堆栈。写明白点，
    // wrangler tail 里一眼能看出是配置问题还是任务本身挂了。
    const report = inspectWorkerEnv(env);
    if (!report.ok) {
      console.error(`[amsg] 定时任务整轮跳过：${report.message}`);
      return;
    }
    return upstream.scheduled(event, env);
  },
};
