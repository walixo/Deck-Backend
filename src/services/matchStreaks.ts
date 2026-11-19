import webpush from 'web-push';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { MatchCall } from '../models/MatchCall';
import { MatchProfile, MatchPush, type IMatchProfile } from '../models/MatchProfile';
import { hoursAt, matchDay } from './matchHours';
import { isOnline, onCallStarted, onClosing } from './matchHub';
import { pushPublicKey } from './vapid';

/**
 * Streaks and the nightly recap: reasons to come back tomorrow evening.
 *
 * A streak is evenings in a row with at least one call that connected — not
 * just opening the app — counted by the evening's Lagos date, so a Match+ call
 * in the late window still belongs to the evening it started in.
 *
 * The recap is that evening in numbers: how many people you talked to, for
 * how long, how many swapped usernames, how many want to talk again. It is
 * shown in the app, and pushed at closing time to anyone who talked that
 * evening, has pings on and has already left.
 */

const DAY = 24 * 60 * 60 * 1000;

/** When the evening that `now` belongs to opened: tonight's, or the last one. */
export function eveningStart(now = Date.now()): number {
  const hours = hoursAt(now);
  return hours.open || hours.opensAt <= now ? hours.opensAt : hours.opensAt - DAY;
}

/** The Lagos date of the evening `now` belongs to. */
export const eveningOf = (now = Date.now()) => matchDay(eveningStart(now));

/** The date before a `YYYY-MM-DD` date. */
export const dayBefore = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);

/** A streak as people see it: alive only if the last evening was tonight or the one before. */
export function streakView(profile: Pick<IMatchProfile, 'streak'>, now = Date.now()) {
  const streak = profile.streak ?? { count: 0, best: 0, lastDay: '' };
  const tonight = eveningOf(now);
  const talkedTonight = streak.lastDay === tonight;
  const alive = talkedTonight || streak.lastDay === dayBefore(tonight);
  return {
    count: alive ? streak.count : 0,
    best: streak.best ?? 0,
    /** Already counted this evening. */
    tonight: talkedTonight,
    /** Alive, but needs a call this evening to carry on. */
    atRisk: alive && !talkedTonight,
  };
}

/** Counts this evening towards someone's streak, once. */
export async function recordStreak(
  userId: mongoose.Types.ObjectId | string,
  now = Date.now(),
): Promise<void> {
  const day = eveningOf(now);
  for (let attempt = 0; attempt < 3; attempt++) {
    const profile = await MatchProfile.findOne({ user: userId }).select('streak');
    if (!profile) return;
    const last = profile.streak?.lastDay ?? '';
    if (last === day) return;
    const count = last === dayBefore(day) ? (profile.streak?.count ?? 0) + 1 : 1;
    const best = Math.max(profile.streak?.best ?? 0, count);
    /* Only if nobody else moved it meanwhile. */
    const moved = await MatchProfile.updateOne(
      { _id: profile._id, 'streak.lastDay': last },
      { $set: { streak: { count, best, lastDay: day } } },
    );
    if (moved.modifiedCount === 1) return;
  }
}

export interface Recap {
  day: string;
  /** Different calls that connected this evening. */
  calls: number;
  /** Whole minutes talked, rounded up. */
  minutes: number;
  /** Calls where both swapped usernames. */
  swapped: number;
  /** Calls where both said they'd talk again. */
  again: number;
  streak: ReturnType<typeof streakView>;
}

/** One person's evening in numbers — tonight's, or the last evening's if closed. */
export async function recapFor(profile: IMatchProfile, now = Date.now()): Promise<Recap> {
  const from = new Date(eveningStart(now));
  const to = new Date(from.getTime() + DAY);
  const me = profile.user;
  const calls = await MatchCall.find({
    startedAt: { $gte: from, $lt: to },
    $or: [{ male: me }, { female: me }],
  })
    .select('startedAt endedAt revealedAt againBy')
    .lean();
  let talkedMs = 0;
  for (const call of calls) {
    if (call.startedAt && call.endedAt) {
      talkedMs += Math.max(0, call.endedAt.getTime() - call.startedAt.getTime());
    }
  }
  return {
    day: matchDay(from.getTime()),
    calls: calls.length,
    minutes: Math.ceil(talkedMs / 60_000),
    swapped: calls.filter((call) => call.revealedAt).length,
    again: calls.filter((call) => (call.againBy ?? []).length >= 2).length,
    streak: streakView(profile, now),
  };
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The recap in one line, for a notification. */
export function recapLine(recap: Recap): string {
  const parts = [`You talked to ${plural(recap.calls, 'person', 'people')}`];
  if (recap.swapped > 0) parts.push(`${recap.swapped} swapped usernames`);
  if (recap.again > 0) parts.push(`${recap.again} want to talk again`);
  if (recap.streak.count > 1) parts.push(`${recap.streak.count}-night streak 🔥`);
  return parts.join(' · ');
}

/**
 * At closing: a recap to everyone who talked this evening, has pings on, and
 * isn't on Match right now (anyone still there sees it in the app).
 */
export async function sendRecaps(now = Date.now()): Promise<void> {
  if (!pushPublicKey()) return;
  /* Just after closing, hoursAt points at tomorrow; step back into tonight. */
  const from = new Date(eveningStart(now - 60_000));
  const to = new Date(from.getTime() + DAY);
  const [men, women, subscribers] = await Promise.all([
    MatchCall.distinct('male', { startedAt: { $gte: from, $lt: to } }),
    MatchCall.distinct('female', { startedAt: { $gte: from, $lt: to } }),
    MatchPush.distinct('user'),
  ]);
  const talked = new Set([...men, ...women].map(String));
  const due = subscribers.filter((id) => talked.has(String(id)) && !isOnline(String(id)));
  const profiles = await MatchProfile.find({ user: { $in: due } }).limit(2000);
  const hour = env.matchHours.open % 12 || 12;
  const opens = `${hour}${env.matchHours.open < 12 ? 'am' : 'pm'}`;

  for (const profile of profiles) {
    const recap = await recapFor(profile, now - 60_000);
    if (recap.calls === 0) continue;
    const payload = JSON.stringify({
      title: 'Tonight on Match',
      body: `${recapLine(recap)}. See you tomorrow at ${opens}.`,
      url: '/',
    });
    for (const device of await MatchPush.find({ user: profile.user })) {
      try {
        await webpush.sendNotification({ endpoint: device.endpoint, keys: device.keys }, payload, {
          TTL: 6 * 60 * 60,
        });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await MatchPush.deleteOne({ _id: device._id });
      }
    }
  }
}

/** Starts counting streaks and sending recaps. Called once at start-up. */
export function startStreaks(): void {
  onCallStarted((call) => {
    for (const userId of [call.male, call.female]) {
      void recordStreak(userId, call.startedAt).catch(() => undefined);
    }
  });
  onClosing(() => {
    void sendRecaps().catch((error: Error) => {
      // eslint-disable-next-line no-console
      console.error(`[match] nightly recaps failed: ${error.message}`);
    });
  });
}
