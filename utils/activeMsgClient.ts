import { ReiClient } from '@rei-standard/amsg-client';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2GlobalConfig,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  APIConfig,
  CharacterProfile,
  Emoji,
  EmojiCategory,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { getLastRealUserMessageAt } from './amsg2ExpireGuard';
import { buildTaskInstruction, resolveSendAtMs } from './amsgFireSchedule';
import {
  getPendingTasks, isAmsg2EnabledForChar, MAX_ACTIVE_TASKS_PER_CHAR,
  parseRemoteTaskLastError, RemoteTaskLastError, type RemoteTaskProjection,
  resolveExpirePolicy, toDatetimeLocalValue,
} from './amsg2Tasks';
import { AMSG_CHAT_PRESENCE_KEY, AmsgChatPresence } from './amsgChatPresence';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_REALTIME_WORLD,
  AMSG_SLOT_SCENE,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG_LAST_SKIP_KEY,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_LIST,
  AMSG_SLOT_TIME_SINCE_USER,
  AMSG_SLOT_USER_CLOCK,
  AmsgFirePack,
  type AmsgLastSkip,
  amsgStateNamespace,
  packStateValue,
  parseLastSkip,
} from './amsgFirePack';
import type { AmsgFireScene } from './amsgFireScene';
import { buildSongPool } from './charMusicSchedule';
import { getDailyScheduleForChar } from './dailySchedule';
import { getLocalDateKey } from './localDate';
import { isScheduleFeatureOn } from './scheduleGenerator';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  buildToolConfig,
  buildToolPack,
} from './amsgToolPack';
import { listRecallableMonths } from './agenticTools';
import { ChatPrompts } from './chatPrompts';
import { nowInTimeZone, resolveCharTimeZone, tzAwarenessNote } from './timezone';
import { DB } from './db';
import { copyWorkerBundleToClipboard } from './instantPushClient';
import { collectMcpFireServers, getMcpUseNativeTools } from './mcpClient';
import { safeResponseJson } from './safeApi';
import { ActiveMsgStore } from './activeMsgStore';
import { KeepAlive } from './keepAlive';
import {
  bytesToB64u,
  describePushCapabilityGap,
  isDeadPushEndpoint,
  subscribeWithRetry,
  SUBSCRIBE_SETTLE_MS,
  type SubscribeFailureKind,
} from './pushSubscribeShared';

export const NATIVE_PUSH_TOKEN_STORAGE_KEY = 'amsg2_fcm_token_v1';
const nativePushBuildEnabled = () => import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true';
const readNativePushToken = () => nativePushBuildEnabled() && typeof localStorage !== 'undefined'
  ? localStorage.getItem(NATIVE_PUSH_TOKEN_STORAGE_KEY)?.trim() || ''
  : '';

export interface ActiveMsg2PushStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  hasSubscription: boolean;
  vapidConfigured: boolean;
  detail?: string;
}

/** worker 上登记的那份订阅（一个用户一行）。读不到时调用方拿 null。 */
export interface AmsgRemotePushSubscription {
  exists: boolean;
  endpoint: string | null;
  updatedAt: number | null;
}

/**
 * 「worker 到点会不会推到这台设备」的结论。
 *
 * 中间那两档是主动消息最难自己发现的故障：任务建得成、界面全绿、到点一条都不来。
 * 换过 worker（新库是空的）、或者在另一台设备上登记过（一个用户只存一份，后来的
 * 顶掉先前的），都会落到这里。
 */
export type AmsgPushRegistrationState =
  | 'worker-unset'    // 还没填 Worker 地址，无从谈起
  | 'unreachable'     // 问不到 worker（断网，或那台 worker 没有这个端点）
  | 'missing'         // worker 上没有登记
  | 'other-endpoint'  // 登记着，但不是本机这个端点
  | 'matched';        // 登记着，且就是本机

/**
 * 拿本机端点跟 worker 登记的那份对一下。纯函数，面板和单测共用同一套判定。
 *
 * 本机还没订阅（localEndpoint 为空）时，只要远端有登记就算 'other-endpoint'——
 * 那份登记确实指向别的地方，说「已登记」会让用户以为这台设备收得到。
 */
export const compareRemotePushSubscription = (
  localEndpoint: string | null | undefined,
  remote: AmsgRemotePushSubscription | null,
): AmsgPushRegistrationState => {
  if (!remote) return 'unreachable';
  if (!remote.exists || !remote.endpoint) return 'missing';
  return remote.endpoint === localEndpoint ? 'matched' : 'other-endpoint';
};

/**
 * 库把载荷加解密留成了私有实现，而分页拉任务、init-tenant 这类库没封装的端点
 * 得自己组加密载荷，所以按运行时的真实形状单独声明一份，在下面两个桥接函数里
 * 转一次。不能写成 `ReiClient & { _encrypt }`——交叉类型碰上 private 成员会整个
 * 塌成 never，连带 ReiClient 自己的方法一起查不到。
 */
interface ReiCryptoBridge {
  _encrypt(plaintext: string): Promise<{ iv: string; authTag: string; encryptedData: string }>;
  _decrypt(payload: { iv: string; authTag: string; encryptedData: string }): Promise<any>;
}

const ACTIVE_MSG_RUNTIME_HEADER = '[ActiveMsg2]';

/** amsg-server 的 DELETE /cancel-message 找不到目标行时回的错误码（HTTP 404）。 */
const REMOTE_TASK_NOT_FOUND_CODE = 'TASK_NOT_FOUND';

// 单用户模式：所有请求打到用户自部署的 Cloudflare Worker（config.workerUrl）。
// 配了 serverToken 就每次带 X-Client-Token；worker 端配了就强制校验，缺/错回 401。
const normalizeWorkerBase = (workerUrl: string) => workerUrl.trim().replace(/\/+$/, '');

const createClient = (config: Pick<ActiveMsg2GlobalConfig, 'userId' | 'workerUrl' | 'serverToken'>) =>
  new ReiClient({
    baseUrl: normalizeWorkerBase(config.workerUrl),
    userId: config.userId,
    serverToken: config.serverToken || undefined,
  });

/** 面板新建任务的默认时间：半小时后，折成 datetime-local 认的本地墙钟。 */
export const getDefaultActiveMsgFirstSendTime = () =>
  toDatetimeLocalValue(new Date(Date.now() + 30 * 60_000).toISOString());

const normalizeChatApiUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

/** amsg-server 对 avatarUrl 的长度上限，超了整条会被拒。 */
const REMOTE_AVATAR_URL_MAX_LENGTH = 2048;

/**
 * 能交给 worker 当推送通知图标的头像地址，不合格返回 undefined。
 *
 * worker 只收公网可访问的 URL（不能是 data: URI，上限 2048 字符）。而本地角色头像基本都是
 * base64，传过去必被拒，代价是每排一条任务就在 worker 日志里刷一条
 * `avatarUrl 不合法，已置空`。这里按同一把尺先筛掉——传了本来也是被置空，通知一样退回
 * 默认图标，少一条噪音而已。
 */
export const toRemoteAvatarUrl = (avatar: string | undefined | null): string | undefined => {
  const value = avatar?.trim();
  if (!value || value.length > REMOTE_AVATAR_URL_MAX_LENGTH || /^data:/i.test(value)) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
};

const looksLikeHtmlFallbackError = (message: string) => (
  /HTML/i.test(message) ||
  message.includes(`Unexpected token '<'`) ||
  /<!doctype/i.test(message) ||
  /<html/i.test(message)
);

// ─── 失败归类（给使用统计分档用）───
//
// 「连接失败」在图上只有一格的话，地址填错、密钥对不上、D1 没绑、纯断网会长成一个样，
// 而这四种要修的引导完全不同。所以在**抛错的那一刻**按源码里写死的谓词挂一个代号，
// 上报只带这个代号。
//
// 报错原文（可能带 Worker 地址、push endpoint）一个字都不进上报——挂在这里的
// 永远是下面这个联合类型里的字面量之一，不是从异常对象上读出来的任何东西。
// 见 docs/analytics.md 「加新埋点的规矩」第 4 条。
export type AmsgFailKind =
  | '地址没填'
  | '打到网页了'
  | '鉴权失败'
  | '端点不存在'
  | '建表失败'
  | '配置缺失'
  | '网络失败'
  | '权限被拒'
  | '不支持推送'
  | 'worker没配VAPID'
  | '订阅失败'
  | '推送通道不通'
  | '端点僵尸'
  | '其他';

const FAIL_KIND_PROP = '__amsgFailKind';

/** 给错误挂一个失败代号，原样抛回去（不改 message、不改类型）。 */
const withFailKind = <T extends Error>(error: T, kind: AmsgFailKind): T => {
  (error as unknown as Record<string, string>)[FAIL_KIND_PROP] = kind;
  return error;
};

/**
 * 读出失败代号，没挂的一律 '其他'。
 * 上报侧只该调这个，别自己从 error 上取任何字段——那些是运行时字符串。
 */
export const readAmsgFailKind = (error: unknown): AmsgFailKind => {
  const kind = (error as Record<string, unknown> | null | undefined)?.[FAIL_KIND_PROP];
  return typeof kind === 'string' ? (kind as AmsgFailKind) : '其他';
};

/**
 * worker 自检的回执（`GET /config-check`，见 worker/amsg/src/index.ts 的 inspectWorkerEnv）。
 * missing 是缺了就跑不起来的，warnings 是能跑但有一块功能是哑的。
 */
export interface AmsgWorkerEnvReport {
  ok: boolean;
  missing: string[];
  /** worker 生成的整句，含「去哪儿补」，直接显示给用户。 */
  message: string;
  warnings: { code: string; message: string }[];
}

/**
 * 问 worker 自己配齐了没。
 *
 * 拿不到结论一律返回 null，不抛：这个端点是后加的，旧 worker 会回 404；而网络本身
 * 不通的话，紧接着的 init-tenant 会用它自己那套分类报出来，在这儿抢先报一遍只会让
 * 用户同时看到两条口径不同的错误。
 */
const inspectWorkerConfig = async (config: ActiveMsg2GlobalConfig): Promise<AmsgWorkerEnvReport | null> => {
  try {
    const { status, body } = await fetchWithAuthRaw('config-check', config, { method: 'GET' }, '配置自检');
    if (status !== 200 || !body?.success) return null;
    // 只认形状对得上的回执。没有这个端点的 worker 回什么的都有（404 只是其中一种），
    // 光看 success 就采信的话，会把一台好 worker 判成「配置缺失」——那比不自检还糟，
    // 用户照着提示改哪儿都改不对。形状不对就当它不支持自检，走原来的流程。
    const data = body.data;
    if (typeof data?.ok !== 'boolean' || !Array.isArray(data.missing) || !Array.isArray(data.warnings)) {
      return null;
    }
    return data as AmsgWorkerEnvReport;
  } catch {
    return null;
  }
};

