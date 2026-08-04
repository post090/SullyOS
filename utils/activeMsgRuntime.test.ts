import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  AMSG2_TASKS_ADOPTED_EVENT,
  EXPIRE_DECISION_TTL_MS,
  INBOX_FRESH_DELIVERY_WINDOW_MS,
  MAX_INBOX_ORDER_HOLDS,
  MAX_INBOX_PROCESS_ATTEMPTS,
  OrphanedCharacterError,
  PUSH_SUBSCRIPTION_CHANGED_KV_ID,
  buildSelfLogEntryId,
  findInboxArtifacts,
  findMissingChunkIndexes,
  findPersistedChunkIndexes,
  flushInboxToChat,
  isFreshInboxDelivery,
  purgeInboxArtifacts,
  refreshPushSubscriptionIfMarked,
  resolveBackfillTimestamp,
  resolveFireExpireDecision,
  resolveInboxFailureAction,
  resolveInboxPersistTimestamp,
  revokeSwallowedSelfLogEntry,
} from './activeMsgRuntime';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { AMSG_SELF_LOG_KEY, amsgStateNamespace } from './amsgFirePack';
import { DB } from './db';

// resolveFireExpireDecision 是从「防穿帮闸·客户端兜底」吞没闸抽出来的 get-or-compute
// helper（带 TTL 清扫），单测把闸的关键不变量钉住，防回归：
//   1. 一次 fire 的多分段 push 共用同一个决定（evaluate 只跑一次，绝不吞一半）；
//   2. TTL 过后同 fireKey 才允许重新判定（迟到分段仍复用同一决定）。
// 用注入的临时 Map 做隔离，不碰模块级 expireDecisionByFire，也不需要 DB / 浏览器。

describe('resolveFireExpireDecision', () => {
  it('一次 fire 的多分段 push（到达顺序 3 → 1 → 2）复用同一个决定，evaluate 只跑一次', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;
    const occ = 1_700_000_000_000;
    const taskIdentity = 'task-A';
    // fireKey 不含 messageIndex：三段 push（messageIndex 3/1/2）解析到同一个 key。
    const fireKey = `${taskIdentity}:${occ}`;

    let calls = 0;
    const evaluate = async () => { calls++; return true; };

    // 按 3 → 1 → 2 的到达顺序处理三段
    const decisions: boolean[] = [];
    for (const messageIndex of [3, 1, 2]) {
      void messageIndex; // 段序不进 key，仅表意
      decisions.push(await resolveFireExpireDecision(cache, fireKey, T0, evaluate));
    }

    expect(calls).toBe(1);                       // 只判一次
    expect(decisions).toEqual([true, true, true]); // 三段同吞
  });

  it('TTL 内复用缓存不重判，TTL 过后同 fireKey 重新判定（并刷新决定）', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;
    const fireKey = 'task-B:1700000000000';

    let calls = 0;
    let decision = false;
    const evaluate = async () => { calls++; return decision; };

    // 首判：false
    const first = await resolveFireExpireDecision(cache, fireKey, T0, evaluate);
    expect(first).toBe(false);
    expect(calls).toBe(1);

    // TTL 尚未到期：即便底层判定已改变，也命中缓存、不重判
    decision = true;
    const within = await resolveFireExpireDecision(cache, fireKey, T0 + EXPIRE_DECISION_TTL_MS - 1, evaluate);
    expect(within).toBe(false);
    expect(calls).toBe(1);

    // TTL 过后：清扫掉旧条目，重新判定，拿到新决定
    const after = await resolveFireExpireDecision(cache, fireKey, T0 + EXPIRE_DECISION_TTL_MS + 1, evaluate);
    expect(after).toBe(true);
    expect(calls).toBe(2);
  });

  // 回归守卫：判不出来的时候绝不能把「判不了」当成「可以发」缓存下来。
  // evaluate 抛错时不写缓存，下次才是真的重判——否则一次读取失败会让这次 fire 的
  // 后续分段全部沿用一个凭空捏造的结论。
  it('evaluate 抛错 → 不缓存，下次重判', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;

    let calls = 0;
    const evaluate = async () => {
      calls++;
      if (calls === 1) throw new Error('IndexedDB read failed');
      return true;
    };

    await expect(resolveFireExpireDecision(cache, 'task-D:333', T0, evaluate)).rejects.toThrow();
    expect(cache.size).toBe(0);

    const second = await resolveFireExpireDecision(cache, 'task-D:333', T0, evaluate);
    expect(calls).toBe(2);
    expect(second).toBe(true);
  });

  it('同任务不同 occurrence 用不同 fireKey，各判各的（不串判定）', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;

    let calls = 0;
    const evaluate = async () => { calls++; return calls === 1; }; // 第一次 true，第二次 false

    const d1 = await resolveFireExpireDecision(cache, 'task-C:111', T0, evaluate);
    const d2 = await resolveFireExpireDecision(cache, 'task-C:222', T0, evaluate);

    expect(calls).toBe(2);      // 两个 occurrence 各判一次
    expect(d1).toBe(true);
    expect(d2).toBe(false);
  });
});

// 回归守卫：push 处理失败时的去向。
// 过去一律就地存原稿——原稿里的表情 / 卡片 / 转账都还是标记形态，渲染时被剥掉，
// 用户看到残缺版，而角色下一轮读历史会当成「我已经发过了」：一次暂时的本地故障
// 就此变成永久的错误前提。现在默认留着重试，重试到头才退回存原稿。
describe('resolveInboxFailureAction', () => {
  it('角色已不存在 → 孤儿，不重试（重试多少次都没用，该去清远端任务）', () => {
    const err = new OrphanedCharacterError('char-gone');
    expect(resolveInboxFailureAction(err, 1)).toBe('orphan');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS + 5)).toBe('orphan');
  });

  it('普通失败且没到上限 → 重试，不把残缺版固化进聊天记录', () => {
    const err = new Error('IndexedDB transaction aborted');
    expect(resolveInboxFailureAction(err, 1)).toBe('retry');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS - 1)).toBe('retry');
  });

  it('重试到上限 → 退回存原稿保底（残缺也好过什么都没有）', () => {
    const err = new Error('IndexedDB transaction aborted');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS)).toBe('degrade');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS + 1)).toBe('degrade');
  });
});

