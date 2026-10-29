import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  MatchLedger,
  MatchTopup,
  type IMatchTopup,
  type MatchGiftKind,
  type MatchLedgerKind,
} from '../models/MatchMoney';
import { MatchProfile, type IMatchProfile } from '../models/MatchProfile';
import { ApiError } from '../utils/ApiError';
import type { VerifiedPayment } from './bachs';

/**
 * Match credit: what things cost, and the only code that moves a balance.
 *
 * Prices are kobo. They live here, in one place, so the screen, the server
 * and the staff numbers can never disagree about what a rose costs.
 */

export const MATCH_CURRENCY = 'NGN';

export const MATCH_PRICES = {
  /** Each extra minute after the free one, per person; free with Match+. */
  minute: 100_00,
  gift: { rose: 200_00, drink: 500_00 } satisfies Record<MatchGiftKind, number>,
  badge: 500_00,
  plus: 1_500_00,
} as const;

export const MATCH_PLUS_DAYS = 30;

/** The top-up amounts offered. Fixed packs keep checkout to one tap. */
export const MATCH_TOPUP_PACKS = [500_00, 1_000_00, 2_000_00, 5_000_00] as const;

const DAY = 24 * 60 * 60 * 1000;

export const isPlus = (profile: Pick<IMatchProfile, 'plusUntil'>, now = Date.now()) =>
  Boolean(profile.plusUntil && profile.plusUntil.getTime() > now);

export const naira = (minor: number) => `₦${(minor / 100).toLocaleString('en-NG')}`;

/** A top-up reference, in the same shape as Deck's other payment references. */
export function topupReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const body = Array.from(crypto.randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join(
    '',
  );
  return `MATCH-${body}`;
}

/** The error an empty wallet raises; the screen offers a top-up on this code. */
export class NotEnoughCredit extends ApiError {
  constructor(
    public readonly neededMinor: number,
    public readonly balanceMinor: number,
    /** Whose wallet was short — in a two-person charge, it may not be the caller's. */
    public readonly userId = '',
  ) {
    super(402, `Not enough Match credit — this costs ${naira(neededMinor)}. Top up to continue.`, {
      code: 'MATCH_CREDIT',
      neededMinor,
      balanceMinor,
    });
  }
}

async function record(
  userId: mongoose.Types.ObjectId | string,
  kind: MatchLedgerKind,
  amountMinor: number,
  balanceAfterMinor: number,
  ref: string,
  note: string,
) {
  await MatchLedger.create({ user: userId, kind, amountMinor, balanceAfterMinor, ref, note });
}

/**
 * Spends credit. Atomic: the balance is only taken if it covers the price,
 * so two taps at once can never spend the same naira twice.
 */
export async function spend(
  userId: mongoose.Types.ObjectId | string,
  amountMinor: number,
  kind: MatchLedgerKind,
  ref: string,
  note: string,
): Promise<number> {
  if (amountMinor <= 0) return (await MatchProfile.findOne({ user: userId }))?.creditMinor ?? 0;
  const updated = await MatchProfile.findOneAndUpdate(
    { user: userId, creditMinor: { $gte: amountMinor } },
    { $inc: { creditMinor: -amountMinor } },
    { new: true },
  );
  if (!updated) {
    const balance = (await MatchProfile.findOne({ user: userId }))?.creditMinor ?? 0;
    throw new NotEnoughCredit(amountMinor, balance, String(userId));
  }
  await record(userId, kind, -amountMinor, updated.creditMinor, ref, note);
  return updated.creditMinor;
}

/** Adds credit: a paid top-up, or money handed back. */
export async function addCredit(
  userId: mongoose.Types.ObjectId | string,
  amountMinor: number,
  kind: MatchLedgerKind,
  ref: string,
  note: string,
): Promise<number> {
  const updated = await MatchProfile.findOneAndUpdate(
    { user: userId },
    { $inc: { creditMinor: amountMinor } },
    { new: true },
  );
  if (!updated) throw ApiError.badRequest('Set up Match first');
  await record(userId, kind, amountMinor, updated.creditMinor, ref, note);
  return updated.creditMinor;
}

/**
 * Charges both people in a call for the same thing, or neither. If the second
 * charge fails the first is handed straight back.
 */
export async function spendBoth(
  charges: { userId: string; amountMinor: number }[],
  kind: MatchLedgerKind,
  ref: string,
  note: string,
): Promise<void> {
  const done: { userId: string; amountMinor: number }[] = [];
  try {
    for (const charge of charges) {
      await spend(charge.userId, charge.amountMinor, kind, ref, note);
      done.push(charge);
    }
  } catch (error) {
    for (const charge of done) {
      if (charge.amountMinor > 0) {
        await addCredit(charge.userId, charge.amountMinor, 'refund', ref, `${note} — not added`);
      }
    }
    throw error;
  }
}

/** Thirty more days of Match+, from now or from when the current run ends. */
export function extendedPlus(current: Date | null, now = Date.now()): Date {
  const from = current && current.getTime() > now ? current.getTime() : now;
  return new Date(from + MATCH_PLUS_DAYS * DAY);
}

/**
 * Applies a provider-confirmed payment to a top-up, crediting it once.
 *
 * The status flip from pending to paid is the guard: the webhook and the
 * return page often both arrive, and only the first to flip it credits.
 * A payment short of the pack, or in another currency, is refused — the same
 * rule as every other Deck payment.
 */
export async function applyVerifiedTopup(
  topup: IMatchTopup,
  verified: VerifiedPayment,
): Promise<IMatchTopup> {
  if (topup.status !== 'pending') return topup;
  if (verified.status === 'failed') {
    topup.status = 'failed';
    await topup.save();
    return topup;
  }
  if (verified.status !== 'success') return topup;
  if (verified.amountMinor < topup.amountMinor || verified.currency !== topup.currency) {
    throw new ApiError(
      409,
      'The payment amount did not match this top-up. Please contact support.',
    );
  }
  return creditTopup(topup, {
    paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
    chargeId: verified.chargeId ?? undefined,
  });
}

export async function creditTopup(
  topup: IMatchTopup,
  paid: { paidAt: Date; chargeId?: string },
): Promise<IMatchTopup> {
  const flipped = await MatchTopup.findOneAndUpdate(
    { _id: topup._id, status: 'pending' },
    { status: 'paid', paidAt: paid.paidAt, chargeId: paid.chargeId },
    { new: true },
  );
  if (!flipped) return (await MatchTopup.findById(topup._id)) ?? topup;
  await addCredit(
    flipped.user,
    flipped.amountMinor,
    'topup',
    flipped.reference,
    `Topped up ${naira(flipped.amountMinor)}`,
  );
  return flipped;
}
