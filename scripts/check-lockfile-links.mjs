/**
 * 检查 pnpm-lock.yaml 里有没有指向仓库外的本地依赖（link:../xxx）。
 *
 * 背景：本地联调时把依赖临时改成 `link:../ReiStandard` 这种兄弟目录引用，
 * 一旦跟着 lockfile 提交上去，Netlify / CI 的 `--frozen-lockfile` 安装会直接失败
 * （那个目录只存在于本地机器上）。
 *
 * 判定规则：把 link 目标按所属 importer 目录解析一次，
 * 解析后仍跳出仓库根目录的才算违规。
 * 仓库内的 workspace 互链（`.` ↔ `worker/*`）是正常写法，放行。
 *
 * 用法：
 *   node scripts/check-lockfile-links.mjs            # 检查 ./pnpm-lock.yaml
 *   node scripts/check-lockfile-links.mjs 某个.yaml   # 检查指定文件
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * 从 lockfile 文本里找出所有指向仓库外的 link 依赖。
 * @param {string} lockfileText pnpm-lock.yaml 的完整内容
 * @returns {{ line: number, importer: string, target: string, raw: string }[]}
 */
export function findExternalLinks(lockfileText) {
  const violations = [];
  let inImporters = false;
  let currentImporter = '.';

  lockfileText.split('\n').forEach((line, index) => {
    // 进入 importers: 段
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      currentImporter = '.';
      return;
    }
    // 碰到下一个顶层键（packages: / snapshots: ...）就离开 importers 段
    if (inImporters && /^[^\s#]/.test(line)) {
      inImporters = false;
    }
    if (!inImporters) return;

    // 缩进 2 空格的键是 importer 目录，形如 `  .:` 或 `  worker/instant-push:`
    const importerMatch = line.match(/^ {2}(\S.*?):\s*$/);
    if (importerMatch) {
      currentImporter = importerMatch[1].replace(/['"]/g, '');
      return;
    }

    const linkMatch = line.match(/link:(\S+)/);
    if (!linkMatch) return;

    const target = linkMatch[1].replace(/['"]/g, '');
    const resolved = path.posix.normalize(path.posix.join(currentImporter, target));
    if (resolved.startsWith('..')) {
      violations.push({
        line: index + 1,
        importer: currentImporter,
        target,
        raw: line.trim(),
      });
    }
  });

  return violations;
}

function main() {
  const lockfilePath = process.argv[2] ?? 'pnpm-lock.yaml';
  let text;
  try {
    text = readFileSync(lockfilePath, 'utf8');
  } catch {
    console.error(`读不到 ${lockfilePath}，跳过检查。`);
    process.exit(0);
  }

  const violations = findExternalLinks(text);
  if (violations.length === 0) {
    console.log(`${lockfilePath} 干净，没有指向仓库外的本地依赖。`);
    return;
  }

  console.error(`${lockfilePath} 里有 ${violations.length} 处指向仓库外的本地依赖：\n`);
  for (const v of violations) {
    console.error(`  第 ${v.line} 行（importer: ${v.importer}）: ${v.raw}`);
  }
  console.error(
    '\n这种引用只在你自己机器上有效，装依赖时会因为找不到目录而失败。' +
      '\n把依赖改回正常的版本号（例如 npm 上的版本），重新 pnpm install 生成 lockfile 再提交。',
  );
  process.exit(1);
}

// 直接执行时才跑检查，被 import 时只导出函数
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
