import crypto from 'node:crypto';
import { env } from '../config/env';
import {
  MatchBrandOrder,
  MatchBrandProduct,
  type IMatchBrandOrder,
  type IMatchBrandProduct,
} from '../models/MatchMoney';
import { ApiError } from '../utils/ApiError';
import type { VerifiedPayment } from './bachs';
import { MATCH_CURRENCY } from './matchWallet';
import {
  findOrder,
  listProducts,
  placeOrder,
  redeemCodes,
  ReloadlyError,
  type ReloadlyOrder,
} from './reloadly';

/**
 * Other brands' gift cards in Match: priced in naira from Reloadly's
 * catalogue, paid for through Bachs, and only then bought from Reloadly.
 */

/** A RANGE product's choices: its ends, and round amounts between. */
const ROUND_AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];
const brandReference = () =>
  `MATCHBRAND-${Array.from(crypto.randomBytes(6), (b) => '23456789ABCDEFGHJKMNPQRSTUVWXYZ'[b % 31]).join('')}`;
export { brandReference };

/** Pulls the country's catalogue from Reloadly, keeping staff's choices. */
export async function syncCatalogue(): Promise<number> {
  const products = await listProducts(env.reloadly.country);
  const now = new Date();
  for (const product of products) {
    await MatchBrandProduct.updateOne(
      { productId: product.productId },
      {
        $set: {
          name: product.productName,
          brand: product.brand?.brandName ?? product.productName,
          logoUrl: product.logoUrls?.[0] ?? '',
          countryCode: product.country?.isoName ?? env.reloadly.country,
          recipientCurrency: product.recipientCurrencyCode,
          senderCurrency: product.senderCurrencyCode,
          denominationType: product.denominationType,
          denominations: product.fixedRecipientDenominations ?? [],
          senderPrices: product.fixedRecipientToSenderDenominationsMap ?? {},
          min: product.minRecipientDenomination ?? null,
          max: product.maxRecipientDenomination ?? null,
          senderFee: product.senderFee ?? 0,
          discountPct: product.discountPercentage ?? 0,
          redeemInstruction:
            product.redeemInstruction?.concise ?? product.redeemInstruction?.verbose ?? '',
          syncedAt: now,
        },
        /* New products start switched off, at no markup, until staff choose. */
        $setOnInsert: { enabled: false, markupPct: 0 },
      },
      { upsert: true },
    );
  }
  return products.length;
}

/** The amounts a product can be bought in, in its own currency. */
export function faceValues(product: IMatchBrandProduct): number[] {
  if (product.denominationType === 'FIXED') return [...product.denominations].sort((a, b) => a - b);
  const min = product.min ?? 0;
  const max = product.max ?? 0;
  return [...new Set([min, ...ROUND_AMOUNTS.filter((a) => a > min && a < max), max])]
    .filter((a) => a > 0)
    .slice(0, 7);
}

/**
 * What Match charges for one card, kobo: what Reloadly charges Deck in naira
 * plus its fee, with staff's markup on top. Only naira-priced products can be
 * sold; anything else returns null.
 */
export function priceMinor(product: IMatchBrandProduct, face: number): number | null {
  if (product.senderCurrency !== MATCH_CURRENCY) return null;
  let sender: number | undefined;
  if (product.denominationType === 'FIXED') {
    sender =
      product.senderPrices[face.toFixed(2)] ??
      product.senderPrices[String(face)] ??
      product.senderPrices[face.toFixed(1)];
  } else if (
    product.min !== null &&
    product.max !== null &&
    face >= product.min &&
    face <= product.max
  ) {
    /* A RANGE product's naira cost scales with the amount; the fixed map, if any, sets the rate. */
    const pairs = Object.entries(product.senderPrices);
    const rate = pairs.length
      ? Number(pairs[0][1]) / Number(pairs[0][0])
      : product.recipientCurrency === MATCH_CURRENCY
        ? 1
        : NaN;
    sender = face * rate;
  }
  if (!sender || !Number.isFinite(sender)) return null;
  const naira = (sender + (product.senderFee ?? 0)) * (1 + (product.markupPct ?? 0) / 100);
  /* Up to the next whole naira: nobody wants to pay ₦5,197.50. */
  return Math.ceil(naira) * 100;
}

