/** 旧版系统默认的粉绿渐变；只用于识别并迁移，不能再作为新默认值使用。 */
export const LEGACY_DEFAULT_WALLPAPER = 'linear-gradient(135deg, #FFDEE9 0%, #B5FFFC 100%)';

/**
 * 浏览器或历史版本可能把十六进制颜色规范化为 rgb()，因此不能只做原字符串相等判断。
 * 同时要求角度和两端系统色都匹配，避免误伤普通用户自定义渐变。
 */
export function isLegacyDefaultWallpaper(wallpaper?: string): boolean {
    if (!wallpaper) return false;
    const compact = wallpaper.toLowerCase().replace(/\s+/g, '');
    const hasPink = compact.includes('#ffdee9') || compact.includes('rgb(255,222,233)');
    const hasMint = compact.includes('#b5fffc') || compact.includes('rgb(181,255,252)');
    return compact.startsWith('linear-gradient(135deg,') && hasPink && hasMint;
}
