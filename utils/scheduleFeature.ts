import type { CharacterProfile } from '../types';

/**
 * 日程 / 情绪 buff 总开关判定。
 * - 显式为 true / false 时直接使用。
 * - undefined 时走向后兼容：老用户若已选了 scheduleStyle，视为开启；否则默认关闭。
 * 任何副 API 调用、情绪评估、日程注入之前都应先过此闸门。
 */
export function isScheduleFeatureOn(
    char: Pick<CharacterProfile, 'scheduleFeatureEnabled' | 'scheduleStyle'> | null | undefined,
): boolean {
    if (!char) return false;
    if (char.scheduleFeatureEnabled === true) return true;
    if (char.scheduleFeatureEnabled === false) return false;
    return !!char.scheduleStyle;
}

/** 根据当前小时数返回 flowNarrative 的时段 key。 */
export function getFlowNarrativeKey(hour: number): 'morning' | 'afternoon' | 'evening' {
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}
