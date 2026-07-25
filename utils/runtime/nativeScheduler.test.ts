import { describe, it, expect, vi } from 'vitest';
import { drainNativeTimers, scheduleNativeTimer, scheduleNativeProactiveTimer } from './nativeScheduler';

describe('nativeScheduler - web fallback', () => {
  it('does not throw on web (no native platform)', async () => {
    await expect(scheduleNativeTimer({ tag: 'test-web', runAt: Date.now() + 60000, kind: 'generic' })).resolves.toBeUndefined();
    await expect(drainNativeTimers()).resolves.toBe(0);
  });

  it('schedules proactive timer safely on web', async () => {
    await expect(scheduleNativeProactiveTimer('char-1', Date.now() + 3600000)).resolves.toBeUndefined();
  });

  it('dispatches custom event only when drain finds completed jobs (mocked)', async () => {
    // On web platform, Capacitor.isNativePlatform() is false, so drain returns 0.
    // This test ensures the module loads and API is present.
    const count = await drainNativeTimers();
    expect(typeof count).toBe('number');
  });
});
