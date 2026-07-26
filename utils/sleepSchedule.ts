import { CharacterProfile } from '../types';

/**
 * 角色睡眠窗口的统一读取口。
 *
 * 历史包袱：睡眠时间最早长在 proactiveConfig（主动消息）里，导致
 * "不开主动消息但想让角色逛彼方"时连睡眠都设不了。现在睡眠时间
 * 归位到神经链接（char.sleepSchedule，角色的全局生物钟），这里做
 * 兼容读取：
 *   1. 新字段 sleepSchedule 存在 → 以它为准（enabled=false 即显式无睡眠窗口）
 *   2. 新字段没设过 → 回落读旧 proactiveConfig.sleepStart/sleepEnd（旧用户无感迁移）
 *
 * 所有消费方（主动消息决策、调度器快照、彼方自主登入、UI 展示）
 * 都必须走这个函数，不要再直接摸 proactiveConfig 的睡眠字段。
 */
export function getSleepWindow(
    char: Pick<CharacterProfile, 'sleepSchedule' | 'proactiveConfig'>,
): { sleepStart?: string; sleepEnd?: string } {
    const s = char.sleepSchedule;
    if (s) {
        return s.enabled ? { sleepStart: s.start, sleepEnd: s.end } : {};
    }
    const p = char.proactiveConfig;
    return { sleepStart: p?.sleepStart, sleepEnd: p?.sleepEnd };
}