// 回归守卫：重试不能把已经写进聊天记录的气泡再写一遍。
//
// 后处理是逐条落库的（十几处 DB.saveMessage），第 3 条写失败时前两条已经在库里了。
// 「失败就整条重跑」最多跑 4 趟（3 次重试 + 最后存原稿保底），不先认领并清掉上一趟的
// 半成品，用户就会看到同一段话出现三四遍——而重复进了聊天记录是永久的。
// 认领的依据是每条气泡都继承的 metadata.activeMsg2.messageId（每条 push 唯一）。
describe('findInboxArtifacts', () => {
  const bubble = (id: number, messageId: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: 'assistant',
    metadata: { source: 'active_msg_2', activeMsg2: { messageId }, ...extra },
  });

  it('认出同一条 push 写下的全部气泡', () => {
    const found = findInboxArtifacts(
      [bubble(1, 'msg_a'), bubble(2, 'msg_a'), bubble(3, 'msg_b')],
      'msg_a',
    );
    expect(found.map((m) => m.id)).toEqual([1, 2]);
  });

  it('别的 push / 别的来源一律不动（多分段 push 每段各有各的 messageId）', () => {
    const messages = [
      bubble(1, 'msg_b'),
      { id: 2, role: 'assistant', metadata: { source: 'chat' } },
      { id: 3, role: 'assistant' },
      { id: 4, role: 'user', metadata: { activeMsg2: { messageId: 'msg_a' } } },
    ];
    expect(findInboxArtifacts(messages as any, 'msg_a')).toEqual([]);
  });

  it('一趟都没写成（第一条就挂了）→ 空清单，调用方据此判定副作用还得重放', () => {
    expect(findInboxArtifacts([bubble(1, 'msg_b')], 'msg_a')).toEqual([]);
  });

  it('退回存原稿那条也带同一个 messageId，所以也认得出来（免得原稿跟残留气泡并排）', () => {
    const raw = { id: 9, role: 'assistant', metadata: { activeMsg2: { messageId: 'msg_a' } } };
    expect(findInboxArtifacts([raw] as any, 'msg_a')).toHaveLength(1);
  });
});

// 上面那条是纯判定，这条走真库（fake-indexeddb）钉住实际删除行为：
// 重试前不清场的话，重跑一趟就是把同样的气泡再写一遍，用户看到重复的一段话。
describe('purgeInboxArtifacts（走真库）', () => {
  const CHAR = 'char-purge';

  const saveBubble = (content: string, messageId: string | null, type = 'text') => DB.saveMessage({
    charId: CHAR,
    role: 'assistant',
    type,
    content,
    metadata: messageId
      ? { source: 'active_msg_2', activeMsg2: { messageId } }
      : { source: 'chat' },
  } as any);

  it('只删这条 push 写下的气泡，别人的一条不动', async () => {
    await saveBubble('上一趟写了一半 1', 'msg_a');
    await saveBubble('上一趟写了一半 2', 'msg_a');
    await saveBubble('另一条 push 的', 'msg_b');
    await saveBubble('普通聊天回复', null);

    const { removed, evidence } = await purgeInboxArtifacts({ charId: CHAR, messageId: 'msg_a' } as any);

    expect(removed).toBe(2);
    expect(evidence).toBe(2);
    const left = await DB.getRecentMessagesByCharId(CHAR, 200);
    expect(left.map((m) => m.content)).toEqual(['另一条 push 的', '普通聊天回复']);
  });

  it('一条都没写过 → 删 0 条，也不报错（首次处理走的就是这条）', async () => {
    await expect(purgeInboxArtifacts({ charId: 'char-empty', messageId: 'msg_x' } as any))
      .resolves.toEqual({ removed: 0, evidence: 0 });
  });

  // 副作用产物跟正文气泡带着同一个 activeMsg2.messageId（chatParser 落库时统一挂的）。
  // 一起删掉的话：本轮又因为「认出了标记」不重放 directives，那张转账卡就永远回不来了。
  // 所以「算不算凭据」和「删不删」必须分开——凭据照数，删只删渲染型气泡。
  it('副作用产物（转账卡等）算凭据但不删，只删渲染型气泡', async () => {
    const charId = 'char-purge-sideeffect';
    const save = (content: string, type: string) => DB.saveMessage({
      charId, role: 'assistant', type, content,
      metadata: { source: 'active_msg_2', activeMsg2: { messageId: 'msg_mixed' } },
    } as any);

    await save('半截正文', 'text');
    await save('[表情]', 'emoji');
    await save('[HTML卡片]', 'html_card');
    await save('给你转 5 块', 'transfer');
    await save('戳了戳你', 'interaction');
    await save('今天的热点', 'news_card');
    await save('[音乐]', 'music_card');
    await save('日程已加', 'info');
    await save('今天的生活记录', 'life_card');
    await save('小红书笔记', 'xhs_card');

    const { removed, evidence } = await purgeInboxArtifacts({ charId, messageId: 'msg_mixed' } as any);

    expect(removed, '只删 text / emoji / html_card').toBe(3);
    expect(evidence, '凭据要把副作用产物一起数上，否则重试会二次转账').toBe(10);
    const left = await DB.getRecentMessagesByCharId(charId, 200);
    expect(left.map((m) => m.type)).toEqual([
      'transfer', 'interaction', 'news_card', 'music_card', 'info', 'life_card', 'xhs_card',
    ]);
  });
});

