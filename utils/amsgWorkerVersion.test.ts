import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareAmsgServerVersions, isAmsgServerVersionAtLeast } from './amsgWorkerVersion';

// 比较逻辑本身用固定样本测，跟设置页当前门槛值无关。
const FLOOR = '2.6.0-next.5';

describe('isAmsgServerVersionAtLeast（重新部署门槛）', () => {
  it('等于门槛 → 达标', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0-next.5', FLOOR)).toBe(true);
  });

  it('next.4 旧部署（features 与 next.5 相同、无法靠 flag 区分）→ 不达标', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0-next.4', FLOOR)).toBe(false);
  });

  it('prerelease 段按数字比较：next.10 > next.5（不是字符串序）', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0-next.10', FLOOR)).toBe(true);
  });

  it('同主版本的正式版高于任何 prerelease：2.6.0 达标', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0', FLOOR)).toBe(true);
  });

  it('更高主/次/补丁版本达标（含带 prerelease 的）', () => {
    expect(isAmsgServerVersionAtLeast('2.6.1-next.1', FLOOR)).toBe(true);
    expect(isAmsgServerVersionAtLeast('2.7.0', FLOOR)).toBe(true);
    expect(isAmsgServerVersionAtLeast('3.0.0-next.1', FLOOR)).toBe(true);
  });

  it('更低版本不达标', () => {
    expect(isAmsgServerVersionAtLeast('2.5.9', FLOOR)).toBe(false);
    expect(isAmsgServerVersionAtLeast('2.6.0-next.1', FLOOR)).toBe(false);
  });

  it('字母段排序：alpha < next（semver 字符串序）', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0-alpha.9', FLOOR)).toBe(false);
  });

  it('解析不了 / 空值 → 不达标（宁亮牌不静默降级）', () => {
    expect(isAmsgServerVersionAtLeast('', FLOOR)).toBe(false);
    expect(isAmsgServerVersionAtLeast(undefined, FLOOR)).toBe(false);
    expect(isAmsgServerVersionAtLeast('dev', FLOOR)).toBe(false);
    expect(isAmsgServerVersionAtLeast('2.6', FLOOR)).toBe(false);
  });

  it('容忍 v 前缀与首尾空白', () => {
    expect(isAmsgServerVersionAtLeast(' v2.6.0-next.5 ', FLOOR)).toBe(true);
  });
});

describe('compareAmsgServerVersions', () => {
  it('相等 → 0', () => {
    expect(compareAmsgServerVersions('2.6.0-next.5', '2.6.0-next.5')).toBe(0);
    expect(compareAmsgServerVersions('2.6.0', '2.6.0')).toBe(0);
  });

  it('prerelease 段数少的更低（2.6.0-next < 2.6.0-next.1）', () => {
    expect(compareAmsgServerVersions('2.6.0-next', '2.6.0-next.1')).toBe(-1);
  });

  it('数字段低于字母段（2.6.0-1 < 2.6.0-next）', () => {
    expect(compareAmsgServerVersions('2.6.0-1', '2.6.0-next')).toBe(-1);
  });

  it('任一侧坏串 → null', () => {
    expect(compareAmsgServerVersions('oops', '2.6.0')).toBeNull();
    expect(compareAmsgServerVersions('2.6.0', '')).toBeNull();
  });
});

// 回归守卫：门槛值与打 bundle 用的 amsg-server 版本要一起动。
// 门槛高于依赖 → 自己发的 bundle 都过不了门槛，用户重贴多少次都亮「重新粘贴部署」；
// 门槛低于依赖 → 新版带的能力（这一波是 next.5 的投影/skip、next.6 的占位租约，都没发
// feature flag）在旧部署上静默缺席，正是这个探测要防的事。真要让门槛落后于依赖（比如
// 新版只修了无关的 bug、不想逼所有人重贴），改这里并在注释里写明理由。
describe('设置页门槛值', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('与 package.json 声明的 amsg-server 版本一致', () => {
    const floor = /REQUIRED_WORKER_VERSION = '([^']+)'/
      .exec(read('../components/settings/ActiveMsgGlobalSettingsModal.tsx'))?.[1];
    const declared = JSON.parse(read('../package.json'))
      .devDependencies['@rei-standard/amsg-server'];
    expect(floor).toBe(declared);
  });
});
