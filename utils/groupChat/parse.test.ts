import { describe, it, expect } from 'vitest';
import { parseDirectorActions, parseSummaryYaml } from './parse';

describe('parseDirectorActions', () => {
    it('标准 JSON 数组直接解析', () => {
        const raw = '[{"charId": "c1", "content": "早啊"}, {"charId": "c2", "content": "困死了"}]';
        expect(parseDirectorActions(raw)).toEqual([
            { charId: 'c1', content: '早啊' },
            { charId: 'c2', content: '困死了' },
        ]);
    });

    it('带 markdown 围栏也能解析', () => {
        const raw = '```json\n[{"charId": "c1", "content": "哈哈哈"}]\n```';
        expect(parseDirectorActions(raw)).toEqual([{ charId: 'c1', content: '哈哈哈' }]);
    });

    it('第二层：没裹数组的单对象也能救回来', () => {
        const raw = '{"charId": "c1", "content": "就我一个人说话吗"}';
        expect(parseDirectorActions(raw)).toEqual([{ charId: 'c1', content: '就我一个人说话吗' }]);
    });

    it('第二层：数组整体损坏时逐个抠对象，坏的跳过好的保留', () => {
        const raw = '好的，以下是本轮群聊：[{"charId": "c1", "content": "第一条"}, {"charId": "c2", "content": "第二条"},]（生成完毕）';
        // 尾逗号让整体 JSON.parse 失败，但两个对象都应被逐个救回
        expect(parseDirectorActions(raw)).toEqual([
            { charId: 'c1', content: '第一条' },
            { charId: 'c2', content: '第二条' },
        ]);
    });

    it('content 为数字 / charId 为数字时强转 string，空 content 丢弃', () => {
        const raw = '[{"charId": 42, "content": 123}, {"charId": "c2", "content": "  "}]';
        expect(parseDirectorActions(raw)).toEqual([{ charId: '42', content: '123' }]);
    });

    it('完全无法解析时返回空数组而不是抛错', () => {
        expect(parseDirectorActions('今天大家聊得很开心。')).toEqual([]);
        expect(parseDirectorActions('')).toEqual([]);
    });
});

describe('parseSummaryYaml', () => {
    it('标准 YAML 带双引号', () => {
        expect(parseSummaryYaml('summary: "群里讨论了猫的照片。"')).toBe('群里讨论了猫的照片。');
    });

    it('带围栏的 YAML', () => {
        expect(parseSummaryYaml('```yaml\nsummary: "大家一起吐槽天气。"\n```')).toBe('大家一起吐槽天气。');
    });

    it('多行内容（引号闭合配对，不会在中途截断）', () => {
        const raw = 'summary: "第一行。\n第二行。"';
        expect(parseSummaryYaml(raw)).toBe('第一行。\n第二行。');
    });

    it('无引号裸值取到文末', () => {
        expect(parseSummaryYaml('summary: 群成员分享了新歌。')).toBe('群成员分享了新歌。');
    });

    it('第二层：完全没有 summary 前缀时整段当正文', () => {
        expect(parseSummaryYaml('大家围观了一只猫，气氛轻松。')).toBe('大家围观了一只猫，气氛轻松。');
    });

    it('中文引号包裹时剥掉', () => {
        expect(parseSummaryYaml('summary: “今天聊了旅行计划。”')).toBe('今天聊了旅行计划。');
    });

    it('空输入返回空串', () => {
        expect(parseSummaryYaml('')).toBe('');
    });
});
