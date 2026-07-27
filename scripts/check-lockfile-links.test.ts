import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error 纯 JS 脚本，没有类型声明
import { findExternalLinks } from './check-lockfile-links.mjs';

const repoRoot = path.resolve(__dirname, '..');

describe('lockfile 本地依赖检查', () => {
  it('仓库当前的 pnpm-lock.yaml 是干净的', () => {
    const text = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    expect(findExternalLinks(text)).toEqual([]);
  });

  it('抓得到指向仓库外兄弟目录的 link', () => {
    const lockfile = [
      'lockfileVersion: 9.0',
      '',
      'importers:',
      '',
      '  .:',
      '    devDependencies:',
      "      '@rei-standard/amsg-server':",
      '        specifier: link:../ReiStandard/packages/amsg-server',
      '        version: link:../ReiStandard/packages/amsg-server',
      '',
      'packages: {}',
    ].join('\n');

    const violations = findExternalLinks(lockfile);
    expect(violations).toHaveLength(2);
    expect(violations[0].importer).toBe('.');
    expect(violations[0].target).toBe('../ReiStandard/packages/amsg-server');
  });

  it('子包里跳出仓库根的 link 同样算违规', () => {
    const lockfile = [
      'importers:',
      '',
      '  worker/instant-push:',
      '    dependencies:',
      '      some-lib:',
      '        version: link:../../../some-lib',
      '',
      'packages: {}',
    ].join('\n');

    const violations = findExternalLinks(lockfile);
    expect(violations).toHaveLength(1);
    expect(violations[0].importer).toBe('worker/instant-push');
  });

  it('仓库内的 workspace 互链放行', () => {
    const lockfile = [
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      instant-push:',
      '        version: link:worker/instant-push',
      '',
      '  worker/instant-push:',
      '    dependencies:',
      '      sullyos:',
      '        version: link:../..',
      '',
      'packages: {}',
    ].join('\n');

    expect(findExternalLinks(lockfile)).toEqual([]);
  });

  it('importers 段之外出现 link 字样不误报', () => {
    const lockfile = [
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      normal-lib:',
      '        version: 1.2.3',
      '',
      'snapshots:',
      '',
      '  fake-pkg@1.0.0:',
      '    resolution: link:../whatever',
    ].join('\n');

    expect(findExternalLinks(lockfile)).toEqual([]);
  });
});
