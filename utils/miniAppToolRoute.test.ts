// utils/miniAppToolRoute.test.ts
// 小程序（麦当劳 / 瑞幸）点单模式下，这一轮请求里除了 propose_cart_items，还挂着主动消息
// 2.0 的排程工具。小程序的工具循环原本把「不是 propose_cart_items 的一律当畸形调用回错」，
// 于是角色在点单时想排个定时消息，调用会被吃掉当报错，紧接着的续写请求又把 tools 删了，
// 排程永远走不到执行器。这里钉住分流：amsg2 工具必须被认出来，不能落进 malformed。
import { describe, it, expect, vi } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { scheduleCharacterTask: vi.fn(), cancelTask: vi.fn() },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import { routeMiniAppToolCall } from './miniAppToolRoute';

describe('routeMiniAppToolCall', () => {
  it('带 items 的 propose_cart_items → 走小程序推荐卡', () => {
    expect(routeMiniAppToolCall('propose_cart_items', { items: [{ code: 'a' }] })).toBe('propose');
  });

  it('排程工具 → 交给 amsg2 执行器（回归：被当成畸形调用吃掉）', () => {
    expect(routeMiniAppToolCall('schedule_active_message', { send_at: 'x' })).toBe('amsg2');
  });

  it('取消 / 续期 / 列表也一样放行', () => {
    expect(routeMiniAppToolCall('cancel_active_message', {})).toBe('amsg2');
    expect(routeMiniAppToolCall('renew_active_message', { send_at: 'x' })).toBe('amsg2');
    expect(routeMiniAppToolCall('list_active_messages', {})).toBe('amsg2');
  });

  it('propose_cart_items 但 items 空 → 仍算畸形，让模型自纠（既有行为不回归）', () => {
    expect(routeMiniAppToolCall('propose_cart_items', { items: [] })).toBe('malformed');
    expect(routeMiniAppToolCall('propose_cart_items', {})).toBe('malformed');
  });

  it('模型幻觉出的工具名 → 畸形', () => {
    expect(routeMiniAppToolCall('order_pizza', {})).toBe('malformed');
  });
});
