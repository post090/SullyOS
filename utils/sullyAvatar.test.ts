import { describe, expect, it } from 'vitest';
import { SULLY_DEFAULT_AVATAR_URL, shouldMigrateSullyAvatar } from './sullyAvatar';

const PAGE = 'https://qegj567-cloud.github.io/SullyOS/';

describe('Sully 默认头像迁移', () => {
    it.each([
        'https://sharkpan.xyz/f/BZ3VSa/head.png',
        'sully/head.png',
        './sully/head.png',
        '/sully/head.png',
        '/SullyOS/sully/head.png',
        'https://qegj567-cloud.github.io/sully/head.png',
        'https://qegj567-cloud.github.io/SullyOS/sully/head.png',
    ])('识别旧默认地址 %s', value => {
        expect(shouldMigrateSullyAvatar(value, PAGE)).toBe(true);
    });

    it('recognizes legacy GitHub Pages URLs after cross-environment restore', () => {
        expect(shouldMigrateSullyAvatar('https://qegj567-cloud.github.io/sully/head.png', 'capacitor://localhost/')).toBe(true);
        expect(shouldMigrateSullyAvatar('https://qegj567-cloud.github.io/SullyOS/sully/head.png', 'http://localhost:5173/')).toBe(true);
    });

    it('不覆盖当前资产仓库地址或用户自定义头像', () => {
        expect(shouldMigrateSullyAvatar(SULLY_DEFAULT_AVATAR_URL, PAGE)).toBe(false);
        expect(shouldMigrateSullyAvatar('https://images.example/custom.png', PAGE)).toBe(false);
        expect(shouldMigrateSullyAvatar('/custom/sully/head.png', PAGE)).toBe(false);
    });
});
