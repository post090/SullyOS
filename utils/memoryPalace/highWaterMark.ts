import { DB } from '../db';

const LOCAL_KEY = (charId: string) => `mp_lastMsgId_${charId}`;
const MIRROR_KEY = (charId: string) => `mp_hwm_v1_${charId}`;

interface HighWaterMarkMirror {
    version: 1;
    charId: string;
    msgId: number;
    updatedAt: number;
}

function normalizeMessageId(value: unknown): number {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/** 同步读取供聊天上下文过滤使用；后台管线会再用 IndexedDB 镜像校准。 */
export function getLocalMemoryPalaceHighWaterMark(charId: string): number {
    try {
        return normalizeMessageId(localStorage.getItem(LOCAL_KEY(charId)));
    } catch {
        return 0;
    }
}

/**
 * 读取 localStorage 与 IndexedDB 中较新的水位线。
 *
 * 部分第三方移动浏览器会只清理/隔离 localStorage，却保留 IndexedDB 中的消息。
 * 水位线是单调递增值，因此取两者最大值既能修复这种驱逐，也不会覆盖更新的数据。
 */
export async function getReliableMemoryPalaceHighWaterMark(charId: string): Promise<number> {
    const localValue = getLocalMemoryPalaceHighWaterMark(charId);
    let mirroredValue = 0;

    try {
        const mirror = await DB.getAssetRaw(MIRROR_KEY(charId)) as Partial<HighWaterMarkMirror> | number | null;
        mirroredValue = normalizeMessageId(typeof mirror === 'number' ? mirror : mirror?.msgId);
    } catch {
        // IndexedDB 本身不可用时仍可使用 localStorage，不扩大故障范围。
        return localValue;
    }

    const reliableValue = Math.max(localValue, mirroredValue);

    if (reliableValue > localValue) {
        try {
            localStorage.setItem(LOCAL_KEY(charId), String(reliableValue));
        } catch {
            // 第三方浏览器可能禁止 localStorage 写入；IndexedDB 镜像仍可继续工作。
        }
    }

    if (reliableValue > mirroredValue) {
        try {
            await DB.saveAssetRaw(MIRROR_KEY(charId), {
                version: 1,
                charId,
                msgId: reliableValue,
                updatedAt: Date.now(),
            } satisfies HighWaterMarkMirror);
        } catch {
            // 镜像失败不阻断原有 localStorage 路径。
        }
    }

    return reliableValue;
}

/** 成功处理消息后同时写两份；任意一份幸存即可避免旧消息被整批重复提取。 */
export async function setReliableMemoryPalaceHighWaterMark(charId: string, msgId: number): Promise<void> {
    const normalized = normalizeMessageId(msgId);

    try {
        localStorage.setItem(LOCAL_KEY(charId), String(normalized));
    } catch {
        // 继续尝试 IndexedDB。
    }

    try {
        await DB.saveAssetRaw(MIRROR_KEY(charId), {
            version: 1,
            charId,
            msgId: normalized,
            updatedAt: Date.now(),
        } satisfies HighWaterMarkMirror);
    } catch {
        // 与旧行为一致：持久化故障不抹掉已经成功写入的记忆。
    }
}
