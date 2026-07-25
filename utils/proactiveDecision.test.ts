import { describe, expect, it } from 'vitest';
import { MISS_THRESHOLD } from './proactiveChat';
import { shouldSkipProactiveForSleep } from './proactiveDecision';

describe('proactive sleep gate', () => {
  const now = new Date(2026, 6, 27, 2, 0);
  it('skips ordinary catch-up during sleep', () => {
    expect(shouldSkipProactiveForSleep({ now, sleepStart: '23:00', sleepEnd: '07:00', missCount: MISS_THRESHOLD - 1 })).toBe(true);
  });
  it('keeps the threshold escape hatch', () => {
    expect(shouldSkipProactiveForSleep({ now, sleepStart: '23:00', sleepEnd: '07:00', missCount: MISS_THRESHOLD })).toBe(false);
  });
  it('does not gate outside sleep or without a valid window', () => {
    expect(shouldSkipProactiveForSleep({ now: new Date(2026, 6, 27, 8, 0), sleepStart: '23:00', sleepEnd: '07:00', missCount: 0 })).toBe(false);
    expect(shouldSkipProactiveForSleep({ now, sleepStart: undefined, sleepEnd: undefined, missCount: 0 })).toBe(false);
  });
});
