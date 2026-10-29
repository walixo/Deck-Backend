import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  MatchGiftCard,
  MatchLedger,
  MatchTopup,
  type IMatchGiftCard,
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

/** More days of Match+ (thirty by default), from now or from when the current run ends. */
export function extendedPlus(current: Date | null, now = Date.now(), days = MATCH_PLUS_DAYS): Date {
  const from = current && current.getTime() > now ? current.getTime() : now;
  return new Date(from + days * DAY);
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

/* ---------------------------------------------------------- gift cards --- */

/** What a gift card can hold. Credit cards cost what they hold. */
export const MATCH_GIFT_CARDS = [
  { id: 'credit-1000', kind: 'credit', valueMinor: 1_000_00, plusDays: 0, priceMinor: 1_000_00 },
  { id: 'credit-2000', kind: 'credit', valueMinor: 2_000_00, plusDays: 0, priceMinor: 2_000_00 },
  { id: 'credit-5000', kind: 'credit', valueMinor: 5_000_00, plusDays: 0, priceMinor: 5_000_00 },
  {
    id: 'plus-30',
    kind: 'plus',
    valueMinor: 0,
    plusDays: MATCH_PLUS_DAYS,
    priceMinor: MATCH_PRICES.plus,
  },
] as const;
export type MatchGiftCardProduct = (typeof MATCH_GIFT_CARDS)[number];

/** How long a card can be redeemed after it is paid for or issued. */
export const MATCH_GIFT_CARD_MONTHS = 12;

export const giftCardProduct = (id: string) => MATCH_GIFT_CARDS.find((card) => card.id === id);

/** What a card holds, in words: "₦2,000 of Match credit", "30 days of Match+". */
export const giftCardLabel = (card: Pick<IMatchGiftCard, 'kind' | 'valueMinor' | 'plusDays'>) =>
  card.kind === 'plus'
    ? `${card.plusDays} days of Match+`
    : `${naira(card.valueMinor)} of Match credit`;

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const pick = (length: number) =>
  Array.from(crypto.randomBytes(length), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join(
    '',
  );

/** A redeem code: 12 characters (about 59 bits) with no 0/O, 1/I/L to misread. */
export const giftCardCode = () => `${pick(4)}-${pick(4)}-${pick(4)}`;

/** How people type codes: any case, with or without dashes or spaces. */
export function normaliseGiftCardCode(raw: string): string {
  const bare = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return bare.length === 12 ? `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8)}` : bare;
}

export function giftCardReference(): string {
  return `MATCHGIFT-${pick(6)}`;
}

function expiryFrom(from: Date): Date {
  const expires = new Date(from);
  expires.setMonth(expires.getMonth() + MATCH_GIFT_CARD_MONTHS);
  return expires;
}

/** Makes a paid card redeemable, once: the flip from pending is the guard. */
export async function activateGiftCard(
  card: IMatchGiftCard,
  paid: { paidAt: Date; chargeId?: string },
): Promise<IMatchGiftCard> {
  const flipped = await MatchGiftCard.findOneAndUpdate(
    { _id: card._id, status: 'pending' },
    {
      status: 'active',
      paidAt: paid.paidAt,
      chargeId: paid.chargeId,
      expiresAt: expiryFrom(paid.paidAt),
    },
    { new: true },
  );
  return flipped ?? (await MatchGiftCard.findById(card._id)) ?? card;
}

/** A provider-confirmed payment for a gift card — the same rules as a top-up. */
export async function applyVerifiedGiftCard(
  card: IMatchGiftCard,
  verified: VerifiedPayment,
): Promise<IMatchGiftCard> {
  if (card.status !== 'pending') return card;
  if (verified.status === 'failed') {
    card.status = 'failed';
    await card.save();
    return card;
  }
  if (verified.status !== 'success') return card;
  if (verified.amountMinor < card.priceMinor || verified.currency !== card.currency) {
    throw new ApiError(
      409,
      'The payment amount did not match this gift card. Please contact support.',
    );
  }
  return activateGiftCard(card, {
    paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
    chargeId: verified.chargeId ?? undefined,
  });
}

/**
 * Claims a card for `userId`. One guarded update moves it from active to
 * redeemed, so two people racing the same code cannot both be paid; only then
 * is the credit or Match+ added.
 */
export async function redeemGiftCard(
  rawCode: string,
  userId: mongoose.Types.ObjectId | string,
): Promise<{ card: IMatchGiftCard; creditMinor: number; plusUntil: Date | null }> {
  /* Checked first: a card claimed by someone with nowhere to put it would be lost. */
  if (!(await MatchProfile.exists({ user: userId })))
    throw ApiError.badRequest('Set up Match first');
  const code = normaliseGiftCardCode(rawCode);
  const now = new Date();
  const card = await MatchGiftCard.findOneAndUpdate(
    { code, status: 'active', expiresAt: { $gt: now } },
    { status: 'redeemed', redeemedBy: userId, redeemedAt: now },
    { new: true },
  );
  if (!card) {
    const known = await MatchGiftCard.findOne({ code });
    throw ApiError.badRequest(
      !known || known.status === 'pending' || known.status === 'failed'
        ? 'That code isn’t right. Check it and try again.'
        : known.status === 'redeemed'
          ? 'That gift card has already been used.'
          : known.status === 'void'
            ? 'That gift card has been cancelled.'
            : 'That gift card has expired.',
    );
  }
  const label = giftCardLabel(card);
  if (card.kind === 'credit') {
    const creditMinor = await addCredit(
      userId,
      card.valueMinor,
      'giftcard',
      card.reference,
      `Gift card · ${label}`,
    );
    return { card, creditMinor, plusUntil: null };
  }
  const profile = (await MatchProfile.findOne({ user: userId }))!;
  const until = extendedPlus(profile.plusUntil, Date.now(), card.plusDays);
  const updated = await MatchProfile.findOneAndUpdate(
    { _id: profile._id },
    { plusUntil: until },
    { new: true },
  );
  await record(userId, 'giftcard', 0, updated!.creditMinor, card.reference, `Gift card · ${label}`);
  return { card, creditMinor: updated!.creditMinor, plusUntil: until };
}
