import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { DB, openDB } from './db';
import { encodeVectorsForBackup, encodeVectorsForBackupChunked, MemoryVectorDB } from './memoryPalace/db';
import { writeV2Backup, assembleV2Backup, shardFileName, type ShardLimits } from './backupFormat';

// fake-indexeddb 已通过 test-setup.ts 注入。
// 这组用例走「真实链路」：writeV2Backup → assembleV2Backup → DB.importFullData，钉死 v2 改造
// 里最危险的几个数据完整性 finding。和 backupFormat.test.ts（纯格式往返）不同，这里验证的是
// 「拼回的 data 喂给原封不动的 importFullData 后，落库行为和 v1 一致、且分片不引入丢数据」。

class FakeFile {
    constructor(private content: string | Uint8Array) {}
    async(type: 'string'): Promise<string>;
    async(type: 'uint8array'): Promise<Uint8Array>;
    async(type: 'string' | 'uint8array'): Promise<string | Uint8Array> {
        if (type === 'uint8array') {
            return Promise.resolve(this.content instanceof Uint8Array ? this.content : new TextEncoder().encode(String(this.content)));
        }
        return Promise.resolve(typeof this.content === 'string' ? this.content : new TextDecoder().decode(this.content));
    }
}
class FakeZip {
    files = new Map<string, string | Uint8Array>();
    file(name: string): FakeFile | null;
    file(name: string, data: string | Uint8Array, options?: {
        base64?: boolean;
        compression?: 'STORE' | 'DEFLATE';
        compressionOptions?: { level?: number };
    }): void;
    file(name: string, data?: string | Uint8Array): FakeFile | null | void {
        if (data === undefined) {
            if (!this.files.has(name)) return null;
            return new FakeFile(this.files.get(name)!);
        }
        this.files.set(name, data);
    }
}

const SMALL_SHARDS = (maxItems: number): ShardLimits => ({ maxLen: 1 << 30, maxItems, hardMaxLen: 1 << 30 });

async function seedStore(name: string, records: any[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        store.clear();
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    // 清掉本组会断言/写入的 store，避免 importFullData 跨用例残留串味
    for (const s of ['gallery', 'themes', 'user_profile', 'characters', 'messages', 'memory_nodes', 'memory_vectors']) {
        await seedStore(s, []);
    }
});

/** 把存储形态的向量记录读回（vector 是 Uint8Array）解码成 number[]，逐值比对用 */
function vecValues(v: any): number[] {
    const u8: Uint8Array = v.vector;
    const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >>> 2);
    return Array.from(f32);
}

