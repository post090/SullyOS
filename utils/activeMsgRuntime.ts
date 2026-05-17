import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';

let initialized = false;

const flushInboxToChat = async () => {
  const pendingMessages = await ActiveMsgStore.consumeInboxMessages();
  // consumeInboxMessages 是 "先 ack 后处理" 语义 —— inbox 已经原子地清空。
  // 这里 per-message try/catch: 单条 saveMessage 抛错 (quota / DB 故障) 不连累
  // 后续条目, 并把失败那条 put 回 inbox 让下次 flush 重试。dispatchEvent 只在
  // save 成功后 fire, 失败的不让 UI 误以为收到了。
  for (const message of pendingMessages) {
    const messageTimestamp = message.sentAt || message.receivedAt || Date.now();
    try {
      await DB.saveMessage({
        charId: message.charId,
        role: 'assistant',
        type: 'text',
        content: message.body,
        timestamp: messageTimestamp,
        metadata: {
          source: 'active_msg_2',
          activeMsg2: {
            messageId: message.messageId,
            taskId: message.taskId,
            messageType: message.messageType,
            messageSubtype: message.messageSubtype,
            avatarUrl: message.avatarUrl,
            sentAt: message.sentAt,
            receivedAt: message.receivedAt,
          },
          ...(message.metadata || {}),
        },
      });

      window.dispatchEvent(new CustomEvent('active-msg-received', {
        detail: {
          charId: message.charId,
          charName: message.charName,
          body: message.body,
          avatarUrl: message.avatarUrl,
          sentAt: messageTimestamp,
        },
      }));
    } catch (e) {
      console.warn('[ActiveMsg] saveMessage failed, requeue to inbox', message.messageId, e);
      try {
        await ActiveMsgStore.saveInboxMessage(message);
      } catch (reputErr) {
        // re-put 也挂了 (大概率同一根因, 比如 quota / DB 关停), 没救了, 至少留个日志
        console.error('[ActiveMsg] requeue failed, message lost', message.messageId, reputErr);
      }
    }
  }
};

const handleDeepLink = () => {
  const currentUrl = new URL(window.location.href);
  const charId = currentUrl.searchParams.get('activeMsgCharId');
  const openApp = currentUrl.searchParams.get('openApp');

  if (openApp === 'chat' && charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', {
      detail: { charId },
    }));
    currentUrl.searchParams.delete('openApp');
    currentUrl.searchParams.delete('activeMsgCharId');
    window.history.replaceState({}, '', currentUrl.toString());
  }
};

export const ActiveMsgRuntime = {
  async init() {
    if (initialized) return;
    initialized = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type === 'active-msg-received') {
          void flushInboxToChat();
          return;
        }

        if (type === 'active-msg-open') {
          void flushInboxToChat().then(() => {
            window.dispatchEvent(new CustomEvent('active-msg-open', {
              detail: { charId: event.data?.charId },
            }));
          });
        }
      });
    }

    await flushInboxToChat();
    handleDeepLink();
  },
};
