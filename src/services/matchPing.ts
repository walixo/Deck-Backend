import webpush from 'web-push';
import { MatchProfile, MatchPush, type MatchGender } from '../models/MatchProfile';
import { hoursAt } from './matchHours';
import { isOnline, onArrival } from './matchHub';
import { pushPublicKey } from './vapid';

export { pushPublicKey };

/**
 * "Ping me when someone's free": a browser push notification, sent when
 * someone on the other side arrives on Match during opening hours.
 *
 * At most once an evening per person (every half hour for Match+), never to
 * someone already on Match, and only to people who turned it on (which needs
 * their browser's permission).
 * Uses the Web Push standard with Deck's own VAPID keys — no third party
 * account — and does nothing if the keys are not configured.
 */

/* One sweep per side at a time, and not more than once a minute. */
const lastSweep: Record<MatchGender, number> = { male: 0, female: 0 };
const SWEEP_MS = 60_000;
const PLUS_PING_GAP_MS = 30 * 60_000;

/** Exported for tests; arrivals call it through `startMatchPings`. */
export async function pingFor(arrived: MatchGender): Promise<void> {
  const now = Date.now();
  if (now - lastSweep[arrived] < SWEEP_MS) return;
  lastSweep[arrived] = now;

  const wanted: MatchGender = arrived === 'male' ? 'female' : 'male';
  const tonight = new Date(hoursAt(now).opensAt);
  const subscribers = await MatchPush.distinct('user');
  const due = await MatchProfile.find({
    user: { $in: subscribers },
    gender: wanted,
    $and: [
      { $or: [{ bannedUntil: null }, { bannedUntil: { $lt: new Date() } }] },
      {
        $or: [
          { pingedAt: null },
          { pingedAt: { $lt: tonight } },
          /* Match+: no once-a-night limit, but never more than every half hour. */
          { plusUntil: { $gt: new Date() }, pingedAt: { $lt: new Date(now - PLUS_PING_GAP_MS) } },
        ],
      },
    ],
  })
    .select('user')
    .limit(200);

  const payload = JSON.stringify({
    title: 'Someone’s on Match',
    body: `${arrived === 'male' ? 'A man' : 'A woman'} is on Match right now — tap to talk.`,
    url: '/',
  });

  for (const profile of due) {
    const userId = String(profile.user);
    if (isOnline(userId)) continue;
    const devices = await MatchPush.find({ user: profile.user });
    let delivered = false;
    for (const device of devices) {
      try {
        await webpush.sendNotification({ endpoint: device.endpoint, keys: device.keys }, payload, {
          TTL: 15 * 60,
        });
        delivered = true;
      } catch (error) {
        /* The browser unsubscribed or the subscription expired: forget it. */
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await MatchPush.deleteOne({ _id: device._id });
      }
    }
    if (delivered) await MatchProfile.updateOne({ _id: profile._id }, { pingedAt: new Date() });
  }
}

/** Starts listening for arrivals. Called once when the server starts. */
export function startMatchPings(): void {
  if (!pushPublicKey()) return;
  onArrival((gender) => {
    void pingFor(gender).catch(() => undefined);
  });
}
