/**
 * 角色在「到点生成主动消息」那一刻给自己排下一条的工具。
 *
 * 前台聊天里角色已经有 schedule_active_message（见 amsg2ToolBridge），这里用同一个名字、
 * 同一套参数把它开到 fire 侧——角色不用学第二套东西，两端说的是同一件事。差别只在执行：
 * 前台走客户端 API，fire 侧走 amsg-server 的 ctx.scheduleTask 直接在 D1 建行，用户离线
 * 也照样排得上（这正是整件事的意义：连着说两句不需要用户在线当中转）。
 *
 * 零运行时依赖（worker bundle 会打进这份代码）：只有纯函数和常量。
 */

import type { ActiveMsg2ExpirePolicy, ActiveMsg2Mode, ActiveMsg2Recurrence } from '../types';
import { type AmsgTzRef, formatFireTimeShort, wallClockPartsInZone } from './amsgFirePack';
import { wallClockToTimestamp } from './timezone';

/** 与前台同名，故意的：见文件头。 */
export const AMSG_FIRE_SCHEDULE_TOOL = 'schedule_active_message';

/**
 * 单次 fire 最多让角色排几条。
 *
 * 上游库自己也有一道同名护栏（默认 2），这里保持一致、不额外收紧：真排爆了是角色的问题，
 * 不是链路该替它兜的。留在这里是为了在打回时能给出一句人话，而不是让上游抛 RangeError
 * 把整条 fire 弄失败——那样用户连本来能收到的那条消息都没了。
 */
export const MAX_FIRE_SCHEDULES = 2;

/**
 * 防穿帮策略的说明，前台工具和 fire 侧共用这一份。
 *
 * 分界线不是「谁提的」，是「到点要说的是一件具体的事，还是只是想找话说」：
 * 想找话说的，用户人回来了就该让路；许过的具体承诺（不管是用户要求的还是角色自己说的），
 * 用户中途回来聊过天也不影响它该响。早先这段只写了「用户明确要求的闹钟」，把角色自己
 * 许下的承诺挡在外面了——「汤炖上了两小时后叫你」会被判成该让路，然后再没人提起。
 */
export const EXPIRE_POLICY_DESCRIPTION = [
  '防穿帮策略。',
  'expire（默认，大多数情况用它）：到点时如果排程之后对话已有新进展、或用户此刻正在聊天，这条自动作废——之后你会在排程现状里看到，由你决定自然带出、续期还是放弃。',
  '挑话题、想找人聊天这类「想说点什么」的排程一律用它：用户人都回来了，你还照着几小时前的想法开口，会很假。',
  'force：不管用户在不在聊天都照发。用在「到那个点必须说这件具体的事」上，两种来源都算——用户明确要求的（如"8点叫我起床"），以及你自己许下的（如"汤炖上了，两小时后好了叫你""你那个会我到点提醒你"）。',
  '这类兑现的是一个具体承诺，用户中途回来聊过天也不影响它该响。',
].join('\n');

/** fire 侧的工具描述：比前台那份多两句「你现在正在发消息」的语境。 */
const FIRE_TOOL_DESCRIPTION = [
  '给自己排下一条主动消息：到指定时间后你会再根据那时的上下文生成一条推送给用户。',
  '你现在正在发一条主动消息，这个工具让你把话接着往下说——比如这条先说一半，过一两个小时再接上去；或者你说了要去做某件事，做完的时间点回来告诉用户。',
  '排下的这条到点时会知道你这次说了什么，能接得上，不用在参数里复述。',
  'send_at 是开始生成的时间，不是送达时间（生成有十几秒延迟），且必须至少比现在晚 1 分钟。',
  `一次最多排 ${MAX_FIRE_SCHEDULES} 条；每个角色同时挂的任务也有上限，排不下时会告诉你。`,
  '没有「接着说」的必要就别排——为了排而排出来的后续，用户读起来就是没话找话。',
].join('\n');

