const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Format a calendar date in the user's current system timezone. */
export function getLocalDateKey(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Parse YYYY-MM-DD as local calendar midnight, never as UTC midnight. */
export function parseLocalDateKey(key: string): Date | null {
    const match = DATE_KEY_RE.exec(key);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (
        parsed.getFullYear() !== year
        || parsed.getMonth() !== month - 1
        || parsed.getDate() !== day
    ) return null;
    return parsed;
}

/** Calendar-day arithmetic in the user's current system timezone. */
export function addLocalDays(key: string, amount: number): string {
    const parsed = parseLocalDateKey(key);
    if (!parsed) return '';
    parsed.setDate(parsed.getDate() + amount);
    return getLocalDateKey(parsed);
}

/** Calendar-day difference (to - from), independent of DST day length. */
export function getCalendarDayDifference(fromKey: string, toKey: string): number | null {
    const fromMatch = DATE_KEY_RE.exec(fromKey);
    const toMatch = DATE_KEY_RE.exec(toKey);
    if (!fromMatch || !toMatch || !parseLocalDateKey(fromKey) || !parseLocalDateKey(toKey)) return null;
    const utcDay = (match: RegExpExecArray) => Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
    );
    return Math.round((utcDay(toMatch) - utcDay(fromMatch)) / 86_400_000);
}

/** Local [start, end) bounds. The duration may be 23/25 hours across DST. */
export function getLocalDayRange(key: string): { start: number; end: number } | null {
    const startDate = parseLocalDateKey(key);
    if (!startDate) return null;
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    return { start: startDate.getTime(), end: endDate.getTime() };
}

/** Milliseconds until the next local midnight, with a small post-boundary buffer. */
export function msUntilNextLocalDay(now: Date = new Date()): number {
    const next = new Date(now);
    next.setHours(24, 0, 0, 50);
    return Math.max(50, next.getTime() - now.getTime());
}
