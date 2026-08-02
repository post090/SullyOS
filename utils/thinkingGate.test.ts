// utils/thinkingGate.test.ts
// 「思考链 + 工具」能不能同时发给后端。
//
// Gemini 兼容层收到 thinking/reasoning 参数 + tools 会直接 400 INVALID_ARGUMENT，
// 所以既有的小程序/MCP 工具模式一律让思考链让步（用户是主动进那个模式的，临时让步）。
// 但主动消息 2.0 的工具是「配了 worker 就常驻」的——把它也算进工具模式，等于让所有配过
// worker 的角色永久失去思考链，这个代价比 400 还大。所以只对真会打回的渠道让步。
import { describe, it, expect } from 'vitest';

import { shouldSendThinkingParams } from './thinkingGate';

const base = {
  thinkingActive: true,
  legacyToolModeActive: false,
  amsg2ToolsInjected: false,
  model: 'claude-sonnet-5',
};

describe('shouldSendThinkingParams', () => {
  it('没开思考链 → 什么都不带', () => {
    expect(shouldSendThinkingParams({ ...base, thinkingActive: false })).toBe(false);
  });

  it('开了思考链、没有任何工具 → 照常带', () => {
    expect(shouldSendThinkingParams(base)).toBe(true);
  });

  it('小程序/MCP 工具模式 → 思考链让步（既有行为不回归）', () => {
    expect(shouldSendThinkingParams({ ...base, legacyToolModeActive: true })).toBe(false);
  });

  it('工具模式让步与渠道无关（Claude 也让）', () => {
    expect(shouldSendThinkingParams({
      ...base, legacyToolModeActive: true, model: 'claude-opus-5',
    })).toBe(false);
  });

  it('amsg2 工具 + Gemini → 让步，避免 400 INVALID_ARGUMENT', () => {
    expect(shouldSendThinkingParams({
      ...base, amsg2ToolsInjected: true, model: 'gemini-2.5-pro',
    })).toBe(false);
  });

  it('amsg2 工具 + Claude → 照常带（thinking+tools 是官方支持组合，不能误伤）', () => {
    expect(shouldSendThinkingParams({
      ...base, amsg2ToolsInjected: true, model: 'claude-sonnet-5',
    })).toBe(true);
  });

  it('amsg2 工具 + OpenAI 系 → 照常带', () => {
    expect(shouldSendThinkingParams({
      ...base, amsg2ToolsInjected: true, model: 'o3-mini',
    })).toBe(true);
  });

  it('渠道名大小写/前缀混写也能认出 Gemini（中转常带前缀）', () => {
    expect(shouldSendThinkingParams({
      ...base, amsg2ToolsInjected: true, model: 'google/Gemini-2.0-Flash',
    })).toBe(false);
  });

  it('没注入 amsg2 工具时，Gemini 的思考链不受影响', () => {
    expect(shouldSendThinkingParams({ ...base, model: 'gemini-2.5-pro' })).toBe(true);
  });
});
