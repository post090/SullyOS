import { beforeEach, describe, expect, it } from 'vitest';
import { dateLaunch } from './dateLaunch';

describe('dateLaunch', () => {
    beforeEach(() => {
        dateLaunch.consume();
    });

    it('keeps a launch intent until DateApp consumes it', () => {
        dateLaunch.request({ surface: 'story' });

        expect(dateLaunch.peek()).toEqual({ surface: 'story' });
        expect(dateLaunch.consume()).toEqual({ surface: 'story' });
        expect(dateLaunch.peek()).toBeNull();
    });

    it('replaces a stale intent with the latest request', () => {
        dateLaunch.request({ surface: 'companion' });
        dateLaunch.request({ surface: 'story' });

        expect(dateLaunch.consume()).toEqual({ surface: 'story' });
    });
});
