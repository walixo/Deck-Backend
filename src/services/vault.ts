import mongoose from 'mongoose';
import { env } from '../config/env';
import { CardRedemption, GiftCard, type IGiftCard } from '../models/GiftCard';
import {
  VaultIssuer,
  VaultProduct,
  type IVaultIssuer,
  type IVaultProduct,
} from '../models/VaultIssuer';
import {
  VaultLedgerEntry,
  VaultTopup,
  type IVaultPartner,
  type IVaultTopup,
  type VaultMode,
} from '../models/VaultPartner';
import { VaultOrder, type IVaultOrder } from '../models/VaultOrder';
import { ApiError } from '../utils/ApiError';
import type { VerifiedPayment } from './bachs';
import { applyVaultFee } from './money';
import { mintCardAtMerchant } from './vaultFulfil';
import {
  decryptSecret,
  hashSecret,
  mintCardCode,
  mintCardPin,
  normaliseCode,
  orderReference,
  redemptionReference,
  sealSecret,
} from './vaultKeys';

/**
 * What Vault actually does: price an order, move a partner's balance, mint
 * cards and redeem them.
 *
 * ## Why there are no transactions in here
 *
 * Deck runs a standalone mongod, where multi-document transactions are not
 * available at all. Nothing in this file pretends otherwise. Correctness comes
 * from two things instead:
 *
 *   * **Unique indexes as the idempotency mechanism.** A ledger movement is
 *     unique on `(partner, reference)` and an order is unique on
 *     `(partner, idempotencyKey)`. A retried request loses the race to the
 *     index rather than debiting a wallet twice.
 *
 *   * **Conditional single-document updates.** Redemption decrements a balance
 *     with the precondition in the filter, so two tills hitting the same card
 *     at once cannot overdraw it — one of them simply matches nothing.
 *
 * Operations are ordered so that a crash leaves a state that can be resumed
 * rather than one that has to be guessed at: the order row exists before the
 * money moves, and the money moves before any card is minted. A process that
 * dies mid-way leaves an order marked `paid` with no cards, which
 * `fulfilOrder` picks up and finishes on the next attempt.
 */

export interface OrderPricing {
  faceTotalMinor: number;
  discountMinor: number;
  chargedMinor: number;
  platformFeeMinor: number;
  issuerNetMinor: number;
}

/** The discount a product actually offers: its own, or its issuer's. */
export function discountFor(issuer: IVaultIssuer, product: IVaultProduct): number {
  return product.discountPercent ?? issuer.discountPercent;
}

/** How long a product's cards last: its own setting, or its issuer's default. */
export function expiryDaysFor(issuer: IVaultIssuer, product: IVaultProduct): number {
  return product.expiryDays ?? issuer.defaultExpiryDays;
}

/**
 * Prices an order at a given discount.
 *
 * Takes the percentage rather than the issuer and product, because the two
 * callers want different answers from the same pair: a distributor buys at the
 * wholesale rate, and a walk-up buyer on the storefront pays face value. An
 * explicit number makes that difference visible at each call site instead of
 * hiding it behind a doctored copy of the issuer.
 *
 * The discount is rounded and the charge is the remainder, so the two always
 * add back to face value exactly — the same discipline `services/money.ts`
 * applies to fees, for the same reason.
 */
export function priceOrder(
  discountPercent: number,
  quantity: number,
  unitFaceMinor: number,
): OrderPricing {
  const faceTotalMinor = unitFaceMinor * quantity;
  const discountMinor = Math.round((faceTotalMinor * discountPercent) / 100);
  const chargedMinor = faceTotalMinor - discountMinor;
  const { feeMinor, netMinor } = applyVaultFee(chargedMinor);

  return {
    faceTotalMinor,
    discountMinor,
    chargedMinor,
    platformFeeMinor: feeMinor,
    issuerNetMinor: netMinor,
  };
}

