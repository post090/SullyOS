import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {},
}));
vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: {}, NATIVE_PUSH_TOKEN_STORAGE_KEY: 'token' }));
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: {} }));
vi.mock('./activeMsgRuntime', () => ({ flushInboxToChat: vi.fn() }));

import { decodeNativeAmsgPayload } from './nativeAmsgPush';

describe('native AMSG2 payload bridge', () => {
  it('用通知正文还原被 Worker 去重掉的 message 字段', () => {
    const payload = decodeNativeAmsgPayload({
      body: '你好呀',
      data: {
        amsgHasBody: '1',
        amsgPayload: JSON.stringify({ messageId: 'm1', metadata: { charId: 'c1' } }),
      },
    });
    expect(payload?.message).toBe('你好呀');
    expect(payload?.metadata.charId).toBe('c1');
  });

  it('非 AMSG2 FCM 通知不接管', () => {
    expect(decodeNativeAmsgPayload({ body: '普通通知', data: {} })).toBeNull();
  });
});

