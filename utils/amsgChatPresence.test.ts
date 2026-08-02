// utils/amsgChatPresence.test.ts
import { describe, it, expect } from 'vitest';
import {
  AmsgChatPresence,
  CHAT_PRESENCE_TTL_MS,
  isFreshChatPresence,
  parseAmsgChatPresence,
} from './amsgChatPresence';

const presence = (over: Partial<AmsgChatPresence> = {}): AmsgChatPresence => ({
  v: 1,
  charId: 'char-1',
  activeAt: 1_000_000,
  lastUserMessageAt: 999_000,
  ...over,
});

describe('parseAmsgChatPresence', () => {
  it('合法 JSON → 还原对象', () => {
    const raw = JSON.stringify(presence());
    expect(parseAmsgChatPresence(raw)).toEqual(presence());
  });

  it('lastUserMessageAt 允许为 null', () => {
    const raw = JSON.stringify(presence({ lastUserMessageAt: null }));
    expect(parseAmsgChatPresence(raw)).toEqual(presence({ lastUserMessageAt: null }));
  });

  it('损坏 JSON → null', () => {
    expect(parseAmsgChatPresence('{ not json')).toBeNull();
  });

  it('undefined / 空串 → null', () => {
    expect(parseAmsgChatPresence(undefined)).toBeNull();
    expect(parseAmsgChatPresence('')).toBeNull();
  });

  it('版本号不对 / 字段类型不对 → null', () => {
    expect(parseAmsgChatPresence(JSON.stringify({ ...presence(), v: 2 }))).toBeNull();
    expect(parseAmsgChatPresence(JSON.stringify({ ...presence(), charId: 123 }))).toBeNull();
    expect(parseAmsgChatPresence(JSON.stringify({ ...presence(), activeAt: 'x' }))).toBeNull();
    expect(parseAmsgChatPresence(JSON.stringify({ ...presence(), lastUserMessageAt: 'x' }))).toBeNull();
  });
});

describe('isFreshChatPresence', () => {
  const now = 2_000_000;

  it('同角色 + 未过期 → true', () => {
    expect(isFreshChatPresence(presence({ activeAt: now - 1000 }), 'char-1', now)).toBe(true);
  });

  it('null / undefined → false', () => {
    expect(isFreshChatPresence(null, 'char-1', now)).toBe(false);
    expect(isFreshChatPresence(undefined, 'char-1', now)).toBe(false);
  });

  it('不同角色 → false', () => {
    expect(isFreshChatPresence(presence({ activeAt: now - 1000 }), 'char-2', now)).toBe(false);
  });

  it('超过 TTL 过期 → false', () => {
    expect(isFreshChatPresence(presence({ activeAt: now - CHAT_PRESENCE_TTL_MS - 1 }), 'char-1', now)).toBe(false);
  });

  it('刚好落在 TTL 边界内 → true', () => {
    expect(isFreshChatPresence(presence({ activeAt: now - CHAT_PRESENCE_TTL_MS }), 'char-1', now)).toBe(true);
  });

  it('未来时钟偏移过大（超过 10s 宽限）→ false', () => {
    expect(isFreshChatPresence(presence({ activeAt: now + 10_001 }), 'char-1', now)).toBe(false);
  });

  it('小幅未来偏移（10s 宽限内）→ true', () => {
    expect(isFreshChatPresence(presence({ activeAt: now + 5_000 }), 'char-1', now)).toBe(true);
  });
});
