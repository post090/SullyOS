/**
 * 主动消息 2.0「满血」fire_pack：前端拼好的 prompt 模板 + 时间槽位的渲染。
 *
 * prompt 不在排程时定稿，而是前端把「除时间性内容外的完整模板」同步到 worker 的
 * client_state（namespace `amsg:char:<id>`，key `fire_pack`），worker 到点用
 * renderFirePack 现算时间填槽——上下文永远是最后一次聊天的状态。这份模块被两边共用：
 *   - 前端 activeMsgClient 的 buildFirePack（排程 / 每轮聊完同步时打包）
 *   - worker/amsg/src/index.ts 的 onBeforeFire（fire 时现场渲染）
 * 时间文案只此一份，两边的槽位定义保证一致。
 *
 * 多任务共用每角色一份 fire_pack：「本次任务」指令随任务 metadata 走、到点填槽（v2 起）。
 *
 * 零运行时依赖（worker bundle 会打进这份代码，别在这里 import 前端环境的东西；类型引用
 * 编译期擦除，不算）。除了压缩那几个函数用 CompressionStream / base64（浏览器和 Workers
 * 运行时都自带），其余都是纯函数。
 */

import type { ActiveMsg2TaskRecord } from '../types';
import { renderFireSceneBlock, type AmsgFireScene } from './amsgFireScene';

export const AMSG_STATE_NAMESPACE_PREFIX = 'amsg:char:';
export const amsgStateNamespace = (charId: string) => `${AMSG_STATE_NAMESPACE_PREFIX}${charId}`;
export const AMSG_FIRE_PACK_KEY = 'fire_pack';

/**
 * 角色到点自己发出去的那几条正文（每角色一份）。
 *
 * fire_pack 的【最近对话上下文】停在「用户最后一次聊天」那一刻，而主动消息发出去之后
 * 那份不会变——用户离线期间连着触发两次，第二次看到的上下文和第一次逐字一样，角色不知道
 * 自己刚说过什么，只能把同一句话换个说法再发一遍。worker 每次发完把正文追加到这里，
 * 下次到点连同 fire_pack 一起读回来，接在对话上下文后面。
 *
 * 用户重新聊天后客户端会传一份新的 fire_pack（新历史里本来就含这些消息），那时这份日志
 * 靠 basePackAt 对不上号自动作废，下一次 fire 直接覆盖成新的一份。
 */
export const AMSG_SELF_LOG_KEY = 'self_log';

/**
 * 大内容旁路：一条 push 塞不下的 XHS 会话数据（笔记详情 + xsecToken）存这个 key，
 * push 里只带 `metadata.xhsSessionRef` 指过来，客户端收到后按键取回、用完即删。
 *
 * 每个任务固定一份、下次触发直接覆盖——所以就算客户端一直没来取，存量也有上限，
 * 不需要额外的过期清理。worker 写（onLLMOutput）与客户端读（activeMsgRuntime）
 * 共用这一份键名，别在任何一侧另起炉灶。
 */
export const amsgXhsSessionKey = (clientTaskId: string) => `xhs_session:${clientTaskId}`;

// ─── client_state 的值压缩 ───
//
// fire_pack 是「角色完整系统提示词 + 最近 30 条对话」，一份 40KB 起步，排了任务的角色
// 每聊完一轮就整份重传一次。压缩必须发生在**交给上游加密之前**：上游 putClientState 是
// 先加密再发，密文近似随机、gzip 压不动（实测只能抵消 base64 那点膨胀，省 25%），
// 而在这里先压再交出去，同一份内容实测省 60%，D1 里存的也跟着变小。

/**
 * 压缩过的值的前缀。
 *
 * 不是版本兼容用的，是「这一份到底压没压」的标记：内容太短时压完反而更大，
 * packStateValue 会原样返回，读侧靠这个前缀分辨该不该解压。
 */
const GZIP_VALUE_PREFIX = 'gz1:';

/** 运行时有没有压缩能力（老 Safari 没有 CompressionStream）。 */
const canCompress = (): boolean =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

