export const SULLY_DEFAULT_AVATAR_URL =
    'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/head.png';

const OLD_SULLY_AVATAR_URL = 'https://sharkpan.xyz/f/BZ3VSa/head.png';
const LEGACY_LOCAL_PATHS = new Set([
    '/sully/head.png',
    '/SullyOS/sully/head.png',
]);
const LEGACY_GITHUB_PAGES_HOST = 'qegj567-cloud.github.io';

/**
 * 只识别 Sully 曾经使用过的默认头像地址。
 * 用户自定义头像即使文件名同为 head.png，也不会被覆盖。
 */
export function shouldMigrateSullyAvatar(value: string | undefined, pageHref?: string): boolean {
    const avatar = String(value || '').trim();
    if (!avatar) return false;
    if (avatar === OLD_SULLY_AVATAR_URL) return true;
    if (avatar === 'sully/head.png' || avatar === './sully/head.png') return true;

    try {
        const page = new URL(
            pageHref || (typeof window !== 'undefined'
                ? window.location.href
                : 'https://local.invalid/SullyOS/'),
        );
        const resolved = new URL(avatar, page);
        return LEGACY_LOCAL_PATHS.has(resolved.pathname)
            && (resolved.origin === page.origin
                || resolved.hostname === LEGACY_GITHUB_PAGES_HOST);
    } catch {
        return false;
    }
}