/** init-tenant 没成功时按 HTTP 状态归类：三种状态要用户去改的地方完全不同。 */
const resolveInitFailKind = (status: number): AmsgFailKind => {
  if (status === 401 || status === 403) return '鉴权失败';   // 共享密钥两边对不上
  if (status === 404) return '端点不存在';                   // 地址不对，或 worker 是旧版
  return '建表失败';                                         // 多半是没绑 D1（变量名 DB）
};

const normalizeActiveMsgApiError = (error: unknown, phase: string) => {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (looksLikeHtmlFallbackError(message)) {
    return withFailKind(new Error(`主动消息 2.0 的 ${phase} 请求没有打到 Worker，而是拿到了网页 HTML。请确认设置里填的是已部署的 amsg Worker 地址，而不是某个网页地址。`), '打到网页了');
  }
  // 走到这儿的基本是 fetch 自己抛的（断网 / DNS 挂 / CORS 被拒），归网络。
  return withFailKind(error instanceof Error ? error : new Error(message), '网络失败');
};

const ensureGlobalReady = async (): Promise<ActiveMsg2GlobalConfig> => {
  const userId = await ActiveMsgStore.ensureUserId();
  const config = await ActiveMsgStore.getGlobalConfig();
  return { ...config, userId };
};

const ensureWorkerReady = async () => {
  const config = await ensureGlobalReady();
  if (!config.workerUrl.trim()) {
    throw withFailKind(new Error('请先在系统设置里填写「主动消息 2.0」的 Worker 地址。'), '地址没填');
  }
  return config;
};

const initializeClient = async (config: ActiveMsg2GlobalConfig) => {
  const client = createClient(config);
  try {
    await client.init();
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '获取用户密钥');
  }
  return client;
};

const resolveApiConfig = (char: CharacterProfile, config: ActiveMsg2CharacterConfig, apiConfig: APIConfig) => {
  const useSecondary = config.useSecondaryApi && config.secondaryApi?.baseUrl;
  const source = useSecondary ? config.secondaryApi! : apiConfig;

  if (!source.baseUrl || !source.apiKey || !source.model) {
    throw new Error('主动消息 2.0 缺少可用的 API URL / Key / Model。');
  }

  return source;
};

/**
 * 一个角色的 AI 任务此刻该用的凭据补丁（update-message 载荷）。
 * 生效凭据的算法与排程时同一份 resolveApiConfig：角色开了单独 API 就写单独 API 的值，
 * 没开才用全局聊天 API——凭据刷新绝不能把单独 API 的任务盖成全局凭据。
 * 凭据配不齐（比如单独 API 缺字段）沿用 resolveApiConfig 的抛错，调用方按角色记失败。
 */
const resolveTaskCredentialUpdates = (
  char: CharacterProfile,
  config: ActiveMsg2CharacterConfig,
  apiConfig: APIConfig,
): Record<string, unknown> => {
  const active = resolveApiConfig(char, config, apiConfig);
  return {
    apiUrl: normalizeChatApiUrl(active.baseUrl),
    apiKey: active.apiKey,
    primaryModel: active.model,
  };
};

const formatHistoryLine = (role: string, content: any, char: CharacterProfile, userProfile: UserProfile) => {
  const speaker = role === 'assistant' ? char.name : role === 'user' ? userProfile.name : '系统';
  const text = Array.isArray(content)
    ? content.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join('\n')
    : String(content || '');
  return `【${speaker}】\n${text.trim()}`;
};

const buildTimeGapHint = async (charId: string) => {
  const recentMessages = await DB.getRecentMessagesByCharId(charId, 200);
  return {
    // 时间差在渲染时刻才算（formatTimeSinceUser），这里只取原始时间戳——
    // 满血链路会把它放进 fire_pack，worker 到点用「fire 时刻」重算，不吃排程时的陈旧值。
    // 「真实用户消息」判定与防穿帮闸共用同一叶子 helper（见 amsg2ExpireGuard）。
    lastUserMessageAt: getLastRealUserMessageAt(recentMessages),
    recentMessages,
  };
};

// 时间性内容留槽位（AMSG_SLOT_*），由 worker 在 fire 时刻用 renderFirePack 填。
// 文案模板本身仍在前端这份代码里维护。
// includeTime：角色关掉「时间感知」时，这一段里报钟的两行连槽位一起不进模板
// （见 buildFirePack 的同名判断）。
const buildLegacyStyleProactiveHint = (targetName: string, includeTime: boolean) => {
  const target = targetName || '对方';

  return [
    '【1.0 风格主动消息提示】',
    ...(includeTime ? [`现在是 ${AMSG_SLOT_CURRENT_TIME}。`, AMSG_SLOT_AWAY_HINT] : []),
    `这不是 ${target} 正在和你聊天，而是你突然想起了 ${target}，想主动发条消息给他/她。`,
    `像真人随手发消息一样自然一点，可以是分享刚看到的东西、轻轻吐槽、问一句近况、突然想念，或者单纯想找 ${target} 聊两句。`,
    `${target} 不在的这段时间，你自己的日子也在往前过：刚发生的小事、注意到的细节、对之前聊过的话冒出来的后续想法，都比干巴巴的问候更像你。`,
    '不要写成汇报近况，不要像在完成任务，也不要解释自己为什么会发这条消息。',
    `关心别变成查岗：不催问 ${target} 在干嘛、怎么还不回；喝水、早睡这类叮嘱偶尔一句是心意，回回都发就成了说教。`,
    `正文尽量短，通常 1 到 2 句就够；如果 ${target} 很久没来找你，可以轻轻带一点想念、好奇或者小小抱怨。`,
  ].join('\n');
};

// 拼出带时间槽位的完整 prompt 模板（fire_pack）：原样 putClientState 上云，
// worker 到点用 renderFirePack 填槽（所以上下文永远是最后一次聊天的状态）。
/**
 * 表情包全库（按角色过滤前）。批量同步时由调用方读一次传进来——它跟角色无关，
 * 一个角色读一遍的话，N 个角色就是 N 次全表 getAll，读回来的还是同一份。
 */
type EmojiLibrary = { all: Emoji[]; categories: EmojiCategory[] };

const readEmojiLibrary = async (): Promise<EmojiLibrary> => {
  const [all, categories] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
  return { all, categories };
};