// btoa/atob 只吃 latin1 字符串，二进制要一个字节一个字符地喂。整段 apply 展开会在大数据上
// 爆调用栈，按块拼。
const CHUNK = 0x8000;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const streamThrough = async (data: Uint8Array, transform: TransformStream): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * 上传前把值压掉。压不动或运行时不支持时原样返回 —— 这个函数永远不该让同步失败，
 * 云端那份 fire_pack 是角色到点时唯一的上下文来源，为了省流量把它弄丢是本末倒置。
 */
export const packStateValue = async (json: string): Promise<string> => {
  if (!canCompress()) return json;
  try {
    const rawBytes = new TextEncoder().encode(json);
    const gz = await streamThrough(rawBytes, new CompressionStream('gzip'));
    const packed = `${GZIP_VALUE_PREFIX}${bytesToBase64(gz)}`;
    // 划算不划算按**字节**比，不能用 .length。fire_pack 几乎全是中文，一个字符占 3 个
    // UTF-8 字节，而压完的 base64 全是 ASCII（1 字符 = 1 字节）——拿字符数比的话，
    // 明明省掉一半流量的结果会被判成「压完更大」，于是一份都压不动。
    return packed.length < rawBytes.length ? packed : json;
  } catch {
    return json;
  }
};

/**
 * 读回来的值还原成 JSON 字符串。没有前缀的就是没压过的，原样返回。
 * 解压失败抛出去 —— 那说明数据真损坏了，不能当成正常内容往下走。
 */
export const unpackStateValue = async (value: string): Promise<string> => {
  if (!value.startsWith(GZIP_VALUE_PREFIX)) return value;
  const gz = base64ToBytes(value.slice(GZIP_VALUE_PREFIX.length));
  const raw = await streamThrough(gz, new DecompressionStream('gzip'));
  return new TextDecoder().decode(raw);
};

/**
 * 防穿帮闸最近一次拦下了哪次触发（每角色一份，新的盖旧的）。
 *
 * 闸是完全静默工作的：worker 判定「该让路」之后直接跳过这次 fire，一条 push 都不发。
 * 对用户来说，「让路了」和「发出去但没收到」「功能坏了」长得一模一样——远端那行任务
 * 两种情况下都会被消费掉，客户端事后无从分辨。
 *
 * 所以让 worker 在跳过时留一句话，客户端读回来照实说明。只留最近一次：这是给人看的
 * 「刚才为什么没响」，不是审计流水，攒着只会越积越多。
 */
export const AMSG_LAST_SKIP_KEY = 'last_skip';

/** last_skip 的原因枚举（新增值时 describeLastSkip 的人话文案要一起补）。 */
const LAST_SKIP_REASONS = [
  'active-chat-presence',
  'conversation-moved-on',
  'empty-generation',
  'side-effects-only',
  'stale',
] as const;

export interface AmsgLastSkip {
  v: 1;
  /** 被跳过的那条任务（uuid，拿不到时为 null）。 */
  taskUuid: string | null;
  /** 本该触发的时刻。 */
  occurrenceMs: number;
  /**
   * active-chat-presence  到点时用户正跟这个角色聊天
   * conversation-moved-on 排程之后对话已经往前走了，原本要说的话过时了
   * empty-generation      模型这次没写出任何能发的正文（空输出 / 纯拒答）
   * side-effects-only     模型这次只做了副作用（点赞、写日记之类）却没说话，整条不发
   * stale                 到点时已经过期太久（服务停摆后恢复），不再补发
   */
  reason: (typeof LAST_SKIP_REASONS)[number];
  skippedAt: number;
  /**
   * reason 为 stale 时补充这条任务的去向：
   *   expired        一次性任务，这一次永远不会补发了
   *   fast_forwarded 循环任务，攒下的这几次都跳过，排期已快进到 nextSendAtMs
   */
  staleAction?: 'expired' | 'fast_forwarded';
  /** 一并跳过了几次（含名义那一次）。 */
  skippedCount?: number;
  /** 循环任务快进到的下一次触发时刻；一次性任务没有下一次，为 null。 */
  nextSendAtMs?: number | null;
}

