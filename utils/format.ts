export const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/**
 * 备份文件名用的可读时间戳：YYYY-MM-DD_HH-MM-SS（本地时区）。
 *
 * 为什么不用 Date.now() 毫秒戳：用户看不懂，本地存了一堆数字结尾的 zip
 * 根本分不出哪份是哪天的。
 *
 * 为什么不用 ISO 字符串（2026-07-20T15:30:45.000Z）：
 *   1. T 和 : 在 Windows / 部分 ROM 文件名里是非法字符
 *   2. ISO 是 UTC，国内用户看到 8 小时偏移会困惑
 *
 * 用本地时区 + 0 填充 + 下划线分隔：字典序 = 时间序，WebDAV 按文件名倒序排
 * 也能正确把最新备份排在最前面。
 */
export const formatBackupTimestamp = (d: Date = new Date()): string => {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
       + `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};
