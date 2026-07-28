import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../../types';
import { EventBoxDB, MemoryNodeDB } from './db';
import {
    buildMemoryRepairCoreContext,
    filterEditableMemoryNodes,
    formatRepairMemoryDate,
    getMemoryGuideCopy,
    loadRecallRepairSnapshot,
    naturalizeMemoryRepairLanguage,
} from './memoryRepair';
import { clearReceipts, getLatestRecallReceipt, recordRecallReceipt } from './recallReceipts';
import type { EventBox, MemoryNode } from './types';

function node(id: string, charId: string, content: string, extra: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        charId,
        content,
        room: 'living_room',
        tags: [],
        importance: 5,
        mood: 'neutral',
        embedded: true,
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
        ...extra,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('本轮召回记忆修补', () => {
    it('只拿时间点之后最近一次回执，不会误用上一轮', () => {
        const charId = 'repair_receipt_latest';
        clearReceipts(charId);
        vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
        recordRecallReceipt(charId, ['old']);
        recordRecallReceipt(charId, ['current']);

        expect(getLatestRecallReceipt(charId, 1500)).toEqual({ ts: 2000, ids: ['current'] });
        expect(getLatestRecallReceipt(charId, 2500)).toBeNull();
    });

    it('命中事件盒任一节点后，展开摘要、活节点和归档节点供原地修改', async () => {
        const charId = 'repair_box_complete';
        const summary = node('repair_summary', charId, '错误的盒摘要', { isBoxSummary: true });
        const live = node('repair_live', charId, '本轮实际经过的活节点', { eventBoxId: 'repair_box' });
        const archived = node('repair_archived', charId, '已经归档但仍可修补', {
            eventBoxId: 'repair_box',
            archived: true,
        });
        const standalone = node('repair_standalone', charId, '散落的独立记忆');
        await MemoryNodeDB.saveMany([summary, live, archived, standalone]);
        const box: EventBox = {
            id: 'repair_box',
            charId,
            name: '那次旅行',
            tags: [],
            summaryNodeId: summary.id,
            liveMemoryIds: [live.id],
            archivedMemoryIds: [archived.id],
            compressionCount: 1,
            createdAt: 1,
            updatedAt: 1,
            lastCompressedAt: 1,
        };
        await EventBoxDB.save(box);
        clearReceipts(charId);
        recordRecallReceipt(charId, [live.id, standalone.id]);

        const snapshot = await loadRecallRepairSnapshot(charId, 0);
        expect(snapshot.standalone.map(item => item.node.id)).toEqual([standalone.id]);
        expect(snapshot.boxes).toHaveLength(1);
        expect(snapshot.boxes[0].nodes.map(item => [item.node.id, item.kind])).toEqual([
            [summary.id, 'summary'],
            [live.id, 'live'],
            [archived.id, 'archived'],
        ]);
        expect(snapshot.boxes[0].recalledNodeIds).toEqual([live.id]);
    });

    it('修补现场使用真实记忆日期，不把中午占位伪装成精确时分', () => {
        const timestamp = new Date(2026, 6, 28, 12, 0, 0).getTime();
        expect(formatRepairMemoryDate(timestamp, timestamp)).toBe('2026年7月28日（今天）');
    });

    it('面向用户的诊断不残留“用户/角色”分析术语', () => {
        expect(naturalizeMemoryRepairLanguage(
            '该用户指出这个角色记错了，角色本人需要核对。',
            '阿宁',
            '小满',
        )).toBe('小满指出阿宁记错了，阿宁需要核对。');
    });

    it('诊断上下文按约定走 false，并隔离持久记忆和运行时向量注入', () => {
        const char = {
            id: 'repair_context',
            name: '阿宁',
            avatar: '',
            description: '',
            systemPrompt: '说话简洁。',
            memories: [{ id: 'legacy', date: '2026-01-01', summary: 'LEGACY_MEMORY_MARKER' }],
            refinedMemories: { '2026-01': 'REFINED_MEMORY_MARKER' },
            activeMemoryMonths: ['2026-01'],
            memoryPalaceEnabled: true,
            memoryPalaceInjection: 'VECTOR_MEMORY_MARKER',
            roomPlatesInjection: 'ROOM_PLATE_MARKER',
            buffInjection: 'BUFF_MARKER',
        } as CharacterProfile;
        const user = { name: '小满' } as UserProfile;

        const context = buildMemoryRepairCoreContext(char, user);
        expect(context).toContain('阿宁');
        expect(context).not.toContain('LEGACY_MEMORY_MARKER');
        expect(context).not.toContain('REFINED_MEMORY_MARKER');
        expect(context).not.toContain('VECTOR_MEMORY_MARKER');
        expect(context).not.toContain('ROOM_PLATE_MARKER');
        expect(context).not.toContain('BUFF_MARKER');
    });

    it('引路者问候由角色风格稳定选择，不调用模型生成', () => {
        const char = {
            id: 'guide_style',
            name: '阿宁',
            personalityStyle: 'imagery',
        } as CharacterProfile;
        const first = getMemoryGuideCopy(char, '小满');
        const second = getMemoryGuideCopy(char, '小满');

        expect(first).toEqual(second);
        expect(first.greeting).toContain('小满');
        expect(first.trail.length).toBeGreaterThan(4);
    });

    it('用户可用不完整关键词和日期模糊找到可修改记忆，包含归档节点', () => {
        const nodes = [
            node('beach', 'search_char', '去年在海边一起过了生日', {
                tags: ['旅行', '礼物'],
                createdAt: new Date(2026, 6, 3, 12, 0, 0).getTime(),
            }),
            node('archived', 'search_char', '旧车站告别', {
                archived: true,
                eventBoxId: 'box_1',
            }),
            node('other', 'search_char', '在家看了一整天电影'),
        ];

        expect(filterEditableMemoryNodes(nodes, '海 生').map(item => item.node.id))
            .toEqual(['beach']);
        expect(filterEditableMemoryNodes(nodes, '海生').map(item => item.node.id))
            .toEqual(['beach']);
        expect(filterEditableMemoryNodes(nodes, '2026-07').map(item => item.node.id))
            .toEqual(['beach']);
        expect(filterEditableMemoryNodes(nodes, '车站')[0]).toMatchObject({
            node: { id: 'archived' },
            kind: 'archived',
        });
    });
});