describe('v2 真实链路：分片 → 组装 → importFullData', () => {
    it('跨分片 clear-and-add：所有片的数据都落库、不只剩最后一片（Finding 1）', async () => {
        await seedStore('gallery', [{ id: 'old', url: 'old' }]);
        const items = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, url: `u${i}` }));

        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { galleryImages: items }, { limits: SMALL_SHARDS(2) });
        expect(manifest.stores.galleryImages.parts).toBe(3); // 5/2 → 3 片，确保真跨片

        const data = await assembleV2Backup(zip, manifest);
        await DB.importFullData(data as any);

        const ids = (await DB.getRawStoreData('gallery')).map((g: any) => g.id).sort();
        // 旧 'old' 被 clear、5 条全部还原（老的「逐片喂 importFullData」写法只会剩最后一片 → 这里会挂）
        expect(ids).toEqual(['g0', 'g1', 'g2', 'g3', 'g4']);
    });
    it('MCP 配置作为 v2 元数据完整组装并由全量导入恢复', async () => {
        const mcpLocal = {
            'aetheros.mcp.servers': '[{"id":"srv-test","name":"测试 MCP"}]',
            'aetheros.mcp.useNativeTools': 'false',
        };
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { mcpLocal } as any, {});
        const data: any = await assembleV2Backup(zip, manifest);
        expect(data.mcpLocal).toEqual(mcpLocal);
        localStorage.removeItem('aetheros.mcp.servers');
        localStorage.removeItem('aetheros.mcp.useNativeTools');
        await DB.importFullData(data);
        expect(localStorage.getItem('aetheros.mcp.servers')).toBe(mcpLocal['aetheros.mcp.servers']);
        expect(localStorage.getItem('aetheros.mcp.useNativeTools')).toBe('false');
        localStorage.removeItem('aetheros.mcp.servers');
        localStorage.removeItem('aetheros.mcp.useNativeTools');
    });

    it('media_only 补丁：文字角色字段 + 文字消息存活，只有媒体被更新（R4·F1）', async () => {
        await seedStore('characters', [{ id: 'c1', name: 'Alice', bio: 'text-bio', avatar: 'old-avatar' }]);
        await seedStore('messages', [{ id: 1, charId: 'c1', type: 'text', content: 'hello' }]);

        // media_only 形状：没有 characters 字段（关键！），只有 mediaAssets + 过滤后的 image 消息
        const backupData = {
            mediaAssets: [{ charId: 'c1', avatar: 'new-avatar', backgrounds: {} }],
            messages: [{ id: 2, charId: 'c1', type: 'image', content: 'img' }],
        };
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, backupData, {});
        const data = await assembleV2Backup(zip, manifest);
        expect('characters' in data).toBe(false); // 没有 characters → importFullData 走 patch、不破坏性清

        await DB.importFullData(data as any);

        const c1 = (await DB.getRawStoreData('characters')).find((c: any) => c.id === 'c1');
        expect(c1.name).toBe('Alice');        // 文字字段存活
        expect(c1.bio).toBe('text-bio');      // 文字字段存活
        expect(c1.avatar).toBe('new-avatar'); // 媒体被 patch
        // 老文字消息 id1 没被清，新 image id2 加上（patch/merge，不 clear）
        const msgIds = (await DB.getRawStoreData('messages')).map((m: any) => m.id).sort();
        expect(msgIds).toEqual([1, 2]);
    });

    it('空数组按 shape 还原：clear-and-add 清、merge 不动、单例省略不动（test 9）', async () => {
        await seedStore('gallery', [{ id: 'gold', url: 'x' }]);          // clear-and-add 目标
        await seedStore('themes', [{ id: 'told', name: 'old-theme' }]);  // merge 目标
        await seedStore('user_profile', [{ id: 'me', name: 'OldUser' }]); // 单例目标

        // galleryImages 空数组（clear-and-add → 清）、customThemes 空数组（merge → 不动）、
        // 不含 userProfile（单例省略 → 不动）
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { galleryImages: [], customThemes: [] }, {});
        const data = await assembleV2Backup(zip, manifest);
        await DB.importFullData(data as any);

        expect(await DB.getRawStoreData('gallery')).toEqual([]);                                    // 被清
        expect((await DB.getRawStoreData('themes')).map((t: any) => t.id)).toEqual(['told']);       // merge 空 → 保留
        expect((await DB.getRawStoreData('user_profile')).map((u: any) => u.name)).toEqual(['OldUser']); // 省略 → 保留
    });

    it('聊天装扮随备份走：角色 chatFineTune 与主题微调字段 v2 往返不丢', async () => {
        // 收官回归钉子：全局微调（OSTheme 七字段 + 表情包大小）走 metadata.json 的 theme 整包，
        // 角色级覆盖（char.chatFineTune）随 characters store 整对象 clear-and-add——两头都不许丢。
        const char = {
            id: 'ft1', name: '小调', avatar: '',
            chatFineTune: { enabled: true, chatBubbleFontSize: 15, chatAvatarVisibility: 'hide_ai' },
        };
        const theme = { chatAvatarVisibility: 'hide_both', chatSnapToEdge: true, chatBubbleLineHeight: 1.5, chatEmojiSize: 'large' };
        // 分角色聊天头像（URL 形态）随 user_profile 单例走；data: 形态在 full/media 模式
        // 走 assets 抽取回填（restoreAssetsInPlace），text_only 剥掉——与整体头像同规则。
        const userProfile = { name: 'me', avatar: 'https://img.example/me.png', bio: '', perCharAvatars: { ft1: 'https://img.example/me-ft1.png' } };

        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { characters: [char], theme, userProfile } as any, {});
        const data: any = await assembleV2Backup(zip, manifest);

        // theme 是非数组字段 → 原样拼回（导入端 OSContext 直接拿它 updateTheme）
        expect(data.theme).toEqual(theme);

        await DB.importFullData(data);
        const restored = (await DB.getRawStoreData('characters')).find((c: any) => c.id === 'ft1');
        expect(restored.chatFineTune).toEqual(char.chatFineTune);
        const profile = (await DB.getRawStoreData('user_profile'))[0];
        expect(profile.perCharAvatars).toEqual(userProfile.perCharAvatars);
    });

    it('AI 原文范围设置随角色备份完整往返', async () => {
        const char = {
            id: 'ctx1',
            name: '上下文角色',
            avatar: '',
            description: '',
            systemPrompt: '',
            memories: [],
            contextRangePolicyVersion: 1,
            contextRangeMode: 'manual',
            contextLimit: 1200,
            contextUserStartMessageId: 345,
        };
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { characters: [char] } as any, {});
        const data = await assembleV2Backup(zip, manifest);

        await DB.importFullData(data as any);

        const restored = (await DB.getRawStoreData('characters')).find((c: any) => c.id === 'ctx1');
        expect(restored).toMatchObject({
            contextRangePolicyVersion: 1,
            contextRangeMode: 'manual',
            contextLimit: 1200,
            contextUserStartMessageId: 345,
        });
    });

    it('formatVersion 3 在组装阶段 abort，DB 未发生任何写（test 12）', async () => {
        await seedStore('gallery', [{ id: 'keep', url: 'x' }]);
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { galleryImages: [{ id: 'new' }] }, {});
        const v3 = { ...manifest, formatVersion: 3 };
        await expect(assembleV2Backup(zip, v3)).rejects.toThrow(/不支持的备份格式版本/);
        // 从没调用 importFullData → gallery 原样
        expect((await DB.getRawStoreData('gallery')).map((g: any) => g.id)).toEqual(['keep']);
    });

    it('缺分片在组装阶段 abort，DB 未发生任何写（test 8）', async () => {
        await seedStore('gallery', [{ id: 'keep', url: 'x' }]);
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { galleryImages: [{ id: 'a' }, { id: 'b' }] }, { limits: SMALL_SHARDS(1) });
        zip.files.delete(shardFileName('galleryImages', 1)); // 删掉第二片
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/中止导入/);
        expect((await DB.getRawStoreData('gallery')).map((g: any) => g.id)).toEqual(['keep']);
    });
});