// 回归守卫：主动消息落库时间戳一律取 sentAt（云端真正发出那一刻）。
//
// 气泡在聊天流里的位置只看自增 id（db.ts 按 charId 索引游标读、Chat.tsx 的 displayMessages
// 不排序），跟 timestamp 无关，所以标 sentAt 不会让消息跑到用户正在聊的内容上面。timestamp
// 只决定气泡上显示的那个数字。唯一要防的是「位置在下、数字往回走」的倒挂，那个由
// resolveBackfillTimestamp 精确接管（本地真有更晚的消息才退让）。
//
// 这里不再按「消息够不够新」二选一：那个判据回答不了「用户在不在场」——到点弹的通知，
// 用户隔几分钟才点进来，消息就会被标成他点进来的那一刻。而在线送达时 sentAt 距落库
// 只有几秒，标 sentAt 一样显示「刚刚」，观感没有差别。
//
// 落库时间戳还会喂给 amsg2ExpireGuard.hasDeliveredProactiveNear（判定窗
// [occurrence-90s, occurrence+30min]）：sentAt ≈ occurrence + 云端生成耗时，稳落在窗内，
// 已送达的消息不会被误判成没送到而生成假作废回执。
describe('resolveInboxPersistTimestamp（边界值）', () => {
  const NOW = 1_700_000_000_000;

  it('刚送达（几秒 / 一分钟前）→ 也落 sentAt，不再改成写库当刻', () => {
    expect(resolveInboxPersistTimestamp(NOW - 3_000, NOW)).toBe(NOW - 3_000);
    expect(resolveInboxPersistTimestamp(NOW - 60_000, NOW)).toBe(NOW - 60_000);
    expect(resolveInboxPersistTimestamp(NOW, NOW)).toBe(NOW);
  });

  // 现场那一例：17:35 到点弹通知，17:43 才点进去，气泡标成了 17:43。
  it('到点弹通知、隔 8 分钟才点进来 → 落 sentAt（不是点进来的那一刻）', () => {
    const sentAt = NOW - 8 * 60_000;
    expect(resolveInboxPersistTimestamp(sentAt, NOW)).toBe(sentAt);
  });

  it('隔夜典型场景：13 小时前的 sentAt 原样返回', () => {
    const sentAt = NOW - 13 * 3_600_000;
    expect(resolveInboxPersistTimestamp(sentAt, NOW)).toBe(sentAt);
  });

  it('sentAt 缺失 / 非法（老 push 可能不带）→ undefined，交给写库当刻', () => {
    expect(resolveInboxPersistTimestamp(undefined, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(0, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(Number.NaN, NOW)).toBeUndefined();
  });

  it('sentAt 在未来（时钟偏差）→ undefined，别把气泡标到未来', () => {
    expect(resolveInboxPersistTimestamp(NOW + 5 * 60_000, NOW)).toBeUndefined();
  });
});

// 回归守卫：补收的消息跳过拟人打字延迟。
//
// 气泡是一条条冒出来的——后处理管线每条之间夹 0.5~2 秒 setTimeout，模拟角色在打字。
// 实时收到时这是对的（角色正在你眼前说话）；但补收的消息早在几小时前就在云端生成完了，
// 再慢放一遍只会让用户干等，而且这段时间里用户来得及插话，把倒挂的口子撑开
// （见 resolveBackfillTimestamp）。所以躺过窗口的消息一次性回填。
//
// 判据用 receivedAt（消息落到这台设备的时刻）而不是 sentAt：它剔除了云端到设备之间的
// 网络延迟，问的正是「这条在收件箱里躺了多久没人消费」。
describe('isFreshInboxDelivery（决定要不要慢放打字节奏）', () => {
  const NOW = 1_700_000_000_000;

  it('刚落到设备（几秒前）→ 保留打字节奏', () => {
    expect(isFreshInboxDelivery(NOW - 3_000, NOW)).toBe(true);
    expect(isFreshInboxDelivery(NOW, NOW)).toBe(true);
  });

  it('前台连收几条排队处理（一分钟前）→ 仍算刚到，用户就在看着', () => {
    expect(isFreshInboxDelivery(NOW - 60_000, NOW)).toBe(true);
  });

  it('恰好等于窗口 → 仍算刚到（规则是「超过」才算补收）', () => {
    expect(isFreshInboxDelivery(NOW - INBOX_FRESH_DELIVERY_WINDOW_MS, NOW)).toBe(true);
  });

  it('点通知隔 8 分钟才进来 → 算补收，一次性回填不慢放', () => {
    expect(isFreshInboxDelivery(NOW - 8 * 60_000, NOW)).toBe(false);
  });

  it('隔夜补收 → 算补收', () => {
    expect(isFreshInboxDelivery(NOW - 13 * 3_600_000, NOW)).toBe(false);
  });

  it('receivedAt 缺失 / 非法 → 当刚到处理（保守：宁可慢放，也别把实时消息秒刷出来）', () => {
    expect(isFreshInboxDelivery(undefined, NOW)).toBe(true);
    expect(isFreshInboxDelivery(0, NOW)).toBe(true);
    expect(isFreshInboxDelivery(Number.NaN, NOW)).toBe(true);
  });

  it('窗口要明显短于用户「看到通知再点进来」的典型间隔，否则补收照样慢放', () => {
    expect(INBOX_FRESH_DELIVERY_WINDOW_MS).toBeLessThanOrEqual(2 * 60_000);
  });
});

// 端到端（走真库 + 真 flush）：钉住主路径（post-processing 逐条落库）和降级存原稿路径
// 用的是同一个口径——离线补收落 sentAt，在线送达落写库当刻。修复前主路径永远落写库当刻
// （离线补收用例挂）、降级路径永远落 sentAt（在线送达用例挂），两套口径各错一半。
describe('flushInboxToChat 落库时间戳（走真库）', () => {
  beforeAll(async () => {
    // flush 尾部会 dispatch 'active-msg-received' 等事件；node 测试环境没有 window，
    // 给个最小 stub（事件本身不在本组断言范围内）。
    (globalThis as any).window ??= { dispatchEvent: () => true };
    // 主路径要查得到角色才不会走孤儿分支。
    await DB.saveCharacter({ id: 'char-ts-main', name: '守夜角色' } as any);
  });

  const inboxMsg = (over: Record<string, unknown>) => ({
    charId: 'char-ts-main',
    charName: '守夜角色',
    body: '还没睡吗，早点休息',
    receivedAt: Date.now(),
    ...over,
  }) as any;

  const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');

  it('主路径·离线补收：sentAt 超过阈值 → 每条气泡都落 sentAt', async () => {
    const sentAt = Date.now() - 13 * 3_600_000; // 昨晚推的，今天中午才打开
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-stale',
      messageType: 'text', // ASSISTANT_TEXT_TYPES 白名单内 → 走 post-processing 主路径
      sentAt,
    }));

    await flushInboxToChat();

    const msgs = await assistantMsgs('char-ts-main');
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBe(sentAt);
  }, 20000);

  // 循环判定读的是 push 顶层的 recurrenceType（库盖上去的，用户排的和角色自排的走同
  // 一份）。任务 metadata 里那份是排程方自己抄的，角色在 fire 里自排那条路径压根不会
  // 抄——照着 metadata 判的话，每日提醒只要用户开过一次口就会被永远吞掉，而 worker 那边
  // 照常生成、照常推、照常记「我说过这句」。几天后角色会说「我连着叫你三天你都不理我」。
  it('角色自排的 daily 任务不被当成一次性吞掉（顶层 recurrenceType 说了算）', async () => {
    const charId = 'char-selfsched-daily';
    await DB.saveCharacter({ id: charId, name: '每日提醒角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3 * 3_600_000;   // 排程那一刻的锚点：三小时前
    // 用户在锚点之后开过口，但离本次触发还有两小时——一次性任务的判据（锚点之后有新
    // 消息就作废）会中招，循环任务的窗口（触发时刻前 10 分钟起算）够不着它。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '在吗',
      timestamp: occurrenceMs - 2 * 3_600_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-selfsched-daily',
      charId,
      charName: '每日提醒角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'daily',   // push 顶层，库盖的
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-selfsched',
        amsgAnchorMs: anchorMs,
        // 角色自排那条路径不往 metadata 抄 recurrence，这里刻意留空。
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs.length, '循环任务不该被防穿帮闸吞掉').toBeGreaterThan(0);
  }, 20000);

  // 记账要排在防穿帮闸之前。排在后面的话，被吞掉的那条 push 会把任务认领一起带走：
  // 任务照常到点触发，面板却列不出来、用户取消不掉，订阅登记和凭据刷新也都够不着它。
  it('消息被防穿帮闸吞掉，角色自排的任务照样认领下来', async () => {
    const charId = 'char-adopt-before-gate';
    await DB.saveCharacter({
      id: charId, name: '自排角色', activeMsg2Config: { enabled: true, tasks: [] },
    } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3_600_000;
    // 锚点之后用户又开口了 → 一次性任务判作废，这条 push 会被吞。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '我在忙',
      timestamp: occurrenceMs - 60_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-adopt-before-gate',
      charId,
      charName: '自排角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'none',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-adopt',
        amsgAnchorMs: anchorMs,
        amsgSelfScheduled: [{
          taskUuid: 'amsgself-adopt-1',
          clientTaskId: 'client-task-adopt-next',
          mode: 'auto',
          firstSendTime: new Date(occurrenceMs + 90 * 60_000).toISOString(),
          recurrenceType: 'none',
          expirePolicy: 'expire',
          source: 'character',
          status: 'scheduled',
          createdAt: occurrenceMs,
        }],
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat();

    expect(await assistantMsgs(charId), '这条消息该被闸吞掉').toHaveLength(0);
    const char = (await DB.getAllCharacters()).find((c) => c.id === charId);
    expect(
      char?.activeMsg2Config?.tasks?.map((t: any) => t.taskUuid),
      '被吞的是这次要说的话，不是这条任务',
    ).toContain('amsgself-adopt-1');
  }, 20000);

  it('主路径·刚送达：一样落 sentAt（本地没有更晚的消息，不需要退让）', async () => {
    const charId = 'char-ts-main-fresh';
    await DB.saveCharacter({ id: charId, name: '在线角色' } as any);
    const sentAt = Date.now() - 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-fresh',
      charId,
      messageType: 'text',
      sentAt,
    }));

    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBe(sentAt);
  }, 20000);

  // 到点弹通知、用户隔几分钟才点进来 —— 这一例的旧行为是把气泡标成点进来的那一刻。
  it('主路径·点通知隔 8 分钟进来：落 sentAt，不是点进来的那一刻', async () => {
    const charId = 'char-ts-main-notif';
    await DB.saveCharacter({ id: charId, name: '定时角色' } as any);
    const sentAt = Date.now() - 8 * 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-notif',
      charId,
      messageType: 'text',
      sentAt,
    }));

    const before = Date.now();
    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.timestamp).toBe(sentAt);
      expect(m.timestamp, '别再标成点进来的那一刻').toBeLessThan(before);
    }
  }, 20000);

  // 倒挂守卫仍然在岗：用户先说了话，补收的消息就不能标成比它更早。
  it('主路径·补收时本地已有更晚的消息 → 退回写库当刻，时间戳不倒挂', async () => {
    const charId = 'char-ts-main-backfill';
    await DB.saveCharacter({ id: charId, name: '倒挂守卫角色' } as any);
    const sentAt = Date.now() - 13 * 3_600_000;   // 昨晚推的
    // 用户今天打开 App 先说了一句，落库时刻比 sentAt 晚得多。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '早',
      timestamp: Date.now() - 5_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-backfill',
      charId,
      messageType: 'text',
      sentAt,
    }));

    const before = Date.now();
    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBeGreaterThanOrEqual(before);
  }, 20000);

  it('降级存原稿路径·离线补收：与主路径同口径，落 sentAt', async () => {
    const charId = 'char-ts-raw-stale';
    const sentAt = Date.now() - 13 * 3_600_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-raw-stale',
      charId,
      messageType: 'forum', // 白名单外 → 不走 post-processing，直接原稿落库
      sentAt,
    }));

    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('还没睡吗，早点休息');
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);

  // 接线守卫：判据（isFreshInboxDelivery）算出来的结论要真的传到后处理管线去。
  //
  // 阈值锚在真实常量上，不是拍脑袋的容差：拟人打字延迟每条气泡至少 500ms
  // （applyAssistantPostProcessing 的 `Math.max(chunk.length * 50, 500)`），所以
  // 「跑没跑那个 setTimeout」在耗时上是 500ms 起 vs 几十毫秒的落库开销，中间隔着
  // 一整个数量级。取 400ms 当界：慢机器把落库拖慢几倍也够不着，而慢放路径必然超过。
  // （别改成「补收比实时快」这种相对比较——接线被删掉时两边都慢放、耗时相当，
  //   谁快谁慢就由噪声决定，测试会时过时挂。）
  it('补收的消息跳过拟人打字延迟，实时收到的照旧慢放', async () => {
    const runFlush = async (charId: string, receivedAt: number) => {
      await DB.saveCharacter({ id: charId, name: '打字节奏角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: `msg-pace-${charId}`,
        charId,
        messageType: 'text',
        sentAt: receivedAt,
        receivedAt,
      }));
      const t0 = Date.now();
      await flushInboxToChat();
      return Date.now() - t0;
    };

    const freshMs = await runFlush('char-pace-fresh', Date.now());
    const staleMs = await runFlush('char-pace-stale', Date.now() - 8 * 60_000);

    // 实时那条确实慢放了，否则下面那条断言就成了空气
    expect(freshMs, '实时送达该保留打字节奏').toBeGreaterThan(400);
    expect(staleMs, '补收该跳过打字延迟').toBeLessThan(400);
  }, 20000);

  it('降级存原稿路径·刚送达：与主路径同口径，落 sentAt', async () => {
    const charId = 'char-ts-raw-fresh';
    const sentAt = Date.now() - 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-raw-fresh',
      charId,
      messageType: 'forum',
      sentAt,
    }));

    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);
});