export interface FireScheduleToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 工具声明 / 说明块的时间上下文：示例按「明天这个点」现算，参照系跟 fire_pack 走。 */
export interface FireScheduleTimeOpts {
  nowMs: number;
  tz: AmsgTzRef;
}

const buildParameters = (example: string) => ({
  type: 'object',
  properties: {
    send_at: {
      type: 'string',
      description: `开始生成的时间，写你本地的墙钟时间、不带时区后缀（如 ${example}），系统按你所在的时区理解。至少比当前时间晚 1 分钟。排之前先想想对方那边是几点——你们之间可能有时差，别把消息排到对方的深夜。`,
    },
    mode: {
      type: 'string',
      enum: ['auto', 'prompted'],
      description: '生成模式。auto=到点根据那时的上下文自由发挥；prompted=围绕 prompt_hint 的方向说。默认 auto。',
    },
    prompt_hint: {
      type: 'string',
      description: '给未来那条消息的方向，如"接着刚才那只猫的话往下说""告诉他汤炖好了"。mode=prompted 时必填。',
    },
    recurrence: {
      type: 'string',
      enum: ['none', 'daily', 'weekly'],
      description: '重复类型。none=一次性（默认）；daily/weekly=每天/每周同一时间。',
    },
    expire_policy: {
      type: 'string',
      enum: ['expire', 'force'],
      description: EXPIRE_POLICY_DESCRIPTION,
    },
  },
  required: ['send_at'],
});

export const buildFireScheduleTool = (opts: FireScheduleTimeOpts): FireScheduleToolDef => ({
  type: 'function',
  function: {
    name: AMSG_FIRE_SCHEDULE_TOOL,
    description: FIRE_TOOL_DESCRIPTION,
    parameters: buildParameters(
      buildSendAtExample(opts.nowMs, opts.tz),
    ) as unknown as Record<string, unknown>,
  },
});

/**
 * 拼进 prompt 的说明块。
 *
 * native 模式只说「有这么个能力、什么时候用」——工具签名已随请求声明，再教一遍正文语法
 * 反而勾引模型往正文里写（与 buildMcpFireBlock 同一个判断）。text 模式（用户的中转拒
 * tools）才教语法。
 */
export const buildFireScheduleBlock = (mode: 'native' | 'text', opts: FireScheduleTimeOpts): string => {
  const howTo = mode === 'native'
    ? `需要时通过系统的工具调用接口发起 ${AMSG_FIRE_SCHEDULE_TOOL}，不要把工具名和参数写进正文。`
    : `需要时单独输出一行 ${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"${
      buildSendAtExample(opts.nowMs, opts.tz)
    }","prompt_hint":"接着说"})（send_at 写你本地的墙钟时间，不带时区后缀），系统会代为安排并把结果告诉你。`;
  return [
    '',
    '---',
    '【你可以给自己排下一条】',
    '这条消息发完，如果还有话要在之后某个时间点说（把没说完的接上去、或者去做的事做完了回来告诉他），',
    '可以现在就把那一条排好——不需要用户在线，到点会自动发出去，而且那时你会知道自己这次说了什么。',
    howTo,
    // 角色在 prompt 里只看得到自己那边的钟，很容易把「晚上聊两句」排到对方的凌晨三点。
    // 对方那边此刻几点写在【当前时刻补充】里（有时差时才有那一行）。
    '定时间之前先想想对方那边是几点：你们之间可能有时差，别把消息排到对方的深夜。',
    '没必要就别排。为了排而排出来的后续，读起来就是没话找话。',
  ].join('\n');
};

/**
 * 把「模式 + 提示方向」拼成写进任务 metadata 的那句指令，worker 到点填进 prompt 的
 * 【本次任务】槽位。
 *
 * 住在这里而不是 activeMsgClient：排程有两条路（用户在面板上排 / 角色自己排，后者还分
 * 前台工具和 fire 里的工具），三条路必须写出一模一样的指令，不然同一个 mode 在不同入口
 * 生成出来的消息方向会不一样。activeMsgClient 带一堆浏览器依赖，worker 引不动。
 */
