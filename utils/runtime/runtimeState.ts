import { AppID } from '../../types';

const SNAPSHOT_KEY = 'sully_runtime_snapshot_v1';
const VALID_APP_IDS = new Set<string>(Object.values(AppID));

export interface SuspendedCallSnapshot {
  charId: string;
  charName: string;
  charAvatar?: string;
  startedAt: number;
  bubbles?: any[];
  sessionId?: string;
  elapsedSeconds?: number;
  voiceLang?: string;
}

export interface RuntimeSnapshot {
  version: 1;
  activeApp?: AppID;
  activeCharacterId?: string;
  lastVisibleAt?: number;
  lastHiddenAt?: number;
  suspendedCall?: SuspendedCallSnapshot | null;
}

const emptySnapshot = (): RuntimeSnapshot => ({ version: 1 });

export function loadRuntimeSnapshot(): RuntimeSnapshot {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return emptySnapshot();
    const parsed = JSON.parse(raw) as RuntimeSnapshot;
    if (!parsed || parsed.version !== 1) return emptySnapshot();
    if (parsed.activeApp && !VALID_APP_IDS.has(parsed.activeApp)) parsed.activeApp = undefined;
    return parsed;
  } catch {
    return emptySnapshot();
  }
}

export function saveRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...snapshot, version: 1 }));
  } catch {
    // best-effort: runtime snapshot must never break the app
  }
}

export function patchRuntimeSnapshot(patch: Partial<RuntimeSnapshot>): RuntimeSnapshot {
  const next = { ...loadRuntimeSnapshot(), ...patch, version: 1 as const };
  saveRuntimeSnapshot(next);
  return next;
}

export function getRestorableActiveApp(): AppID {
  const app = loadRuntimeSnapshot().activeApp;
  // 不恢复到锁屏/启动类状态；其它 App 都可以作为“上次现场”恢复。
  if (!app || app === AppID.Launcher) return AppID.Launcher;
  return app;
}

export function getRestorableActiveCharacterId(): string | undefined {
  const id = loadRuntimeSnapshot().activeCharacterId;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

export function getRestorableSuspendedCall(): SuspendedCallSnapshot | null {
  const call = loadRuntimeSnapshot().suspendedCall;
  if (!call?.charId || !call.charName || !call.startedAt) return null;
  return call;
}

/**
 * 距上次“回到前台/变可见”的毫秒数。lastVisibleAt 由 visibilitychange / appStateChange 写入；
 * 未记录时返回 Infinity（视为“不在回前台恢复窗口”，走常规逻辑）。
 * 用于区分“切后台再回来”的前几秒（系统网络栈尚未恢复，连接尸体导致必炸）。
 */
export function msSinceForeground(now: number = Date.now()): number {
  const t = loadRuntimeSnapshot().lastVisibleAt;
  return typeof t === 'number' && t > 0 ? Math.max(0, now - t) : Infinity;
}