// ─── ② pushsubscriptionchange 标记消费（真库 fake-indexeddb）───
// SW 换订阅时往 ActiveMsg 库 kv store 写固定 key 的标记（worker/sw-keep-alive.ts），
// 这里钉主线程的消费口径：有标记才刷；刷成功才清；不支持 / 部分失败 / 抛错都留着
// 下次再试（清了就再也没人补——marker 只在 pushsubscriptionchange 那一刻写一次）。
describe('refreshPushSubscriptionIfMarked', () => {
  const openAmsgDb = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ActiveMsg');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  /** 按 SW 写入的同款记录形状（KvRecord {id, value}）把标记放进真库。 */
  const putMarker = async () => {
    await ActiveMsgStore.getGlobalConfig(); // 先把 schema 建到当前版本（含 kv store）
    const db = await openAmsgDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({
        id: PUSH_SUBSCRIPTION_CHANGED_KV_ID,
        value: { changedAt: Date.now(), resubscribed: false },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  const markerExists = async (): Promise<boolean> => {
    const db = await openAmsgDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const request = tx.objectStore('kv').get(PUSH_SUBSCRIPTION_CHANGED_KV_ID);
        request.onsuccess = () => resolve(Boolean(request.result));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };

  const clearMarker = async () => {
    const db = await openAmsgDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(PUSH_SUBSCRIPTION_CHANGED_KV_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMarker();
  });

  it('没有标记 → 不发起登记', async () => {
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockResolvedValue(undefined);

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('no-marker');
    expect(register).not.toHaveBeenCalled();
  });

  // 登记是一次覆盖写，覆盖到的是用户级那一份订阅——本地知不知道有哪些任务、有没有
  // 任务，都跟它无关。所以只有「成功清标记 / 失败留标记」两种归宿。
  it('有标记 + 登记成功 → 调一次并清掉标记', async () => {
    await putMarker();
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockResolvedValue(undefined);

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('refreshed');
    expect(register).toHaveBeenCalledTimes(1);
    await expect(markerExists()).resolves.toBe(false);
  });

  it('登记抛错（断网 / 权限被收回）→ 标记保留下次再试', async () => {
    await putMarker();
    vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockRejectedValue(new Error('offline'));

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('kept');
    await expect(markerExists()).resolves.toBe(true);
  });
});

// ─── ③ 角色自排任务：认领之后要广播出去 ───
// 认领只写了 IndexedDB 的话，React 那侧内存里的任务清单还是旧的：任务面板列不出这条、
// 按任务数 / 凭据 / 订阅这三道门做判断的地方也都看不见它，而它照常到点触发。
// 事件名和 detail 形状是与 OSContext 监听侧的约定，这组用例把它钉死。
describe('认领角色自排任务后广播 amsg2-tasks-adopted', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** 把 flush 期间派发的事件都收下来（node 环境没有真 window，只记录不分发）。 */
  const captureEvents = (): any[] => {
    const seen: any[] = [];
    vi.spyOn((globalThis as any).window, 'dispatchEvent')
      .mockImplementation((event: any) => { seen.push(event); return true; });
    return seen;
  };

  const selfScheduledTask = (taskUuid: string, at: number) => ({
    taskUuid,
    clientTaskId: `client-${taskUuid}`,
    mode: 'auto',
    firstSendTime: new Date(at + 90 * 60_000).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    source: 'character',
    status: 'scheduled',
    createdAt: at,
  });

  const pushWithSelfScheduled = (charId: string, messageId: string, tasks: unknown[]) =>
    ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '自排角色',
      body: '晚点再找你',
      // 白名单外的类型 → 走原稿落库，不必为这组用例跑整条后处理管线。
      messageType: 'forum',
      receivedAt: Date.now(),
      metadata: { charId, amsgSelfScheduled: tasks },
    } as any);

  it('认领到新任务 → 派发一次，detail.charId 是这个角色', async () => {
    const charId = 'char-adopt-event';
    const now = Date.now();
    await DB.saveCharacter({
      id: charId, name: '自排角色', activeMsg2Config: { enabled: true, tasks: [] },
    } as any);
    await pushWithSelfScheduled(charId, 'msg-adopt-event-1', [selfScheduledTask('amsgself-evt-1', now)]);

    const events = captureEvents();
    await flushInboxToChat();

    const adopted = events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT);
    expect(adopted, '修复前只写库不广播，这里拿到 0 条').toHaveLength(1);
    expect(adopted[0].detail).toEqual({ charId });
  }, 20000);

  it('同一条任务再来一次（push 重放）→ 不重复派发，别让 UI 白重读', async () => {
    const charId = 'char-adopt-event-dup';
    const now = Date.now();
    await DB.saveCharacter({
      id: charId,
      name: '自排角色',
      activeMsg2Config: { enabled: true, tasks: [selfScheduledTask('amsgself-evt-dup', now)] },
    } as any);
    await pushWithSelfScheduled(charId, 'msg-adopt-event-2', [selfScheduledTask('amsgself-evt-dup', now)]);

    const events = captureEvents();
    await flushInboxToChat();

    expect(events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT)).toHaveLength(0);
  }, 20000);
});

