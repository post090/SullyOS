import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryNodeDB, MemoryVectorDB } from './db';
import type { EmbeddingConfig, MemoryNode } from './types';
import { updateStoredMemoryNode } from './vectorStore';

const originalFetch = global.fetch;
const embeddingConfig: EmbeddingConfig = {
    baseUrl: 'https://embedding.test/v1',
    apiKey: 'test-key',
    model: 'test-embedding',
    dimensions: 3,
};

function makeNode(id: string, content: string): MemoryNode {
    return {
        id,
        charId: 'memory_edit_char',
        content,
        room: 'living_room',
        tags: ['旧标签'],
        importance: 5,
        mood: 'neutral',
        embedded: true,
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
    };
}

beforeEach(() => {
    global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
    })) as any;
});

afterAll(() => {
    global.fetch = originalFetch;
});

describe('统一记忆编辑保存', () => {
    it('只修改 metadata 时不调用 Embedding API', async () => {
        const original = makeNode('memory_edit_metadata', '正文没有变化');
        await MemoryNodeDB.save(original);

        const result = await updateStoredMemoryNode(
            original.id,
            { room: 'study', tags: ['新标签'], importance: 8 },
            embeddingConfig,
        );

        expect(result.reembedded).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        expect(result.node).toMatchObject({
            content: '正文没有变化',
            room: 'study',
            tags: ['新标签'],
            importance: 8,
        });
    });

    it('正文变化时只请求一次，并覆盖同一 memoryId 的向量', async () => {
        const original = makeNode('memory_edit_content', '旧正文');
        await MemoryNodeDB.save(original);

        const result = await updateStoredMemoryNode(
            original.id,
            { content: '修正后的正文' },
            embeddingConfig,
        );
        const storedNode = await MemoryNodeDB.getById(original.id);
        const storedVector = await MemoryVectorDB.getByMemoryId(original.id);

        expect(result.reembedded).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(storedNode?.id).toBe(original.id);
        expect(storedNode?.content).toBe('修正后的正文');
        expect(storedNode?.embedded).toBe(true);
        expect(storedVector?.memoryId).toBe(original.id);
        expect(Array.from(storedVector?.vector as Float32Array)).toEqual([
            expect.closeTo(0.1),
            expect.closeTo(0.2),
            expect.closeTo(0.3),
        ]);
    });
});
