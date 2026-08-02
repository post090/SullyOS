import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';

// `[schedule_message]` 排的是浏览器里的本地定时消息：存 IndexedDB，靠 OSContext 里一个
// 5 秒轮询的 React 定时器派发，App 关着就不存在。主动消息 2.0 到点生成走的是另一条路
// （worker 到点跑），它有自己的排程工具，说明由 worker 追加在 fire_pack 末尾。
//
// 两套一起摆在角色面前，它会挑错的那套：正文里写「我到点叫你」+ 一行 [schedule_message]，
// 然后那条排程永远不会响。fire_pack 打包时用 forFirePack 把老那套拿掉。

const char = { id: 'char-sched', name: '阿一' } as any;
const userProfile = { name: '条条' } as any;

const buildStable = async (promptOptions?: { forFirePack?: boolean }) => {
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, [], [], [], [],
        undefined, undefined, undefined, undefined, undefined, undefined,
        promptOptions,
    );
    return parts.stable;
};

describe('行为规范 · [schedule_message] 的教学开关', () => {
    it('默认（前台聊天）照常教', async () => {
        const stable = await buildStable();
        expect(stable).toContain('[schedule_message | YYYY-MM-DD HH:MM:SS | fixed | 消息内容]');
        expect(stable).toContain('定时发送消息');
    });

    it('forFirePack（打包主动消息模板）时整条不出现', async () => {
        const stable = await buildStable({ forFirePack: true });
        expect(stable).not.toContain('schedule_message');
        expect(stable).not.toContain('定时发送消息');
        // 只拿掉这一条，同一段里的其他动作说明得留着
        expect(stable).toContain('[[ACTION:POKE]]');
        expect(stable).toContain('[[ACTION:ADD_EVENT');
    });
});