export const parseLastSkip = (value: string): AmsgLastSkip | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.occurrenceMs === 'number'
      && (LAST_SKIP_REASONS as readonly string[]).includes(parsed.reason)
    ) {
      return parsed as AmsgLastSkip;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/** 给人看的一句话：为什么那一次没响。 */
export const describeLastSkip = (skip: AmsgLastSkip, formatTime: (ms: number) => string): string => {
  const when = formatTime(skip.occurrenceMs);
  switch (skip.reason) {
    case 'active-chat-presence':
      return `${when} 那次主动消息让路了——到点时你正在和 ta 聊天。`;
    case 'conversation-moved-on':
      return `${when} 那次主动消息取消了——排程之后你们的对话已经聊到别处，原本要说的话过时了。`;
    case 'empty-generation':
      return `${when} 那次主动消息没发出来——ta 到点想了想，这次没写出要说的话。`;
    case 'side-effects-only':
      return `${when} 那次主动消息没发出来——ta 到点只顾着做事，一句话都没说，就没打扰你。`;
    case 'stale': {
      // 循环任务只是跳过了攒下的这几次，下一次照常响；一次性任务是真的没了。
      // 两句话分开说，不然用户会以为每日提醒已经死了。
      const times = skip.skippedCount && skip.skippedCount > 1 ? `连着 ${skip.skippedCount} 次` : '那次';
      if (skip.staleAction === 'fast_forwarded') {
        const next = skip.nextSendAtMs ? `，下一次 ${formatTime(skip.nextSendAtMs)} 照常` : '，下一次照常';
        return `${when} 起${times}主动消息没发——中间服务中断过，过期的就不补了${next}。`;
      }
      return `${when} 那次主动消息没发——到点时已经过去太久（服务中断过），过期的话就不补发了。`;
    }
  }
};

export const AMSG_SLOT_CURRENT_TIME = '{{AMSG_CURRENT_TIME}}';
export const AMSG_SLOT_TIME_SINCE_USER = '{{AMSG_TIME_SINCE_USER}}';
export const AMSG_SLOT_AWAY_HINT = '{{AMSG_AWAY_HINT}}';
export const AMSG_SLOT_TASK_INSTRUCTION = '{{AMSG_TASK_INSTRUCTION}}';
/**
 * 「对方那边现在几点」的落点，紧跟在角色自己的当前时间后面。
 *
 * 角色的钟按 tzId 走，用户的钟按 userTzId 走——异国恋角色排消息时只看得到自己那边的
 * 时间，很容易把「晚上九点聊两句」排到用户的凌晨三点。这一行给它一个参照。
 *
 * 两个时区一样时 worker 填空串（绝大多数角色都是这种），槽位连带消失：同一个钟报两遍
 * 只会让模型以为 prompt 里有两个打架的时间。
 */
export const AMSG_SLOT_USER_CLOCK = '{{AMSG_USER_CLOCK}}';
/**
 * 「这份上下文之后，角色自己又发过什么」的落点，紧跟在【最近对话上下文】后面。
 *
 * 槽位而不是把这段拼在整份 prompt 尾巴上：接在对话记录后面读起来才是一条时间线，
 * 挂在最后（本次任务指令之后）的话，角色多半会把它当成新指令的一部分。
 */
export const AMSG_SLOT_SELF_LOG = '{{AMSG_SELF_LOG}}';
/**
 * 「你现在还挂着哪些排程」的落点。
 *
 * 平时聊天时角色每轮都能看到这份清单（见 amsg2TaskContext 的排程现状块），到点生成时
 * 反而看不到——它因此不知道自己已经排了什么，容易把同一件事再排一遍，也没法在说话时
 * 避开「等下再跟你说 X」而 X 其实早就排在半小时后。这个槽位把同一份信息补到 fire 这边。
 */
export const AMSG_SLOT_TASK_LIST = '{{AMSG_TASK_LIST}}';
/**
 * 「你此刻在做什么」的落点：日程当前时段 + 由日程推出来的此刻在听的歌。
 *
 * 这两块以前跟着角色设定一起烤进模板，说的是打包那一刻的事——凌晨三点触发时角色
 * 会说「我在健身房呢」。改成随包带整天的作息表，worker 到点按角色时区现挑时段。
 */
export const AMSG_SLOT_SCENE = '{{AMSG_SCENE}}';
/**
 * 「外面的世界此刻什么样」的落点：今日节日 + 实时天气 + 热搜。
 *
 * 这一段前台每轮都有（见 realtimeWorldCore 的 renderRealtimeWorldBlock），到点生成
 * 也该有，但绝不能跟着模板一起烤进来——它抬头就写着「以下信息来自真实世界」，
 * 措辞比任何免责声明都硬，照着打包那一刻的读数说话就是大晴天叫人带伞、第二天还在
 * 祝七夕快乐。所以留成槽位，worker 到点现拉现填；拉不到就填空串，这一段整个消失。
 *
 * 注意这段里不带「当前时间」那一行：时间由 AMSG_SLOT_CURRENT_TIME 给，
 * 两处都出的话一份 prompt 里就有了两个钟。
 */
export const AMSG_SLOT_REALTIME_WORLD = '{{AMSG_REALTIME_WORLD}}';

export interface AmsgFirePack {
  v: typeof FIRE_PACK_VERSION;
  /** 完整 prompt 模板，时间性内容与本次任务指令留 AMSG_SLOT_* 槽位。 */
  template: string;
  /** 用户上次真实主动发消息的时间（epoch ms）；没有聊天记录时为 null。 */
  lastUserMessageAt: number | null;
  /**
   * 角色的 IANA 时区 id（角色开了自定义时区用角色的，没开用打包设备的）。
   * worker 渲染一切给角色看的时间都以它为参照系（Intl 处理夏令时）。必填：
   * 缺了整包按格式不对打回（parseFirePack → null，worker 抛 fire-state 错）。
   */
  tzId: string;
  /**
   * 打包这台设备的 IANA 时区 id，也就是「用户那边」的钟。
   *
   * 只用来渲染 AMSG_SLOT_USER_CLOCK 那一行参考——角色自己的一切时间仍按 tzId 走，
   * 这两个绝不能混着用。必填：缺了整包按格式不对打回（跟 tzId 同一条规矩）。
   */
  userTzId: string;
  /** 用户称呼（userProfile.name || '对方'），awayHint 文案用。 */
  targetName: string;
  /**
   * 这份模板打包的时刻（epoch ms），self_log 拿它当对齐锚点：日志里记的 basePackAt
   * 和这个值不一样，说明客户端之后又传了一份新模板，那几条正文已经在新的【最近对话上下文】
   * 里了，日志整份作废（见 selfLogMatchesPack）。
   */
  builtAt: number;
  /**
   * 打包时该角色还挂着的排程（客户端清单里的原始记录）。worker 到点渲染成
   * AMSG_SLOT_TASK_LIST 那一段，并把「正在发的这一条」摘掉。
   *
   * 和模板其余部分一样是「最后一次聊天时」的快照：用户中途在面板上取消了任务，这份要等
   * 下次同步才更新。角色到点自己排下的那些不在这里，由 worker 从 self_log 补上。
   */
  pendingTasks: ActiveMsg2TaskRecord[];
  /**
   * 「此刻在做什么」的原始素材（作息表 + 歌单抽样池），worker 到点渲染进
   * AMSG_SLOT_SCENE。没日程的角色为 null，那个槽位被抹平。
   */
  scene: AmsgFireScene | null;
}

// ─── 按角色参照系渲染时间（②：worker 给角色看的一切时间只此一份） ───

/** 「角色活在哪个参照系」：fire_pack 的 tzId（IANA 时区 id，Intl 管夏令时）。 */
export interface AmsgTzRef {
  tzId: string;
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  /** 0=周日 … 6=周六。 */
  weekday: number;
  hour: number;
  minute: number;
}

/**
 * nowMs 在 tz 参照系下的墙钟读数。全程 Intl（Workers 运行时带完整 ICU，
 * 严禁手搓时差加减——项目时区文档的红线）。tzId 非法直接抛错：parseFirePack 已经
 * 保证它非空，还解析不了就是数据坏了，走 fire 失败路径留痕，不静默给一个错的时间。
 */
export const wallClockPartsInZone = (nowMs: number, tz: AmsgTzRef): WallClockParts => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz.tzId,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // 个别环境用 24:00 表示午夜
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    weekday: weekdayIdx >= 0 ? weekdayIdx : 0,
    hour,
    minute: parseInt(map.minute, 10),
  };
};

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 时段词分桶照抄 buildTimeAwarenessBlock（utils/context.ts），两边说同一套话。 */
const timeOfDayWord = (h: number): string =>
  h < 5 ? '凌晨' : h < 9 ? '早晨' : h < 12 ? '上午' : h < 14 ? '中午'
  : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 22 ? '晚上' : '深夜';