// ─── ④ 被吞掉的消息，云端「我说过什么」也要跟着撤 ───
// worker 发完就把正文记进了 client_state 的 self_log，而这条在客户端被防穿帮闸吞掉、
// 用户一个字没看到。不撤的话，下一次到点的 prompt 里【这之后你又主动发过】列着它，
// 角色接着一句没人看过的话往下说。
describe('revokeSwallowedSelfLogEntry', () => {
  const CHAR = 'char-selflog';
  const NS = amsgStateNamespace(CHAR);
  const ENTRY_ID = 'client-task-x@1700000000000';

  const cloudLog = (
    entries: Array<{ id: string; at: number; text: string }>,
    tasks: unknown[] = [],
  ) => JSON.stringify({ v: 2, basePackAt: 1_700_000_000_000, entries, tasks });

  const entry = (id: string) => ({ id, at: 1_700_000_000_000, text: '在忙吗' });

  const stubCloud = (raw: string | null) => {
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(raw);
    return {
      clear: vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined),
      write: vi.spyOn(ActiveMsgClient, 'writeClientStateValue').mockResolvedValue(undefined),
    };
  };

  /** 读回这次写上去的那份日志。 */
  const writtenLog = (write: any) => JSON.parse(write.mock.calls[0][2]);

  afterEach(() => { vi.restoreAllMocks(); });

  it('日志里只剩这一条 → 整份清空（对 worker 而言等价于「重新建一份空的」）', async () => {
    const { clear, write } = stubCloud(cloudLog([entry(ENTRY_ID)]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('cleared');
    expect(clear).toHaveBeenCalledWith(NS, AMSG_SELF_LOG_KEY);
    expect(write).not.toHaveBeenCalled();
  });

  it('还有别的条目 → 只摘掉被吞那条，其余原样写回', async () => {
    const { clear, write } = stubCloud(cloudLog([entry('other@1'), entry(ENTRY_ID)]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('rewritten');
    expect(clear, '整份清空会把用户真收到过的话也抹掉').not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(NS, AMSG_SELF_LOG_KEY, expect.any(String));
    expect(writtenLog(write).entries.map((e: any) => e.id)).toEqual(['other@1']);
  });

  it('日志里还挂着角色自排的任务 → 摘条目、任务原样留着', async () => {
    const { clear, write } = stubCloud(cloudLog([entry(ENTRY_ID)], [{ taskUuid: 'amsgself-1' }]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('rewritten');
    expect(clear).not.toHaveBeenCalled();
    const next = writtenLog(write);
    expect(next.entries).toEqual([]);
    expect(next.tasks, '任务清单缺一块，角色下次会把同一件事再排一遍').toEqual([{ taskUuid: 'amsgself-1' }]);
    expect(next.basePackAt, 'basePackAt 要原样带着，改了整份日志就对不上号作废了').toBe(1_700_000_000_000);
  });

  it('日志里没有这条（id 对不上 / 已经被别处清了）→ 什么都不写', async () => {
    const { clear, write } = stubCloud(cloudLog([entry('someone-else@2')]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('not-found');
    expect(clear).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('云端压根没有这份日志 → 什么都不写', async () => {
    const { clear, write } = stubCloud(null);

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('no-log');
    expect(clear).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

// 条目 id 的拼法必须跟 worker 写日志那份逐字对齐（`<clientTaskId>@<触发时刻>`），
// 差一个字符就永远认领不到——而认领不到是静默的，没人会发现。
describe('buildSelfLogEntryId', () => {
  it('有任务归属键 → `<clientTaskId>@<触发时刻>`', () => {
    expect(buildSelfLogEntryId({
      occurrenceMs: 1_700_000_000_000,
      metadata: { amsgClientTaskId: 'client-task-x' },
    } as any)).toBe('client-task-x@1700000000000');
  });

  it('缺任务归属键 → 用 worker 那边同款的字面量 task', () => {
    expect(buildSelfLogEntryId({ occurrenceMs: 1_700_000_000_000, metadata: {} } as any))
      .toBe('task@1700000000000');
  });

  it('缺触发时刻（老 push 不带）→ null，宁可不动也不瞎猜', () => {
    expect(buildSelfLogEntryId({ metadata: { amsgClientTaskId: 'client-task-x' } } as any)).toBeNull();
  });
});

// 走真 flush 钉住接线：闸吞掉之后确实去撤了对应的那条，且用的是上面那套 id 拼法。
describe('防穿帮闸吞掉消息后撤销云端自述日志（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('吞掉一条 → 按 `<clientTaskId>@<触发时刻>` 把云端那条撤掉', async () => {
    const charId = 'char-swallow-selflog';
    await DB.saveCharacter({ id: charId, name: '被吞角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3_600_000;
    // 锚点之后用户又开口了 → 一次性任务判作废，这条 push 会被吞。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '我在忙',
      timestamp: occurrenceMs - 60_000,
    } as any);

    const entryId = `client-task-swallow@${occurrenceMs}`;
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(JSON.stringify({
      v: 2,
      basePackAt: 1_700_000_000_000,
      entries: [{ id: entryId, at: occurrenceMs, text: '刚看到楼下那只猫又来了' }],
      tasks: [],
    }));
    const clear = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined);

    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-swallow-selflog',
      charId,
      charName: '被吞角色',
      body: '刚看到楼下那只猫又来了',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'none',
      occurrenceMs,
      receivedAt: Date.now(),
      sentAt: occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-swallow',
        amsgAnchorMs: anchorMs,
      },
    } as any);

    await flushInboxToChat();

    // 撤销是 best-effort、不拦着 flush，所以等它自己跑完。
    await vi.waitFor(() => {
      expect(clear, '修复前这里一次都不会被调').toHaveBeenCalledWith(
        amsgStateNamespace(charId), AMSG_SELF_LOG_KEY,
      );
    });
  }, 20000);
});

// ─── ⑤ 多段消息的等齐守卫 ───
// 一次生成拆成几条 push，Web Push 不保证按序到达；App 开着时每条 push 各触发一次 flush，
// 两段落进两批的话「同批按段序排」根本够不着——显示顺序按自增 id，后段先到就永久颠倒。
describe('findPersistedChunkIndexes / findMissingChunkIndexes', () => {
  const bubble = (sessionId: string, messageIndex: number, role = 'assistant') => ({
    role,
    metadata: { sessionId, messageIndex },
  });

  it('认出同 session 已经落过库的段序（一条 push 拆成几个气泡也只算一段）', () => {
    const found = findPersistedChunkIndexes(
      [bubble('S', 1), bubble('S', 1), bubble('S', 3), bubble('T', 2), bubble('S', 2, 'user')],
      'S',
    );
    expect([...found].sort()).toEqual([1, 3]);
  });

  it('前面的段都齐了 → 不缺；缺哪段就报哪段', () => {
    expect(findMissingChunkIndexes(3, new Set([1, 2]))).toEqual([]);
    expect(findMissingChunkIndexes(3, new Set([2]))).toEqual([1]);
    expect(findMissingChunkIndexes(3, new Set())).toEqual([1, 2]);
    expect(findMissingChunkIndexes(1, new Set()), '第一段没有前面的段').toEqual([]);
  });
});

describe('多段消息跨批到达的等齐守卫（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    // 扣住时会排一次几秒后的重看；这组用例自己手动驱动 flush，别让真定时器插进来。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterAll(() => { vi.useRealTimers(); });

  const chunk = (charId: string, sessionId: string, index: number, total: number, body: string) =>
    ActiveMsgStore.saveInboxMessage({
      messageId: `${sessionId}-${index}`,
      charId,
      charName: '分段角色',
      body,
      // 白名单外 → 原稿落库，这组只关心落库顺序。
      messageType: 'forum',
      receivedAt: Date.now() + index,
      sentAt: Date.now() + index,
      metadata: { sessionId, messageIndex: index, totalMessages: total },
    } as any);

  const bodies = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50))
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);

  it('后段先到 → 先扣住等前段；前段到了之后两条按序落库', async () => {
    const charId = 'char-chunk-order';
    const sessionId = 'sess-order';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 2, 2, '……不然我一个人吃不完');
    await flushInboxToChat();

    expect(await bodies(charId), '修复前后段会直接落库，顺序就此固定').toEqual([]);
    expect(
      (await ActiveMsgStore.listInboxMessages()).map((m) => m.messageId),
      '被扣住的消息留在收件箱里等下一次',
    ).toEqual([`${sessionId}-2`]);

    await chunk(charId, sessionId, 1, 2, '晚上一起吃火锅吧');
    await flushInboxToChat();

    expect(await bodies(charId)).toEqual(['晚上一起吃火锅吧', '……不然我一个人吃不完']);
  }, 20000);

  it('前段真丢了 → 扣到上限就放行，绝不永远扣着后段', async () => {
    const charId = 'char-chunk-giveup';
    const sessionId = 'sess-giveup';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 2, 2, '……你说呢');

    // 扣满上限的那几次
    for (let i = 0; i < MAX_INBOX_ORDER_HOLDS; i += 1) {
      await flushInboxToChat();
      expect(await bodies(charId), `第 ${i + 1} 次还该扣着`).toEqual([]);
    }
    // 再来一次：放行
    await flushInboxToChat();

    expect(await bodies(charId)).toEqual(['……你说呢']);
    expect(await ActiveMsgStore.listInboxMessages()).toEqual([]);
  }, 20000);

  it('第一段（messageIndex=1）从不扣，单条 push 也照常直接落库', async () => {
    const charId = 'char-chunk-first';
    const sessionId = 'sess-first';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 1, 2, '在吗');
    await flushInboxToChat();

    expect(await bodies(charId)).toEqual(['在吗']);
  }, 20000);
});

