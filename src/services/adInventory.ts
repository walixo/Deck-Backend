import type { Types } from 'mongoose';
import { AD_SLOT_CAPACITY, type AdPlacement } from '../constants';
import { AdCampaign } from '../models/AdCampaign';
import { ApiError } from '../utils/ApiError';

/**
 * How full each ad slot is, and when it next has room.
 *
 * Only *paid* campaigns hold a seat. A booking in review or an approval waiting
 * on payment reserves nothing: holding dates for somebody who may never pay
 * would let an unpaid booking block a paying one, and approvals can sit for
 * days. So the first approved campaign to pay gets the dates, and everyone is
 * checked against what has actually been bought.
 *
 * Checked three times on the way to live, each for a different reason:
 *
 * 1. At booking — so an advertiser learns the dates are gone before anyone
 *    reviews an ad that could not run then.
 * 2. When opening payment — the authoritative check, since the slot can fill
 *    between booking and approval.
 * 3. When the payment is confirmed — the backstop for two advertisers paying
 *    for the last seat in the same minute. By then money has moved, so instead
 *    of overbooking, the later one is moved to the next opening and still gets
 *    every day it paid for.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface Window {
  startAt: Date;
  endAt: Date;
}

/** Paid campaigns in a placement that end after `from`, soonest first. */
async function paidAfter(placement: AdPlacement, from: Date, exclude?: Types.ObjectId) {
  return AdCampaign.find({
    placement,
    status: 'live',
    endAt: { $gt: from },
    ...(exclude ? { _id: { $ne: exclude } } : {}),
  })
    .select('startAt endAt')
    .sort({ startAt: 1 })
    .lean<Window[]>();
}

/**
 * The most campaigns running at any single instant inside `[start, end)`.
 *
 * A sweep over start and end points rather than a count of overlaps: three
 * campaigns that each touch a two-week window but never run at the same time
 * leave room for a fourth, and a plain overlap count would call it full.
 * Ends sort before starts at the same instant, so back-to-back runs — one
 * ending at midnight as the next begins — never count as overlapping.
 */
function peak(campaigns: Window[], start: Date, end: Date): number {
  const events: [number, number][] = [];
  for (const campaign of campaigns) {
    const from = Math.max(campaign.startAt.getTime(), start.getTime());
    const to = Math.min(campaign.endAt.getTime(), end.getTime());
    if (from < to) events.push([from, 1], [to, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let running = 0;
  let most = 0;
  for (const [, change] of events) {
    running += change;
    most = Math.max(most, running);
  }
  return most;
}

/**
 * The earliest start at or after `from` with room for `days` days.
 *
 * The only moments a slot can open are `from` itself and the instant some paid
 * campaign ends, so those are the only candidates worth testing. The last
 * campaign's end always has room, so this always returns.
 */
export async function nextOpening(
  placement: AdPlacement,
  days: number,
  from: Date,
  exclude?: Types.ObjectId,
): Promise<Date> {
  const campaigns = await paidAfter(placement, from, exclude);
  const candidates = [from, ...campaigns.map((campaign) => campaign.endAt)]
    .filter((candidate) => candidate.getTime() >= from.getTime())
    .sort((a, b) => a.getTime() - b.getTime());

  for (const candidate of candidates) {
    const end = new Date(candidate.getTime() + days * DAY_MS);
    if (peak(campaigns, candidate, end) < AD_SLOT_CAPACITY) return candidate;
  }
  return candidates[candidates.length - 1];
}

/** "3 Oct 2026" — the day in UTC, which is the day the board runs on. */
function day(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Refuses a run of dates the slot cannot take, naming the next one it can.
 *
 * A bare "unavailable" would send the advertiser guessing dates one at a time;
 * the answer to "when, then?" is cheap to compute, so it is part of the error.
 */
export async function assertSlotOpen(
  placement: AdPlacement,
  startAt: Date,
  days: number,
  exclude?: Types.ObjectId,
): Promise<void> {
  const opening = await nextOpening(placement, days, startAt, exclude);
  if (opening.getTime() === startAt.getTime()) return;

  throw ApiError.conflict(
    `That slot is already booked for some of those dates. The next ${days}-day opening starts ${day(opening)} (UTC).`,
  );
}
