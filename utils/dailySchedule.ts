import { DailySchedule } from '../types';
import { DB } from './db';
import { getLocalDateKey } from './localDate';

/**
 * Load the schedule for the user's local calendar day.
 *
 * Older builds keyed schedules by UTC date. If today's local key is absent, a
 * legacy-keyed record is reused only when its generatedAt belongs to today in
 * the current system timezone. Historical records are deliberately untouched.
 */
export async function getLocalDailySchedule(
    charId: string,
    at: Date = new Date(),
): Promise<DailySchedule | null> {
    const localKey = getLocalDateKey(at);
    const current = await DB.getDailySchedule(charId, localKey);
    if (current) return current;

    const legacyUtcKey = at.toISOString().slice(0, 10);
    if (legacyUtcKey === localKey) return null;

    const legacy = await DB.getDailySchedule(charId, legacyUtcKey);
    if (!legacy || !Number.isFinite(legacy.generatedAt)) return null;
    if (getLocalDateKey(new Date(legacy.generatedAt)) !== localKey) return null;

    const migrated: DailySchedule = {
        ...legacy,
        id: `${charId}_${localKey}`,
        charId,
        date: localKey,
    };
    await DB.saveDailySchedule(migrated);
    return migrated;
}
