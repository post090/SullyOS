/**
 * vitest 全局 setup — 为 Node 环境补齐浏览器 API.
 *  - fake-indexeddb/auto: 把 indexedDB / IDBKeyRange 等挂到 globalThis,
 *    让 activeMsgStore.ts 在 Node 里能直接跑.
 *  - localStorage stub: instantPushClient.ts 在模块加载时不读 localStorage,
 *    但运行时调 loadInstantConfig() 会读, 给最简易 in-memory 实现.
 *  - 构建注入常量: vite.config.ts 的 define 在 Node 里没人替换, 而 utils/buildInfo.ts
 *    模块顶层就要读它们, 不补的话 import 到它的测试直接 ReferenceError.
 */

import 'fake-indexeddb/auto';

class MemStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) { this.store.set(k, String(v)); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
  key(i: number) { return Array.from(this.store.keys())[i] ?? null; }
  get length() { return this.store.size; }
}

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = new MemStorage();
}

const BUILD_DEFINES: Record<string, string | boolean> = {
  __BUILD_BRANCH__: 'test',
  __BUILD_COMMIT__: '0000000',
  __BUILD_TIME__: '1970-01-01 00:00',
  __BUILD_BADGE_VISIBLE__: false,
};
for (const [name, value] of Object.entries(BUILD_DEFINES)) {
  if (typeof (globalThis as any)[name] === 'undefined') {
    (globalThis as any)[name] = value;
  }
}
