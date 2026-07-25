import { showNativeRoleEventNotification } from './nativeRuntime';

export type RoleEventNotificationKind = 'message' | 'other_side' | 'task' | 'event' | 'error';

export interface RoleEventNotificationInput {
  charName?: string;
  kind: RoleEventNotificationKind;
  name?: string;
  route?: string;
  tag: string;
}

export function formatRoleEventNotification(input: RoleEventNotificationInput): { title: string; body: string; tag: string; route?: string } {
  const title = input.charName?.trim() || 'SullyOS';
  const name = input.name?.trim();
  let body: string;
  switch (input.kind) {
    case 'message': body = '给你发了一条消息'; break;
    case 'other_side': body = name ? `刚刚去了「${name}」` : '刚刚去彼方了'; break;
    case 'task': body = name ? `完成了「${name}」` : '刚刚完成了一件事'; break;
    case 'event': body = name ? `在「${name}」遇到了一件事` : '刚刚有件事想告诉你'; break;
    case 'error': body = '刚才没能联系上你'; break;
  }
  return { title, body, tag: input.tag, route: input.route };
}

const NOTIFIED_KEY = 'sully_role_event_notifications_v1';
const NOTIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function claimNotification(tag: string): boolean {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY);
    const current = raw ? JSON.parse(raw) as Record<string, number> : {};
    const now = Date.now();
    for (const key of Object.keys(current)) if (!Number.isFinite(current[key]) || now - current[key] > NOTIFIED_TTL_MS) delete current[key];
    if (current[tag]) return false;
    current[tag] = now;
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(current));
    return true;
  } catch {
    return true;
  }
}

export async function notifyRoleEvent(input: RoleEventNotificationInput): Promise<void> {
  if (!claimNotification(input.tag)) return;
  await showNativeRoleEventNotification(formatRoleEventNotification(input));
}