const pad2 = (n: number) => n.toString().padStart(2, '0');

/** 当前时间槽用的自然中文全格式：`2026年8月1日 周六 早晨 08:00`（与 buildCoreContext 同款）。 */
export const formatFireTimeFull = (nowMs: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(nowMs, tz);
  return `${p.year}年${p.month}月${p.day}日 ${WEEKDAY_NAMES[p.weekday]} ${timeOfDayWord(p.hour)} ${pad2(p.hour)}:${pad2(p.minute)}`;
};

/** self_log 时间戳 / 排程清单用的短格式：`8月1日 08:00`（同一参照系，只是省地方）。 */
export const formatFireTimeShort = (nowMs: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(nowMs, tz);
  return `${p.month}月${p.day}日 ${pad2(p.hour)}:${pad2(p.minute)}`;
};

/**
 * 「对方那边现在几点」那一行（填进 AMSG_SLOT_USER_CLOCK）。
 *
 * 一份 prompt 里出现两个时间是很危险的，所以这一行把主语写死：上面那行是角色自己的
 * 当前时间，这一行明说是对方那边的。两个时区相同时返回空串——同一个钟报两遍，模型
 * 只会觉得这两个时间在打架。
 */
export const buildUserClockHint = (
  nowMs: number,
  charTz: AmsgTzRef,
  userTz: AmsgTzRef,
  targetName: string,
): string => {
  if (!userTz.tzId || userTz.tzId === charTz.tzId) return '';
  const p = wallClockPartsInZone(nowMs, userTz);
  const target = targetName || '对方';
  return `\n（对方所在时区参考：${target}那边现在是 ${p.month}月${p.day}日 ${timeOfDayWord(p.hour)} ${pad2(p.hour)}:${pad2(p.minute)}。`
    + `你们之间有时差，别拿自己这边的钟去推断 ${target} 此刻醒着还是睡着。）`;
};

