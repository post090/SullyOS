import type {
    ScheduleCardAppearance,
    ScheduleCardPresetId,
} from '../types';

export interface ScheduleCardPreset {
    id: Exclude<ScheduleCardPresetId, 'custom'>;
    name: string;
    description: string;
    background: string;
    base: string;
    text: string;
    accent: string;
}

export interface ScheduleCardPalette {
    preset: ScheduleCardPresetId;
    background: string;
    base: string;
    text: string;
    accent: string;
    accentSoft: string;
    line: string;
    isOriginal: boolean;
}

export const SCHEDULE_CARD_PRESETS: ScheduleCardPreset[] = [
    {
        id: 'original',
        name: '原版星夜',
        description: '跟随角色主题色',
        background: '',
        base: '',
        text: '#ffffff',
        accent: '',
    },
    {
        id: 'cream',
        name: '奶油信笺',
        description: '暖白与焦糖棕',
        background: 'linear-gradient(145deg, #fffaf0, #f0dfc9)',
        base: '#f0dfc9',
        text: '#584337',
        accent: '#b96f4b',
    },
    {
        id: 'sakura',
        name: '樱桃牛乳',
        description: '浅粉与莓果红',
        background: 'linear-gradient(145deg, #fff3f7, #f5dce8)',
        base: '#f5dce8',
        text: '#623d50',
        accent: '#c85d8b',
    },
    {
        id: 'mint',
        name: '薄荷清晨',
        description: '雾绿与深松石',
        background: 'linear-gradient(145deg, #ecfbf5, #cee9df)',
        base: '#cee9df',
        text: '#284b46',
        accent: '#2c9a83',
    },
    {
        id: 'twilight',
        name: '暮光紫',
        description: '柔紫与月光白',
        background: 'linear-gradient(145deg, #352747, #191321)',
        base: '#191321',
        text: '#f6edff',
        accent: '#d3a7ff',
    },
    {
        id: 'midnight',
        name: '午夜青',
        description: '墨蓝与冷青光',
        background: 'linear-gradient(145deg, #14252d, #071117)',
        base: '#071117',
        text: '#edfafa',
        accent: '#70d9cf',
    },
];

function hexToRgba(hex: string, alpha: number): string {
    const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, transparent)`;
    const value = Number.parseInt(match[1], 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export function resolveScheduleCardPalette(
    appearance: ScheduleCardAppearance | undefined,
    hue: number = 260,
    fallbackText: string = '#ffffff',
): ScheduleCardPalette {
    const presetId = appearance?.preset || 'original';
    if (presetId === 'original') {
        const accent = `hsl(${hue}, 70%, 65%)`;
        return {
            preset: 'original',
            background: `linear-gradient(145deg, hsl(${hue}, 40%, 12%), hsl(${hue}, 35%, 8%))`,
            base: `hsl(${hue}, 40%, 12%)`,
            text: fallbackText,
            accent,
            accentSoft: `hsla(${hue}, 70%, 55%, 0.28)`,
            line: 'rgba(255,255,255,0.16)',
            isOriginal: true,
        };
    }

    const preset = presetId === 'custom'
        ? null
        : SCHEDULE_CARD_PRESETS.find(item => item.id === presetId) || SCHEDULE_CARD_PRESETS[0];
    const background = preset?.background || appearance?.background || '#21192b';
    const base = preset?.base || appearance?.background || '#21192b';
    const text = preset?.text || appearance?.textColor || '#f8f3ff';
    const accent = preset?.accent || appearance?.accentColor || '#c9a7ff';
    return {
        preset: presetId,
        background,
        base,
        text,
        accent,
        accentSoft: hexToRgba(accent, 0.18),
        line: hexToRgba(text, 0.16),
        isOriginal: false,
    };
}

export const SCHEDULE_CSS_SCOPE_REGEX = /^\.sully-schedule-[\w-]+\b/;

export const SCHEDULE_CSS_SCOPE_HINT = '`.sully-schedule-*`';