/**
 * Checks a chosen amount against what the product allows.
 *
 * A range product is checked against its ends; a fixed one against its list.
 * Being strict here is what stops a partner ordering a ₦1 card against a
 * product whose smallest denomination is ₦1,000 and reselling the difference.
 */
export function assertDenomination(product: IVaultProduct, unitFaceMinor: number): void {
  if (!Number.isInteger(unitFaceMinor) || unitFaceMinor < 1) {
    throw ApiError.badRequest('The amount must be a whole number of minor units');
  }
  if (product.denominationType === 'fixed') {
    if (!product.denominationsMinor.includes(unitFaceMinor)) {
      throw ApiError.badRequest(
        `That amount is not offered. Choose one of: ${product.denominationsMinor.join(', ')}`,
      );
    }
    return;
  }
  if (unitFaceMinor < product.minMinor || unitFaceMinor > product.maxMinor) {
    throw ApiError.badRequest(
      `That amount is outside the range ${product.minMinor}–${product.maxMinor}`,
    );
  }
}

/* ------------------------------------------------------------------ wallet */

/**
 * A partner's balance: the sum of their ledger rows for that mode.
 *
 * Computed, never stored — see `models/VaultPartner.ts` and `ledger.ts` for
 * why a running total on a balance nobody external reconciles is a liability.
 */