const LARGE_VECTOR_COUNT = 4500;
const LARGE_VECTOR_DIMENSIONS = 1024;

function largeVectorMeta(row: number) {
    return {
        memoryId: `memory_${row}`,
        charId: `char_${row % 3}`,
        dimensions: LARGE_VECTOR_DIMENSIONS,
        model: row % 2 === 0 ? 'BAAI/bge-m3' : 'Pro/BAAI/bge-m3',
    };
}

function makeLargeVector(row: number): Float32Array {
    const vector = new Float32Array(LARGE_VECTOR_DIMENSIONS);
    for (let d = 0; d < vector.length; d++) {
        vector[d] = (((row * 31 + d * 17) % 1009) - 504) / 504;
    }
    return vector;
}

function updateVectorDigest(
    hash: ReturnType<typeof createHash>,
    meta: ReturnType<typeof largeVectorMeta>,
    bytes: Uint8Array,
) {
    hash.update(`${meta.memoryId}\0${meta.charId}\0${meta.dimensions}\0${meta.model}\0`);
    hash.update(bytes);
}

function numericMemoryOrder(a: { memoryId: string }, b: { memoryId: string }) {
    return Number(a.memoryId.slice('memory_'.length)) - Number(b.memoryId.slice('memory_'.length));
}

async function seedLargeVectorLibrary(): Promise<string> {
    const expected = createHash('sha256');
    const db = await openDB();
    const CHUNK_SIZE = 25;
    for (let start = 0; start < LARGE_VECTOR_COUNT; start += CHUNK_SIZE) {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['memory_nodes', 'memory_vectors'], 'readwrite');
            const nodeStore = tx.objectStore('memory_nodes');
            const vectorStore = tx.objectStore('memory_vectors');
            const end = Math.min(start + CHUNK_SIZE, LARGE_VECTOR_COUNT);
            for (let row = start; row < end; row++) {
                const meta = largeVectorMeta(row);
                const f32 = makeLargeVector(row);
                const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
                updateVectorDigest(expected, meta, bytes);
                nodeStore.put({
                    id: meta.memoryId,
                    charId: meta.charId,
                    content: `第 ${row} 条记忆`,
                    room: 'living_room',
                    tags: [],
                    importance: 5,
                    embedded: true,
                    createdAt: row,
                    lastAccessedAt: row,
                    accessCount: 0,
                });
                vectorStore.put({
                    ...meta,
                    // 两种历史存储形态各占一半，确保 number[] 与 Uint8Array 都逐字节无损。
                    vector: row % 2 === 0 ? Array.from(f32) : bytes,
                });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
    return expected.digest('hex');
}

function digestStoredVectors(vectors: any[]): string {
    const hash = createHash('sha256');
    for (const vector of [...vectors].sort(numericMemoryOrder)) {
        const f32 = vector.vector instanceof Float32Array
            ? vector.vector
            : vector.vector instanceof Uint8Array
                ? new Float32Array(vector.vector.buffer, vector.vector.byteOffset, vector.vector.byteLength >>> 2)
                : new Float32Array(vector.vector);
        updateVectorDigest(
            hash,
            {
                memoryId: vector.memoryId,
                charId: vector.charId,
                dimensions: vector.dimensions,
                model: vector.model,
            },
            new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength),
        );
    }
    return hash.digest('hex');
}