/** Moves a paid brand order on: buys the card, or settles one already bought. */
export async function fulfil(orderId: IMatchBrandOrder['_id']): Promise<IMatchBrandOrder | null> {
  const now = new Date();
  /* One worker at a time; a claim lasts a minute in case a worker dies. */
  const order = await MatchBrandOrder.findOneAndUpdate(
    {
      _id: orderId,
      status: { $in: ['paid', 'stuck'] },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
    },
    { lockedUntil: new Date(now.getTime() + 60_000), $inc: { attempts: 1 } },
    { new: true },
  );
  if (!order) return MatchBrandOrder.findById(orderId);
  const stuck = async (problem: string) =>
    MatchBrandOrder.findByIdAndUpdate(
      order._id,
      { status: 'stuck', problem, lockedUntil: null },
      { new: true },
    );
  try {
    let placed: ReloadlyOrder | null = null;
    if (order.reloadlyTransactionId) {
      placed = {
        transactionId: order.reloadlyTransactionId,
        status: 'SUCCESSFUL',
      } as ReloadlyOrder;
    } else if (order.attempts > 1) {
      /* An earlier try may have gone through: never order twice. */
      placed = await findOrder(order.reference);
    }
    if (!placed) {
      placed = await placeOrder({
        productId: order.productId,
        countryCode: env.reloadly.country,
        unitPrice: order.faceValue,
        customIdentifier: order.reference,
        senderName: 'Deck',
      });
    }
    await MatchBrandOrder.updateOne(
      { _id: order._id },
      {
        reloadlyTransactionId: placed.transactionId,
        ...(placed.amount !== undefined
          ? { costAmount: placed.amount, costCurrency: placed.currencyCode }
          : {}),
      },
    );
    if (placed.status !== 'SUCCESSFUL') {
      return stuck(
        `Reloadly says the order is ${placed.status.toLowerCase()}; it is retried shortly.`,
      );
    }
    const [card] = await redeemCodes(placed.transactionId);
    if (!card || !(card.cardNumber || card.pinCode || card.redemptionUrl)) {
      return stuck('Reloadly has not issued the code yet; it is retried shortly.');
    }
    return MatchBrandOrder.findByIdAndUpdate(
      order._id,
      {
        status: 'fulfilled',
        code: {
          cardNumber: card.cardNumber ?? '',
          pinCode: card.pinCode ?? '',
          redemptionUrl: card.redemptionUrl ?? '',
        },
        problem: '',
        lockedUntil: null,
        fulfilledAt: new Date(),
      },
      { new: true },
    ).select('+code');
  } catch (error) {
    const message =
      error instanceof ReloadlyError
        ? error.message
        : `Could not reach Reloadly: ${(error as Error).message}`;
    return stuck(message);
  }
}

/** A provider-confirmed payment for a brand order: pending to paid once, then buy the card. */
export async function applyVerifiedBrandOrder(
  order: IMatchBrandOrder,
  verified: VerifiedPayment,
): Promise<IMatchBrandOrder> {
  if (order.status !== 'pending') return order;
  if (verified.status === 'failed') {
    order.status = 'failed';
    await order.save();
    return order;
  }
  if (verified.status !== 'success') return order;
  if (verified.amountMinor < order.priceMinor || verified.currency !== order.currency) {
    throw new ApiError(
      409,
      'The payment amount did not match this gift card. Please contact support.',
    );
  }
  return markPaid(order, verified.paidAt ? new Date(verified.paidAt) : new Date());
}

export async function markPaid(order: IMatchBrandOrder, paidAt: Date): Promise<IMatchBrandOrder> {
  const flipped = await MatchBrandOrder.findOneAndUpdate(
    { _id: order._id, status: 'pending' },
    { status: 'paid', paidAt },
    { new: true },
  );
  if (!flipped) return (await MatchBrandOrder.findById(order._id)) ?? order;
  return (await fulfil(flipped._id)) ?? flipped;
}

/**
 * Keeps paid orders moving: any still waiting on Reloadly is tried again
 * every two minutes, up to eight times, then left for staff.
 */
export function startBrandRetries(): void {
  setInterval(() => {
    void (async () => {
      const due = await MatchBrandOrder.find({
        status: { $in: ['paid', 'stuck'] },
        attempts: { $lt: 8 },
        updatedAt: { $lt: new Date(Date.now() - 60_000) },
      })
        .select('_id')
        .limit(20);
      for (const order of due) await fulfil(order._id);
    })().catch(() => undefined);
  }, 120_000).unref();
}
