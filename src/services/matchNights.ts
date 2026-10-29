import { MatchNight, type IMatchNight } from '../models/MatchMoney';
import { hoursAt, matchDay } from './matchHours';

/**
 * Tonight's sponsor and theme, held in memory.
 *
 * Every screen asks "what is on tonight?" — the countdown, the lobby, the
 * line — far too often to read the database each time, and nights change only
 * when staff edit one. So the next few days are cached, and refreshed every
 * minute and whenever staff save.
 */

export interface NightView {
  day: string;
  sponsor: { name: string; line: string; url: string } | null;
  theme: { title: string; blurb: string; entryMinor: number } | null;
}

const toView = (night: IMatchNight): NightView => ({
  day: night.day,
  sponsor: night.sponsor
    ? { name: night.sponsor.name, line: night.sponsor.line, url: night.sponsor.url }
    : null,
  theme: night.theme
    ? { title: night.theme.title, blurb: night.theme.blurb, entryMinor: night.theme.entryMinor }
    : null,
});

let byDay = new Map<string, NightView>();

export async function refreshNights(): Promise<void> {
  const today = matchDay();
  const nights = await MatchNight.find({ day: { $gte: today } })
    .sort({ day: 1 })
    .limit(14)
    .lean<IMatchNight[]>();
  byDay = new Map(nights.map((night) => [night.day, toView(night)]));
}

/** The evening that is on now, or the next one if Match is closed. */
export function tonight(now = Date.now()): NightView | null {
  return byDay.get(matchDay(hoursAt(now).opensAt)) ?? null;
}

export function startNights(): void {
  void refreshNights().catch(() => undefined);
  setInterval(() => void refreshNights().catch(() => undefined), 60_000).unref();
}