export async function partnerBalanceMinor(
  partnerId: mongoose.Types.ObjectId,
  mode: VaultMode,
): Promise<number> {
  const [row] = await VaultLedgerEntry.aggregate<{ total: number }>([
    { $match: { partner: partnerId, mode } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]);
  return row?.total ?? 0;
}

/**
 * Writes one movement.
 *
 * A duplicate reference is not an error worth raising: it means this exact
 * movement has already been applied, which is precisely what the index is
 * there to guarantee. Returning quietly makes every caller safe to retry.
 */
export async function recordMovement(input: {
  partner: mongoose.Types.ObjectId;
  mode: VaultMode;
  kind: 'topup' | 'order' | 'refund' | 'adjustment';
  amountMinor: number;
  reference: string;
  order?: mongoose.Types.ObjectId | null;
  note?: string;
  currency?: string;
}): Promise<void> {
  try {
    await VaultLedgerEntry.create({
      partner: input.partner,
      mode: input.mode,
      kind: input.kind,
      amountMinor: input.amountMinor,
      reference: input.reference,
      order: input.order ?? null,
      note: input.note ?? '',
      currency: input.currency ?? env.currency,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return;
    throw error;
  }
}

/** The sandbox money a partner starts with, granted once when a test key exists. */
export async function grantTestBalance(partner: IVaultPartner): Promise<void> {
  await recordMovement({
    partner: partner._id,
    mode: 'test',
    kind: 'topup',
    amountMinor: env.vault.testGrantMinor,
    reference: `GRANT-${partner._id.toString()}`,
    note: 'Sandbox balance',
  });
}

/* ------------------------------------------------------------------- cards */

/**
 * Mints the cards an order bought.
 *
 * Idempotent by counting what already exists: a resumed order mints only the
 * remainder. That is what makes the crash-between-debit-and-mint case
 * recoverable without anyone reconciling by hand.
 *
 * In `merchant` fulfilment each code comes from the issuer's own endpoint, one
 * call per card, so the card is native to their system from the start. A
 * failure there aborts the rest: a half-filled order that reports success is
 * worse than one that fails and refunds.
 */
export async function mintCardsFor(
  order: IVaultOrder,
  issuer: IVaultIssuer,
  product: IVaultProduct,
): Promise<IGiftCard[]> {
  const existing = await GiftCard.find({ order: order._id });
  if (existing.length >= order.quantity) return existing;

  const expiryDays = expiryDaysFor(issuer, product);
  const expiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000) : null;
  const minted: IGiftCard[] = [...existing];

  for (let index = existing.length; index < order.quantity; index += 1) {
    let code: string;
    let pin: string | null;
    let externalId: string | null = null;

    if (issuer.fulfilment === 'merchant') {
      const result = await mintCardAtMerchant(issuer, {
        orderReference: order.reference,
        /* Per card, not per order: the merchant's own idempotency needs to
           distinguish the 40th card of an order from the 41st. */
        idempotencyKey: `${order.reference}-${index + 1}`,
        productSlug: product.slug,
        amountMinor: order.unitFaceMinor,
        currency: order.currency,
        mode: order.mode,
        expiresAt,
      });
      code = result.code;
      pin = result.pin ?? null;
      externalId = result.externalId ?? null;
    } else {
      code = mintCardCode();
      pin = mintCardPin();
    }

    minted.push(
      await GiftCard.create({
        issuer: issuer._id,
        product: product._id,
        order: order._id,
        mode: order.mode,
        code: sealSecret(code),
        pin: pin ? sealSecret(pin) : null,
        faceValueMinor: order.unitFaceMinor,
        balanceMinor: order.unitFaceMinor,
        currency: order.currency,
        origin: issuer.fulfilment,
        externalId,
        expiresAt,
        recipientName: order.recipientName,
        recipientEmail: order.recipientEmail,
        giftMessage: order.giftMessage,
      }),
    );
  }

  return minted;
}

/**
 * Finishes a paid order: mints its cards and marks it fulfilled.
 *
 * Safe to call again on an order that is already fulfilled, and safe to call
 * on one that died half-way — which is the whole point of it being separate
 * from the code that took the money.
 */
export async function fulfilOrder(order: IVaultOrder): Promise<IGiftCard[]> {
  const issuer = await VaultIssuer.findById(order.issuer).select('+fulfilSecret');
  const product = await VaultProduct.findById(order.product);
  if (!issuer || !product) throw ApiError.notFound('That order points at a card that no longer exists');

  try {
    const cards = await mintCardsFor(order, issuer, product);
    if (order.status !== 'fulfilled') {
      order.status = 'fulfilled';
      order.fulfilledAt = new Date();
      order.failureReason = '';
      await order.save();
    }
    return cards;
  } catch (error) {
    order.status = 'failed';
    order.failureReason = error instanceof Error ? error.message.slice(0, 400) : 'Minting failed';
    await order.save();

    /* The buyer never got the cards, so the money goes back. Referenced off
       the order so a second failure cannot refund twice. */
    if (order.partner) {
      await recordMovement({
        partner: order.partner,
        mode: order.mode,
        kind: 'refund',
        amountMinor: order.chargedMinor,
        reference: `${order.reference}-REFUND`,
        order: order._id,
        note: 'Order could not be fulfilled',
      });
    }
    throw error;
  }
}

/* ------------------------------------------------------------- revealing */

/**
 * The plaintext code and PIN, decrypted.
 *
 * Every caller of this is handing a bearer instrument to someone, so each one
 * is responsible for having checked that they are entitled to it first. The
 * `+code.cipher` projection is required — the ciphertext is `select: false`
 * precisely so that reaching for it has to be deliberate.
 */
export async function revealCard(cardId: mongoose.Types.ObjectId): Promise<{
  code: string;
  pin: string | null;
}> {
  const card = await GiftCard.findById(cardId).select('+code.cipher +pin.cipher');
  if (!card) throw ApiError.notFound('That card does not exist');

  return {
    code: decryptSecret(card.code.cipher),
    pin: card.pin ? decryptSecret(card.pin.cipher) : null,
  };
}

/* ------------------------------------------------------------- redemption */

export interface RedeemResult {
  card: IGiftCard;
  redeemedMinor: number;
  balanceMinor: number;
  reference: string;
}

/**
 * Spends part or all of a card.
 *
 * The decrement is a single conditional update, which is what makes this safe
 * without a transaction: the preconditions — still active, enough left — are
 * in the filter, so two tills redeeming the same card at the same instant
 * cannot both succeed against the same money. One of them matches no document
 * and is told the balance moved.
 *
 * The status flip to `redeemed` happens inside the same update through a
 * pipeline, so a card can never be observed at zero while still marked active.
 */
export async function redeemCard(input: {
  code: string;
  pin?: string | null;
  amountMinor?: number;
  mode: VaultMode;
  issuer?: mongoose.Types.ObjectId;
  source: 'issuer_api' | 'issuer_console' | 'partner_api';
  actor?: mongoose.Types.ObjectId | null;
  note?: string;
}): Promise<RedeemResult> {
  const card = await GiftCard.findOne({ 'code.hash': hashSecret(normaliseCode(input.code)) }).select(
    '+pin.cipher',
  );

  /* The same message whether the code is unknown or belongs to another issuer.
     Distinguishing them turns this endpoint into an oracle for guessing codes
     against a merchant's own catalogue. */
  const wrongIssuer = input.issuer && !card?.issuer.equals(input.issuer);
  if (!card || card.mode !== input.mode || wrongIssuer) {
    throw ApiError.notFound('No card matches that code');
  }

  if (card.pin) {
    if (!input.pin || decryptSecret(card.pin.cipher) !== input.pin.trim()) {
      throw ApiError.badRequest('That PIN is not right for this card');
    }
  }

  if (card.status === 'void') throw ApiError.badRequest('That card has been cancelled');
  if (card.status === 'redeemed') throw ApiError.badRequest('That card has already been used up');
  if (card.expiresAt && card.expiresAt.getTime() < Date.now()) {
    /* Written back so reporting and the next lookup agree, rather than leaving
       the row `active` and expired-by-arithmetic forever. */
    if (card.status !== 'expired') {
      card.status = 'expired';
      await card.save();
    }
    throw ApiError.badRequest('That card has expired');
  }

  const amountMinor = input.amountMinor ?? card.balanceMinor;
  if (!Number.isInteger(amountMinor) || amountMinor < 1) {
    throw ApiError.badRequest('The amount to redeem must be a positive whole number');
  }

  const updated = await GiftCard.findOneAndUpdate(
    { _id: card._id, status: 'active', balanceMinor: { $gte: amountMinor } },
    [
      { $set: { balanceMinor: { $subtract: ['$balanceMinor', amountMinor] } } },
      {
        $set: {
          status: { $cond: [{ $eq: ['$balanceMinor', 0] }, 'redeemed', 'active'] },
        },
      },
    ],
    { new: true },
  );

  if (!updated) {
    throw ApiError.badRequest(
      `That card does not have ${amountMinor} left on it — check the balance and try again`,
    );
  }

  const reference = redemptionReference();
  await CardRedemption.create({
    card: updated._id,
    issuer: updated.issuer,
    mode: updated.mode,
    amountMinor,
    balanceAfterMinor: updated.balanceMinor,
    source: input.source,
    actor: input.actor ?? null,
    reference,
    note: input.note ?? '',
  });

  return { card: updated, redeemedMinor: amountMinor, balanceMinor: updated.balanceMinor, reference };
}

/* ------------------------------------------------------------ partner orders */

/**
 * The whole buy-side flow, in the order a crash can survive.
 *
 * 1. An existing order under the same idempotency key wins outright.
 * 2. The order row is written first, so there is something to resume.
 * 3. The wallet is debited, referenced off the order so a retry cannot repeat it.
 * 4. Only then are cards minted.
 */
export async function placePartnerOrder(input: {
  partner: IVaultPartner;
  mode: VaultMode;
  issuer: IVaultIssuer;
  product: IVaultProduct;
  quantity: number;
  unitFaceMinor: number;
  idempotencyKey?: string | null;
  recipientName?: string;
  recipientEmail?: string;
  giftMessage?: string;
}): Promise<{ order: IVaultOrder; cards: IGiftCard[] }> {
  const { partner, mode, issuer, product } = input;

  if (issuer.status !== 'live') throw ApiError.badRequest('That issuer is not selling right now');
  if (product.status !== 'active') throw ApiError.badRequest('That card is not on sale right now');
  assertDenomination(product, input.unitFaceMinor);

  if (input.idempotencyKey) {
    const already = await VaultOrder.findOne({
      partner: partner._id,
      idempotencyKey: input.idempotencyKey,
    });
    if (already) {
      /* A repeat of a request that died before fulfilment finishes the job
         rather than reporting a stale `paid`. */
      const cards =
        already.status === 'paid' ? await fulfilOrder(already) : await GiftCard.find({ order: already._id });
      return { order: already, cards };
    }
  }

  const pricing = priceOrder(discountFor(issuer, product), input.quantity, input.unitFaceMinor);
  const balance = await partnerBalanceMinor(partner._id, mode);
  if (balance < pricing.chargedMinor) {
    throw ApiError.badRequest(
      `Not enough balance: this costs ${pricing.chargedMinor} and you have ${balance}`,
    );
  }

  let order: IVaultOrder;
  try {
    order = await VaultOrder.create({
      reference: orderReference(),
      mode,
      buyerKind: 'partner',
      partner: partner._id,
      issuer: issuer._id,
      product: product._id,
      quantity: input.quantity,
      unitFaceMinor: input.unitFaceMinor,
      currency: product.currency,
      status: 'pending',
      idempotencyKey: input.idempotencyKey ?? null,
      recipientName: input.recipientName ?? '',
      recipientEmail: input.recipientEmail ?? '',
      giftMessage: input.giftMessage ?? '',
      ...pricing,
    });
  } catch (error) {
    /* Two concurrent requests with the same key: the loser reads the winner's
       order rather than creating a second one. */
    if ((error as { code?: number }).code === 11000 && input.idempotencyKey) {
      const winner = await VaultOrder.findOne({
        partner: partner._id,
        idempotencyKey: input.idempotencyKey,
      });
      if (winner) return { order: winner, cards: await GiftCard.find({ order: winner._id }) };
    }
    throw error;
  }

  await recordMovement({
    partner: partner._id,
    mode,
    kind: 'order',
    amountMinor: -pricing.chargedMinor,
    reference: order.reference,
    order: order._id,
    note: `${input.quantity} × ${product.name}`,
    currency: order.currency,
  });

  /*
   * Two requests can both pass the balance check above before either debits,
   * which without transactions is unavoidable. So the balance is checked again
   * after the fact: if it went negative, this order is the one that overdrew
   * and it is reversed. Sequencing it this way means an overdraft is corrected
   * rather than merely unlikely.
   */
  if ((await partnerBalanceMinor(partner._id, mode)) < 0) {
    await recordMovement({
      partner: partner._id,
      mode,
      kind: 'adjustment',
      amountMinor: pricing.chargedMinor,
      reference: `${order.reference}-REVERSAL`,
      order: order._id,
      note: 'Reversed: balance was spent by another order first',
    });
    order.status = 'failed';
    order.failureReason = 'Balance was spent by another order first';
    await order.save();
    throw ApiError.badRequest('Not enough balance — another order spent it first');
  }

  order.status = 'paid';
  await order.save();

  return { order, cards: await fulfilOrder(order) };
}

/* ------------------------------------------------------------- settlement */

/**
 * A confirmed Bachs payment for a partner's top-up.
 *
 * Follows the discipline every other applier on Deck uses: act only on a
 * pending record, refuse an amount or currency that does not match, and flip
 * the status with a conditional update so two webhook deliveries racing each
 * other credit the balance once. The ledger's unique reference is the second
 * guard behind that one.
 */
export async function applyVerifiedVaultTopup(
  topup: IVaultTopup,
  verified: VerifiedPayment,
): Promise<IVaultTopup> {
  if (topup.status !== 'pending') return topup;

  if (verified.status === 'failed') {
    topup.status = 'failed';
    await topup.save();
    return topup;
  }
  if (verified.status !== 'success') return topup;

  if (verified.amountMinor < topup.amountMinor || verified.currency !== topup.currency) {
    throw new ApiError(409, 'The payment amount did not match this top-up. Please contact support.');
  }

  const flipped = await VaultTopup.findOneAndUpdate(
    { _id: topup._id, status: 'pending' },
    {
      status: 'paid',
      paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
      chargeId: verified.chargeId ?? null,
    },
    { new: true },
  );
  if (!flipped) return (await VaultTopup.findById(topup._id)) ?? topup;

  await recordMovement({
    partner: flipped.partner,
    mode: flipped.mode,
    kind: 'topup',
    amountMinor: flipped.amountMinor,
    reference: flipped.reference,
    note: 'Wallet top-up',
    currency: flipped.currency,
  });

  return flipped;
}

/**
 * A confirmed Bachs payment for a card somebody bought on the storefront.
 *
 * The cards are minted here rather than at checkout, because until this moment
 * nobody has paid for them. A minting failure leaves the order `failed` with
 * the money taken, which is the one case a human has to look at — there is no
 * wallet to refund into for a consumer, so it is surfaced rather than
 * swallowed.
 */
export async function applyVerifiedVaultOrder(
  order: IVaultOrder,
  verified: VerifiedPayment,
): Promise<IVaultOrder> {
  if (order.status !== 'pending') return order;

  if (verified.status === 'failed') {
    order.status = 'failed';
    order.failureReason = 'Payment failed';
    await order.save();
    return order;
  }
  if (verified.status !== 'success') return order;

  if (verified.amountMinor < order.chargedMinor || verified.currency !== order.currency) {
    throw new ApiError(409, 'The payment amount did not match this order. Please contact support.');
  }

  const flipped = await VaultOrder.findOneAndUpdate(
    { _id: order._id, status: 'pending' },
    { status: 'paid' },
    { new: true },
  );
  if (!flipped) return (await VaultOrder.findById(order._id)) ?? order;

  await fulfilOrder(flipped);
  return (await VaultOrder.findById(flipped._id)) ?? flipped;
}

/* ----------------------------------------------------------- issuer money */

/**
 * What an issuer has earned and what is still outstanding against it.
 *
 * `owed` counts fulfilled live orders only — a test order is play money and a
 * failed one was refunded. `outstanding` is the face value still sitting
 * unredeemed on live cards, which is the issuer's actual liability and the
 * number their finance team cares about more than the sales figure.
 */
export async function issuerSummary(issuerId: mongoose.Types.ObjectId): Promise<{
  soldMinor: number;
  owedMinor: number;
  outstandingMinor: number;
  cardsIssued: number;
  ordersCount: number;
}> {
  const [sales] = await VaultOrder.aggregate<{
    face: number;
    net: number;
    orders: number;
  }>([
    { $match: { issuer: issuerId, mode: 'live', status: 'fulfilled' } },
    {
      $group: {
        _id: null,
        face: { $sum: '$faceTotalMinor' },
        net: { $sum: '$issuerNetMinor' },
        orders: { $sum: 1 },
      },
    },
  ]);

  const [cards] = await GiftCard.aggregate<{ outstanding: number; count: number }>([
    { $match: { issuer: issuerId, mode: 'live', status: 'active' } },
    { $group: { _id: null, outstanding: { $sum: '$balanceMinor' }, count: { $sum: 1 } } },
  ]);

  const issued = await GiftCard.countDocuments({ issuer: issuerId, mode: 'live' });

  return {
    soldMinor: sales?.face ?? 0,
    owedMinor: sales?.net ?? 0,
    outstandingMinor: cards?.outstanding ?? 0,
    cardsIssued: issued,
    ordersCount: sales?.orders ?? 0,
  };
}