// ─── ⑥ 补收时间戳不能倒挂 ───
// 「打开 App」和「后台补投的 push 送到」之间隔着好几秒，用户来得及先说一句话。
// 这时候还按 sentAt 落库，聊天流里就会出现：08:01 用户说「早安」，下面紧跟着一条
// 标着昨晚 23:00 的角色消息。
describe('resolveBackfillTimestamp', () => {
  const SENT_AT = 1_700_000_000_000;

  it('本地没有更晚的消息 → 保住 sentAt（隔夜补收就该显示昨晚的时间）', () => {
    expect(resolveBackfillTimestamp(SENT_AT, undefined)).toBe(SENT_AT);
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT - 60_000)).toBe(SENT_AT);
  });

  it('本地已有更晚的消息 → 退回写库当刻（undefined），别让时间戳往回走', () => {
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT + 1)).toBeUndefined();
  });

  it('恰好同一时刻 → 不算更晚，保住 sentAt（同一次触发的几段常常同时刻）', () => {
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT)).toBe(SENT_AT);
  });

  it('本来就是在线送达（写库当刻）→ 原样返回 undefined', () => {
    expect(resolveBackfillTimestamp(undefined, SENT_AT + 1)).toBeUndefined();
  });
});

describe('离线补收落库时间戳与本地历史的先后（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });

  const backfillPush = (charId: string, messageId: string, sentAt: number) =>
    ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '守夜角色',
      body: '早点睡',
      messageType: 'forum',
      receivedAt: sentAt,
      sentAt,
    } as any);

  const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');

  it('用户已经先说了话 → 补收的这条落写库当刻，不倒挂到他那句话前面', async () => {
    const charId = 'char-backfill-after-user';
    const sentAt = Date.now() - 13 * 3_600_000;   // 昨晚 23:00 推的
    await DB.saveCharacter({ id: charId, name: '守夜角色' } as any);
    // 用户今早先开的口（push 补投比它晚到几秒）
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '早安', timestamp: Date.now() - 60_000,
    } as any);
    await backfillPush(charId, 'msg-backfill-after-user', sentAt);

    const before = Date.now();
    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp, '修复前这里落的是昨晚 23:00，排在「早安」下面').toBeGreaterThanOrEqual(before);
  }, 20000);

  it('用户没说话 → 照旧落 sentAt（跟正文里角色说的晚上的话对得上）', async () => {
    const charId = 'char-backfill-quiet';
    const sentAt = Date.now() - 13 * 3_600_000;
    await DB.saveCharacter({ id: charId, name: '守夜角色' } as any);
    await backfillPush(charId, 'msg-backfill-quiet', sentAt);

    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);
});

