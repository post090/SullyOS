import { ActiveMsg2GlobalConfig, ActiveMsg2InboxMessage } from '../types';

const DB_NAME = 'ActiveMsg';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_INBOX = 'inbox';
const GLOBAL_CONFIG_KEY = 'global-config';

type KvRecord<T = unknown> = {
  id: string;
  value: T;
};

const defaultGlobalConfig: ActiveMsg2GlobalConfig = {
  userId: '',
  driver: 'pg',
  databaseUrl: '',
};

const openDB = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
  request.onupgradeneeded = () => {
    const db = request.result;

    if (!db.objectStoreNames.contains(STORE_KV)) {
      db.createObjectStore(STORE_KV, { keyPath: 'id' });
    }

    if (!db.objectStoreNames.contains(STORE_INBOX)) {
      db.createObjectStore(STORE_INBOX, { keyPath: 'messageId' });
    }
  };
});

const getKv = async <T>(id: string): Promise<T | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KV, 'readonly');
    const request = tx.objectStore(STORE_KV).get(id);
    request.onsuccess = () => resolve((request.result as KvRecord<T> | undefined)?.value ?? null);
    request.onerror = () => reject(request.error);
  });
};

const setKv = async <T>(id: string, value: T): Promise<void> => {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_KV, 'readwrite');
    tx.objectStore(STORE_KV).put({ id, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const generateUuidV4 = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

export const ActiveMsgStore = {
  async getGlobalConfig(): Promise<ActiveMsg2GlobalConfig> {
    const stored = await getKv<ActiveMsg2GlobalConfig>(GLOBAL_CONFIG_KEY);
    return { ...defaultGlobalConfig, ...(stored || {}) };
  },

  async saveGlobalConfig(updates: Partial<ActiveMsg2GlobalConfig>): Promise<ActiveMsg2GlobalConfig> {
    const current = await this.getGlobalConfig();
    const next: ActiveMsg2GlobalConfig = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };
    await setKv(GLOBAL_CONFIG_KEY, next);
    return next;
  },

  async ensureUserId(): Promise<string> {
    const current = await this.getGlobalConfig();
    if (current.userId) return current.userId;

    const userId = generateUuidV4();
    await this.saveGlobalConfig({ userId });
    return userId;
  },

  async saveInboxMessage(message: ActiveMsg2InboxMessage): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readwrite');
      tx.objectStore(STORE_INBOX).put(message);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async listInboxMessages(): Promise<ActiveMsg2InboxMessage[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readonly');
      const request = tx.objectStore(STORE_INBOX).getAll();
      request.onsuccess = () => {
        const messages = (request.result || []) as ActiveMsg2InboxMessage[];
        messages.sort((a, b) => (a.sentAt || a.receivedAt) - (b.sentAt || b.receivedAt));
        resolve(messages);
      };
      request.onerror = () => reject(request.error);
    });
  },

  // 单事务原子 claim: getAll + delete 同一个 readwrite tx。IndexedDB 跨连接
  // (跨 tab / 跨 SW / 同 tab 多 caller) 对同一 object store 的 readwrite 事务
  // 是 serializable 的, 第二个 caller 会等第一个 commit 后才进入, 所以同一条
  // inbox 消息绝不可能被两个 caller 同时 claim。这是把 race 关在 IDB 层。
  //
  // 已知取舍 (TODO): 这是"先 ack 后处理"语义 —— 调用方拿到 messages 后若
  // saveMessage 抛错, 消息已经从 inbox 删了, 会丢。当前没修是因为:
  //   1. DB.saveMessage 用 IDB add(), 失败极罕见 (quota / corruption)
  //   2. 改成"先 save 后 ack" 会需要把 list 和 delete 拆开, 反而把这里的
  //      原子性优势让出去, 重新打开并发读到同一项的窗口
  // 真要补防丢, 加一层 dead-letter / try-catch 后 put 回 inbox, 而不是
  // 拆开这个事务。
  async consumeInboxMessages(): Promise<ActiveMsg2InboxMessage[]> {
    const db = await openDB();
    return new Promise<ActiveMsg2InboxMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readwrite');
      const store = tx.objectStore(STORE_INBOX);
      const request = store.getAll();
      let messages: ActiveMsg2InboxMessage[] = [];
      request.onsuccess = () => {
        messages = (request.result || []) as ActiveMsg2InboxMessage[];
        messages.sort((a, b) => (a.sentAt || a.receivedAt) - (b.sentAt || b.receivedAt));
        messages.forEach((m) => store.delete(m.messageId));
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(messages);
      tx.onabort = () => reject(tx.error || new Error('inbox consume aborted'));
      tx.onerror = () => reject(tx.error);
    });
  },
};

export const maskActiveMsgUserId = (userId: string) => {
  if (!userId) return '未生成';
  if (userId.length <= 12) return userId;
  return `${userId.slice(0, 8)}••••${userId.slice(-8)}`;
};
