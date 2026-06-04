/**
 * 「彼方」独立 API 配置 + 调用记录。
 *
 * 彼方的角色会自主、频繁地登入触发 LLM 调用，比较费 API，所以允许用户单独
 * 指定一份 API（与聊天 App 共用同一批已保存的预设 os_api_presets，但选择独立）。
 * 不设则回退聊天默认 apiConfig。
 *
 * 同时记录每次调用，方便用户对账、避免误会"偷偷调用"。
 */
import type { APIConfig } from '../../types';

const API_KEY = 'vr_world_api';
const LOG_KEY = 'vr_world_api_log';
const LOG_CAP = 120;

export interface VRApiCall {
    ts: number;
    charName?: string;
    room?: string;
    model?: string;
    baseUrl?: string;
    ok: boolean;
    ms: number;
    error?: string;
}

/** 彼方独立 API；null = 跟随聊天默认。 */
export function getVRApi(): APIConfig | null {
    try { const s = localStorage.getItem(API_KEY); return s ? JSON.parse(s) as APIConfig : null; } catch { return null; }
}

export function setVRApi(cfg: APIConfig | null): void {
    try {
        if (cfg) localStorage.setItem(API_KEY, JSON.stringify(cfg));
        else localStorage.removeItem(API_KEY);
        window.dispatchEvent(new CustomEvent('vr-api-changed'));
    } catch { /* ignore */ }
}

export function getVRApiLog(): VRApiCall[] {
    try { const s = localStorage.getItem(LOG_KEY); return s ? JSON.parse(s) as VRApiCall[] : []; } catch { return []; }
}

export function logVRApiCall(entry: VRApiCall): void {
    try {
        const log = getVRApiLog();
        log.unshift(entry);
        localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, LOG_CAP)));
        window.dispatchEvent(new CustomEvent('vr-api-log'));
    } catch { /* ignore */ }
}

export function clearVRApiLog(): void {
    try { localStorage.removeItem(LOG_KEY); window.dispatchEvent(new CustomEvent('vr-api-log')); } catch { /* ignore */ }
}
