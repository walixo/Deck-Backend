import mongoose from 'mongoose';
import { Contribution } from '../models/Contribution';
import { GamePurchase } from '../models/GamePurchase';
import { Order } from '../models/Order';
import { Payout } from '../models/Payout';
import { env } from '../config/env';

/**
 * What Deck owes people.
 *
 * Deck collects every payment, so a seller's balance is a debt on Deck's books.
 * It is computed from the source rows every time rather than kept as a running
 * total — earnings minus payouts, always. That costs an aggregation, and buys
 * the property that matters on a ledger nobody external reconciles: it cannot
 * silently drift. A stored balance goes wrong the first time an increment fails
 * after its transaction committed, and nothing would ever notice.
 *
 * Only settled money counts. An abandoned checkout owes nobody anything, which
 * is why order status is filtered rather than assumed.
 */
export const EARNING_ORDER_STATUSES = ['paid', 'shipped', 'delivered'] as const;

/**
 * Earnings paid before this moment have cleared the hold.
 *
 * A row with no payment date at all is treated as cleared: those are orders
 * and contributions from before the date was recorded, long past any window.
 */
export function clearedBefore(now = new Date()): Date {
  return new Date(now.getTime() - env.payoutHoldDays * 24 * 60 * 60 * 1000);
}

const EPOCH = new Date(0);

/** A game purchase that earns: paid, with real money. */
const EARNING_GAME_PURCHASE = { status: 'paid', mode: 'live' } as const;

/**
 * Payouts that count against a balance: everything except a `failed` one.
 * A pending transfer counts as already gone — see the Payout model for why
 * that is what keeps a crash from paying anybody twice.
 */
const COUNTS_AS_PAID = { status: { $ne: 'failed' } };

export interface Balance {
  merchNetMinor: number;
  merchShippingMinor: number;
  merchFeeMinor: number;
  orders: number;
  fundraiseNetMinor: number;
  fundraiseFeeMinor: number;
  contributions: number;
  /** A developer's 80% of live in-game purchases. Test purchases never count. */
  gamesNetMinor: number;
  gamesFeeMinor: number;
  gameSales: number;
  earnedMinor: number;
  paidOutMinor: number;
  /** What Deck still owes. Floored at zero so an overpayment reads as settled. */
  owedMinor: number;
  /**
   * The part of what is owed that has cleared the hold and will go out on the
   * next transfer run. Earnings paid inside the last `payoutHoldDays` are owed
   * but not yet available — that window is where a refund can still land
   * before the money has left Deck.
   */
  availableMinor: number;
  /** Owed, but still inside the hold. `owed = available + held`. */
  heldMinor: number;
}

const EMPTY: Balance = {
  merchNetMinor: 0,
  merchShippingMinor: 0,
  merchFeeMinor: 0,
  orders: 0,
  fundraiseNetMinor: 0,
  fundraiseFeeMinor: 0,
  contributions: 0,
  gamesNetMinor: 0,
  gamesFeeMinor: 0,
  gameSales: 0,
  earnedMinor: 0,
  paidOutMinor: 0,
  owedMinor: 0,
  availableMinor: 0,
  heldMinor: 0,
};

export async function balanceFor(userId: mongoose.Types.ObjectId | string): Promise<Balance> {
  const seller = new mongoose.Types.ObjectId(userId);
  const cutoff = clearedBefore();

  const [merchRows, raiseRows, gameRows, payoutRows] = await Promise.all([
    Order.aggregate<{
      net: number;
      cleared: number;
      shipping: number;
      fee: number;
      orders: number;
    }>([
      { $match: { status: { $in: [...EARNING_ORDER_STATUSES] }, 'sellerShares.seller': seller } },
      { $unwind: '$sellerShares' },
      { $match: { 'sellerShares.seller': seller } },
      {
        $group: {
          _id: null,
          net: { $sum: '$sellerShares.netMinor' },
          cleared: {
            $sum: {
              $cond: [
                { $lte: [{ $ifNull: ['$payment.paidAt', EPOCH] }, cutoff] },
                '$sellerShares.netMinor',
                0,
              ],
            },
          },
          shipping: { $sum: '$sellerShares.shippingMinor' },
          fee: { $sum: '$sellerShares.platformFeeMinor' },
          orders: { $sum: 1 },
        },
      },
    ]),
    Contribution.aggregate<{ net: number; cleared: number; fee: number; count: number }>([
      { $match: { beneficiary: seller, status: 'paid' } },
      {
        $group: {
          _id: null,
          net: { $sum: '$netMinor' },
          cleared: {
            $sum: {
              $cond: [{ $lte: [{ $ifNull: ['$paidAt', EPOCH] }, cutoff] }, '$netMinor', 0],
            },
          },
          fee: { $sum: '$platformFeeMinor' },
          count: { $sum: 1 },
        },
      },
    ]),
    GamePurchase.aggregate<{ net: number; cleared: number; fee: number; count: number }>([
      { $match: { developer: seller, ...EARNING_GAME_PURCHASE } },
      {
        $group: {
          _id: null,
          net: { $sum: '$developerShareMinor' },
          cleared: {
            $sum: {
              $cond: [
                { $lte: [{ $ifNull: ['$paidAt', EPOCH] }, cutoff] },
                '$developerShareMinor',
                0,
              ],
            },
          },
          fee: { $sum: '$platformFeeMinor' },
          count: { $sum: 1 },
        },
      },
    ]),
    Payout.aggregate<{ total: number }>([
      { $match: { seller, ...COUNTS_AS_PAID } },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } },
    ]),
  ]);

  const merch = merchRows[0] ?? { net: 0, cleared: 0, shipping: 0, fee: 0, orders: 0 };
  const raise = raiseRows[0] ?? { net: 0, cleared: 0, fee: 0, count: 0 };
  const games = gameRows[0] ?? { net: 0, cleared: 0, fee: 0, count: 0 };
  const paidOutMinor = payoutRows[0]?.total ?? 0;
  const earnedMinor = merch.net + raise.net + games.net;
  const clearedMinor = merch.cleared + raise.cleared + games.cleared;
  const owedMinor = Math.max(0, earnedMinor - paidOutMinor);
  const availableMinor = Math.max(0, clearedMinor - paidOutMinor);

  return {
    ...EMPTY,
    merchNetMinor: merch.net,
    merchShippingMinor: merch.shipping,
    merchFeeMinor: merch.fee,
    orders: merch.orders,
    fundraiseNetMinor: raise.net,
    fundraiseFeeMinor: raise.fee,
    contributions: raise.count,
    gamesNetMinor: games.net,
    gamesFeeMinor: games.fee,
    gameSales: games.count,
    earnedMinor,
    paidOutMinor,
    owedMinor,
    availableMinor,
    heldMinor: Math.max(0, owedMinor - availableMinor),
  };
}

