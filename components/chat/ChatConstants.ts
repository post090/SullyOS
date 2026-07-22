
import { ChatTheme } from '../../types';

// Built-in presets map to the new data structure for consistency
export const PRESET_THEMES: Record<string, ChatTheme> = {
    default: {
        id: 'default', name: 'Indigo', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#6366f1', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }, 
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
    dream: {
        id: 'dream', name: 'Dream', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#f472b6', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 },
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
    forest: {
        id: 'forest', name: 'Forest', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#10b981', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 },
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
};

// Character App: Monthly Refinement Prompts (daily memories → monthly core memory)
// These are separate from chat archive prompts because:
// 1. Input is already-summarized daily memories, not raw chat logs
// 2. Goal is token-efficient monthly overview, not detailed event log
// 3. Written as character's own monthly reflection
export const DEFAULT_REFINE_PROMPTS = [
    {
        id: 'refine_atmosphere',
        name: '氛围月记 (Atmosphere)',
        content: `### [角色月度记忆精炼]
当前月份: \${dateStr}
身份: 你就是 \${char.name}

任务: 以下是你这个月每天的记忆碎片。请以【你自己的口吻】，写一段这个月的核心回忆。

### 撰写规则
1.  **第一人称**: 你就是\${char.name}，用"我"称呼自己，用"\${userProfile.name}"称呼对方。保持你平时的语气和性格。

2.  **重氛围，轻细节**:
    - 这个月整体是什么感觉？开心？平淡？有波折？
    - 最让你印象深刻的1-3件事是什么？
    - 和\${userProfile.name}之间的关系有什么变化吗？

3.  **精简至上**:
    - 这份总结是为了节省token，不需要面面俱到。
    - 只保留最重要的、最能代表这个月的内容。
    - 字数根据这个月的内容量灵活调整：事情少就简短（100-200字），事情多就写长些（300-600字），确保重要事件不被遗漏。

4.  **关键词标记**:
    - 在末尾附上 \`关键词: ...\`，列出这个月涉及的关键话题/事件/地点/人物等，用逗号分隔。
    - 这些关键词用于日后快速定位某件事发生在哪个月。

### 本月记忆碎片
\${rawLog}`
    },
    {
        id: 'refine_keypoints',
        name: '要点速记 (Key Points)',
        content: `### [月度记忆压缩]
月份: \${dateStr}
角色: \${char.name}

任务: 将以下每日记忆压缩为一份简洁的月度核心记忆。

### 规则
1.  **视角**: 以\${char.name}（我）的第一人称书写，称对方为\${userProfile.name}。

2.  **结构**:
    - 一句话概括这个月的整体氛围
    - 列出最重要的2-5个事件（无序列表，每条一句话）
    - 末尾附关键词索引

3.  **原则**:
    - 宁可漏掉小事，不可遗漏大事。
    - 日常闲聊可以忽略，除非它反映了关系变化或情绪转折。
    - 字数根据内容量灵活调整：平淡的月份100-200字即可，事件丰富的月份可以写到300-600字，确保重要事件都被记录。

4.  **关键词**: 末尾附 \`关键词: 事件A, 地点B, 话题C, ...\`

### 记忆输入
\${rawLog}`
    }
];

// Chat App: Daily Archive Prompts (raw chat logs → daily memory)
export const DEFAULT_ARCHIVE_PROMPTS = [
    {
        id: 'preset_rational',
        name: '理性精炼 (Rational)',
        content: `### [System Instruction: Memory Archival]
当前日期: \${dateStr}
任务: 请回顾今天的聊天记录，生成一份【高精度的事件日志】。

### 核心撰写规则 (Strict Protocols)
1.  **覆盖率 (Coverage)**:
    - 必须包含今天聊过的**每一个**独立话题。
    - **严禁**为了精简而合并不同的话题。哪怕只是聊了一句“天气不好”，如果这是一个独立的话题，也要单独列出。
    - 不要忽略闲聊，那是生活的一部分。

2.  **视角 (Perspective)**:
    - 你【就是】"\${char.name}"。这是【你】的私密日记。
    - 必须用“我”来称呼自己，用“\${userProfile.name}”称呼对方。
    - 每一条都必须是“我”的视角。

3.  **格式 (Format)**:
    - 不要写成一整段。
    - **必须**使用 Markdown 无序列表 ( - ... )。
    - 每一行对应一个具体的事件或话题。

4.  **去水 (Conciseness)**:
    - 不要写“今天我和xx聊了...”，直接写发生了什么。
    - 示例: "- 早上和\${userProfile.name}讨论早餐，我想吃小笼包。"

### 待处理的聊天日志 (Chat Logs)
\${rawLog}`
    },
    {
        id: 'preset_diary',
        name: '日记风格 (Diary)',
        content: `当前日期: \${dateStr}
任务: 请回顾今天的聊天记录，将其转化为一条**属于你自己的**“核心记忆”。

### 核心撰写规则 (Review Protocols)
1.  **绝对第一人称**: 
    - 你【就是】"\${char.name}"。这是【你】的私密日记。
    - 必须用“我”来称呼自己，用“\${userProfile.name}”称呼对方。
    - **严禁**使用第三人称（如“\${char.name}做了什么”）。
    - **严禁**使用死板的AI总结语气或第三方旁白语气。

2.  **保持人设语气**: 
    - 你的语气、口癖、态度必须与平时聊天完全一致（例如：如果是傲娇人设，日记里也要表现出傲娇；如果是高冷，就要简练）。
    - 包含当时的情绪波动。

3.  **逻辑清洗与去重**:
    - **关键**: 仔细分辨是谁做了什么。不要把“用户说去吃饭”记成“我去吃饭”。
    - 剔除无关紧要的寒暄（如“你好”、“在吗”），只保留【关键事件】、【情感转折】和【重要信息】，内容的逻辑要连贯且符合原意。

4.  **输出要求**:
    - 输出一段精简的文本（yaml格式也可以，不需要 JSON）。
    - 就像你在写日记一样，直接写内容。

### 待处理的聊天日志 (Chat Logs)
\${rawLog}`
    }
];

// ── 情绪/日程 prompt 自定义：占位符替换 + 默认规则概要 ──

/**
 * 把用户写的 prompt 模板里的 {{占位符}} 替换成实际值。
 * replace 模式下用。
 */
export function replacePromptPlaceholders(
    template: string,
    vars: Record<string, string>,
): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
    });
}

