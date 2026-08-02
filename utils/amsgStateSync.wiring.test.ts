// amsg2 打脏入口 & 删角色阻塞的接线守卫。
//
// 仓库的 vitest 是纯 Node 环境（没装 jsdom），OSContext / Chat / Character 这些 React
// 组件没法真渲染起来测行为，这里退而求其次做**源码级**断言：把「保存路径后面跟着
// markAmsgStateDirty」「删角色会被云端清理失败拦下」这几处接线钉住，谁把调用删了
// 这里就红。它验证不了运行时时序，只防「接线被误删」这一种回归——补上组件测试基建
// 后应该换成真正的行为测试。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 取 [start, end) 之间的源码片段；找不到锚点直接让断言失败。 */
const sliceBetween = (src: string, start: string, end: string): string => {
  const i = src.indexOf(start);
  expect(i, `找不到锚点: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `找不到结束锚点: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

describe('打脏入口接线（保存后调 markAmsgStateDirty）', () => {
  it('OSContext.updateCharacter：落库成功后打脏（改人设/改记忆/面板取消任务的汇合点）', () => {
    const src = read('../context/OSContext.tsx');
    const fn = sliceBetween(src, 'const updateCharacter = async', 'const deleteCharacter');
    // 时序也要钉住：是「落库成功后」（saveCharacter 的 then 里），不是随手同步调一下。
    expect(fn).toMatch(/DB\.saveCharacter\(target\)\.then\([\s\S]*?markAmsgStateDirty\(/);
  });

  it('Chat：删除 / 编辑 / 清空消息路径都打脏', () => {
    const src = read('../apps/Chat.tsx');
    for (const [start, end] of [
      ['const handleDeleteMessage', 'const confirmEditMessage'],
      ['const confirmEditMessage', 'const handleQuickReply'],
      ['const handleClearHistory', "trackEvent('清空聊天记录');\n        setModalType"],
      ['const handleReroll', 'const handleImageSelect'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 里少了打脏调用`).toContain('markAmsgStateDirty(');
    }
  });

  it('OSContext 启动路径接了底账补传 resumePendingAmsgStateSync', () => {
    expect(read('../context/OSContext.tsx')).toContain('resumePendingAmsgStateSync({');
  });
});

describe('删角色阻塞接线（云端任务清不掉先不删本地）', () => {
  it('deleteCharacter：await 云端清理、失败返回 cloud-cleanup-failed', () => {
    const src = read('../context/OSContext.tsx');
    const fn = sliceBetween(src, 'const deleteCharacter = async', 'const createCharacterGroup');
    expect(fn).toContain('await ActiveMsgClient.cancelAllTasksForChar(');
    expect(fn).toContain("return { status: 'cloud-cleanup-failed' }");
    // 旧实现的「void (async () => { cancelAllTasksForChar ... })()」整段后台化是这次
    // 修的病根；只允许 force（仍然删除）和无任务两条路走后台。
    expect(fn).toContain("options?.force");
  });

  it('角色 App 对 cloud-cleanup-failed 弹「重试 / 仍然删除」', () => {
    const src = read('../apps/Character.tsx');
    expect(src).toContain("cloud-cleanup-failed");
    expect(src).toContain('仍然删除');
    expect(src).toMatch(/runDeleteCharacter\(cloudCleanupFailTarget, true\)/);
  });
});