// ─── ⑦ 重试清场：只清正文，副作用产物留在原地 ───
// 副作用产物（转账卡等）跟正文气泡带着同一个 activeMsg2.messageId。一起删掉的话，
// 本轮又因为「认出了标记」判定副作用上次已跑完、不重放 directives —— 卡片删了又不重建，
// 用户看到的就是「角色说转了账，但没有转账卡」，而钱是真的转过。
describe('重试清场时副作用产物不受牵连（走真库）', () => {
  beforeAll(async () => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    await DB.saveCharacter({ id: 'char-retry-sideeffect', name: '转账角色' } as any);
  });

  it('转账卡 + 半截正文 → 只删正文，卡还在，directives 也不重放', async () => {
    const charId = 'char-retry-sideeffect';
    const messageId = 'msg-retry-sideeffect';
    const stale = (content: string, type: string) => DB.saveMessage({
      charId, role: 'assistant', type, content,
      metadata: { source: 'active_msg_2', activeMsg2: { messageId } },
    } as any);

    // 上一趟：副作用跑完了（转账卡已落库），正文写到一半挂了
    await stale('给你转 5 块', 'transfer');
    await stale('给你转个账', 'text');

    await ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '转账角色',
      body: '给你转个账',
      messageType: 'text',          // 白名单内 → 走后处理主路径（重试清场在这条路上）
      receivedAt: Date.now(),
      sentAt: Date.now(),
      processAttempts: 1,           // 这是一次重试
      metadata: { directives: [{ type: 'transfer', amount: 5 }] },
    } as any);

    await flushInboxToChat();

    const msgs = await DB.getRecentMessagesByCharId(charId, 200);
    const transfers = msgs.filter((m) => m.type === 'transfer');
    expect(transfers, '删了又不重放 → 0 张；删了还重放 → 2 张（二次转账）').toHaveLength(1);
    expect(transfers[0].content).toBe('给你转 5 块');
    expect(
      msgs.filter((m) => m.type === 'text' && m.content === '给你转个账'),
      '上一趟的半截正文该被清掉、由这一趟重新渲染，不该并排两条',
    ).toHaveLength(1);
  }, 20000);
});

