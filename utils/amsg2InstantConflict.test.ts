// utils/amsg2InstantConflict.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CharacterProfile } from '../types';

// 判定要拿两边的开关合起来看，两个来源都 mock 掉，用例只管组合。
vi.mock('./instantPushClient', () => ({ isInstantConfigReady: vi.fn() }));
vi.mock('./amsg2Tasks', () => ({ isAmsg2EnabledForChar: vi.fn() }));

import { isAmsg2SuppressedByInstant } from './amsg2InstantConflict';
import { isInstantConfigReady } from './instantPushClient';
import { isAmsg2EnabledForChar } from './amsg2Tasks';

const char = { id: 'c1', name: '测试角色' } as unknown as CharacterProfile;

const setup = (instantReady: boolean, amsg2On: boolean) => {
  vi.mocked(isInstantConfigReady).mockReturnValue(instantReady);
  vi.mocked(isAmsg2EnabledForChar).mockReturnValue(amsg2On);
};

describe('isAmsg2SuppressedByInstant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('两边都开着 → 本轮 amsg2 被顶掉', () => {
    setup(true, true);
    expect(isAmsg2SuppressedByInstant(char)).toBe(true);
  });

  it('只开了 instant，角色没开 2.0 → 没什么可顶的', () => {
    setup(true, false);
    expect(isAmsg2SuppressedByInstant(char)).toBe(false);
  });

  it('只开了 2.0 → 聊天走本地，三样都正常', () => {
    setup(false, true);
    expect(isAmsg2SuppressedByInstant(char)).toBe(false);
  });

  it('都没开 → 无冲突', () => {
    setup(false, false);
    expect(isAmsg2SuppressedByInstant(char)).toBe(false);
  });

  it('没有角色时不判定，也不去读两边的配置', () => {
    setup(true, true);
    expect(isAmsg2SuppressedByInstant(undefined)).toBe(false);
    expect(isInstantConfigReady).not.toHaveBeenCalled();
  });
});
