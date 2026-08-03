// utils/amsg2TaskContext.ts
/**
 * 排程现状块（防穿帮闸·下轮告知，浏览器侧编排；纯判定在 amsg2ExpireGuard）。
 *
 * useChatAI 每轮组请求时调 collectAmsg2TaskContext：
 *   1. 检出该角色回看期内已作废的排程（每任务独立判定）→ 落台账去重；
 *   2. 把「进行中任务 + 未告知的回执」拼成一段 system 背景块。
 * 回执有两种来源：闸自动作废（这里检出）、用户在面板手动取消 / 关掉 2.0
 * （面板调 buildUserCancelledNotices 写进同一本台账）。
 * 没任务也没回执 → null，整块不注入。发送成功后调
 * ActiveMsgStore.markExpiredNoticesNotified 标记，失败下轮重注（回执不丢）。
 */

import { ActiveMsg2TaskRecord, Amsg2ExpiredNoticeRecord, CharacterProfile } from '../types';
import { ActiveMsgStore } from './activeMsgStore';
import { DB } from './db';
import { resolveCharTimeZone } from './timezone';
import { detectExpiredOccurrences, hasDeliveredProactiveNear } from './amsg2ExpireGuard';
import {
  AMSG2_SCHEDULE_SECRECY_NOTE, canExpire, currentOccurrenceMs, describeExpirePolicy,
  describeRecurrence, describeTaskMode, formatTaskTime, getPendingTasks, isPendingTask,
  shortTaskId,
} from './amsg2Tasks';

/**
 * 排程现状块回看多久内的触发时刻。
 *
 * 必须**明确短于**作废回执台账的 TTL（48h）：两者一样长的话，边界那天的触发会在台账
 * 刚清掉它的下一轮被重新检出，同一件事再给角色说一遍。40h 留出的这 8 小时就是给
 * 「清账」和「重检」拉开距离用的。
 */
export const AMSG2_TASK_LOOKBACK_MS = 40 * 3600_000;

/** 每次向 DB 要多少条历史；不够覆盖回看期就翻倍再要一次。 */
const MESSAGE_PAGE_SIZE = 200;
/** 单轮检出最多读这么多条，兜住「一天几千条」的极端聊天量。 */
const MESSAGE_FETCH_LIMIT = 2000;

/**
 * 取够「覆盖整个回看期」的近史。
 *
 * 按条数取是不行的：重度用户 48 小时能聊出好几百条，固定 200 条窗口会把已送达的
 * 那条主动消息挤到窗外——检出侧看不到送达证据，就把一条**已经发出去**的触发判成
 * 作废，角色于是把发过的事再来一遍。DB 只提供「最近 N 条」，所以这里按需翻倍地要，
 * 直到最老一条早于回看起点（窗口盖住了）或历史见底为止。
 */
const loadMessagesCoveringLookback = async (charId: string, sinceMs: number) => {
  let limit = MESSAGE_PAGE_SIZE;
  let messages = await DB.getRecentMessagesByCharId(charId, limit);
  while (
    messages.length >= limit               // 要多少给多少 = 后面可能还有
    && limit < MESSAGE_FETCH_LIMIT
    && (messages[0]?.timestamp ?? 0) > sinceMs   // 最老一条还没退到回看起点之前
  ) {
    limit = Math.min(limit * 2, MESSAGE_FETCH_LIMIT);
    messages = await DB.getRecentMessagesByCharId(charId, limit);
  }
  return messages;
};

/**
 * 用户在面板里手动取消任务 / 关掉 2.0 时，给角色留的交代。
 *
 * 不留的话，聊天里那句「明早八点叫你～」就永远停在承诺状态：任务其实早没了，角色
 * 下次还接着说「放心我叫你」。所以手动取消也走作废回执那条路，角色下一轮就知道黄了。
 * 只给「还会响」的任务写——已经发过的一次性任务没有承诺可撤，写了纯属噪音。
 */
