// 「订阅建不出来时，用户能不能看懂为什么」这条链路的回归守卫。
//
// 背景：华为 Mate 60（国行安卓机，出厂不带谷歌服务）上的实测——面板显示浏览器支持=是、
// 权限=已授权、SW=已激活，浏览器订阅就是「不存在」，点多少次重置都没变化。根因是
// Chromium 系的网页推送要转交系统里的谷歌服务（GMS）去注册，没 GMS 就必挂；而失败原文
// 只走 toast，一闪而过，用户回头什么都看不到。
//
// 这里钉住三件事：失败要分得出「换设备才有救」这一类、失败要落盘、修好之后记录要清掉。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSubscribeFailure,
  explainSubscribeError,
  readSubscribeFailure,
  rememberSubscribeFailure,
  subscribeWithRetry,
  SUBSCRIBE_ATTEMPTS_MAX,
} from './pushSubscribeShared';

/** 合法的 base64url，只为让 b64uToBytes 别在 atob 上炸。 */
const FAKE_VAPID = 'AAAA';

const makeRegistration = (subscribe: () => Promise<unknown>) =>
  ({ pushManager: { subscribe } }) as unknown as ServiceWorkerRegistration;

const makeSubscription = (endpoint: string) => ({
  endpoint,
  unsubscribe: async () => true,
});

const namedError = (name: string, message = '') => {
  const error = new Error(message);
  error.name = name;
  return error;
};

beforeEach(() => {
  clearSubscribeFailure();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('explainSubscribeError 的失败分类', () => {
  it('把「连不上推送服务器」单独归成 channel-unreachable', () => {
    // 没装谷歌服务的安卓机上，Chromium 就是这么抛的。这一类跟「订阅失败」必须分开：
    // 前者重试无用、只能换浏览器/换设备，后者才值得让用户再点一次。
    expect(explainSubscribeError(namedError('AbortError')).kind).toBe('channel-unreachable');
    expect(
      explainSubscribeError(namedError('Error', 'Registration failed - push service error')).kind,
    ).toBe('channel-unreachable');
  });

  it('给出的建议里带上「换 Firefox」这条同机可走的路', () => {
    // 只说「换台设备 / 用电脑」的话，手上只有这一台手机的用户就走到头了。
    // Firefox 的推送走 Mozilla 自己的服务器，不经过谷歌，是同一台机器上唯一的希望。
    expect(explainSubscribeError(namedError('AbortError')).text).toContain('Firefox');
  });

  it('权限、内核不支持、状态冲突各归各的', () => {
    expect(explainSubscribeError(namedError('NotAllowedError')).kind).toBe('permission');
    expect(explainSubscribeError(namedError('NotSupportedError')).kind).toBe('unsupported');
    expect(explainSubscribeError(namedError('InvalidStateError')).kind).toBe('state');
    expect(explainSubscribeError(namedError('WeirdError', '没见过')).kind).toBe('unknown');
  });
});

describe('subscribeWithRetry 的失败落盘', () => {
  it('subscribe 抛错时把原因记下来，面板才有得显示', async () => {
    const registration = makeRegistration(async () => { throw namedError('AbortError'); });

    const result = await subscribeWithRetry(registration, FAKE_VAPID, '[test]');

    expect(result.sub).toBeNull();
    expect(result.failure?.kind).toBe('channel-unreachable');
    // 关键：落了盘。以前只有 toast，用户点完重置一眨眼就没了，回头再看面板还是干巴巴
    // 一行「不存在」。
    const stored = readSubscribeFailure();
    expect(stored?.kind).toBe('channel-unreachable');
    expect(stored?.text).toBe(result.failure?.text);
    expect(stored?.at).toBeGreaterThan(0);
  });

  it('订阅建成时把上一次的失败记录清掉', async () => {
    rememberSubscribeFailure({ kind: 'channel-unreachable', text: '陈年旧账', at: 1 });
    const registration = makeRegistration(async () => makeSubscription('https://fcm.googleapis.com/fcm/send/ok'));

    const result = await subscribeWithRetry(registration, FAKE_VAPID, '[test]');

    expect(result.sub).not.toBeNull();
    // 不清的话，用户换了浏览器修好了，面板还挂着一条早就过期的红色失败，比不显示更糟。
    expect(readSubscribeFailure()).toBeNull();
  });

  it('重试到底还是僵尸端点时归成 zombie 并落盘', async () => {
    vi.useFakeTimers();
    const subscribe = vi.fn(async () => makeSubscription('https://permanently-removed.invalid/x'));
    const pending = subscribeWithRetry(makeRegistration(subscribe), FAKE_VAPID, '[test]');
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();

    expect(subscribe).toHaveBeenCalledTimes(SUBSCRIBE_ATTEMPTS_MAX);
    expect(result.sub).toBeNull();
    expect(result.failure?.kind).toBe('zombie');
    expect(readSubscribeFailure()?.kind).toBe('zombie');
  });
});

describe('readSubscribeFailure 的容错', () => {
  it('存的东西坏了就当没有，不抛', () => {
    localStorage.setItem('push_last_subscribe_failure_v1', '{不是 JSON');
    expect(readSubscribeFailure()).toBeNull();

    localStorage.setItem('push_last_subscribe_failure_v1', JSON.stringify({ kind: 'x' }));
    expect(readSubscribeFailure()).toBeNull();
  });
});