// export 只为单测（activeMsgClient.test.ts 钉 tzId 取值与模板不烤时间）。
export const buildFirePack = async (
  char: CharacterProfile,
  userProfile: UserProfile,
  groups: GroupProfile[],
  realtimeConfig: RealtimeConfig | undefined,
  emojiLibrary?: EmojiLibrary,
): Promise<AmsgFirePack> => {
  const [{ recentMessages, lastUserMessageAt }, library, schedule] = await Promise.all([
    buildTimeGapHint(char.id),
    emojiLibrary ? Promise.resolve(emojiLibrary) : readEmojiLibrary(),
    // 日程随包带原始表（不是渲染好的文字），worker 到点自己挑时段。总开关关掉的角色没有表。
    isScheduleFeatureOn(char)
      ? getDailyScheduleForChar(char).catch((e) => {
          console.warn('[ActiveMsg2] 日程读取失败，这次不带作息表', char.id, e);
          return null;
        })
      : Promise.resolve(null),
  ]);
  // 角色的时间参照系：开了自定义时区用角色的，没开用设备的。worker 渲染一切给角色看的
  // 时间（当前时间、日程日期、排程清单）都按它来。
  const charTz = resolveCharTimeZone(char);
  const tzId = charTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 用户设备自己的钟。跟 tzId 分开存：角色排消息时得知道「对方那边现在几点」，
  // 不然异国恋角色会把「晚上聊两句」排到用户的凌晨三点，而且没有任何线索能让它避开。
  const userTzId = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 时间相关的行整块跟着角色的「时间感知」开关走：关掉的角色在前台连今天几号都读不到
  // （buildTimeAwarenessBlock 直接返回空串），主动消息这边却精确报出年月日 + 星期，
  // 是同一个开关的两套行为。关掉时这几行连槽位一起不进模板。
  // 排程工具的 send_at 说明不受影响（那份在 amsgFireSchedule）：排时间本来就得知道现在几点。
  const timeAware = char.timeAwarenessEnabled !== false;
  // 只摘渲染会读到的字段：整份日程里还挂着每个时段缓存的小剧场台词和看板图，
  // 带上去只是白占云端状态的体积（fire_pack 本来就有几万字）。
  const scene: AmsgFireScene | null = schedule
    ? {
        charId: char.id,
        // 这份表是角色当地「今天」的安排，到点先比日期再用（见 renderFireSceneBlock）。
        dateKey: getLocalDateKey(nowInTimeZone(tzId)),
        schedule: {
          slots: schedule.slots.map((s) => ({
            startTime: s.startTime,
            activity: s.activity,
            ...(s.description ? { description: s.description } : {}),
            ...(s.emoji ? { emoji: s.emoji } : {}),
            ...(s.location ? { location: s.location } : {}),
            ...(s.innerThought ? { innerThought: s.innerThought } : {}),
          })),
          ...(schedule.flowNarrative ? { flowNarrative: schedule.flowNarrative } : {}),
        },
        songPool: buildSongPool(char).map((s) => ({ id: s.id, name: s.name, artists: s.artists })),
      }
    : null;
  const legacyHint = buildLegacyStyleProactiveHint(userProfile.name || '对方', timeAware);
  // 前台每轮都注入的时差说明（「你身处 X 时区……对方可能在不同时区」）。它是静态文案、
  // 不随时间变，所以打包时就烤进模板；到点由 AMSG_SLOT_USER_CLOCK 补上「对方那边现在
  // 几点」。fire 侧的角色设定是 skipTimeAwareness 建的，整块时间感知都被抹掉了，
  // 不在这里补回来的话，最容易撞用户睡觉的恰恰是主动消息。
  const tzNote = timeAware ? tzAwarenessNote(charTz).trim() : '';
  // 按角色可见性过滤表情包：主动消息不经过 Chat.tsx 的 aiVisibleEmojis/visibleCategories，
  // 必须在这里复用同一套过滤，否则角色会用到只对其他角色开放的表情包。
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
    library.all,
    library.categories,
    char.id,
  );
  const systemPrompt = await ChatPrompts.buildSystemPrompt(
    char,
    userProfile,
    groups,
    emojis,
    categories,
    recentMessages,
    realtimeConfig,
    // 主动消息路径：注入任务状态（让角色知道有什么可催的），但不要每轮教 LLM 命令语法
    // （角色主动找用户时一般输出纯文本催促，不会用 [[TASK_DONE]] 这种用户确认才用的命令）。
    undefined, undefined, undefined, undefined,
    // 模板是现在打好、到点才渲染的，凡是「打包这一刻」的状态都不烤进去。
    // 具体拿掉哪些块、到点由谁补，见 ChatPrompts.PromptBuildOptions 上的表。
    { taskCommandGuide: false, forFirePack: true },
  );
  const { apiMessages } = ChatPrompts.buildMessageHistory(
    recentMessages,
    Math.min(char.contextLimit || 120, 120),
    char,
    userProfile,
    emojis,
  );

  const recentTranscript = apiMessages
    .slice(-30)
    .map((message) => formatHistoryLine(message.role, message.content, char, userProfile))
    .join('\n\n');

  // 记忆库里有哪些月份查得到 —— 提示词一直在教角色用 [[RECALL: 年-月]]，却没说过
  // 哪些月份有东西。不报菜单的话它多半不查，直接凭空编一段「回忆」出来。
  // 只写进下面这段主动消息自己的规则里，不动 chatPrompts 那条所有角色每轮都走的主链路。
  const recallableMonths = listRecallableMonths(char.memories);
  const recallHint = recallableMonths.length > 0
    ? `- 你的记忆库里存着这些月份的经历：${recallableMonths.join('、')}。想聊起其中某段时，先输出 [[RECALL: 年-月]] 把细节取回来再写，别凭印象编。`
    : null;

  const template = [
    '你将代表下面这个角色，生成一条“主动发给用户”的私聊消息。',
    '',
    '【重要规则】',
    '- 这不是回复用户刚刚发来的消息，而是角色主动来找用户聊天。',
    '- 输出只能是最终要发送的消息正文，不要解释，不要写分析，不要加引号。',
    '- 像真实聊天一样简短自然，优先 1 到 2 句，最多 3 句。',
    '- 可以用换行拆成多个聊天气泡，但不要写时间戳、名字前缀、系统提示。',
    '- 不要出现“作为AI”“系统提示”等元话语。',
    '- 语气更像真人突然想起对方时发来的私聊，不要像在完成任务。',
    '- 角色设定里描述的查记忆、读日记、联网搜索、逛小红书等能力照常可用：需要时正常输出对应标签，系统会取回结果后让你继续写。',
    ...(recallHint ? [recallHint] : []),
    '',
    '【角色系统设定】',
    systemPrompt,
    `（注意：上面角色设定里的情绪、印象等状态是最近一次聊天时的快照。${timeAware ? '此刻的时间、你正在做什么' : '你此刻正在做什么'}，以下方「当前时刻补充」为准。）`,
    '',
    '【最近对话上下文】',
    // 槽位直接黏在最后一行后面（不单独占一行）：worker 到点没有可写的自述时填空串，
    // 输出跟没这个槽位一模一样；有内容时那段自带前导空行，见 renderSelfLogBlock。
    `${recentTranscript || '（暂时没有最近聊天记录）'}${AMSG_SLOT_SELF_LOG}`,
    '',
    // 「此刻在做什么」紧跟当前时间：日程时段本来就要对着钟读，挨在一起才对得上。
    // 没日程的角色 worker 填空串，这一行连带消失（那段自带前导空行，见 renderFireSceneBlock）。
    // 时区那两行也挨着钟：静态说明打包时就烤好，「对方那边现在几点」由 worker 到点现算——
    // 一个是角色自己的钟、一个是用户的钟，各自把主语写在文案里，别让模型以为在打架。
    ...(timeAware
      ? [
          '【当前时刻补充】',
          `当前本地时间（你所在地）：${AMSG_SLOT_CURRENT_TIME}${tzNote ? `\n${tzNote}` : ''}${AMSG_SLOT_USER_CLOCK}${AMSG_SLOT_SCENE}`,
        ]
      // 关了时间感知的架空角色：整段只剩「你在做什么 / 外面什么样」，一个钟都不给。
      : [`【当前时刻补充】${AMSG_SLOT_SCENE}`]),
    // 排程清单跟在时间后面：它整段都在讲「几点会发生什么」，挨着当前时刻读才对得上。
    // 没有待触发任务时 worker 填空串，这一行连带消失。
    // 最后是「外面的世界此刻什么样」（节日 / 天气 / 热搜）：跟时间同属「此刻的读数」，
    // 一样由 worker 到点现拉现填，拉不到就整段消失。
    `${timeAware ? AMSG_SLOT_TIME_SINCE_USER : ''}${AMSG_SLOT_TASK_LIST}${AMSG_SLOT_REALTIME_WORLD}`,
    '',
    legacyHint,
    '',
    '【本次任务】',
    AMSG_SLOT_TASK_INSTRUCTION,
    '',
    // recency 末位人声锚：上面【角色系统设定】里已带「回到你自己」钢印，但被任务说明压在后面、
    // 失了 recency。这里在最后一句把它拎回来，让主动消息也从「你这个人」长出来，而不是滑回均值腔。
    `（开口前回到你自己：这条得是 ${char.name} 会发的那一条——语气、用词、节奏都只属于你。哪怕只是随口一句，也要是你。）`,
  ].join('\n');

  return {
    v: 6,
    template,
    lastUserMessageAt,
    // 角色的时间参照系（见上面的 tzId / userTzId）：前者是角色自己的钟，后者是用户那边的，
    // worker 渲染时两者各管各的一行，绝不混用。
    tzId,
    userTzId,
    targetName: userProfile.name || '对方',
    // 这份模板的身份戳：worker 用它判断云端那份「角色自己发过什么」还配不配得上
    // 当前上下文（见 amsgFirePack 的 selfLogMatchesPack）。每打一次包都是新值。
    builtAt: Date.now(),
    // 到点时角色要知道自己还挂着什么，才不会把同一件事再排一遍。这里带原始记录，
    // 渲染成人话由 worker 现场做（时间要按 tzId 换算，且得摘掉正在发的那条）。
    pendingTasks: getPendingTasks(char.activeMsg2Config, Date.now()),
    // 「此刻在做什么」也带原始素材：整天的作息表 + 歌单抽样池，worker 到点按 tzId
    // 挑当前时段。烤成文字的话，凌晨三点触发时角色会说「我在健身房呢」。
    scene,
  };
};

/**
 * 按任务生成「本次任务」指令——排程时写进 task metadata，worker 到点填槽。
 * 实现搬到了 amsgFireSchedule（worker 也要用同一份），这里转出去保持调用方不动。
 */
export { buildTaskInstruction } from './amsgFireSchedule';

/**
 * 首次发送时间 → 绝对时刻（UTC ISO）。
 *
 * 裸墙钟（`2026-08-03T09:00:00`，datetime-local 输入框和角色用工具排程时给的都是这种）
 * 按 tz 参照系解释，跟 worker 到点解析 send_at 是同一份规则（amsgFireSchedule.resolveSendAtMs）。
 * 各解各的话，纽约角色说的「明早九点」，前端按设备的东八区算成绝对时刻，worker 又按
 * 角色时区去理解，同一句话差整整一个时差。带 Z / ±hh:mm 后缀的照标注解析。
 */
const ensureFutureTime = (value: string, tzId: string) => {
  const ms = resolveSendAtMs(value, { tzId });
  if (Number.isNaN(ms)) {
    throw new Error('请选择有效的首次发送时间。');
  }
  if (ms <= Date.now()) {
    throw new Error('首次发送时间必须晚于当前时间。');
  }
  return new Date(ms).toISOString();
};

/**
 * 任务体里 messages 的占位内容。
 *
 * 服务端要求「completePrompt 或 messages」二选一、messages 非空、content 非空字符串，
 * 所以哪怕真正的 prompt 是到点才由 worker 下发的，排程时也得塞点东西过校验。
 * 写成一眼能认出来的标记：它要是出现在 worker 日志、模型输出或者聊天气泡里，
 * 就说明 worker 的 fire hooks 没生效（正常路径下它会被 onBeforeFire 的返回值覆盖）。
 */
const AMSG2_PLACEHOLDER_PROMPT =
  'AMSG2_PLACEHOLDER_PROMPT（正式 prompt 到点由 worker onBeforeFire 下发；看到这条说明 fire hooks 未生效）';

/** client_state 上传每次尝试前等多久：数组长度即总尝试次数（首次不等）。 */
const CLIENT_STATE_BACKOFF_MS = [0, 400, 1200];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 上传一批 client_state 条目：网络抖动重试，最终失败抛错——不降级。
 *
 * 为什么这一步是硬要求：worker 到点靠 fire_pack 拿新鲜上下文，「远端有任务、云端
 * 没状态」是个不该存在的中间态。过去这里失败只 warn，任务照建，到点用排程那一刻
 * 冻结的 prompt 发——用户不知道自己收到的是旧上下文。现在传不上去就让整个排程失败，
 * 由用户 / 角色重试。
 *
 * 被 worker 点名 rejected（体积超限等结构性原因）不重试：重试不会变好，直接把原因
 * 抛出来。注意 putClientState 失败有两种形态——抛异常和回 { success: false }，
 * 两种都要接住，只判 try/catch 会漏掉后者。
 */
export const putClientStateOrThrow = async (
  client: ReiClient,
  entries: Array<{ namespace: string; key: string; value: string; updatedAt: number }>,
  phase: string,
): Promise<void> => {
  let lastError: unknown;

  for (const backoffMs of CLIENT_STATE_BACKOFF_MS) {
    if (backoffMs) await delay(backoffMs);

    let response: { success?: boolean; data?: { rejected?: Array<{ key: string; message?: string }> }; error?: { message?: string } } | undefined;
    try {
      response = await client.putClientState(entries) as typeof response;
    } catch (error) {
      lastError = error;
      continue;
    }

    if (!response?.success) {
      lastError = new Error(response?.error?.message || `${phase}失败。`);
      continue;
    }

    const rejected = response.data?.rejected;
    if (rejected?.length) {
      throw new Error(
        `${phase}被 Worker 拒绝：${rejected.map((r) => `${r.key}(${r.message || 'rejected'})`).join('、')}。`
        + '请确认已部署最新的 Worker 代码（设置页有版本探测）。',
      );
    }
    return;
  }

  throw normalizeActiveMsgApiError(lastError, phase);
};

