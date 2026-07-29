import { describe, expect, it } from 'vitest';
import { validateScopedCss } from './scopedCss';
import {
    resolveScheduleCardPalette,
    SCHEDULE_CSS_SCOPE_HINT,
    SCHEDULE_CSS_SCOPE_REGEX,
} from './scheduleAppearance';

describe('resolveScheduleCardPalette', () => {
    it('keeps the original card tied to the current theme', () => {
        const palette = resolveScheduleCardPalette(undefined, 212, '#f4f1eb');

        expect(palette.preset).toBe('original');
        expect(palette.isOriginal).toBe(true);
        expect(palette.text).toBe('#f4f1eb');
        expect(palette.accent).toBe('hsl(212, 70%, 65%)');
        expect(palette.background).toContain('hsl(212');
    });

    it('uses the complete preset color pairing', () => {
        const palette = resolveScheduleCardPalette({ preset: 'sakura' }, 30, '#ffffff');

        expect(palette.isOriginal).toBe(false);
        expect(palette.background).toContain('#fff3f7');
        expect(palette.text).toBe('#623d50');
        expect(palette.accent).toBe('#c85d8b');
        expect(palette.line).toBe('rgba(98, 61, 80, 0.16)');
    });

    it('keeps all three user-defined colors', () => {
        const palette = resolveScheduleCardPalette({
            preset: 'custom',
            background: '#112233',
            textColor: '#ddeeff',
            accentColor: '#66ccaa',
        });

        expect(palette).toMatchObject({
            preset: 'custom',
            background: '#112233',
            base: '#112233',
            text: '#ddeeff',
            accent: '#66ccaa',
            isOriginal: false,
        });
    });
});

describe('schedule custom CSS scope', () => {
    it('accepts schedule hooks and rejects styles that leak into the app', () => {
        const valid = validateScopedCss(
            '.sully-schedule-root { border-radius: 22px !important; }\n.sully-schedule-item-current { opacity: 1; }',
            SCHEDULE_CSS_SCOPE_REGEX,
            SCHEDULE_CSS_SCOPE_HINT,
        );
        const leaking = validateScopedCss(
            '.sully-chat-root { display: none; }',
            SCHEDULE_CSS_SCOPE_REGEX,
            SCHEDULE_CSS_SCOPE_HINT,
        );

        expect(valid.isValid).toBe(true);
        expect(valid.importantCount).toBe(1);
        expect(leaking.isValid).toBe(false);
    });
});