export function buildUserCancelledNotices(
  charId: string,
  tasks: ActiveMsg2TaskRecord[],
  nowMs: number = Date.now(),
): Amsg2ExpiredNoticeRecord[] {
  return tasks
    .filter((t) => isPendingTask(t, nowMs))
    .map((t) => ({
      // 编号跟作废回执分开：同一条任务可能先攒了一次作废、之后才被手动取消，两件事都得说。
      // 同一条任务重复取消只会命中同一个 id，台账按 id 去重，天然幂等。
      id: `${t.taskUuid}:cancelled`,
      charId,
      occurrenceMs: currentOccurrenceMs(t, nowMs) ?? new Date(t.firstSendTime).getTime(),
      mode: t.mode,
      promptHint: t.promptHint,
      recurrenceType: t.recurrenceType,
      kind: 'user-cancelled' as const,
      createdAt: nowMs,
    }));
}

/** 回执条目那一行（自动作废和手动取消长一个样，只是所在的段落不同）。 */
const describeNoticeLine = (r: Amsg2ExpiredNoticeRecord, charTz: string | undefined): string => {
  const recurrence = r.recurrenceType === 'daily' ? '（每日循环的当次）'
    : r.recurrenceType === 'weekly' ? '（每周循环的当次）' : '';
  return `- [${shortTaskId(r.id)}] 原定 ${formatTaskTime(r.occurrenceMs, charTz)}，${describeTaskMode(r)}${recurrence}`;
};

/** 纯拼文案，方便单测。进行中/回执两段任一非空才产出。 */
export function buildAmsg2TaskContextText(
  pending: ActiveMsg2TaskRecord[],
  expired: Amsg2ExpiredNoticeRecord[],
  nowMs: number = Date.now(),
  /**
   * 角色的时间参照系（没开自定义时区时为 undefined，跟着设备走）。
   * 位置参数不设默认值：这一段是给角色看的，调用方必须显式想过时间该按谁的钟写。
   */
  charTz: string | undefined,
  /**
   * 本轮工具循环里刚排出来的任务 uuid。
   *
   * 工具循环第二轮起这份清单是现算的，里面混着「本来就有的」和「角色刚排的」。不点名
   * 的话角色分不清，容易当成别人排的、再排一条一样的——现场那次「一句『等会找我』排出
   * 5 条」就有这一份。空集合等于没传：首轮那份是排程前的快照，不该凭空长出提醒。
   */
  createdThisTurn?: ReadonlySet<string>,
): string | null {
  if (!pending.length && !expired.length) return null;
  const isNewThisTurn = (taskUuid: string) => !!createdThisTurn?.has(taskUuid);
  const hasNewThisTurn = pending.some((t) => isNewThisTurn(t.taskUuid));
  const parts: string[] = ['【你的主动消息排程·仅你可见】'];
  // 闸自动作废 / 用户手动取消，两种回执给角色的交代完全不同（前者可以续期补上，
  // 后者是用户不要了），分成两段说。没有 kind 的老记录按自动作废处理。
  const autoExpired = expired.filter((r) => r.kind !== 'user-cancelled');
  const userCancelled = expired.filter((r) => r.kind === 'user-cancelled');

  if (pending.length) {
    parts.push('进行中：');
    for (const t of pending) {
      // 循环任务写「下一次」的时间。写 firstSendTime 的话，一条每天的任务在角色眼里
      // 是个好几天前的时刻，它会当成已经过去的排程，然后在对话里说漏嘴或重复排一条。
      const occurrenceMs = currentOccurrenceMs(t, nowMs);
      parts.push(`- [${shortTaskId(t.taskUuid)}] ${formatTaskTime(occurrenceMs ?? t.firstSendTime, charTz)} ${describeRecurrence(t.recurrenceType)}`
        + ` · ${describeTaskMode(t)} · ${describeExpirePolicy(t.expirePolicy)}`
        + (isNewThisTurn(t.taskUuid) ? ' · 本轮刚排的' : ''));
    }
    parts.push('（想调整就用 schedule/cancel/renew 工具；内容方向变了用 cancel + schedule 重建。'
      + (hasNewThisTurn ? '标着「本轮刚排的」是你这次回复里已经排好的，别再排一条一样的。' : '')
      + '）');
  }

  if (autoExpired.length) {
    parts.push('已作废（到点时对话正在进行，为避免撞车自动取消）：');
    for (const r of autoExpired) {
      parts.push(describeNoticeLine(r, charTz));
    }
    parts.push([
      '作废条目的处理由你判断，三选一：',
      '1. 就地消化：只在当前时间与话题都合适时自然带进对话——先想「现在提这个还合不合适」（早安任务拖到晚上就别再道早安），不要因为看到这份回执就强行转移当前话题。',
      '2. 续期：还想之后专门说，用 renew_active_message 换个时间（循环任务续期只补当次，原来的节奏照旧）；内容或方向变了，改用 cancel_active_message + schedule_active_message 重新创建。',
      '3. 放弃：已经没意义就只字不提。',
    ].join('\n'));
  }

  if (userCancelled.length) {
    parts.push('已被手动取消：');
    for (const r of userCancelled) {
      parts.push(describeNoticeLine(r, charTz));
    }
    parts.push('这几条是用户直接取消的，相关约定不再生效，自然接受即可、不必向用户求证，也别再拿它们许诺。还想在别的时间说的话，用 schedule_active_message 重新排一条。');
  }

  // 约束放在块尾，管住上面每一种形态。挂在某一段里的话，只有进行中任务的那次就是裸奔的：
  // 短 id、「遇忙作废」这些系统腔会被角色当成可以复述的内容念出来。
  parts.push(AMSG2_SCHEDULE_SECRECY_NOTE);

  return parts.join('\n');
}