/** 「距离用户上次主动发消息……」三档文案；diffMinutes 为 null 表示没有聊天记录。 */
export const formatTimeSinceUser = (diffMinutes: number | null): string => {
  if (diffMinutes == null) {
    return '你们最近没有新的聊天记录。';
  }
  const minutesTotal = Math.max(0, diffMinutes);
  if (minutesTotal < 60) {
    return `距离用户上次主动发消息大约 ${minutesTotal} 分钟。`;
  }
  if (minutesTotal < 1440) {
    const hours = Math.floor(minutesTotal / 60);
    const minutes = minutesTotal % 60;
    return `距离用户上次主动发消息大约 ${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}。`;
  }
  const days = Math.floor(minutesTotal / 1440);
  const hours = Math.floor((minutesTotal % 1440) / 60);
  return `距离用户上次主动发消息大约 ${days} 天${hours ? ` ${hours} 小时` : ''}。`;
};

/** legacyHint 里的「对方已经多久没来」变体，从 timeSinceUser 文案变换而来。 */
export const buildAwayHint = (targetName: string, timeSinceUser: string): string => {
  const target = targetName || '对方';
  if (timeSinceUser.includes('没有新的聊天记录')) return `${target}最近没有主动来找你说话。`;
  // 只借用里面那段时长，句子重新拼——照搬原句换个开头会读成「小明同学已经上次主动发消息大约 9 小时」。
  const span = timeSinceUser.match(/大约 (.+?)。?$/)?.[1];
  return span
    ? `${target}已经大约 ${span} 没主动来找你了。`
    : `${target}最近没有主动来找你说话。`;
};