/**
 * 把一个 namespace 下还有内容的条目全部清空，返回被清掉的键名。
 *
 * 先读一遍再逐条写空，而不是照着已知键名盲写，有两个原因：
 *   1. 旁路存储的键名带 clientTaskId（`xhs_session:<id>`），任务记录被
 *      pruneStaleTasks 清掉之后就再也拼不出来，只能靠读回来才知道有哪些；
 *   2. 盲写会把本来不存在的条目 upsert 出来 —— putClientState 是 upsert，
 *      "清理" 反倒变成新建。
 *
 * 和 clearClientStateValue 一样是写空串而不是删行（HTTP 的 PUT /client-state 没有
 * 删除语义，value: null 会被当无效条目跳过），留下的是几字节的空壳，内容本身没了。
 */
export const clearNamespaceValuesOrThrow = async (
  client: ReiClient,
  namespace: string,
): Promise<string[]> => {
  // 全局 namespace 不许走这条路：里面的 tool_config 只在配置变更时才重传，被清成空壳
  // 之后没有任何一条路会把它补回来，而 worker 到点读不到它就整条任务硬失败。
  // 这个函数目前只服务「删角色」（每角色一个 namespace），加道护栏免得将来被顺手复用。
  if (namespace === AMSG_GLOBAL_NAMESPACE) {
    throw new Error('全局云端状态不能按 namespace 清空（tool_config 清掉就没人补了）。');
  }
  const response = await client.getClientState(namespace);
  if (!response?.success) {
    throw new Error(response?.error?.message || '读取云端状态失败。');
  }
  const entries = (response.data?.entries ?? []) as Array<{ key?: string; value?: string }>;
  // 已经是空壳的条目跳过：再写一遍不会更干净，只是白占一次请求体。
  const keys = entries.filter((e) => e?.key && e?.value).map((e) => e.key as string);
  if (keys.length === 0) return [];

  const now = Date.now();
  await putClientStateOrThrow(
    client,
    keys.map((key) => ({ namespace, key, value: '', updatedAt: now })),
    '清空云端状态',
  );
  return keys;
};

/**
 * 角色侧云端状态的两条条目（fire_pack + tool_pack）。
 *
 * 「哪个 namespace 配哪个 key 配哪个 build 函数」只在这里写一遍：排程和批量同步两条路
 * 都得把同一批东西写上去，各写各的话漏一条就是 worker 到点读不到 → 整条任务硬失败。
 */
const buildCharStateEntries = async (
  char: CharacterProfile,
  firePack: AmsgFirePack,
  updatedAt: number,
) => [
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_FIRE_PACK_KEY,
    // 压在加密之前：上游 putClientState 先加密再发，密文压不动（见 amsgFirePack）。
    value: await packStateValue(JSON.stringify(firePack)),
    updatedAt,
  },
  // v2 服务端工具循环的角色侧数据（recall 月度总结 / XHS 开关 / 角色名）。
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_TOOL_PACK_KEY,
    value: await packStateValue(JSON.stringify(buildToolPack(char))),
    updatedAt,
  },
];

/** 全局工具凭据条目（v2 服务端工具循环用的搜索 / Notion / 飞书 / 小红书 / 自配 MCP 配置）。 */
const buildToolConfigEntry = (
  realtimeConfig: RealtimeConfig | undefined,
  updatedAt: number,
) => ({
  namespace: AMSG_GLOBAL_NAMESPACE,
  key: AMSG_TOOL_CONFIG_KEY,
  // MCP 配置在这里现读现带：三条上传路径（排程 / fire_pack 冲刷 / 设置保存）
  // 全走这个咽喉，不会出现某条路漏带的版本分叉。
  value: JSON.stringify(buildToolConfig(realtimeConfig, {
    servers: collectMcpFireServers(),
    useNativeTools: getMcpUseNativeTools(),
  })),
  updatedAt,
});

/**
 * 现有推送订阅还能不能继续用；不能用的当场退订，返回 null 让调用方重新订阅。
 *
 * 两种「留着必失联」的形态：
 *   1. 死端点——浏览器把订阅僵尸化成 `permanently-removed.invalid` 哨兵，推必失败；
 *   2. 绑的 VAPID 公钥跟目标 worker 的不一致——换过 VAPID 后旧订阅还签着老公钥，
 *      worker 发推会被推送服务 403 拒掉。
 * 退订后要等浏览器清内部 removed 标记（SUBSCRIBE_SETTLE_MS），否则紧接着的
 * subscribe() 又拿到死哨兵。
 *
 * 判定口径与 instantPushClient.getOrCreateInstantSubscription /
 * proactivePushConfig.getOrCreateSubscription 的内联实现一致；那两处在各自文件里，
 * 将来合并时以这份抽出来的函数为准。export 供单测 mock pushManager 钉行为。
 */
export const dropStaleSubscription = async (
  sub: PushSubscription | null,
  targetVapidPublicKey: string,
): Promise<PushSubscription | null> => {
  if (!sub) return null;
  if (isDeadPushEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    await delay(SUBSCRIBE_SETTLE_MS);
    return null;
  }
  try {
    const existingKey = bytesToB64u(sub.options.applicationServerKey);
    if (existingKey && existingKey !== targetVapidPublicKey) {
      await sub.unsubscribe();
      await delay(SUBSCRIBE_SETTLE_MS);
      return null;
    }
  } catch {
    // 公钥读不出来（个别浏览器不暴露 options）就按可复用处理——
    // 与 instant / proactive 两处同款 fall-through。
  }
  return sub;
};

/**
 * 重置类操作的前置：Worker 地址填了、浏览器有推送能力、通知权限拿到了。
 *
 * 权限这一步会弹框（用户点的就是「重置订阅」，弹一次合理）；没给就直接抛，
 * 别硬着头皮往下走——没有权限 subscribe() 必然失败，报「订阅失败」会把用户
 * 引去查网络，实际上只要去站点设置里放开通知。
 */
const requirePushReady = async (): Promise<ActiveMsg2GlobalConfig> => {
  const capabilityGap = describePushCapabilityGap();
  if (capabilityGap) throw withFailKind(new Error(`${capabilityGap}。`), '不支持推送');

  const config = await ensureWorkerReady();

  let permission = Notification.permission;
  if (permission !== 'granted') permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw withFailKind(new Error('通知权限未授予，没法重建推送订阅。'), '权限被拒');
  }

  await KeepAlive.init();
  return config;
};

/** 退掉当前这条浏览器订阅，并等浏览器把内部的 removed 标记清完再返回。 */
const unsubscribeCurrentPush = async (): Promise<void> => {
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return;
    try { await existing.unsubscribe(); } catch { /* 退不掉也继续，下面重订会再试 */ }
    // 不等的话，紧接着的 subscribe() 大概率直接吐 permanently-removed.invalid 哨兵。
    await delay(SUBSCRIBE_SETTLE_MS);
  } catch (error) {
    console.warn('[ActiveMsg] 退订旧推送订阅时出错，继续重建', error);
  }
};

/**
 * 问 worker 要它自己签推送用的 VAPID 公钥。
 *
 * 各用户自部署 worker、各有各的 VAPID，运行时拉、不编译进前端。拿别人的公钥订阅，
 * worker 推的时候会 403。
 */
const fetchWorkerVapidKey = async (client: ReiClient): Promise<string> => {
  let vapidPublicKey: string;
  try {
    vapidPublicKey = await client.getVapidPublicKey();
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '获取 Worker VAPID 公钥');
  }
  if (!vapidPublicKey) {
    throw withFailKind(new Error('Worker 没返回 VAPID 公钥，请确认已配置 VAPID 并部署了最新 worker。'), 'worker没配VAPID');
  }
  return vapidPublicKey;
};

/**
 * 建一条新的浏览器推送订阅，拿不到活端点就抛。
 *
 * 走共用的 subscribeWithRetry 而不是 `ReiClient.subscribePush`：后者是裸的
 * `pushManager.subscribe()`，刚退订完的窗口期里浏览器会吐 permanently-removed.invalid
 * 哨兵，它照单收下——那个死端点一旦被登记进 worker，用户看到「订阅成功」，到点却一条
 * 都收不到，两边都没有任何报错。重试到底仍是僵尸的话挂 '端点僵尸' 代号，设置页据此
 * 把「重置订阅」升级成「深度重置」。
 */
/** 共用层的失败分类 → 上报用的失败代号。两边都是源码里写死的枚举。 */
const SUBSCRIBE_FAIL_KIND: Record<SubscribeFailureKind, AmsgFailKind> = {
  'channel-unreachable': '推送通道不通',
  unsupported: '不支持推送',
  permission: '权限被拒',
  state: '订阅失败',
  zombie: '端点僵尸',
  unknown: '订阅失败',
};

const subscribeOrThrow = async (
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription> => {
  const { sub, failure } = await subscribeWithRetry(registration, vapidPublicKey, ACTIVE_MSG_RUNTIME_HEADER);
  if (sub) return sub;
  // 提示原文（浏览器能力、重试了几次）留在 toast 和 console 里。挂上去的代号来自
  // 上面那张写死的表，不是从异常对象上读出来的任何东西。
  const message = failure?.text || '订阅创建失败';
  throw withFailKind(new Error(message), failure ? SUBSCRIBE_FAIL_KIND[failure.kind] : '订阅失败');
};

/** 重置的公共尾段：拿 worker 的 VAPID → 重新订阅 → 覆盖登记回 worker。 */
const resubscribeAndRegister = async (client: ReiClient): Promise<void> => {
  const vapidPublicKey = await fetchWorkerVapidKey(client);
  const registration = await navigator.serviceWorker.ready;
  const sub = await subscribeOrThrow(registration, vapidPublicKey);

  try {
    await client.putPushSubscription(sub);
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '登记推送订阅');
  }
};

/**
 * 带鉴权头请求 worker，同时把 HTTP 状态一起交出来。
 * 状态只有「连接」那条路用得上（401/404/其它要引导用户去改的地方不同），
 * 其余调用方走下面那层薄壳，签名跟以前一样只拿 body。
 */
const fetchWithAuthRaw = async (
  path: string,
  config: ActiveMsg2GlobalConfig,
  init: RequestInit,
  phase = '接口',
): Promise<{ status: number; body: any }> => {
  const headers = new Headers(init.headers);
  if (config.serverToken) headers.set('X-Client-Token', config.serverToken);
  headers.set('X-User-Id', config.userId);

  try {
    const response = await fetch(`${normalizeWorkerBase(config.workerUrl)}/${path}`, {
      ...init,
      headers,
    });

    return { status: response.status, body: await safeResponseJson(response) };
  } catch (error) {
    throw normalizeActiveMsgApiError(error, phase);
  }
};

