/**
 * API 站点视图层 —— 官方平铺预设 (os_api_presets) 之上的"纯派生"分组视图。
 *
 * 设计约束（用户明确要求）：
 *   - 底层数据永远是官方格式 ApiPreset[]，导出备份 / 导回官方版零障碍
 *   - 站点信息（改名等）存独立的附加 key (os_api_station_meta)，官方版导入时自动无视
 *   - 新界面主导：站点/模型的增删改都在站点视图完成，底层自动生成/删除官方预设
 *
 * 分组规则：baseUrl + apiKey 相同 → 同一站。
 * 站名推断：预设名去掉「（xxx）/(xxx)」尾缀后取组内最常见前缀（用户命名习惯本来就是「站名（模型）」）。
 */
import type { ApiPreset, APIConfig } from '../types';

// ─── 类型 ───────────────────────────────────────────────────

export interface StationModel {
    presetId: string;   // 对应官方预设 id
    model: string;      // 真实模型 id（发请求用）
    label: string;      // 展示名（从预设名提取的括号内容，或裸 model id）
    stream: boolean;
    temperature: number;
}

export interface Station {
    key: string;        // 稳定键 = baseUrl|apiKey
    name: string;       // 展示名（meta 改名优先，否则自动推断）
    baseUrl: string;
    apiKey: string;
    models: StationModel[];
}

interface StationMetaEntry { name?: string }
type StationMeta = Record<string, StationMetaEntry>;

// ─── meta 存取（附加信息，官方版无视）───────────────────────

const META_KEY = 'os_api_station_meta';
// 首次归并确认标记：没确认前 Settings 弹确认清单
const CONFIRM_KEY = 'os_api_station_confirmed';

export const loadStationMeta = (): StationMeta => {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; }
};

export const saveStationMeta = (meta: StationMeta): void => {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* 存不上不炸 */ }
};

export const renameStationInMeta = (key: string, name: string): void => {
    const meta = loadStationMeta();
    meta[key] = { ...meta[key], name };
    saveStationMeta(meta);
};

export const isStationViewConfirmed = (): boolean => {
    try { return localStorage.getItem(CONFIRM_KEY) === '1'; } catch { return false; }
};

export const markStationViewConfirmed = (): void => {
    try { localStorage.setItem(CONFIRM_KEY, '1'); } catch { /* ignore */ }
};

// ─── 派生逻辑 ───────────────────────────────────────────────

export const stationKey = (baseUrl: string, apiKey: string): string =>
    `${(baseUrl || '').trim().replace(/\/+$/, '')}|${(apiKey || '').trim()}`;

// 「站名（别名）」→ { prefix: '站名', label: '别名' }；没有括号 → label 空
// 仅用于兼容旧备份（没有 ApiPreset.label 字段时从 name 解析）。
// 别名含括号时此正则会截断，新数据走 ApiPreset.label 字段不再依赖它。
const splitPresetName = (name: string): { prefix: string; label: string } => {
    const m = name.match(/^(.*?)[（(]([^（()）]+)[)）]\s*$/);
    if (m) return { prefix: m[1].trim(), label: m[2].trim() };
    return { prefix: name.trim(), label: '' };
};

// 组内取出现最多的前缀当站名；全都不一样就用第一个
const inferStationName = (presetNames: string[]): string => {
    const count = new Map<string, number>();
    for (const n of presetNames) {
        const { prefix } = splitPresetName(n);
        if (!prefix) continue;
        count.set(prefix, (count.get(prefix) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [prefix, c] of count) {
        if (c > bestCount) { best = prefix; bestCount = c; }
    }
    return best || presetNames[0] || '未命名站点';
};

/** 官方预设 → 站点视图。保持预设首次出现顺序。 */
export const deriveStations = (presets: ApiPreset[], meta?: StationMeta): Station[] => {
    const m = meta || loadStationMeta();
    const map = new Map<string, { presets: ApiPreset[] }>();
    for (const p of presets) {
        const key = stationKey(p.config.baseUrl, p.config.apiKey);
        if (!map.has(key)) map.set(key, { presets: [] });
        map.get(key)!.presets.push(p);
    }
    const stations: Station[] = [];
    for (const [key, { presets: group }] of map) {
        const names = group.map(p => p.name);
        const name = m[key]?.name || inferStationName(names);
        stations.push({
            key,
            name,
            baseUrl: group[0].config.baseUrl,
            apiKey: group[0].config.apiKey,
            models: group.map(p => {
                // 新数据：p.label 字段直接存了别名，不再依赖 name 解析
                // 旧数据：从 name 的括号里解析（别名含括号会截断，但旧数据已那样了，保持现状）
                const parsedLabel = splitPresetName(p.name).label;
                const label = p.label ?? (parsedLabel || p.config.model);
                return {
                    presetId: p.id,
                    model: p.config.model,
                    label,
                    stream: p.config.stream === true,
                    temperature: typeof p.config.temperature === 'number' ? p.config.temperature : 0.85,
                };
            }),
        });
    }
    return stations;
};

/** 当前 apiConfig 命中的站（按 URL+KEY 匹配） */
export const findActiveStation = (stations: Station[], config: APIConfig): Station | undefined =>
    stations.find(s => s.key === stationKey(config.baseUrl, config.apiKey));

/** 新模型的官方预设命名：「站名（标签）」，跟用户既有命名习惯保持一致 */
export const presetNameFor = (stationName: string, modelLabel: string): string =>
    `${stationName}（${modelLabel}）`;

// ─── 悬浮球配置（也是附加 key，官方版无视）──────────────────

export interface FloatBallConfig {
    enabled: boolean;
    size: number;        // 直径 px
    opacity: number;     // 0.2 ~ 1
    color: string;       // 'auto' = 跟随主题色，否则 hex
    side: 'left' | 'right';   // 旧版吸边位置（仅作为没有 x/y 时的初始位兑底）
    yPct: number;        // 旧版垂直百分比（同上）
    x?: number;          // 自由摆放像素位（相对 PhoneShell 内容区，同音乐球）
    y?: number;
}

export const DEFAULT_FLOATBALL: FloatBallConfig = {
    enabled: false,
    size: 44,
    opacity: 0.85,
    color: 'auto',
    side: 'right',
    yPct: 55,
};

const BALL_KEY = 'os_api_floatball';
export const FLOATBALL_EVENT = 'sully-floatball-config';

export const loadFloatBallConfig = (): FloatBallConfig => {
    try {
        const raw = localStorage.getItem(BALL_KEY);
        return raw ? { ...DEFAULT_FLOATBALL, ...JSON.parse(raw) } : { ...DEFAULT_FLOATBALL };
    } catch { return { ...DEFAULT_FLOATBALL }; }
};

export const saveFloatBallConfig = (config: Partial<FloatBallConfig>): FloatBallConfig => {
    const next = { ...loadFloatBallConfig(), ...config };
    try { localStorage.setItem(BALL_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    // 悬浮球组件挂在 PhoneShell、设置页挂在 Settings，跨组件用事件同步
    try { window.dispatchEvent(new CustomEvent(FLOATBALL_EVENT, { detail: next })); } catch { /* ignore */ }
    return next;
};
