/**
 * 时间窗口工具 — 主要给主动消息睡眠感知用。
 *
 * 关键点：睡眠窗口通常跨日（23:00-07:00），不能简单 start <= now <= end。
 * 这里把 "HH:MM" 字符串转成当日分钟数（0-1439），跨日窗口拆成两段判断。
 */

/**
 * 把 "HH:MM" 字符串转成当日分钟数（0-1439）。
 * 非法格式 / 越界返回 null。
 */
export function parseHHMMToMinutes(hhmm: string): number | null {
    if (typeof hhmm !== 'string') return null;
    const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

/**
 * 判断当前时间是否落在 [start, end) 窗口内。
 * - start < end（同日，如 13:00-15:00 午睡）：nowMinutes ∈ [start, end)
 * - start > end（跨日，如 23:00-07:00 夜睡）：nowMinutes >= start || nowMinutes < end
 * - start === end：视为全天（返回 true）—— 这种配置无意义，按"一直在睡"处理
 *
 * @param now 当前时间（用 new Date()）
 * @param startHHMM 起始时间 "HH:MM"
 * @param endHHMM 结束时间 "HH:MM"
 * @returns 在窗口内返回 true；任一参数非法返回 false（fail-open，不卡用户）
 */
export function isInTimeWindow(
    now: Date,
    startHHMM: string | undefined | null,
    endHHMM: string | undefined | null,
): boolean {
    if (!startHHMM || !endHHMM) return false;
    const start = parseHHMMToMinutes(startHHMM);
    const end = parseHHMMToMinutes(endHHMM);
    if (start === null || end === null) return false;
    if (start === end) return true; // 全天窗口（无意义但合法）

    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    if (start < end) {
        // 同日窗口
        return nowMinutes >= start && nowMinutes < end;
    } else {
        // 跨日窗口（如 23:00-07:00）
        return nowMinutes >= start || nowMinutes < end;
    }
}
