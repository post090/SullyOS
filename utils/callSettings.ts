// 通话（CallApp）独立设置 —— localStorage 一份，齿轮 bottom sheet 编辑。
// 只管通话自己的语音输入链路：云端 STT / 音频理解模型 / 转写方式。
// STT 取值链：callAutoStart.sttOverride（面试场景）> 这里的 stt > 全局 apiConfig。
// 普通通话的「一体」模式只做转写进输入框，不做说话状态分析（那是面试专属）。

export interface CallApiRef {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface CallSettings {
    /** 云端 STT（null = 跟随全局 apiConfig.stt*） */
    stt: CallApiRef | null;
    /** 音频理解模型（一体转写用；null = 未配置，一体模式不可用） */
    audio: CallApiRef | null;
    /** 转写方式：stt = 录音走 STT 接口；audioModel = 录音直接交音频模型转写 */
    transcribeMode: 'stt' | 'audioModel';
}

export const CALL_SETTINGS_KEY = 'os_call_settings';

export const DEFAULT_CALL_SETTINGS: CallSettings = {
    stt: null, audio: null, transcribeMode: 'stt',
};

export const loadCallSettings = (): CallSettings => {
    let raw: any = {};
    try { raw = JSON.parse(localStorage.getItem(CALL_SETTINGS_KEY) || '{}') || {}; } catch { raw = {}; }
    return {
        ...DEFAULT_CALL_SETTINGS,
        ...raw,
        stt: raw.stt?.baseUrl ? raw.stt : null,
        audio: raw.audio?.baseUrl ? raw.audio : null,
        transcribeMode: raw.transcribeMode === 'audioModel' ? 'audioModel' : 'stt',
    };
};

export const saveCallSettings = (settings: CallSettings): void => {
    try { localStorage.setItem(CALL_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 存储满等场景静默 */ }
};
