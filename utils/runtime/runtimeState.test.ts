import { beforeEach, describe, expect, it } from 'vitest';
import { AppID } from '../../types';
import {
  getRestorableActiveApp,
  getRestorableActiveCharacterId,
  getRestorableSuspendedCall,
  loadRuntimeSnapshot,
  patchRuntimeSnapshot,
  saveRuntimeSnapshot,
} from './runtimeState';

const KEY = 'sully_runtime_snapshot_v1';

describe('runtimeState snapshot', () => {
  beforeEach(() => localStorage.removeItem(KEY));

  it('stores and restores active app and character', () => {
    patchRuntimeSnapshot({ activeApp: AppID.Chat, activeCharacterId: 'char-1' });

    expect(getRestorableActiveApp()).toBe(AppID.Chat);
    expect(getRestorableActiveCharacterId()).toBe('char-1');
  });

  it('does not restore launcher as a meaningful active app', () => {
    patchRuntimeSnapshot({ activeApp: AppID.Launcher });
    expect(getRestorableActiveApp()).toBe(AppID.Launcher);
  });

  it('drops invalid app ids instead of crashing', () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, activeApp: 'bad-app' }));

    expect(loadRuntimeSnapshot().activeApp).toBeUndefined();
    expect(getRestorableActiveApp()).toBe(AppID.Launcher);
  });

  it('restores only valid suspended calls', () => {
    saveRuntimeSnapshot({
      version: 1,
      suspendedCall: { charId: 'c1', charName: '阿澄', startedAt: 123 },
    });
    expect(getRestorableSuspendedCall()).toMatchObject({ charId: 'c1', charName: '阿澄' });

    saveRuntimeSnapshot({ version: 1, suspendedCall: { charId: '', charName: '', startedAt: 0 } as any });
    expect(getRestorableSuspendedCall()).toBeNull();
  });
});