describe('v2 真实链路：向量二进制旁路', () => {
    it('4500×1024 真 ZIP → importFullData → 检索读取：数量、关联、元数据和全部 Float32 字节零变化', async () => {
        const expectedDigest = await seedLargeVectorLibrary();
        const sourceNodes = await DB.getRawStoreData('memory_nodes');

        const payload = await encodeVectorsForBackupChunked(async (onBatch) => {
            await DB.streamRawStoreData('memory_vectors', item => onBatch([item]));
        });
        expect(payload.index).toHaveLength(LARGE_VECTOR_COUNT);
        expect(payload.bin.byteLength).toBe(LARGE_VECTOR_COUNT * LARGE_VECTOR_DIMENSIONS * 4);

        const zip = new JSZip();
        await writeV2Backup(zip as any, { memoryNodes: sourceNodes }, { vectors: payload, mode: 'text_only' });
        const archive = await zip.generateAsync({
            type: 'uint8array',
            streamFiles: true,
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });
        const loaded = await JSZip.loadAsync(archive);
        const manifest = JSON.parse(await loaded.file('manifest.json')!.async('string'));
        const data: any = await assembleV2Backup(loaded as any, manifest);

        expect(data.memoryVectors).toHaveLength(LARGE_VECTOR_COUNT);
        expect(data.memoryNodes).toHaveLength(LARGE_VECTOR_COUNT);
        // 每条必须是独立 buffer；否则写入 IDB 时可能把整根 17.6 MiB bin 为每条重复克隆。
        expect(new Set(data.memoryVectors.map((v: any) => v.vector.buffer)).size).toBe(LARGE_VECTOR_COUNT);

        await seedStore('memory_nodes', [{ id: 'stale', charId: 'stale', content: '应被清除' }]);
        await seedStore('memory_vectors', [{
            memoryId: 'stale', charId: 'stale', dimensions: 1, model: 'old', vector: new Uint8Array(4),
        }]);
        await DB.importFullData(data);

        const restoredNodes = await DB.getRawStoreData('memory_nodes');
        const restoredRaw = await DB.getRawStoreData('memory_vectors');
        expect(restoredNodes).toHaveLength(LARGE_VECTOR_COUNT);
        expect(restoredRaw).toHaveLength(LARGE_VECTOR_COUNT);
        expect(restoredRaw.every((v: any) => v.vector instanceof Uint8Array)).toBe(true);
        expect(digestStoredVectors(restoredRaw)).toBe(expectedDigest);

        const nodeById = new Map(restoredNodes.map((node: any) => [node.id, node]));
        for (const vector of restoredRaw) {
            expect(nodeById.get(vector.memoryId)?.charId).toBe(vector.charId);
        }

        // 再走实际检索侧公开读取 API：应解码成 Float32Array，仍与导出前全量哈希相同。
        const searchSideVectors = (
            await Promise.all(['char_0', 'char_1', 'char_2'].map(charId => MemoryVectorDB.getAllByCharId(charId)))
        ).flat();
        expect(searchSideVectors).toHaveLength(LARGE_VECTOR_COUNT);
        expect(searchSideVectors.every(v => v.vector instanceof Float32Array)).toBe(true);
        expect(digestStoredVectors(searchSideVectors)).toBe(expectedDigest);
    }, 30_000);

    it('向量 clear-once：目标独有的旧向量被清、备份的向量落库、逐值一致（test 10 + 二进制往返）', async () => {
        // 目标已有 vA、vB（存储形态 Uint8Array）
        const toU8 = (vals: number[]) => { const f = new Float32Array(vals); return new Uint8Array(f.buffer, f.byteOffset, f.byteLength); };
        await seedStore('memory_vectors', [
            { memoryId: 'vA', charId: 'c1', dimensions: 4, vector: toU8([9, 9, 9, 9]) },
            { memoryId: 'vB', charId: 'c1', dimensions: 4, vector: toU8([8, 8, 8, 8]) },
        ]);

        // 备份只含 vA（新值）+ vC，不含 vB
        const payload = encodeVectorsForBackup([
            { memoryId: 'vA', charId: 'c1', vector: toU8([1, 2, 3, 4]) },
            { memoryId: 'vC', charId: 'c2', vector: toU8([5, 6, 7, 8]) },
        ]);
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { memoryNodes: [{ id: 'n1' }] }, { vectors: payload });
        const data = await assembleV2Backup(zip, manifest);
        await DB.importFullData(data as any);

        const stored = await DB.getRawStoreData('memory_vectors');
        const byId = new Map(stored.map((v: any) => [v.memoryId, v]));
        // vB 被清（走 importFullData 的 clearStore，不是 saveMany upsert 旁路）
        expect([...byId.keys()].sort()).toEqual(['vA', 'vC']);
        // 逐值一致，且 vA 是新值不是旧值
        expect(vecValues(byId.get('vA'))).toEqual([1, 2, 3, 4]);
        expect(vecValues(byId.get('vC'))).toEqual([5, 6, 7, 8]);
        // 落库形态是 Uint8Array（紧凑存储）
        expect(byId.get('vA').vector).toBeInstanceOf(Uint8Array);
    });

    it('遗留 number[] 向量导出 v2、再导入逐值一致（R4·F4 / test 18）', async () => {
        // 老数据：vector 还是 raw number[]（未迁移成 Uint8Array）
        await seedStore('memory_vectors', [
            { memoryId: 'legacy1', charId: 'c1', dimensions: 4, vector: [0.11, 0.22, 0.33, 0.44] },
        ]);

        // 导出走和 OSContext 完全相同的归一化函数
        const raw = await DB.getRawStoreData('memory_vectors');
        const payload = encodeVectorsForBackup(raw);
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, {}, { vectors: payload });
        expect(manifest.vectors).toEqual({ count: 1, byteLength: 16 });

        await seedStore('memory_vectors', []); // 清空目标，证明是从备份还原
        const data = await assembleV2Backup(zip, manifest);
        await DB.importFullData(data as any);

        const stored = await DB.getRawStoreData('memory_vectors');
        expect(stored).toHaveLength(1);
        expect(stored[0].memoryId).toBe('legacy1');
        const vals = vecValues(stored[0]);
        expect(vals).toEqual([
            expect.closeTo(0.11, 6), expect.closeTo(0.22, 6), expect.closeTo(0.33, 6), expect.closeTo(0.44, 6),
        ]);
    });
});