export const buildTaskInstruction = (mode: ActiveMsg2Mode, promptHint?: string): string => {
  if (mode === 'prompted') {
    return [
      '这是一条需要 AI 参与生成的主动消息。',
      '请严格围绕下面的额外提示发起私聊，但仍然保持像真人一样自然，不要像系统任务汇报。',
      `额外提示：${promptHint?.trim() || '无'}`,
    ].join('\n');
  }
  return [
    '这是一条需要 AI 自主生成的主动消息。',
    '请结合角色设定、关系状态、最近上下文与当前时间，自然地主动找用户说一到三句私聊消息。',
    promptHint?.trim() ? `可选灵感补充：${promptHint.trim()}` : '可选灵感补充：无',
  ].join('\n');
};

// ─── send_at 的时间参照系 ───
//
// 角色在 prompt 里看到的钟是自己时区的（fire_pack 的 tzId），它写出来的 send_at
// 也是那个参照系的墙钟。worker 跑在 UTC，直接 new Date('2026-08-01T09:00:00')
// 会按 UTC 解析——「明早 9 点」实际差整整一个时差。规则：
//   - 带 Z / ±hh:mm 后缀的照旧按标注的时区解析（模型硬要写也不算错）；
//   - 裸 datetime 按 tz 参照系的墙钟解析（tzId 走 Intl 逆解，禁手搓偏移）。

const pad2 = (n: number) => n.toString().padStart(2, '0');

/** send_at 串尾带没带显式时区（Z 或 ±hh:mm / ±hhmm）。 */
const hasExplicitOffset = (s: string): boolean => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());

