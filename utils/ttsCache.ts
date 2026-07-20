/**
 * Shared long-term cache for MiniMax TTS audio.
 *
 * Keying strategy: callers build a plain object describing the request
 * (text + voice settings + model + language_boost, etc.), hash it, and use the
 * resulting string as the IndexedDB key. Two callers that send the same
 * effective request reuse the same cached audio, regardless of which app
 * (Chat / Date / Call / VoiceDesigner) generated it first.
 *
 * Storage lives in the existing `assets` object store via `DB.saveAssetRaw` /
 * `DB.getAssetRaw`, so no schema migration is required. Entries record
 * `createdAt` / `lastUsedAt` timestamps for optional future pruning; we don't
 * auto-evict yet — the user explicitly asked for a long-lived cache.
 */
import { DB } from './db';

// cyrb53: fast non-crypto 64-bit hash. Collisions are astronomically unlikely
// for the number of distinct (text, voice-config) pairs a user will generate.
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// Deterministic JSON: sorts object keys so equivalent objects hash identically
// regardless of insertion order.
function stableStringify(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function hashTtsParams(params: any): string {
  return 'tts_' + cyrb53(stableStringify(params));
}

interface TtsCacheEntry {
  blob: Blob;
  createdAt: number;
  lastUsedAt: number;
}

export async function getCachedTts(key: string): Promise<Blob | null> {
  try {
    const entry = (await DB.getAssetRaw(key)) as TtsCacheEntry | null;
    if (!entry || !(entry.blob instanceof Blob)) return null;
    // ⚠️ 关键修复：校验 blob 是真的音频，避免"缓存中毒"。
    // 历史背景：ElevenLabs / 鱼声在某些 validation 场景返回 200 + JSON 错误体，
    // 早期代码只检查 blob.size > 0 就当音频存进了 IndexedDB。后续每次同文本命中缓存
    // 都返回这个坏 blob → <audio>.play() 失败被静默吞 → 用户看到语音条但无声，永久复现。
    // 这里多一道校验：blob.type 必须是 audio/* 或 octet-stream（兼容 Capacitor base64 解码）；
    // 否则当成 miss 处理（返回 null 让调用方重合成），并 fire-and-forget 删掉这个坏 entry。
    const type = (entry.blob.type || '').toLowerCase();
    const isAudio = type.startsWith('audio/') || type.startsWith('application/octet-stream') || type === '';
    if (!isAudio || entry.blob.size < 32) {
      console.warn('[TTS cache] dropping poisoned entry', { key, type, size: entry.blob.size });
      DB.deleteAsset(key).catch(() => { /* ignore */ });
      return null;
    }
    // Fire-and-forget touch so future pruning can keep the hot set.
    DB.saveAssetRaw(key, { ...entry, lastUsedAt: Date.now() }).catch(() => { /* ignore */ });
    return entry.blob;
  } catch {
    return null;
  }
}

export async function saveCachedTts(key: string, blob: Blob): Promise<void> {
  try {
    const now = Date.now();
    const entry: TtsCacheEntry = { blob, createdAt: now, lastUsedAt: now };
    await DB.saveAssetRaw(key, entry);
  } catch (e) {
    console.warn('[TTS cache] save failed', e);
  }
}
