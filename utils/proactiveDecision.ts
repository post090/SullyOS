import { isInTimeWindow } from './timeWindow';
import { MISS_THRESHOLD } from './proactiveChat';

export interface ProactiveSleepDecisionInput {
  now: Date;
  sleepStart?: string;
  sleepEnd?: string;
  missCount: number;
}

/**
 * Sleep is a gate for ordinary proactive catch-up. The miss threshold remains
 * the explicit escape hatch, including the boundary where it is reached as
 * the sleep window starts.
 */
export function shouldSkipProactiveForSleep(input: ProactiveSleepDecisionInput): boolean {
  return isInTimeWindow(input.now, input.sleepStart, input.sleepEnd)
    && input.missCount < MISS_THRESHOLD;
}
