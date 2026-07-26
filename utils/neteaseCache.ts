/**
 * 网易云数据本地缓存（SWR：先上缓存秒开，后台静默刷新覆盖）。
 *
 * 为什么单独开一个小 IndexedDB 而不塞进 utils/db.ts 的主库：
 * 主库加 store 要 bump DB_VERSION、触发全量 upgrade，为一个纯缓存不值得；
 * 这里的数据丢了毫无损失（下次重新拉就是），隔离在自己的库里最干净。
 *
 * key 约定：
 *   home:{uid}  — 「我的」页三件套 { playlists, records, cloud }
 *   pl:{id}     — 歌单详情整单曲目 { tracks, desc }
 */

const DB_NAME = 'sully_netease_cache';
const STORE = 'kv';
const MAX_AGE_MS = 30 * 24 * 3600_000; // 超过 30 天没更新过的条目开库时顺手清掉

interface CacheEntry<T = unknown> {
    key: string;
    savedAt: number;
    data: T;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let prunedThisSession = false;

const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // 连接被别的 tab 升级/浏览器强关时清掉单例，下次调用自动重开
            db.onversionchange = () => { db.close(); if (dbPromise === p) dbPromise = null; };
            db.onclose = () => { if (dbPromise === p) dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => {
            if (dbPromise === p) dbPromise = null;
            reject(req.error);
        };
    });
    dbPromise = p;
    return p;
};

/** 读缓存。任何失败（含无痕模式没有 IDB）都静默返回 null —— 缓存只是加速，不能变成新故障点。 */
export async function neteaseCacheGet<T>(key: string): Promise<{ data: T; savedAt: number } | null> {
    try {
        const db = await open();
        return await new Promise(resolve => {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            req.onsuccess = () => {
                const e = req.result as CacheEntry<T> | undefined;
                resolve(e ? { data: e.data, savedAt: e.savedAt } : null);
            };
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

/** 写缓存（覆盖同 key）。失败静默。 */
export async function neteaseCacheSet(key: string, data: unknown): Promise<void> {
    try {
        const db = await open();
        const entry: CacheEntry = { key, savedAt: Date.now(), data };
        await new Promise<void>(resolve => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(entry);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
        pruneOld();
    } catch { /* ignore */ }
}

/** 清空整个缓存库（登出 / 换账号 / 换代理时调）。 */
export async function neteaseCacheClearAll(): Promise<void> {
    try {
        const db = await open();
        await new Promise<void>(resolve => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch { /* ignore */ }
}

/** 30 天没碰过的条目清掉（每个会话最多跑一次，写入时顺带触发）。 */
function pruneOld(): void {
    if (prunedThisSession) return;
    prunedThisSession = true;
    open().then(db => {
        const cutoff = Date.now() - MAX_AGE_MS;
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.openCursor();
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return;
            const e = cur.value as CacheEntry;
            if ((e.savedAt || 0) < cutoff) cur.delete();
            cur.continue();
        };
    }).catch(() => { /* ignore */ });
}