export interface OwedRow {
  sellerId: string;
  earnedMinor: number;
  /** Earned before the hold cutoff. */
  clearedMinor: number;
  paidOutMinor: number;
  owedMinor: number;
  /** Cleared and not yet paid out — what the next transfer run would send. */
  availableMinor: number;
}

/**
 * One place money is earned, as a per-person total and the cleared part of it.
 *
 * Each source is its own aggregation, joined in memory below, so adding a new
 * way to earn — game sales are the next — is one more entry in `SOURCES`
 * rather than a rewrite of the query that decides who gets paid. Two readable
 * aggregations that anyone can check by hand are worth more than one clever
 * `$unionWith` here.
 */
type EarningSource = (
  cutoff: Date,
) => Promise<{ _id: mongoose.Types.ObjectId; net: number; cleared: number }[]>;

const merchEarnings: EarningSource = (cutoff) =>
  Order.aggregate([
    { $match: { status: { $in: [...EARNING_ORDER_STATUSES] } } },
    { $unwind: '$sellerShares' },
    {
      $group: {
        _id: '$sellerShares.seller',
        net: { $sum: '$sellerShares.netMinor' },
        cleared: {
          $sum: {
            $cond: [
              { $lte: [{ $ifNull: ['$payment.paidAt', EPOCH] }, cutoff] },
              '$sellerShares.netMinor',
              0,
            ],
          },
        },
      },
    },
  ]);

const fundraiseEarnings: EarningSource = (cutoff) =>
  Contribution.aggregate([
    { $match: { status: 'paid' } },
    {
      $group: {
        _id: '$beneficiary',
        net: { $sum: '$netMinor' },
        cleared: {
          $sum: { $cond: [{ $lte: [{ $ifNull: ['$paidAt', EPOCH] }, cutoff] }, '$netMinor', 0] },
        },
      },
    },
  ]);

const gameEarnings: EarningSource = (cutoff) =>
  GamePurchase.aggregate([
    { $match: EARNING_GAME_PURCHASE },
    {
      $group: {
        _id: '$developer',
        net: { $sum: '$developerShareMinor' },
        cleared: {
          $sum: {
            $cond: [{ $lte: [{ $ifNull: ['$paidAt', EPOCH] }, cutoff] }, '$developerShareMinor', 0],
          },
        },
      },
    },
  ]);

const SOURCES: EarningSource[] = [merchEarnings, fundraiseEarnings, gameEarnings];

/**
 * Everyone Deck currently owes, largest first — and how much of it has cleared.
 *
 * This is what the automatic transfer run reads. `availableMinor` is the only
 * number it acts on; `owedMinor` is for the staff view, where money owed to
 * somebody who has not set up a sub-account yet still has to be visible.
 */
export async function outstandingBalances(): Promise<OwedRow[]> {
  const cutoff = clearedBefore();

  const [sourceRows, payoutRows] = await Promise.all([
    Promise.all(SOURCES.map((source) => source(cutoff))),
    Payout.aggregate<{ _id: mongoose.Types.ObjectId; total: number }>([
      { $match: COUNTS_AS_PAID },
      { $group: { _id: '$seller', total: { $sum: '$amountMinor' } } },
    ]),
  ]);

  const earned = new Map<string, { net: number; cleared: number }>();
  for (const row of sourceRows.flat()) {
    const key = row._id.toString();
    const current = earned.get(key) ?? { net: 0, cleared: 0 };
    earned.set(key, { net: current.net + row.net, cleared: current.cleared + row.cleared });
  }

  const paid = new Map(payoutRows.map((row) => [row._id.toString(), row.total]));

  return [...earned.entries()]
    .map(([sellerId, totals]) => {
      const paidOutMinor = paid.get(sellerId) ?? 0;
      return {
        sellerId,
        earnedMinor: totals.net,
        clearedMinor: totals.cleared,
        paidOutMinor,
        owedMinor: totals.net - paidOutMinor,
        availableMinor: Math.max(0, totals.cleared - paidOutMinor),
      };
    })
    .filter((row) => row.owedMinor > 0)
    .sort((a, b) => b.owedMinor - a.owedMinor);
}
