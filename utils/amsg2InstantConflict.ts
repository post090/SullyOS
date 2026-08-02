/**
 * 主动消息 2.0 与 Instant Push 同时开着时的冲突判定。
 *
 * 聊天路径二选一：Instant Push 配好之后，一轮聊天会在 useChatAI 里提前交给 instant worker
 * 并 return，本地 fetch 那条路后面的东西全都不执行。而主动消息 2.0 挂在本地那条路上的
 * 有三样，走 instant 时一样都不生效：
 *
 *   1. 排程工具 —— schedule / cancel / renew / list 拼在 baseReqBody.tools 里，
 *      instant 的请求体压根不带 tools 字段，角色想排任务也没有工具可调；
 *   2. 排程现状块 —— 「你有哪些任务待触发」是新拼一份 messages 塞进去的，
 *      instant 发的是原始那份，角色不知道自己有任务在排；
 *   3. 活跃会话租约 —— 心跳写在 instant 那个 return 之后。租约是防穿帮闸的依据
 *      （worker 到点看到「用户正在跟这个角色聊」就跳过），不开就等于闸失灵：
 *      你正聊着，一条定时主动消息可能直接弹出来。
 *
 * 三样都是**静默**失效的：没有报错、没有提示，功能就是不响。所以这份判定要同时供
 * 设置面板（提前告诉用户）和聊天路径（真走岔了留一条 trace）用，两边看的是同一个条件。
 */

import { CharacterProfile } from '../types';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { isInstantConfigReady } from './instantPushClient';

/** trace 事件名：本轮聊天走了 instant，该角色的 amsg2 三件套本轮没生效。 */
export const AMSG2_SUPPRESSED_TRACE = 'amsg2-suppressed-by-instant';

/**
 * 这个角色本轮的 amsg2 能力会不会被 instant 顶掉。
 *
 * 只看「两边都开着」：instant 就绪 + 该角色的 2.0 没被关掉。角色有没有待触发任务
 * 不在判定里——没有任务时排程工具和现状块照样是哑的，用户照样会觉得「功能坏了」。
 */
export const isAmsg2SuppressedByInstant = (char: CharacterProfile | undefined): boolean =>
  Boolean(char) && isAmsg2EnabledForChar(char!) && isInstantConfigReady();