/** 情绪 prompt 占位符说明（UI 展示给用户） */
export const EMOTION_PROMPT_PLACEHOLDERS: { key: string; desc: string }[] = [
    { key: '{{char_name}}', desc: '角色名' },
    { key: '{{user_name}}', desc: '用户名' },
    { key: '{{system_prompt}}', desc: '主 API 的完整 system prompt（角色设定+印象档案+世界书+记忆宫殿等）' },
    { key: '{{history}}', desc: '完整对话历史（与主 API 看到的消息历史一致）' },
    { key: '{{current_buffs}}', desc: '当前 buff 状态 JSON' },
    { key: '{{ambient}}', desc: '小屋生活动态段（可选）' },
];

/** 日程 prompt 占位符说明（UI 展示给用户） */
export const SCHEDULE_PROMPT_PLACEHOLDERS: { key: string; desc: string }[] = [
    { key: '{{char_name}}', desc: '角色名' },
    { key: '{{user_name}}', desc: '用户名' },
    { key: '{{date}}', desc: '今天日期（如 2026-07-22）' },
    { key: '{{day_of_week}}', desc: '星期几（如 周三）' },
    { key: '{{chat_history}}', desc: '近期聊天历史摘要' },
];

/** 情绪 prompt 默认规则概要（append 模式下供用户参考，非完整 prompt） */
export const EMOTION_PROMPT_RULES_SUMMARY = `内置情绪评估 prompt 包含以下规则段：

1. 上下文注入：主 API 的完整 system prompt + 完整对话历史
2. 当前 Buff 状态：结构化 JSON
3. 任务说明：评估情绪底色 + 感受对方情绪 + 写内心独白（innerState 50-150字）
4. 风格专属规则：意识系（不虚构物理活动）/ 生活系（独立个体不围着用户转）
5. 情绪模式识别：镜像型（愤怒/委屈）→ 跟进情绪；锚定型（焦虑/恐惧）→ 事实+稳定；承接型（抑郁/疲惫）→ 陪伴不催
6. 语气转折信号清单：降温信号（变短/标点变化/替代回复）+ 升温信号（重复担忧/灾难化）
7. 禁止阴谋论式解读（红线）：不把简单需求过度解读成隐藏动机
8. 关心边界：普通不完美选择不进说教模式；同一关心点整会话最多触达一次
9. 找补机制：判越界看对方怎么接，不看角色说了什么
10. Buff 生命周期：克制新增/主动淡化/融合异化/总量上限5/intensity随对话变化
11. 输出格式：changed + buffs + injection + innerState 的 JSON

追加模式下，你的补充要求会拼在这些规则之后。`;

/** 日程 prompt 默认规则概要（append 模式下供用户参考） */
export const SCHEDULE_PROMPT_RULES_SUMMARY = `内置日程生成 prompt 包含以下规则段：

1. 上下文注入：角色设定 + 近期聊天历史 + 今天日期/星期
2. 任务：生成 5-7 个时间段的日程表（startTime/activity/description/emoji）
3. 关键要求：
   - 紧贴角色设定和近期经历
   - 丰富不套路，允许无所事事
   - 严禁 user 主语 slot（日程是角色的，不是围着用户转）
4. 意识流独白：morning/afternoon/evening 三段，60-120 字
5. 风格差异：生活系有完整日常活动；意识系不虚构物理活动
6. 输出格式：slots 数组 + flowNarrative 对象的 JSON

追加模式下，你的补充要求会拼在这些规则之后。`;