const fetchWithAuth = async (path: string, config: ActiveMsg2GlobalConfig, init: RequestInit, phase = '接口') =>
  (await fetchWithAuthRaw(path, config, init, phase)).body;

const encryptPayload = async (client: ReiClient, payload: unknown) => {
  return (client as unknown as ReiCryptoBridge)._encrypt(JSON.stringify(payload));
};

const decryptPayload = async (client: ReiClient, payload: { iv: string; authTag: string; encryptedData: string }) => {
  return (client as unknown as ReiCryptoBridge)._decrypt(payload);
};

export const ActiveMsgClient = {
  async registerNativePushToken(token: string): Promise<void> {
    if (!nativePushBuildEnabled()) throw new Error('当前构建未开启 Capacitor 原生推送');
    const value = token.trim();
    if (!value) throw new Error('FCM registration token 为空');
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await client.putPushSubscription({ endpoint: `fcm:${value}` });
  },

  async getGlobalConfig() {
    return ensureGlobalReady();
  },

  // 生成 worker env 用的 AMSG_MASTER_KEY（32 字节 → 64 位 hex）。
  // 只在设置页展示给用户粘进 CF env，前端自己不存也用不到它。
  generateMasterKey(): string {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return Array.from(buf, (byte) => byte.toString(16).padStart(2, '0')).join('');
  },

  // 复制站点随 build 发布的 public/amsg-worker.bundle.js（Dashboard 粘贴部署用）。
  copyWorkerBundleToClipboard(): Promise<void> {
    return copyWorkerBundleToClipboard('amsg-worker.bundle.js');
  },

  // 复制 public/amsg-deno-proxy.ts —— 贴进 Deno Playground 当 worker 的门面用。
  // 走的是同一套「fetch 站点静态文件 → 剪贴板」，只是这份不打包、原样发布，
  // 因为用户要照着里面的注释改 UPSTREAM 那一行。
  copyDenoProxyToClipboard(): Promise<void> {
    return copyWorkerBundleToClipboard('amsg-deno-proxy.ts');
  },

  async getPushStatus(): Promise<ActiveMsg2PushStatus> {
    const config = await ensureGlobalReady();
    const workerConfigured = Boolean(config.workerUrl.trim());
    // 能力检测与 instant push / proactive push 共用 describePushCapabilityGap：
    // 它会说清缺的是三件套里的哪一件，「不支持」这三个字用户拿着没法action。
    const capabilityGap = describePushCapabilityGap();
    if (capabilityGap) {
      return {
        supported: false,
        permission: 'unsupported',
        hasSubscription: false,
        vapidConfigured: workerConfigured,
        detail: `${capabilityGap}。`,
      };
    }

    await KeepAlive.init();
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    return {
      supported: true,
      permission: Notification.permission,
      hasSubscription: Boolean(subscription),
      vapidConfigured: workerConfigured,
      detail: !workerConfigured ? '请先填写 Worker 地址。' : undefined,
    };
  },

  async ensurePushSubscription() {
    // 只需要「支不支持」这一个判断，不走 getPushStatus——那会把 KeepAlive.init /
    // serviceWorker.ready / getSubscription 整套先跑一遍，下面又原样跑一次。
    const capabilityGap = describePushCapabilityGap();
    if (capabilityGap) throw withFailKind(new Error(`${capabilityGap}。`), '不支持推送');

    const config = await ensureWorkerReady();

    let permission = Notification.permission;
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      throw withFailKind(new Error('通知权限未授予，无法创建主动消息 2.0 的推送订阅。'), '权限被拒');
    }

    await KeepAlive.init();
    const registration = await navigator.serviceWorker.ready;

    // **有旧订阅也要拉公钥**：换过 VAPID 后旧订阅绑的还是老公钥，无条件复用等于把一个
    // 必 403 的订阅继续写进新任务——自检就是拿目标公钥跟旧订阅比对（还有浏览器僵尸化
    // 的死端点），不合格先退订再重订（见 dropStaleSubscription）。
    const client = createClient(config);
    const vapidPublicKey = await fetchWorkerVapidKey(client);

    const existing = await registration.pushManager.getSubscription();
    const reusable = await dropStaleSubscription(existing, vapidPublicKey);
    if (reusable) return reusable.toJSON();

    return (await subscribeOrThrow(registration, vapidPublicKey)).toJSON();
  },

  /**
   * 把当前这个浏览器的推送订阅登记到 worker——一个用户一份，覆盖写。
   *
   * worker 到点投递时读的就是这一份，包括角色在 fire 里给自己排的、客户端根本
   * 不知道存在的那些任务。所以订阅换了端点只要覆盖这一份，已排的任务一条都不用
   * 碰；反过来说**排程前必须先登记过**，否则 worker 没地方推、直接拒绝建任务。
   *
   * 幂等：重复调用只是把同一份再写一遍，启动自检可以无脑调。
   *
   * 「一个用户一份」是有意为之，不是待修的限制：worker 上按 user_id 存单行，后登记的
   * 设备直接顶掉前一台，主动消息只会推到最后登记的那一台。所以不支持多设备同时收——
   * 一般也不会有人同时开着两台设备玩，真开了的话，「另一台不响了」就是正常现象。
   */
  async registerPushSubscription(): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const subscription = await this.ensurePushSubscription();
    try {
      await client.putPushSubscription(subscription);
    } catch (error) {
      throw normalizeActiveMsgApiError(error, '登记推送订阅');
    }
  },

  /**
   * worker 上登记的那份订阅现状（不含密钥，只有 endpoint 和登记时间）。
   *
   * 问不到一律返回 null、不抛：设置页的状态面板会反复调它，断网或者对面是台没有
   * 这个端点的旧 worker 时，面板显示「问不到」就够了，不该整块红着报错。
   */
  async getRemotePushSubscription(): Promise<AmsgRemotePushSubscription | null> {
    try {
      const config = await ensureWorkerReady();
      const client = await initializeClient(config);
      const response = await client.getPushSubscription();
      if (!response?.success) return null;
      const data = response.data;
      // 形状对不上就当问不到。旧 worker 什么都可能回，照着猜会把「没登记」显示成
      // 「已登记」——那正好是这一行要拆穿的故障，判反了还不如不显示。
      if (typeof data?.exists !== 'boolean') return null;
      return {
        exists: data.exists,
        endpoint: typeof data.endpoint === 'string' ? data.endpoint : null,
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : null,
      };
    } catch {
      return null;
    }
  },

  /**
   * 重置订阅：清掉现在这条，重新建一条，再覆盖登记回 worker。
   *
   * 三步缺一不可。只在浏览器重订不登记的话，worker 的 push_subscriptions 里还是
   * 旧端点，到点推给一个已经不存在的地址——界面全绿、一条消息都收不到，正是这个
   * 按钮要治的病，不能自己再犯一遍。
   */
  async resetPushSubscription(): Promise<void> {
    const config = await requirePushReady();
    const client = await initializeClient(config);

    // 先让 worker 忘掉旧的那行。失败不拦：下面重新登记本来就是覆盖写，删不掉也不
    // 影响结果，只是万一后面挂了，D1 里会多留一条已经没用的旧记录。
    try {
      await client.deletePushSubscription();
    } catch (error) {
      console.warn('[ActiveMsg] 重置订阅：删除 worker 上的旧订阅失败，继续重建', error);
    }

    await unsubscribeCurrentPush();
    await resubscribeAndRegister(client);
  },

  /**
   * 深度重置：在普通重置的基础上，把 Service Worker 整个注销再装一遍。
   *
   * 什么时候需要：Chromium 会把订阅锁死在内部的 MarkedForRemoval 状态，这时候
   * `pushManager.unsubscribe()` 清不掉标记，重订多少次都只会拿到
   * `permanently-removed.invalid`。唯一能从代码里走出来的路是换一个 SW 注册 id，
   * 绑在旧 id 上的坏记录自然失效。
   *
   * 副作用：SW 会短暂下线（1 秒上下），这期间来的推送是真丢。但会点这个按钮的前提
   * 就是「已经收不到了」，不存在把原本收得到的弄丢。主动消息 2.0 的排程存在 worker
   * 的 D1 里、跟 SW 无关，不用像 proactive-push 那样重新推排程回去。
   */
  async deepResetPushSubscription(): Promise<void> {
    const config = await requirePushReady();
    const client = await initializeClient(config);

    try {
      await client.deletePushSubscription();
    } catch (error) {
      console.warn('[ActiveMsg] 深度重置：删除 worker 上的旧订阅失败，继续重建', error);
    }

    await unsubscribeCurrentPush();

    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    } catch (error) {
      console.warn('[ActiveMsg] 深度重置：注销 Service Worker 失败，继续走重装', error);
    }

    try {
      await KeepAlive.reregister();
      await navigator.serviceWorker.ready;
    } catch (error) {
      throw withFailKind(
        new Error(`Service Worker 重新注册失败：${(error as Error)?.message || error}`),
        '订阅失败',
      );
    }

    await resubscribeAndRegister(client);
  },

  /**
   * 「连接并验证」的收尾：把浏览器当前的推送订阅补登记到这台 worker 上。
   *
   * 订阅存在 worker 自己的 D1 里（push_subscriptions，一个用户一行）。换一台 worker
   * 就是换一个空库，而浏览器这侧的订阅一个字都没变——SW 的 pushsubscriptionchange
   * 不会响，refreshPushSubscriptionIfMarked 也就没有标记可消费。于是面板全绿、连接
   * 验证通过，worker 到点却读不到订阅，直接抛 PUSH_SUBSCRIPTION_MISSING：消息一条
   * 都发不出来，用户这侧看不到任何异常。所以连接这一步顺手覆盖写一次。
   *
   * 只在**权限已授予且浏览器已有订阅**时补。没订阅说明用户还没走「开启通知与推送
   * 订阅」那步，那是引导流程该做的事——连接不替用户开推送，也不在这儿弹权限框。
   *
   * 返回值只为单测断言：'registered' 补了 / 'skipped' 条件不满足 / 'failed' 补失败了。
   */
  async reconcilePushSubscription(): Promise<'registered' | 'skipped' | 'failed'> {
    try {
      if (describePushCapabilityGap()) return 'skipped';
      if (Notification.permission !== 'granted') return 'skipped';
      await KeepAlive.init();
      const registration = await navigator.serviceWorker.ready;
      if (!await registration.pushManager.getSubscription()) return 'skipped';
    } catch {
      // 探测本身炸了（SW 没就绪 / 环境不支持）就算了，别为一句自检拦住连接。
      return 'skipped';
    }

    try {
      await this.registerPushSubscription();
      return 'registered';
    } catch (error) {
      // init-tenant 过了、鉴权也通了，连接本身是成功的，这里不能往外抛：否则用户
      // 会被指去改一堆根本没错的配置。补不上就等排程那步（scheduleTask 也会登记）。
      console.warn('[ActiveMsg] 连接后补登记推送订阅失败', error);
      return 'failed';
    }
  },

  // 单用户「连接」：先 POST /init-tenant 让 worker 在自己的 D1 里幂等建表
  // （Dashboard 粘贴部署的用户不用碰 SQL），再拿一次 user key 验证地址与鉴权都通，
  // 最后把推送订阅补登记上去（换 worker 后云端那份是空的，见 reconcilePushSubscription）。
  async connect() {
    const config = await ensureWorkerReady();

    // 先问 worker 配齐了没：缺 D1 绑定或 master key 的话，下面的 init-tenant 必然失败，
    // 而那一步只能按 HTTP 状态猜个大概（三种原因共用「建表失败」）。自检能直接说出
    // 缺的是哪一样、去哪儿补，用户不用再去翻 Cloudflare 的日志。
    const report = await inspectWorkerConfig(config);
    if (report && !report.ok) {
      throw withFailKind(new Error(report.message), '配置缺失');
    }

    const { status, body: initResponse } = await fetchWithAuthRaw('init-tenant', config, { method: 'POST' }, '初始化数据库');
    if (!initResponse?.success) {
      throw withFailKind(
        new Error(initResponse?.error?.message || '主动消息 2.0 初始化数据库失败，请确认 Worker 已绑定 D1（变量名 DB）。'),
        resolveInitFailKind(status),
      );
    }
    await initializeClient(config);
    await ActiveMsgStore.saveGlobalConfig({ ...config, initializedAt: Date.now() });
    await this.reconcilePushSubscription();
    const nativeToken = readNativePushToken();
    if (nativeToken) await this.registerNativePushToken(nativeToken);
    // warnings 是「连上了，但有一块功能是哑的」——比如 VAPID 没配齐，任务能建、到点
    // 却一条都推不出去。连接本身算成功，交给调用方提示，别拦住流程。
    return { ok: true, userId: config.userId, warnings: report?.warnings ?? [] };
  },

  // 分页全量：循环 messages?limit=100&offset=<n>，每页解密后读 tasks 与 pagination.hasMore，
  // 拉到最后一页为止。任一页失败整体抛错——不能拿半页结果去判「远端不存在」（会误伤没拉到的任务）。
  // 每条任务带上游投影的顶层 charId / clientTaskId，供按角色对账/关闭全部。
  async listAllTasks(): Promise<any[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);

    const all: any[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const response = await fetchWithAuth(`messages?limit=${limit}&offset=${offset}`, config, {
        method: 'GET',
        headers: {
          'X-Response-Encrypted': 'true',
          'X-Encryption-Version': '1',
        },
      }, '读取任务列表');

      if (!response?.success) {
        throw new Error(response?.error?.message || '读取主动消息 2.0 任务列表失败。');
      }

      const page = await decryptPayload(client, response.data);
      const pageTasks: any[] = page?.tasks || [];
      all.push(...pageTasks);

      if (!page?.pagination?.hasMore || pageTasks.length === 0) break;
      offset += limit;
    }
    return all;
  },

  /**
   * 某个角色在远端的任务投影（uuid + status + lastError），面板对账 / 失败可见化用。
   *
   * 老 worker（amsg-server < 2.6.0-next.5）不投影 charId：远端明明有任务，这里却一条都
   * 匹配不上。空结果此时不是「远端没有」的证据，直接抛错让调用方走各自的降级——面板
   * 对账整体关掉「远端不存在」徽标，关闭 2.0 退回本地全量清单——而不是拿半份证据误判。
   *
   * lastError 是 run-tick 记进 payload 的「上一次为什么没发出去」（2.6.0-next.10 起
   * GET /messages 透出；旧 worker 没有这字段 → null，界面上就是不显示那行说明）。
   */
  async listRemoteTasksForChar(charId: string): Promise<RemoteTaskProjection[]> {
    const tasks = await this.listAllTasks();
    if (tasks.length > 0 && tasks.every((t) => t?.charId == null)) {
      throw new Error('worker 版本过旧：任务列表没有 charId 投影，无法按角色对账，请在设置里重新粘贴部署。');
    }
    return tasks
      .filter((t) => t?.charId === charId && typeof t?.uuid === 'string')
      .map((t) => ({
        uuid: t.uuid as string,
        status: typeof t?.status === 'string' ? t.status as string : undefined,
        lastError: parseRemoteTaskLastError(t?.lastError),
        clientTaskId: typeof t?.clientTaskId === 'string' ? t.clientTaskId : undefined,
        messageType: typeof t?.messageType === 'string' ? t.messageType : undefined,
        recurrenceType: typeof t?.recurrenceType === 'string' ? t.recurrenceType : undefined,
        // 远端算出来的下一次触发时刻。循环任务按角色时区的墙钟推进，本地拿固定周期
        // 自己乘出来的那个跨夏令时会偏一小时——显示以远端为准，跟真正会响的时刻一致。
        nextSendAt: typeof t?.nextSendAt === 'string' ? t.nextSendAt : undefined,
      }));
  },

  /** 只要 uuid 的薄壳（删角色 / 关闭全部这些路径不关心 status / lastError）。 */
  async listRemoteTaskUuidsForChar(charId: string): Promise<string[]> {
    return (await this.listRemoteTasksForChar(charId)).map((t) => t.uuid);
  },

  /**
   * 取消一个远端任务。**幂等**：远端已经没有这一条（一次性任务发完就删行、或在别处
   * 取消过），amsg-server 回 404 `TASK_NOT_FOUND`，那正是取消要达到的终态，算成功并
   * 带上 alreadyGone=true 交给调用方——当失败处理会让「取消一条已经发过的任务」显示
   * 成红色的「远端取消失败，可重试」，其实没有任何东西需要重试。
   * 其余错误（鉴权、D1 挂了、网络）照常抛，别一起吞掉。
   */
  async cancelTask(taskUuid: string): Promise<{ uuid: string; alreadyGone: boolean }> {
    const config = await ensureWorkerReady();
    const response = await fetchWithAuth(`cancel-message?id=${encodeURIComponent(taskUuid)}`, config, {
      method: 'DELETE',
    }, '取消任务');

    if (!response?.success) {
      if (response?.error?.code === REMOTE_TASK_NOT_FOUND_CODE) {
        return { uuid: taskUuid, alreadyGone: true };
      }
      throw new Error(response?.error?.message || '取消主动消息 2.0 任务失败。');
    }

    return { uuid: taskUuid, alreadyGone: false };
  },

  /**
   * 取消某个角色在远端的全部任务（关闭 2.0 / 删角色共用）。
   *
   * 以远端清单为准：本地 pending 派生会漏掉「已过点但 Cron 还没消费」的一次性任务，
   * 只按本地清单取消会留下还会响的幽灵任务。远端读不到（网络故障 / 老 worker 没
   * charId 投影）才退回调用方给的本地清单——半份证据也比不取消强。
   *
   * 逐条取消，单条失败记进 failed 继续跑完其余的：一条网络抖动不该让剩下的任务都留着。
   */
  async cancelAllTasksForChar(
    charId: string,
    localTaskUuids: string[],
  ): Promise<{ targets: string[]; failed: Set<string> }> {
    let targets: string[];
    try {
      targets = await this.listRemoteTaskUuidsForChar(charId);
    } catch {
      targets = localTaskUuids;
    }
    const failed = new Set<string>();
    for (const uuid of targets) {
      try { await this.cancelTask(uuid); } catch { failed.add(uuid); }
    }
    return { targets, failed };
  },

  async scheduleCharacterTask(params: {
    char: CharacterProfile;
    /** 角色级共享设置（secondaryApi / maxTokens）。 */
    config: ActiveMsg2CharacterConfig;
    /** 本次要排的任务。 */
    task: {
      mode: ActiveMsg2Mode;
      firstSendTime: string;
      recurrenceType: ActiveMsg2Recurrence;
      promptHint?: string;
      userMessage?: string;
      expirePolicy?: ActiveMsg2ExpirePolicy;
    };
    /** 编辑/续期时传旧任务 uuid：先取消它再新建（不传 = 纯新建）。 */
    replaceTaskUuid?: string;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    apiConfig: APIConfig;
  }) {
    const { char, config, task, replaceTaskUuid, userProfile, groups, realtimeConfig, apiConfig } = params;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    // 任务体不带订阅，worker 到点读用户级那一份——所以建任务前先把它登记上去。
    const nativeToken = readNativePushToken();
    if (nativeToken) await this.registerNativePushToken(nativeToken);
    else await this.registerPushSubscription();

    // 数量封顶：待触发任务（不含被替换的那个）满 5 个就拒绝，让角色/用户先清。
    const pendingOthers = getPendingTasks(config, Date.now())
      .filter((t) => t.taskUuid !== replaceTaskUuid);
    if (pendingOthers.length >= MAX_ACTIVE_TASKS_PER_CHAR) {
      throw new Error(`该角色的待触发任务已达上限 ${MAX_ACTIVE_TASKS_PER_CHAR} 个，请先取消或合并已有任务。`);
    }

    // 角色的时间参照系：任务行、fire_pack、worker 渲染全用这一个，解析 send_at 也一样。
    const tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 裸墙钟在这里被折成绝对时刻。调用方要把这一份存进任务记录（见返回值 firstSendAt），
    // 别存自己手上那个墙钟串——角色写的是它那边的钟、面板填的是设备的钟，两种串长得一样，
    // 落盘后谁也认不出该按哪个时区读，本地一律 new Date() 按设备解析就会差一个时差。
    const firstSendTime = ensureFutureTime(task.firstSendTime, tzId);
    // AI 模式的 prompt 只有一条来源：firePack 上传 client_state，worker 到点现场填槽。
    // 任务体里不再冻结一份渲染好的 prompt——读不到 fire_pack 就直接报错，没有第二条路，
    // 留着那份快照只是白占请求体（完整角色卡 + 世界书）。
    const firePack = task.mode === 'fixed'
      ? null
      : await buildFirePack(char, userProfile, groups, realtimeConfig);
    // 防穿帮闸锚点：排程这一刻的最后一条真实用户消息（见 utils/amsg2ExpireGuard.ts）。
    // 与 fire_pack 的 lastUserMessageAt 同源，直接复用——各读各的就是同一段 200 条历史
    // 扫两遍。fixed 任务恒 force，锚点用不到，也就不必去读。
    const anchorMs = firePack?.lastUserMessageAt ?? 0;
    // 任务身份：客户端自造 clientTaskId——远端 uuid 要创建成功后才有，而 metadata
    // 必须在创建时就带上归属键；push 原样透传，送达归属全靠它。
    const clientTaskId = crypto.randomUUID();

    const remoteAvatarUrl = toRemoteAvatarUrl(char.avatar);
    const payload: Record<string, any> = {
      contactName: char.name,
      // 本地 base64 头像过不了 worker 的校验，不合格干脆不带这个字段（见 toRemoteAvatarUrl）。
      ...(remoteAvatarUrl ? { avatarUrl: remoteAvatarUrl } : {}),
      messageType: task.mode,
      messageSubtype: 'chat',
      firstSendTime,
      recurrenceType: task.recurrenceType,
      // 角色的时间参照系（与 fire_pack 同一份）。daily / weekly 由 worker 按这个时区的
      // 墙钟推进——固定加 24 小时的话，跨夏令时切换之后每天的触发时刻会永久偏一小时。
      tzId,
      metadata: {
        charId: char.id,
        charName: char.name,
        source: 'active_msg_2',
        // worker 满血链路的 onLLMOutput 拿不到任务顶层的 messageType，靠 metadata 透传
        // 还原 push.messageType（老任务没这字段时 worker 回退 'auto'，收侧只展示不路由）。
        amsgMode: task.mode,
        // 防穿帮闸字段：worker onBeforeFire 与客户端送达兜底都从这里读。
        // fixed 恒为 force——它走不了 worker 闸（taskNeedsLlm=false），语义统一钉死。
        // recurrenceType / occurrenceMs 不往这儿抄：库会把它们盖在每条 push 顶层，
        // 角色在 fire 里自排的任务也一样有，抄一份反而多一处会漏写的地方。
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: resolveExpirePolicy(task.mode, task.expirePolicy),
        amsgAnchorMs: anchorMs,
      },
    };

    if (task.mode === 'fixed') {
      const userMessage = task.userMessage?.trim();
      if (!userMessage) throw new Error('固定消息模式需要填写消息内容。');
      payload.userMessage = userMessage;
    } else {
      const activeApi = resolveApiConfig(char, config, apiConfig);
      // 「本次任务」指令随任务 metadata 走，worker 到点拿它填 fire_pack 的指令槽。
      payload.metadata.amsgTaskInstruction = buildTaskInstruction(task.mode, task.promptHint);
      // 服务端要求「completePrompt 或 messages」二选一，且 messages 必须非空、
      // content 必须非空字符串，所以这里给一条占位。到点真正发给 LLM 的 messages 由
      // worker 的 onBeforeFire 返回值覆盖（库用 { ...payload, messages } 调 LLM），
      // 这条内容永远不参与生成——它要是真出现在哪里，就说明 worker 的 fire hooks 没生效。
      payload.messages = [{ role: 'user', content: AMSG2_PLACEHOLDER_PROMPT }];
      payload.apiUrl = normalizeChatApiUrl(activeApi.baseUrl);
      payload.apiKey = activeApi.apiKey;
      payload.primaryModel = activeApi.model;
      if (config.maxTokens && config.maxTokens > 0) {
        payload.maxTokens = config.maxTokens;
      }
    }

    // ── 先传云端状态，成功了再建任务 ──
    // fire_pack / tool_pack 都按角色存、不依赖任务 id，所以顺序可以倒过来。倒过来的好处：
    // 上传失败时远端还没有任务，直接抛错就行，既不用回滚、也不会留下「用户看到排程失败、
    // 远端却会到点触发」的幽灵任务。反过来（先建后传）失败时只剩降级或回滚两条路，都更差。
    //
    // 反向的残留是无害的那一侧：上传成功但建任务失败 → 云端多一份没人引用的 fire_pack，
    // 不会被读（worker 只在 fire 某个任务时读它），下次同步直接覆盖。
    //
    // 大值（胖角色的完整角色卡 / 世界书）由 amsg-server 2.6.0-next.4+ 在 worker 存储层
    // 透明分块，客户端整条直传即可；老 worker 会拒超限条目 → putClientStateOrThrow 抛错。
    if (firePack) {
      const now = Date.now();
      await putClientStateOrThrow(client, [
        ...(await buildCharStateEntries(char, firePack, now)),
        buildToolConfigEntry(realtimeConfig, now),
      ], '上传云端状态');
    }

    const encrypted = await encryptPayload(client, payload);
    const response = await fetchWithAuth('schedule-message', globalConfig, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1',
      },
      body: JSON.stringify(encrypted),
    }, '创建任务');

    if (!response?.success) {
      throw new Error(response?.error?.message || '主动消息 2.0 任务创建失败。');
    }

    // 先建后删（Codex #4）：新任务确认创建成功才取消旧的——反过来一旦创建失败，
    // 旧任务已删、新任务没建，两头空。取消失败时新旧短暂并存于远端，把状态交还
    // 调用方（保留旧记录 + 标错 + 可重试），绝不静默。
    let replacedCancelFailed = false;
    if (replaceTaskUuid) {
      try {
        await this.cancelTask(replaceTaskUuid);
      } catch (error) {
        replacedCancelFailed = true;
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 替换后取消旧任务失败（远端新旧并存，待重试）`, error);
      }
    }

    return {
      ...(response.data as { uuid: string; status: string; nextSendAt?: string }),
      anchorMs,
      clientTaskId,
      replacedCancelFailed,
      // 解析好的绝对时刻（UTC ISO）。任务记录存这一份，字段口径才只有一种。
      firstSendAt: firstSendTime,
    };
  },

  // 同角色活跃会话租约：只 PUT 这一条几十字节的 chat_presence，不复用胖 fire_pack。
  // worker 对 expire AI 任务到点前先读它——新鲜则 skip，避免正在聊天时又弹主动消息。
  // 写入失败由调用方（amsgStateSync 的 lease timer）只 warn，45s TTL 自然失效。
  async syncChatPresence(charId: string, presence: AmsgChatPresence): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const response = await client.putClientState([{
      namespace: amsgStateNamespace(charId),
      key: AMSG_CHAT_PRESENCE_KEY,
      value: JSON.stringify(presence),
      updatedAt: presence.activeAt,
    }]);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传活跃会话租约失败。');
    }
  },

  // 满血同步：把一批角色的最新 fire_pack 合成一次 putClientState 上传（amsgStateSync
  // 去抖后调用；iOS 切后台只有几秒存活窗口，多角色也必须一次请求写完）。
  // 这里只是拿最新聊天状态去刷新云端那份，失败由调用方 warn（沿用上一份，上下文旧一点）。
  async syncCharFirePacks(items: Array<{
    char: CharacterProfile;
    config: ActiveMsg2CharacterConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
  }>): Promise<void> {
    if (!items.length) return;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const now = Date.now();
    // 表情包全库与角色无关，整批读一次就够——放在循环里的话 N 个角色要跑 2N 次全表
    // getAll（表情记录带图片数据），拿回来的还是同一份。
    const emojiLibrary = await readEmojiLibrary();
    const entries = [];
    // 逐个串行：并发跑会同时开 N 个 IDB 事务，正是 instant push 那次超时的连接风暴成因。
    for (const item of items) {
      const firePack = await buildFirePack(
        item.char, item.userProfile, item.groups, item.realtimeConfig, emojiLibrary,
      );
      // 大值由 amsg-server 2.6.0-next.4+ 在 worker 存储层透明分块，整条直传，
      // 内容一个字不裁；老 worker 拒超限条目 → 设置页 capabilities 探测亮牌。
      entries.push(...(await buildCharStateEntries(item.char, firePack, now)));
    }
    const response = await client.putClientState(entries);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传云端状态失败。');
    }
    // amsg-server 2.6.0-next.4+ 局部失败语义：单个坏条目只拒自己，不连坐同批。
    // 被拒的条目点名 warn 出来（该角色沿用上一份 fire_pack，其余角色不受影响）。
    const rejected = (response as { data?: { rejected?: Array<{ namespace: string; key: string; message?: string }> } })
      .data?.rejected;
    if (rejected && rejected.length > 0) {
      console.warn(
        `${ACTIVE_MSG_RUNTIME_HEADER} 云端状态部分条目被拒（对应角色沿用上一份 fire_pack）`,
        rejected.map((r) => `${r.namespace}/${r.key}: ${r.message || 'rejected'}`),
      );
    }
  },

  async syncToolConfig(realtimeConfig: RealtimeConfig | undefined): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const response = await client.putClientState([buildToolConfigEntry(realtimeConfig, Date.now())]);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传工具凭据失败。');
    }
  },

  // worker 特性探测（amsg-server 2.6.0-next.4+ 的 GET /capabilities）。
  // 老部署没有这个端点 → null。设置页用它亮「worker 需要重新粘贴部署」的牌子，
  // 防止版本落后时新特性静默降级、用户以为功能坏了。不需要 init（无加密参与）。
  async getCapabilities(): Promise<{ serverVersion: string; features: string[] } | null> {
    const globalConfig = await ensureWorkerReady();
    const client = createClient(globalConfig);
    return client.getCapabilities();
  },

  /**
   * 逐条 PUT update-message，返回成功数与失败的 uuid。
   * TASK_NOT_FOUND / TASK_ALREADY_COMPLETED 不算失败——远端已经没有 / 已完结的
   * 任务本来就没有「刷新」可言，正是不需要动的那一侧。单条失败继续跑完其余的
   * （口径同 cancelAllTasksForChar：一条网络抖动不该拖累剩下的任务）。
   */
  async updatePendingTasksRemote(
    taskUuids: string[],
    updates: Record<string, unknown>,
  ): Promise<{ updated: number; failed: string[] }> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    let updated = 0;
    const failed: string[] = [];
    for (const uuid of taskUuids) {
      try {
        const response = await client.updateMessage(uuid, { ...updates });
        const code = response?.error?.code;
        if (response?.success) {
          updated += 1;
        } else if (code !== 'TASK_NOT_FOUND' && code !== 'TASK_ALREADY_COMPLETED') {
          failed.push(uuid);
        }
      } catch {
        failed.push(uuid);
      }
    }
    return { updated, failed };
  },

  /**
   * 单角色版凭据刷新：面板保存后用。
   * 面板手里就有最新的角色级配置（onSave 落库是异步的，读 DB 会拿到旧的），
   * 所以这里让调用方把 config 和要刷的任务清单直接传进来；fixed 在这里再滤一遍，
   * 传错也不至于给固定消息塞凭据。
   */
  async refreshCharPendingAiTaskCredentials(params: {
    char: CharacterProfile;
    config: ActiveMsg2CharacterConfig;
    apiConfig: APIConfig;
    tasks: ActiveMsg2TaskRecord[];
  }): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const aiTaskUuids = params.tasks
      .filter((t) => t.mode !== 'fixed')
      .map((t) => t.taskUuid);
    if (aiTaskUuids.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const updates = resolveTaskCredentialUpdates(params.char, params.config, params.apiConfig);
    const { updated, failed } = await this.updatePendingTasksRemote(aiTaskUuids, updates);
    return { status: failed.length ? 'partial' : 'ok', updated, failed: failed.length };
  },

  /**
   * 聊天 API 配置保存后，把新凭据写回还会响的远端 AI 任务（设置页保存路径调）。
   * 任务体里的 apiUrl / apiKey / primaryModel 是排程那一刻冻结的——换了 Key、
   * 旧 Key 吊销后，已排程任务到点全部 401，用户只看到「主动消息怎么不来了」。
   *
   * 范围：开着 2.0（enabled !== false）且有 pending AI 任务（mode !== 'fixed'）的
   * 角色。fixed 不走 LLM 用不到凭据；关掉 2.0 的角色残留任务是「待取消」而不是
   * 「待续命」，不给它们续新凭据。生效凭据按 resolveTaskCredentialUpdates 算——
   * 开了单独 API 的角色写的是单独 API 的值，不会被全局配置覆盖。
   */
  async refreshApiCredentialsForPendingTasks(apiConfig: APIConfig): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const now = Date.now();
    const targets = (await DB.getAllCharacters())
      .filter((char) => isAmsg2EnabledForChar(char))
      .map((char) => ({
        char,
        config: char.activeMsg2Config ?? { enabled: true },
        aiTaskUuids: getPendingTasks(char.activeMsg2Config, now)
          .filter((t) => t.mode !== 'fixed')
          .map((t) => t.taskUuid),
      }))
      .filter((item) => item.aiTaskUuids.length > 0);
    // 没有要刷的任务直接返回：没配 2.0 的用户每次保存 API 不该多打一个请求。
    if (targets.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    let updated = 0;
    let failed = 0;
    for (const item of targets) {
      let updates: Record<string, unknown>;
      try {
        updates = resolveTaskCredentialUpdates(item.char, item.config, apiConfig);
      } catch (error) {
        // 这个角色的凭据配不齐（多半是单独 API 缺字段），整组记失败，别拦着其他角色。
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 角色凭据解析失败，跳过其任务的凭据刷新`, item.char.id, error);
        failed += item.aiTaskUuids.length;
        continue;
      }
      const result = await this.updatePendingTasksRemote(item.aiTaskUuids, updates);
      updated += result.updated;
      failed += result.failed.length;
    }
    return { status: failed ? 'partial' : 'ok', updated, failed };
  },

  /**
   * 角色资料改了之后，把跟着变的字段写回还会响的远端任务行（角色页保存的路径调）。
   *
   * **timeZone**：上游是按任务行里冻结的那份 tzId、以墙钟推进循环任务的下次触发时刻的
   * （tzId 缺省时才退回死加 24h）。fire_pack 里那份 tzId 每轮聊天都会重传，但它救不了
   * 任务行——不刷的话「每天 9:00」会一直按排程那天的时区走，角色改到纽约就成了当地晚上
   * 八九点，跨夏令时还会永久偏一小时；同一次 fire 里 prompt 用新时区、触发时刻用旧时区，
   * 两个钟直接打架。
   *
   * **contactName**：推送横幅标题「来自 X」。AI 模式的 fire 会从 tool_pack 取当前名字
   * （见 worker 的 onLLMOutput），但 fixed 模式不走 hooks，标题直接读任务行这一份。
   *
   * 范围是全部 pending 任务，**含 fixed**：固定文本的循环任务同样按墙钟推进、同样要弹
   * 横幅，所以不能沿用凭据刷新那边的 `mode !== 'fixed'` 过滤。
   *
   * fields 由调用方按「哪些真的变了」逐项开：任务行里存的可能是排程那一刻的快照，跟着
   * 别的操作顺手全刷的话，用户出差时保存一次配置就会把所有任务的时区悄悄挪走。
   */
  async refreshCharPendingTaskRow(
    char: CharacterProfile,
    fields: { timeZone?: boolean; contactName?: boolean },
  ): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const updates: Record<string, unknown> = {};
    // 关掉自定义时区也走这里：那时该回落到设备时区，跟排程时的算法保持同一份。
    if (fields.timeZone) {
      updates.tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    // 上游要求非空字符串，空名字传上去会被打回 400。
    if (fields.contactName && char.name?.trim()) updates.contactName = char.name;
    if (Object.keys(updates).length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const uuids = getPendingTasks(char.activeMsg2Config, Date.now()).map((t) => t.taskUuid);
    if (uuids.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const { updated, failed } = await this.updatePendingTasksRemote(uuids, updates);
    return { status: failed.length ? 'partial' : 'ok', updated, failed: failed.length };
  },

  /**
   * 取回 worker 旁路存下的一份云端状态（push 装不下的大内容，见 amsgXhsSessionKey）。
   * 键不存在、或者内容已被取走清空，都返回 null 交调用方决定——不要在这里编一个空壳
   * 出来，那会让「数据还没取回」和「本来就没有」变成同一件事。
   */
  async readClientStateValue(namespace: string, key: string): Promise<string | null> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await client.getClientState(namespace);
    if (!response?.success) {
      throw new Error(response?.error?.message || '读取云端状态失败。');
    }
    const entries = (response.data?.entries ?? []) as Array<{ key: string; value: string }>;
    const hit = entries.find((e) => e?.key === key);
    return hit?.value ? hit.value : null;
  },

  /**
   * 防穿帮闸最近一次拦下了哪次触发（没有记录 / 读不出来一律 null）。
   *
   * 闸跳过一次 fire 时不发任何 push，而远端那行任务照样被消费掉——客户端事后分不出
   * 「让路了」和「发出去但没收到」。这条记录就是 worker 留下的那句解释，面板照实说明。
   * 读失败按「没有记录」处理：这是一句锦上添花的说明，不该让面板打不开。
   */
  async readLastSkip(charId: string): Promise<AmsgLastSkip | null> {
    try {
      const value = await this.readClientStateValue(amsgStateNamespace(charId), AMSG_LAST_SKIP_KEY);
      return value ? parseLastSkip(value) : null;
    } catch {
      return null;
    }
  },

  /**
   * 往云端 client_state 的某个 namespace/key 上写一份内容（不存在就新建，已有就覆盖）。
   *
   * 云端状态的读写都从这个模块走：worker 地址、用户身份、鉴权初始化都在这里一处备齐，
   * 别处要写云端状态时调这个函数就行，不用自己再建一条连接。
   *
   * 写失败会抛错（内部带网络抖动重试），交调用方决定是重试还是放弃——静默吞掉的话
   * 云端留的就是上一份旧内容，而调用方以为自己已经写成功了。
   */
  async writeClientStateValue(namespace: string, key: string, value: string): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await putClientStateOrThrow(
      client,
      [{ namespace, key, value, updatedAt: Date.now() }],
      '写入云端状态',
    );
  },

  /**
   * 取回落库后把云端那份的内容清掉，腾回 D1 空间。
   *
   * 这里是**写空串**而不是删除整行：`value: null` 的删除语义只有 hook 侧的
   * `ctx.writeState` 有，HTTP 的 `PUT /client-state` 会把这条当无效条目跳过、
   * 内容原封不动（harness S6b 钉住了这个差异）。留一个几字节的空壳无所谓——键是
   * 每任务固定的，下次触发直接覆盖，存量本来就有上限。
   */
  async clearClientStateValue(namespace: string, key: string): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await client.putClientState([{ namespace, key, value: '', updatedAt: Date.now() }]);
  },

  /**
   * 清掉某个角色在云端 client_state 里的全部条目（fire_pack / tool_pack /
   * 活跃会话租约 / 旁路存的小红书会话），删角色时用。
   *
   * 为什么单独有这么一个：设置页的「清除云端状态」是全局的、要用户主动去点，
   * 删一个角色时该走的是只清这一个角色的路。返回被清掉的键名供调用方记账。
   */
  async clearCharClientState(charId: string): Promise<string[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    return clearNamespaceValuesOrThrow(client, amsgStateNamespace(charId));
  },

  /**
   * 清空该用户在 worker D1 里的全部 client_state（设置页「清除云端状态」按钮），
   * 清完立刻把全局工具凭据补回去。
   *
   * 为什么补传这一步是必须的：云端有三份数据，角色上下文与角色工具数据每轮聊完都会
   * 重新同步（见 syncCharFirePacks），只有全局的 tool_config 是「改的时候才传」——
   * 它没有别的补写时机。而 worker 到点三份缺一就硬失败（见 worker/amsg/src/index.ts
   * 的 fireStateError），于是清空之后已排程的 AI 任务会一直失败，聊多少轮天都不会好。
   *
   * 清空这个动作本身就是一次「云端凭据变没了」的变更，所以在这里就地补回来，
   * 不必让每轮同步都白传一遍。任务表跟 client_state 不在一起、不受清空影响，
   * 所以这也是「任务还活着、凭据却没了」的唯一入口，堵住这里就够。
   *
   * 补传失败不算清空失败（清空确实成功了），返回值把结果交给调用方去提示。
   */
  async clearClientState(
    realtimeConfig: RealtimeConfig | undefined,
  ): Promise<{ deleted: number; toolConfigRestored: boolean }> {
    const config = await ensureWorkerReady();
    const client = createClient(config);
    const response = await client.clearClientState();
    if (!response?.success) {
      throw new Error(response?.error?.message || '清除云端状态失败。');
    }
    const { deleted } = response.data as { deleted: number };

    let toolConfigRestored = true;
    try {
      const authed = await initializeClient(config);
      await putClientStateOrThrow(
        authed,
        [buildToolConfigEntry(realtimeConfig, Date.now())],
        '重新上传工具凭据',
      );
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 清空后补传工具凭据失败`, error);
      toolConfigRestored = false;
    }
    return { deleted, toolConfigRestored };
  },
};