// 更狠的一种半成品：副作用跑完了、正文一条都没来得及写。
// 这时可删的气泡是 0 条，但「上一趟已经转过账」是铁证——凭据要是照着「删了几条」算，
// 这一趟就会把 directives 再放一遍，用户账上真的少两笔。
describe('重试清场·只留下副作用产物的半成品（走真库）', () => {
  beforeAll(async () => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    await DB.saveCharacter({ id: 'char-retry-cardonly', name: '转账角色' } as any);
  });

  it('上一趟只写下了转账卡 → 不重放 directives，卡还是一张', async () => {
    const charId = 'char-retry-cardonly';
    const messageId = 'msg-retry-cardonly';
    await DB.saveMessage({
      charId, role: 'assistant', type: 'transfer', content: '给你转 8 块',
      metadata: { source: 'active_msg_2', activeMsg2: { messageId } },
    } as any);

    await ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '转账角色',
      body: '给你转个账',
      messageType: 'text',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      processAttempts: 1,
      metadata: { directives: [{ type: 'transfer', amount: 8 }] },
    } as any);

    await flushInboxToChat();

    const transfers = (await DB.getRecentMessagesByCharId(charId, 200))
      .filter((m) => m.type === 'transfer');
    expect(transfers, '凭据按「删了几条」算的话这里会变成 2 张 —— 二次转账').toHaveLength(1);
    expect(transfers[0].content).toBe('给你转 8 块');
  }, 20000);
});
