// 上岸计划 · 工作台设置（localStorage，用户级全局一份，不分角色）
// 提取成独立模块：单聊注入（chatPrompts）、通话（CallApp）、App 本体（JobHuntApp）多方共读。
// 编辑入口分工：单聊设置管 inject（单聊上下文注入）；App 设置中心管面试域
// （interviewInject / practiceTemplates / api / redactMode）；视图选择在岗位 tab 工具条。

/** 与 components/os/ApiConnectionPicker 的 ApiTriple 结构兼容（避免 utils→components 反向依赖） */
export interface JobApiRef {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface JobHuntSettings {
    zoom: number;                              // 文档流缩放挡位（0.9/1/1.1/1.2）
    typewriter: boolean;                       // 打字机效果
    autoSpeak: 'off' | 'interview' | 'all';    // 回复自动朗读范围
    autoMemorySync: boolean;                   // 离开会话自动沉淀记忆
    syncThreshold: number;                     // 自动沉淀的新消息条数阈值
    /** 单聊上下文注入（编辑入口在单聊设置，全局生效）：简历三态 / 竞争力档案 / 岗位摘要 */
    inject: { resume: 'none' | 'raw' | 'digest'; profile: boolean; positions: boolean; notes: boolean };
    /** 模拟面试出题素材注入（编辑入口在 App 设置中心） */
    interviewInject: { profile: boolean; resumeDigest: boolean };
    /** 练习附加提示词命名模板（练习设置弹窗「存为模板」） */
    practiceTemplates: { id: string; name: string; text: string }[];
    /** 面试独立 API 三路 + 音频分析（null / 'follow' = 跟随全局） */
    api: {
        chat: JobApiRef | null;
        stt: JobApiRef | null;
        ttsProvider: 'follow' | 'minimax' | 'fishaudio' | 'elevenlabs';
        audio: JobApiRef | null;
        audioAnalysis: boolean;
        transcribeMode: 'stt' | 'audioModel';
    };
    /**
     * 本地模糊化档位（全程离线，只有代号化后的文本上云）：
     * company: initial=拼音首字母+去重（默认，辨识度优先/隐私中等）/ pinyin=完整拼音缩写（好认/云端可能反推）
     *          / custom=用户自定义+codeLocked / off=不脱敏（不推荐）
     * name:    fixed=固定「候选人」（默认）/ pinyin=拼音缩写 / off=真名不脱敏
     */
    redactMode: { company: 'initial' | 'pinyin' | 'custom' | 'off'; name: 'fixed' | 'pinyin' | 'off' };
    /** 岗位列表视图：简略（一行预览）/ 详细 / 竖卡片瀑布流 */
    positionView: 'compact' | 'detailed' | 'masonry';
}

export const JH_SETTINGS_KEY = 'os_jobhunt_settings';

export const DEFAULT_JH_SETTINGS: JobHuntSettings = {
    zoom: 1, typewriter: true, autoSpeak: 'interview', autoMemorySync: true, syncThreshold: 6,
    inject: { resume: 'digest', profile: true, positions: true, notes: true },
    interviewInject: { profile: true, resumeDigest: true },
    practiceTemplates: [],
    api: { chat: null, stt: null, ttsProvider: 'follow', audio: null, audioAnalysis: false, transcribeMode: 'stt' },
    redactMode: { company: 'initial', name: 'fixed' },
    positionView: 'detailed',
};

/** 读取 + 缺省合并（嵌套对象逐层兜底，老数据/部分写入都能补齐新字段） */
export const loadJhSettings = (): JobHuntSettings => {
    let raw: any = {};
    try { raw = JSON.parse(localStorage.getItem(JH_SETTINGS_KEY) || '{}') || {}; } catch { raw = {}; }
    return {
        ...DEFAULT_JH_SETTINGS,
        ...raw,
        inject: { ...DEFAULT_JH_SETTINGS.inject, ...(raw.inject || {}) },
        interviewInject: { ...DEFAULT_JH_SETTINGS.interviewInject, ...(raw.interviewInject || {}) },
        practiceTemplates: Array.isArray(raw.practiceTemplates) ? raw.practiceTemplates : [],
        api: { ...DEFAULT_JH_SETTINGS.api, ...(raw.api || {}) },
        redactMode: { ...DEFAULT_JH_SETTINGS.redactMode, ...(raw.redactMode || {}) },
    };
};

export const saveJhSettings = (settings: JobHuntSettings): void => {
    try { localStorage.setItem(JH_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 存储满等场景静默 */ }
};
