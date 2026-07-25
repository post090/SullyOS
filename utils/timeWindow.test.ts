import { describe, expect, it } from 'vitest';
import { isInTimeWindow } from './timeWindow';

describe('proactive sleep windows', () => {
  it('blocks a cross-midnight sleep window at night', () => {
    expect(isInTimeWindow(new Date(2026, 6, 26, 23, 30), '23:00', '07:00')).toBe(true);
    expect(isInTimeWindow(new Date(2026, 6, 27, 6, 59), '23:00', '07:00')).toBe(true);
    expect(isInTimeWindow(new Date(2026, 6, 27, 7, 0), '23:00', '07:00')).toBe(false);
  });
  it('blocks a same-day sleep window', () => {
    expect(isInTimeWindow(new Date(2026, 6, 26, 13, 0), '13:00', '15:00')).toBe(true);
    expect(isInTimeWindow(new Date(2026, 6, 26, 15, 0), '13:00', '15:00')).toBe(false);
  });
});