export interface Amsg2TaskContextResult {
  text: string | null;
  /** 本轮注入的回执 id（闸作废的 + 用户手动取消的），发送成功后 markExpiredNoticesNotified。 */
  expiredIds: string[];
  /**
   * 本轮要告知的回执原始记录。
   *
   * 工具循环里每发一次请求都要按最新任务清单重渲染这一块，但回执这半边是「检出 + 落台账」
   * 的结果、带副作用，一轮只该算一次。把记录交出去，后续轮次直接拿它配上新的 pending 调
   * buildAmsg2TaskContextText 就行，不用再碰 DB 和台账。
   */
  notices: Amsg2ExpiredNoticeRecord[];
}

export async function collectAmsg2TaskContext(char: CharacterProfile): Promise<Amsg2TaskContextResult> {
  const config = char.activeMsg2Config;
  const tasks = config?.tasks ?? [];
  const now = Date.now();

  // 逐任务检出作废（AI 任务且 expire 策略才判；force / fixed 不作废）。
  if (config?.enabled && tasks.length) {
    // 取够整个回看期的历史再判：证据（那条已送达的主动消息）落在窗外的话，
    // 检出侧会把一条发过的触发当成作废，角色接着把同一件事再说一遍。
    const messages = await loadMessagesCoveringLookback(char.id, now - AMSG2_TASK_LOOKBACK_MS);
    const candidates = tasks
      .filter(canExpire)
      .flatMap((t) => detectExpiredOccurrences({
        taskUuid: t.taskUuid,
        policy: t.expirePolicy,
        recurrenceType: t.recurrenceType,
        firstSendTime: t.firstSendTime,
        anchorMs: t.anchorLastUserMsgAt ?? null,
        messages,
        nowMs: now,
        lookbackMs: AMSG2_TASK_LOOKBACK_MS,
      }).filter((c) => !hasDeliveredProactiveNear(messages, c.occurrenceMs, t.clientTaskId))
        .map((c) => ({
          id: c.id, charId: char.id, occurrenceMs: c.occurrenceMs,
          mode: t.mode, promptHint: t.promptHint, recurrenceType: t.recurrenceType,
          kind: 'expired', createdAt: now,
        } satisfies Amsg2ExpiredNoticeRecord)));
    if (candidates.length) await ActiveMsgStore.upsertExpiredNotices(char.id, candidates);
  }

  const unnotified = (await ActiveMsgStore.getExpiredNotices(char.id)).filter((r) => !r.notifiedAt);
  const pending = getPendingTasks(config, now);
  return {
    // 时间按角色的钟写：这一段是给角色看的，到点 worker 渲染的那份也是角色时区，
    // 两边对不上的话，纽约角色会在同一轮里读到差一个时差的两个「同一条任务」。
    text: buildAmsg2TaskContextText(pending, unnotified, now, resolveCharTimeZone(char)),
    expiredIds: unnotified.map((r) => r.id),
    notices: unnotified,
  };
}
