/**
 * 小程序（麦当劳 / 瑞幸）点单模式下一次工具调用该交给谁。
 *
 * 这两个模式的循环原本只认 propose_cart_items，其余一律当畸形调用回错让模型自纠。
 * 但主动消息 2.0 的排程工具是常驻注入的，也会出现在同一批 tool_calls 里——被当成畸形
 * 吃掉后，紧接着的续写请求又把 tools 删了，角色「点单时顺手排个提醒」就永远不会生效。
 */

import { AMSG2_TOOL_NAMES } from './amsg2ToolBridge';

export type MiniAppToolRoute = 'propose' | 'amsg2' | 'malformed';

export const routeMiniAppToolCall = (fname: string, args: any): MiniAppToolRoute => {
  if (AMSG2_TOOL_NAMES.has(fname)) return 'amsg2';
  if (fname === 'propose_cart_items' && Array.isArray(args?.items) && args.items.length) return 'propose';
  return 'malformed';
};
