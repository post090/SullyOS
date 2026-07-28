import { describe, expect, it } from 'vitest';
import {
    EXTERNAL_MEMORY_MAX_CHARS,
    assertExternalMemoryCoverage,
    assertExternalMemorySchema,
    buildExternalMemoryPrompt,
    getExternalMemoryLengthInfo,
    getExternalMemoryOverLimitMessage,
    parseExternalMemoryItems,
    parseCompleteExternalMemoryReply,
    splitExternalMemoryText,
} from './externalMemory';
import {
    buildAutoArchiveFragments,
    mergePalaceFragmentsIntoMemories,
} from './pipeline';

describe('外部记忆搬家', () => {
    it('最多接收 5 万字，并优先按换行分批且不丢正文', () => {
        const paragraphs = [
            '甲'.repeat(7_000),
            '乙'.repeat(7_000),
            '丙'.repeat(7_000),
        ];
        const source = paragraphs.join('\n');
        const chunks = splitExternalMemoryText(source, 10_000);

        expect(chunks).toEqual(paragraphs);
        expect(chunks.join('\n')).toBe(source);
        expect(() => splitExternalMemoryText('字'.repeat(EXTERNAL_MEMORY_MAX_CHARS + 1)))
            .toThrow(/超过单次上限/);
    });

    it('字数在本地按 Unicode 字符统计，超限时给出明确分批建议', () => {
        expect(getExternalMemoryLengthInfo('记忆😀')).toMatchObject({
            count: 3,
            overLimit: false,
            suggestedBatches: 1,
        });

        const overLimit = '字'.repeat(EXTERNAL_MEMORY_MAX_CHARS * 2 + 1);
        const info = getExternalMemoryLengthInfo(overLimit);
        expect(info.count).toBe(100_001);
        expect(info.overLimit).toBe(true);
        expect(info.suggestedBatches).toBe(3);
        expect(getExternalMemoryOverLimitMessage(overLimit)).toContain('拆成 3 批');
        expect(getExternalMemoryOverLimitMessage(overLimit)).toContain('不会调用 API');
    });

    it('提示词钉死只整理时间、不压缩内容的搬家原则', () => {
        const prompt = buildExternalMemoryPrompt('小满', '阿宁');

        expect(prompt).toContain('只整理时间和结构，不压缩内容');
        expect(prompt).toContain('输出能被程序直接解析');
        expect(prompt).toContain('不删除、不更改、不压缩内容');
        expect(prompt).toContain('不得总结、概括、润色、改写、合并同类项或去重');
        expect(prompt).toContain('每个具体事实');
        expect(prompt).toContain('不能省略');
        expect(prompt).toContain('严禁猜日期');
        expect(prompt).toContain('阿宁');
    });

    it('搬家只接受完整 JSON，不把截断对象抢救成半份成功', () => {
        expect(parseCompleteExternalMemoryReply('[{"content":"完整"}]')).toEqual([{ content: '完整' }]);
        expect(() => parseCompleteExternalMemoryReply('[{"content":"只剩前半段"}'))
            .toThrow(/完整 JSON|JSON 格式/);
        expect(() => parseCompleteExternalMemoryReply('说明如下：[{"content":"完整"}]'))
            .toThrow(/完整 JSON/);
    });

    it('可解析但缺字段或字段越界的结果也不会静默补默认值', () => {
        expect(() => assertExternalMemorySchema([{
            date: null,
            content: '正文',
            room: 'living_room',
            importance: 7,
            mood: 'neutral',
            valence: 0,
            arousal: 0,
            tags: ['事件'],
        }])).not.toThrow();
        expect(() => assertExternalMemorySchema([{
            date: null,
            content: '正文',
            room: '不存在的房间',
            importance: 7,
            mood: 'neutral',
            valence: 0,
            arousal: 0,
            tags: [],
        }])).toThrow(/room/);
        expect(() => assertExternalMemorySchema([{
            date: null,
            content: '正文',
            room: 'living_room',
            importance: 7,
            mood: 'neutral',
            tags: [],
        }])).toThrow(/valence/);
    });

    it('清洗结果保留完整 content，并按日期与房间生成可向量化节点', () => {
        const importedAt = new Date(2026, 6, 28, 12).getTime();
        const longContent = '完整细节：' + '没有被摘要。'.repeat(100);
        const nodes = parseExternalMemoryItems([
            {
                date: '2024年3月9日',
                content: longContent,
                room: 'user_room',
                importance: 8,
                mood: 'nostalgic',
                tags: ['外婆', '旧家'],
            },
            {
                date: null,
                content: '日期未知但内容仍应保留',
                room: 'not-a-room',
            },
        ], 'char_1', importedAt);

        expect(nodes).toHaveLength(2);
        expect(nodes[0].content).toBe(longContent);
        expect(nodes[0].room).toBe('user_room');
        expect(new Date(nodes[0].createdAt).getFullYear()).toBe(2024);
        expect(new Date(nodes[0].createdAt).getMonth()).toBe(2);
        expect(new Date(nodes[0].createdAt).getDate()).toBe(9);
        expect(nodes[0].embedded).toBe(false);
        expect(nodes[1].room).toBe('living_room');
        expect(nodes[1].createdAt).toBe(importedAt + 60_000);
    });

    it('明显压缩或漏掉大段内容时拒绝继续写入', () => {
        const source = '这是不能被删掉的完整经历。'.repeat(80);
        const nodes = parseExternalMemoryItems([{
            date: null,
            content: '一句摘要',
            room: 'living_room',
        }], 'char_1');
        expect(() => assertExternalMemoryCoverage(source, nodes)).toThrow(/删减或压缩/);
    });

    it('与全自动水位线共用同一桥接器，把同批向量节点写进神经链接档案', () => {
        const day = new Date(2025, 4, 20, 12).getTime();
        const payload = buildAutoArchiveFragments([
            { id: 'mn_1', content: '第一条完整记忆', createdAt: day },
            { id: 'mn_2', content: '第二条完整记忆', createdAt: day + 60_000 },
        ], 0);

        expect(payload?.hideBeforeMessageId).toBe(0);
        expect(payload?.fragments).toHaveLength(1);
        expect(payload?.fragments[0].summary).toBe('- 第一条完整记忆\n- 第二条完整记忆');

        const merged = mergePalaceFragmentsIntoMemories([], payload?.fragments || []);
        expect(merged).toHaveLength(1);
        expect(merged[0].mood).toBe('palace');
        expect(merged[0].summary).toContain('第一条完整记忆');
        expect(merged[0].summary).toContain('第二条完整记忆');
    });
});
