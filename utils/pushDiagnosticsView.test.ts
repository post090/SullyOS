// 设置页「链路状态」面板文案的回归守卫。
//
// 要钉住的核心行为：**能力检测说「支持」不等于这台设备真能推**。华为 Mate 60 这类不带
// 谷歌服务的国行安卓机上，Chromium 把 PushManager 编译进去了，所以接口检测全绿，但
// subscribe() 必挂。以前面板对着这种机器写「浏览器支持：是」，用户完全无从下手。

import { describe, expect, it } from 'vitest';
import {
  describeElapsed,
  describeSupport,
  hasLiveFailure,
  isSupportBad,
  liveFailureKind,
} from './pushDiagnosticsView';
import type { BrowserPushState } from './pushSubscribeShared';

const baseState = (patch: Partial<BrowserPushState> = {}): BrowserPushState => ({
  supported: true,
  capabilityGap: null,
  permission: 'granted',
  swScope: 'https://example.test/',
  swState: 'activated',
  endpoint: null,
  endpointDead: false,
  channel: '未知',
  iosNeedsPwa: false,
  capacitorNative: false,
  lastSubscribeFailure: null,
  ...patch,
});

describe('「浏览器支持」这一行', () => {
  it('接口齐全但连不上推送服务器时，不再简单说「是」', () => {
    // 正是 Mate 60 的读数：接口全在、权限已授权、SW 已激活、订阅建不出来。
    const state = baseState({
      lastSubscribeFailure: { kind: 'channel-unreachable', text: '连不上推送服务器……', at: Date.now() },
    });

    expect(describeSupport(state)).toBe('接口齐全，但连不上推送服务器');
    expect(isSupportBad(state)).toBe(true);
  });

  it('浏览器自称支持但实际建不出订阅时判「否」', () => {
    const state = baseState({
      lastSubscribeFailure: { kind: 'unsupported', text: '当前浏览器不支持网页推送……', at: Date.now() },
    });

    expect(describeSupport(state)).toBe('否（浏览器自称支持，实际建不出订阅）');
    expect(isSupportBad(state)).toBe(true);
  });

  it('权限被拒、状态冲突这类不赖设备，「浏览器支持」照旧是「是」', () => {
    // 这两类换设备没用、重试有用，标红只会把用户往错的方向引。
    for (const kind of ['permission', 'state', 'zombie', 'unknown'] as const) {
      const state = baseState({ lastSubscribeFailure: { kind, text: '...', at: Date.now() } });
      expect(describeSupport(state)).toBe('是');
      expect(isSupportBad(state)).toBe(false);
    }
  });

  it('接口本身就缺、或跑在 App 里的老判定不变', () => {
    expect(describeSupport(baseState({ supported: false }))).toBe('否（浏览器缺少推送相关接口）');
    expect(describeSupport(baseState({ capacitorNative: true }))).toBe('否（现在跑在 App 里）');
    expect(isSupportBad(baseState({ supported: false }))).toBe(true);
    expect(isSupportBad(baseState({ capacitorNative: true }))).toBe(true);
  });

  it('什么都没失败过时是「是」，不标红', () => {
    expect(describeSupport(baseState())).toBe('是');
    expect(isSupportBad(baseState())).toBe(false);
  });
});

describe('失败记录的时效', () => {
  it('已经有活订阅了就当没失败过', () => {
    // 换了浏览器 / SW 自愈重订之后，旧记录还在盘上但显然过期了，再显示就是误导。
    const state = baseState({
      endpoint: 'https://fcm.googleapis.com/fcm/send/ok',
      lastSubscribeFailure: { kind: 'channel-unreachable', text: '陈年旧账', at: 1 },
    });

    expect(hasLiveFailure(state)).toBe(false);
    expect(liveFailureKind(state)).toBeNull();
    expect(describeSupport(state)).toBe('是');
  });

  it('端点是僵尸哨兵时失败记录仍然算数', () => {
    const state = baseState({
      endpoint: 'https://permanently-removed.invalid/x',
      endpointDead: true,
      lastSubscribeFailure: { kind: 'channel-unreachable', text: '...', at: Date.now() },
    });

    expect(hasLiveFailure(state)).toBe(true);
    expect(liveFailureKind(state)).toBe('channel-unreachable');
  });
});

describe('describeElapsed', () => {
  const now = 1_700_000_000_000;

  it('按分钟 / 小时 / 天说人话', () => {
    expect(describeElapsed(now - 10_000, now)).toBe('刚刚');
    expect(describeElapsed(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(describeElapsed(now - 3 * 3600_000, now)).toBe('3 小时前');
    expect(describeElapsed(now - 2 * 86_400_000, now)).toBe('2 天前');
  });

  it('没有时间戳就不说', () => {
    expect(describeElapsed(0, now)).toBe('');
  });
});
