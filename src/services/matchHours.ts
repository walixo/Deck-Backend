import { env } from '../config/env';

/**
 * When Match is open: evenings, Lagos time (8pm to 10pm at GMT+1 by default).
 *
 * Concentrating everyone into one short window is what makes a live matching
 * app work while it is small: two hours with people in them beat a day of
 * empty lines. All times returned are epoch milliseconds.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface MatchHours {
  open: boolean;
  /** While open, when this evening opened; while closed, when it next opens. */
  opensAt: number;
  closesAt: number;
}

export function hoursAt(now = Date.now()): MatchHours {
  if (env.matchAlwaysOpen) return { open: true, opensAt: now - HOUR, closesAt: now + DAY };
  const offset = env.matchUtcOffset * HOUR;
  const local = now + offset;
  const midnight = Math.floor(local / DAY) * DAY;
  const opens = midnight + env.matchHours.open * HOUR - offset;
  const closes = midnight + env.matchHours.close * HOUR - offset;
  if (now < opens) return { open: false, opensAt: opens, closesAt: closes };
  if (now < closes) return { open: true, opensAt: opens, closesAt: closes };
  return { open: false, opensAt: opens + DAY, closesAt: closes + DAY };
}

export interface MatchLate {
  /** Inside the Match+ hour after closing. */
  open: boolean;
  /** When the current, or next, late window ends. */
  closesAt: number;
}

/**
 * The Match+ late window: from closing time for `matchLateHours` (10pm to
 * midnight by default). Only members may join the line in it.
 */
export function lateAt(now = Date.now()): MatchLate {
  const span = env.matchLateHours * HOUR;
  if (env.matchAlwaysOpen || span === 0) return { open: false, closesAt: now };
  const offset = env.matchUtcOffset * HOUR;
  const midnight = Math.floor((now + offset) / DAY) * DAY;
  /* Today's window, and yesterday's in case it runs past midnight. */
  for (const day of [midnight, midnight - DAY]) {
    const starts = day + env.matchHours.close * HOUR - offset;
    if (now >= starts && now < starts + span) return { open: true, closesAt: starts + span };
  }
  const ends = midnight + env.matchHours.close * HOUR - offset + span;
  return { open: false, closesAt: ends > now ? ends : ends + DAY };
}

/** The Lagos calendar date, `YYYY-MM-DD`, for the daily numbers. */
export function matchDay(now = Date.now()): string {
  return new Date(now + env.matchUtcOffset * HOUR).toISOString().slice(0, 10);
}