/** ms 在 tz 参照系下的裸墙钟 ISO（无时区后缀），工具描述里的示例 / 打回文案用。 */
export const wallClockIso = (ms: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(ms, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:00`;
};

/** 给模型看的 send_at 示例：明天这个点的裸墙钟——别再教它写 +08:00 之类的 offset。 */
export const buildSendAtExample = (nowMs: number, tz: AmsgTzRef): string =>
  wallClockIso(nowMs + 24 * 3600_000, tz);

/** send_at 串 → epoch ms（解析不出 NaN）。规则见上面这段注释。 */
export const resolveSendAtMs = (raw: string, tz: AmsgTzRef): number => {
  const text = raw.trim();
  if (hasExplicitOffset(text)) return new Date(text).getTime();
  return wallClockToTimestamp(text, tz.tzId);
};

// ─── 参数校验 ───

export interface FireScheduleRequest {
  sendAt: string;
  mode: ActiveMsg2Mode;
  promptHint?: string;
  recurrence: ActiveMsg2Recurrence;
  expirePolicy: ActiveMsg2ExpirePolicy;
}

/** 校验失败时回给模型的形状（与内置工具的失败语义一致：ok:false + 一句能照做的话）。 */
export interface FireScheduleReject {
  ok: false;
  reason: string;
  message: string;
}

/** 上游要求至少提前 60 秒（cron 一分钟一跳）。这里留同样的线，好在打回时说人话。 */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

const MODES: ActiveMsg2Mode[] = ['auto', 'prompted'];
const RECURRENCES: ActiveMsg2Recurrence[] = ['none', 'daily', 'weekly'];

/**
 * 把模型给的参数收成一份能用的请求，或者给出一句「你哪里写得不对、该怎么改」。
 *
 * 一律不抛错：这是模型写出来的东西，写歪很正常，回喂让它改比让整条 fire 失败强得多
 * （fire 失败 = 任务重跑 = 用户这一次一个字都收不到）。
 *
 * tz 是角色的时间参照系（fire_pack 的 tzId）：裸 send_at 按它的墙钟解析，
 * 打回文案里的时间也用它说人话。
 */
export const parseFireScheduleArgs = (
  args: Record<string, unknown>,
  nowMs: number,
  tz: AmsgTzRef,
): FireScheduleRequest | FireScheduleReject => {
  const example = buildSendAtExample(nowMs, tz);
  const sendAtRaw = args?.send_at;
  if (typeof sendAtRaw !== 'string' || !sendAtRaw.trim()) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at 必填，写你本地的墙钟时间（如 ${example}）。` };
  }
  const sendAtMs = resolveSendAtMs(sendAtRaw, tz);
  if (!Number.isFinite(sendAtMs)) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at「${sendAtRaw}」解析不出时间，写你本地的墙钟时间（如 ${example}）。` };
  }
  if (sendAtMs < nowMs + MIN_SCHEDULE_LEAD_MS) {
    return {
      ok: false,
      reason: 'send_at_too_soon',
      message: `send_at 至少要比现在晚 1 分钟（你那边现在是 ${formatFireTimeShort(nowMs, tz)}）。想马上说的话直接写进这条消息里，不用排。`,
    };
  }

  const mode = args?.mode == null ? 'auto' : args.mode;
  if (typeof mode !== 'string' || !MODES.includes(mode as ActiveMsg2Mode)) {
    return { ok: false, reason: 'invalid_mode', message: 'mode 只能是 auto 或 prompted。' };
  }
  const promptHintRaw = args?.prompt_hint;
  const promptHint = typeof promptHintRaw === 'string' ? promptHintRaw.trim() : '';
  if (mode === 'prompted' && !promptHint) {
    return { ok: false, reason: 'missing_prompt_hint', message: 'mode=prompted 时要给 prompt_hint，说清那条消息该往哪个方向说。' };
  }

  const recurrence = args?.recurrence == null ? 'none' : args.recurrence;
  if (typeof recurrence !== 'string' || !RECURRENCES.includes(recurrence as ActiveMsg2Recurrence)) {
    return { ok: false, reason: 'invalid_recurrence', message: 'recurrence 只能是 none / daily / weekly。' };
  }

  const expirePolicy = args?.expire_policy == null ? 'expire' : args.expire_policy;
  if (expirePolicy !== 'expire' && expirePolicy !== 'force') {
    return { ok: false, reason: 'invalid_expire_policy', message: 'expire_policy 只能是 expire 或 force。' };
  }

  return {
    sendAt: new Date(sendAtMs).toISOString(),
    mode: mode as ActiveMsg2Mode,
    ...(promptHint ? { promptHint } : {}),
    recurrence: recurrence as ActiveMsg2Recurrence,
    expirePolicy,
  };
};

// ─── 正文协议兜底（用户的中转拒 tools 时） ───

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export interface FireScheduleTextCall {
  args: Record<string, unknown>;
  /** 原始匹配串，剥语法时用。 */
  matched: string;
}

/**
 * 从正文里抠出 `schedule_active_message({...})` 形态的调用。
 *
 * 只认括号带 JSON 这一种写法——排程参数是结构化的（时间 + 方向 + 策略），MCP 那边
 * 「行首 name: 值」的单参数形态在这里表达不了，认了反而会把「我等下用
 * schedule_active_message: 提醒你」这种叙述当成真调用。
 */
export const extractFireScheduleTextCalls = (content: string): FireScheduleTextCall[] => {
  if (!content) return [];
  const re = new RegExp(`(^|[^\\w./])${escapeRegExp(AMSG_FIRE_SCHEDULE_TOOL)}\\s*\\(([^)]*)\\)`, 'g');
  const calls: FireScheduleTextCall[] = [];
  for (const m of content.matchAll(re)) {
    const matched = m[0].slice(m[1].length);
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse((m[2] || '').trim() || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch {
      // 参数写坏了也算一次调用：交给 parseFireScheduleArgs 回一句「该怎么写」，
      // 比把这行当正文推给用户强（用户会看到一串工具语法）。
    }
    calls.push({ args, matched });
  }
  return calls;
};
