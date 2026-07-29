/** 把消息时间转成模型更容易感知的相对时间，避免把几天前的群聊当成“刚才”。 */
export function formatRelativeAge(timestamp: number, now: number = Date.now()): string {
    if (!Number.isFinite(timestamp)) return '时间未知';

    const deltaMs = Math.max(0, now - timestamp);
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `约 ${minutes} 分钟前`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `约 ${hours} 小时前`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `约 ${days} 天前`;

    const months = Math.floor(days / 30);
    if (months < 12) return `约 ${months} 个月前`;

    const years = Math.max(1, Math.floor(days / 365));
    return `约 ${years} 年前`;
}
