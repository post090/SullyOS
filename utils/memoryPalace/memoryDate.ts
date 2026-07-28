const DAY_MS = 24 * 60 * 60 * 1000;

function localDayNumber(date: Date): number {
    return Math.floor(Date.UTC(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
    ) / DAY_MS);
}

/**
 * 给记忆日期补上相对今天的距离，避免模型把有明确年份的旧事仍误判成“最近”。
 *
 * 按本地日历日计算，而不是直接拿毫秒相除；这样跨夏令时或午夜附近也不会偏一天。
 */
export function formatMemoryDateWithDistance(
    createdAt: number,
    now: number = Date.now(),
): string {
    const date = new Date(createdAt);
    const today = new Date(now);
    if (Number.isNaN(date.getTime()) || Number.isNaN(today.getTime())) return '日期不详';

    const dayDistance = localDayNumber(today) - localDayNumber(date);
    const relative = dayDistance === 0
        ? '今天'
        : dayDistance > 0
            ? `距今约${dayDistance}天`
            : `约${Math.abs(dayDistance)}天后`;

    const calendarDate = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    return `${calendarDate}（${relative}）`;
}