// ─── self_log：角色自己发出去的那几条 ───

export interface AmsgSelfLogEntry {
  /**
   * 这条正文属于哪一次触发（`<clientTaskId>@<触发时刻>`）。
   *
   * 有它才能区分「同一次触发重跑」和「真的又发了一条」：fire 抛错会整条重跑
   * （worker 那边重试三次），追加式记录会把同一条消息记好几遍，角色下次读回来
   * 以为自己连发了三条。同 id 覆盖，重跑多少次都只留一条。
   */
  id: string;
  /** 发出去的时刻（epoch ms）。 */
  at: number;
  /** 正文（多段消息拼成一条记，超长截断）。 */
  text: string;
}

export interface AmsgSelfLog {
  v: 2;
  /** 写这份日志时云端 fire_pack 的 builtAt，见 AmsgFirePack.builtAt。 */
  basePackAt: number;
  entries: AmsgSelfLogEntry[];
  /**
   * 角色在这几次 fire 里给自己排下的任务（客户端还不知道它们存在）。
   *
   * 用途是让下一次 fire 的排程清单完整：fire_pack.pendingTasks 是打包那一刻的快照，
   * 之后角色自己排的都不在里面。没有这份的话，角色排完一条、下次到点又看不见它，
   * 很容易把同一件事再排一遍。
   *
   * 客户端上线重放 directive 之后，这些任务会进它的本地清单，下次同步就随
   * fire_pack.pendingTasks 一起上来——那时这份日志整份作废（basePackAt 对不上），
   * 不会两边各记一份。
   */
  tasks: ActiveMsg2TaskRecord[];
}

/** 最多留几条。再往前的对角色接话没帮助，只是白占 prompt。 */
export const SELF_LOG_MAX_ENTRIES = 8;
/** 单条正文留多长。主动消息本来就一两句，超出的部分基本是标签和长引用。 */
export const SELF_LOG_TEXT_MAX = 200;

export const createSelfLog = (basePackAt: number): AmsgSelfLog => ({
  v: 2,
  basePackAt,
  entries: [],
  tasks: [],
});

/** 记下角色刚给自己排的任务（同 uuid 覆盖，fire 重跑不会记重）。 */
export const appendSelfLogTask = (log: AmsgSelfLog, task: ActiveMsg2TaskRecord): AmsgSelfLog => ({
  ...log,
  tasks: [...log.tasks.filter((t) => t.taskUuid !== task.taskUuid), task],
});

/** 追加一条（同 id 覆盖、正文截断、只留最近 SELF_LOG_MAX_ENTRIES 条）。空正文原样返回。 */
export const appendSelfLogEntry = (log: AmsgSelfLog, entry: AmsgSelfLogEntry): AmsgSelfLog => {
  const text = entry.text.trim().slice(0, SELF_LOG_TEXT_MAX);
  if (!text) return log;
  const kept = log.entries.filter((e) => e.id !== entry.id);
  return { ...log, entries: [...kept, { ...entry, text }].slice(-SELF_LOG_MAX_ENTRIES) };
};

/**
 * 云端那份日志还配不配得上当前这份 fire_pack。
 *
 * 对不上就整份丢掉：客户端传新模板意味着用户又聊过（或角色资料变了重新打包），
 * 新模板的【最近对话上下文】是从本地聊天记录重读的，主动消息送达时 SW 已经写进库里，
 * 所以那几条正文本来就在里面。再叠一份日志就是同一段话在 prompt 里出现两次。
 */
export const selfLogMatchesPack = (log: AmsgSelfLog | null, pack: AmsgFirePack): boolean =>
  !!log && log.basePackAt === pack.builtAt;

