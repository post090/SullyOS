import { useEffect, useState } from 'react';
import { getLocalDateKey, msUntilNextLocalDay } from '../utils/localDate';

/**
 * Reactive local calendar date. Rechecks at midnight and when a suspended app
 * returns to the foreground; the periodic check also catches live timezone changes.
 */
export function useLocalDateKey(): string {
    const [dateKey, setDateKey] = useState(() => getLocalDateKey());

    useEffect(() => {
        let midnightTimer: ReturnType<typeof setTimeout> | null = null;

        const refresh = () => {
            setDateKey(previous => {
                const next = getLocalDateKey();
                return previous === next ? previous : next;
            });
            scheduleMidnight();
        };

        const scheduleMidnight = () => {
            if (midnightTimer) clearTimeout(midnightTimer);
            midnightTimer = setTimeout(refresh, msUntilNextLocalDay());
        };

        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') refresh();
        };

        scheduleMidnight();
        const timezonePoll = window.setInterval(refresh, 60_000);
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            if (midnightTimer) clearTimeout(midnightTimer);
            window.clearInterval(timezonePoll);
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, []);

    return dateKey;
}
