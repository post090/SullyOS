import { describe, it, expect } from 'vitest';
import { AppID } from '../types';
import { shellHandlesSafeArea } from './safeAreaApps';

describe('shellHandlesSafeArea', () => {
    // 回归守卫：Spark 已迁移成自理安全区，外壳就不该再加 padding，否则顶部会双重让位（留白过多）。
    // 旧行为（Social 不在名单）下此条挂；迁移后过。防止以后误把 Social 移出名单导致回退。
    it('Spark(Social) 自理安全区，外壳不应再加 padding', () => {
        expect(shellHandlesSafeArea(AppID.Social)).toBe(false);
    });

    // 对照：尚未迁移的 App 仍由外壳兜底让位，避免顶栏怼进刘海。
    it('未迁移的 App（设置）仍由外壳让位安全区', () => {
        expect(shellHandlesSafeArea(AppID.Settings)).toBe(true);
    });

    // 既有自理 App 不应回退（聊天/彼方/桌面）。
    it('既有自理 App（聊天）保持自理', () => {
        expect(shellHandlesSafeArea(AppID.Chat)).toBe(false);
    });
});