export const parseSelfLog = (value: string): AmsgSelfLog | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' && parsed.v === 2
      && typeof parsed.basePackAt === 'number'
      && Array.isArray(parsed.tasks)
      && Array.isArray(parsed.entries)
      && parsed.entries.every((e: unknown) => {
        const entry = e as Partial<AmsgSelfLogEntry> | null;
        return !!entry && typeof entry.id === 'string'
          && typeof entry.at === 'number' && typeof entry.text === 'string';
      })
    ) {
      return parsed as AmsgSelfLog;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/**
 * 渲染进 AMSG_SLOT_SELF_LOG 的那一段。没有可写的就返回空串（槽位被抹掉，模板跟没这回事一样）。
 *
 * 开头两个空行是刻意的：槽位紧接在对话记录最后一行后面，不空开的话这段会黏成聊天记录的续行。
 */
export const renderSelfLogBlock = (log: AmsgSelfLog | null, tz: AmsgTzRef): string => {
  if (!log || log.entries.length === 0) return '';
  return [
    '',
    '',
    '【这之后你又主动发过（对方还没回）】',
    ...log.entries.map((e) => `- ${formatFireTimeShort(e.at, tz)}　${e.text}`),
    '（这几条是你自己发出去的，对方一直没回应。往下接着说，别把已经说过的话换个说法再讲一遍，也别假装这些没发生过。）',
  ].join('\n');
};

const fillSlot = (text: string, slot: string, value: string) => text.split(slot).join(value);

/**
 * 连排提醒（对方未回应期间的第 x 条）插在哪一行前面。
 * 【本次任务】是模板里任务指令段的固定标题（activeMsgClient 的模板写死这一行）。
 */
const TASK_SECTION_HEADING = '【本次任务】';

/** x ≥ 2 时的边界提醒（不做强制拦截，force/expire 一视同仁）。export 只为单测。 */
export const buildStreakReminder = (x: number): string =>
  `（这是你在对方未回应期间发出的第 ${x} 条主动消息。请注意边界：若要继续安排新的消息，考虑对方的需求和实际观感。）`;

/**
 * 用 nowMs 时刻的时间信息填掉模板里的全部槽位，得到最终可发给 LLM 的 prompt。
 * taskInstruction 由排程时写进任务 metadata（见 activeMsgClient.buildTaskInstruction），
 * worker 读不到就先抛错，所以这里按必填收。
 *
 * 另外两块由调用方现算好传进来（都不传时对应槽位被抹平，输出与没有这回事时一致）：
 *   selfLog       这份上下文之后角色自己发过什么，先用 selfLogMatchesPack 对齐过；
 *   taskListBlock 「你现在还挂着哪些排程」那一段，见 amsg2Tasks.buildFireTaskListBlock。
 *   文案住在 amsg2Tasks 而不是这里：那边已经有一整套给人看的任务描述（面板、
 *   排程现状块、list 工具共用），同一件事不该有第二套说法。
 *   realtimeWorldBlock 到点现拉的节日 / 天气 / 热搜，见 realtimeWorldCore.renderRealtimeWorldBlock。
 *
 * 连排提醒：selfLog 里已有 n 条「对方未回应期间发出的」正文时，本条是第 x = n+1 条；
 * x ≥ 2 时在【本次任务】前插一行边界提醒（见 buildStreakReminder）。
 */
export const renderFirePack = (
  pack: AmsgFirePack,
  nowMs: number,
  taskInstruction: string,
  extras?: { selfLog?: AmsgSelfLog | null; taskListBlock?: string; realtimeWorldBlock?: string },
): string => {
  const tz: AmsgTzRef = { tzId: pack.tzId };
  const currentTime = formatFireTimeFull(nowMs, tz);
  const diffMinutes = pack.lastUserMessageAt == null
    ? null
    : Math.max(0, Math.floor((nowMs - pack.lastUserMessageAt) / 60_000));
  const timeSinceUser = formatTimeSinceUser(diffMinutes);
  const awayHint = buildAwayHint(pack.targetName, timeSinceUser);

  let out = pack.template;
  const streak = (extras?.selfLog?.entries.length ?? 0) + 1;
  if (streak >= 2) {
    out = out.replace(TASK_SECTION_HEADING, `${buildStreakReminder(streak)}\n${TASK_SECTION_HEADING}`);
  }
  out = fillSlot(out, AMSG_SLOT_CURRENT_TIME, currentTime);
  // 对方那边的钟：跟上面那行是两个主体各自的时间，文案里各自写清主语（见 buildUserClockHint）。
  out = fillSlot(out, AMSG_SLOT_USER_CLOCK, buildUserClockHint(nowMs, tz, { tzId: pack.userTzId }, pack.targetName));
  out = fillSlot(out, AMSG_SLOT_TIME_SINCE_USER, timeSinceUser);
  out = fillSlot(out, AMSG_SLOT_AWAY_HINT, awayHint);
  out = fillSlot(out, AMSG_SLOT_TASK_INSTRUCTION, taskInstruction);
  out = fillSlot(out, AMSG_SLOT_SELF_LOG, renderSelfLogBlock(extras?.selfLog ?? null, tz));
  out = fillSlot(out, AMSG_SLOT_TASK_LIST, extras?.taskListBlock ?? '');
  out = fillSlot(out, AMSG_SLOT_SCENE, renderFireSceneBlock(pack.scene, nowMs, tz));
  // 实时世界那一段是独立的一整块，前导空行在这里补：拉到东西才隔开成段，
  // 没拉到（或功能没开）填空串，输出跟没有这个槽位时一模一样。
  const realtimeWorld = extras?.realtimeWorldBlock?.trim();
  out = fillSlot(out, AMSG_SLOT_REALTIME_WORLD, realtimeWorld ? `\n\n${realtimeWorld}` : '');
  return out;
};

/**
 * 当前 fire_pack 的版本号。前端打包写它，worker 只认它。
 *
 * 版本不匹配一律整包打回，不做任何形状兼容——两边永远同一次发布上线。
 * 唯一的例外是「说清楚为什么」：见 describeFirePackVersion，worker 拿它拼失败原因，
 * 面板的 lastError 才能直接告诉用户该重贴 bundle 还是该刷新前端。
 */
export const FIRE_PACK_VERSION = 6;

/**
 * 解析失败时给人看的一句原因。
 *
 * 存在的理由：升 fire_pack 版本需要 worker bundle 和前端一起动，而设置页的版本门槛读的是
 * **上游 amsg-server 库**的版本号——只改 SullyOS 自己的 worker 代码时那个号不动，门槛不会亮。
 * 没有这句话的话，用户忘了重贴 bundle 时看到的只有「格式不对或数据损坏」，完全不知道该做什么。
 */
export const describeFirePackVersion = (value: string): string => {
  let v: unknown;
  try { v = JSON.parse(value)?.v; } catch { return '不是合法 JSON（数据损坏）'; }
  if (v === FIRE_PACK_VERSION) return '版本号对得上，是别的字段不合格式（数据损坏）';
  if (typeof v === 'number' && v < FIRE_PACK_VERSION) {
    return `包是 v${v}、worker 要 v${FIRE_PACK_VERSION} —— 前端比 worker 旧，打开一次网页让它重新上传`;
  }
  if (typeof v === 'number') {
    return `包是 v${v}、worker 只认 v${FIRE_PACK_VERSION} —— worker bundle 是旧的，去设置页重新粘贴部署`;
  }
  return '包里没有版本号（数据损坏）';
};

/** worker 侧从 client_state 读回的 value 解析成 fire_pack；形状不对返回 null（调用方抛错）。 */
export const parseFirePack = (value: string): AmsgFirePack | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' &&
      parsed.v === FIRE_PACK_VERSION &&
      typeof parsed.template === 'string' && parsed.template.length > 0 &&
      (parsed.lastUserMessageAt === null || typeof parsed.lastUserMessageAt === 'number') &&
      typeof parsed.tzId === 'string' && parsed.tzId.length > 0 &&
      typeof parsed.userTzId === 'string' && parsed.userTzId.length > 0 &&
      typeof parsed.targetName === 'string' &&
      typeof parsed.builtAt === 'number' &&
      Array.isArray(parsed.pendingTasks) &&
      (parsed.scene === null || typeof parsed.scene === 'object')
    ) {
      return parsed as AmsgFirePack;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};
