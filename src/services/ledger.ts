import mongoose from 'mongoose';
import { Contribution } from '../models/Contribution';
import { Order } from '../models/Order';
import { Payout } from '../models/Payout';

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

export interface Balance {
  merchNetMinor: number;
  merchShippingMinor: number;
  merchFeeMinor: number;
  orders: number;
  fundraiseNetMinor: number;
  fundraiseFeeMinor: number;
  contributions: number;
  earnedMinor: number;
  paidOutMinor: number;
  /** What Deck still owes. Floored at zero so an overpayment reads as settled. */
  owedMinor: number;
}

const EMPTY: Balance = {
  merchNetMinor: 0,
  merchShippingMinor: 0,
  merchFeeMinor: 0,
  orders: 0,
  fundraiseNetMinor: 0,
  fundraiseFeeMinor: 0,
  contributions: 0,
  earnedMinor: 0,
  paidOutMinor: 0,
  owedMinor: 0,
};

export async function balanceFor(userId: mongoose.Types.ObjectId | string): Promise<Balance> {
  const seller = new mongoose.Types.ObjectId(userId);

  const [merchRows, raiseRows, payoutRows] = await Promise.all([
    Order.aggregate<{ net: number; shipping: number; fee: number; orders: number }>([
      { $match: { status: { $in: [...EARNING_ORDER_STATUSES] }, 'sellerShares.seller': seller } },
      { $unwind: '$sellerShares' },
      { $match: { 'sellerShares.seller': seller } },
      {
        $group: {
          _id: null,
          net: { $sum: '$sellerShares.netMinor' },
          shipping: { $sum: '$sellerShares.shippingMinor' },
          fee: { $sum: '$sellerShares.platformFeeMinor' },
          orders: { $sum: 1 },
        },
      },
    ]),
    Contribution.aggregate<{ net: number; fee: number; count: number }>([
      { $match: { beneficiary: seller, status: 'paid' } },
      {
        $group: {
          _id: null,
          net: { $sum: '$netMinor' },
          fee: { $sum: '$platformFeeMinor' },
          count: { $sum: 1 },
        },
      },
    ]),
    Payout.aggregate<{ total: number }>([
      { $match: { seller } },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } },
    ]),
  ]);

  const merch = merchRows[0] ?? { net: 0, shipping: 0, fee: 0, orders: 0 };
  const raise = raiseRows[0] ?? { net: 0, fee: 0, count: 0 };
  const paidOutMinor = payoutRows[0]?.total ?? 0;
  const earnedMinor = merch.net + raise.net;

  return {
    ...EMPTY,
    merchNetMinor: merch.net,
    merchShippingMinor: merch.shipping,
    merchFeeMinor: merch.fee,
    orders: merch.orders,
    fundraiseNetMinor: raise.net,
    fundraiseFeeMinor: raise.fee,
    contributions: raise.count,
    earnedMinor,
    paidOutMinor,
    owedMinor: Math.max(0, earnedMinor - paidOutMinor),
  };
}

export interface OwedRow {
  sellerId: string;
  earnedMinor: number;
  paidOutMinor: number;
  owedMinor: number;
}

/**
 * Everyone Deck currently owes, largest first — the disbursement run.
 *
 * Earnings and payouts are aggregated separately and joined in memory. A single
 * pipeline could do it with `$unionWith`, but two readable aggregations that
 * anyone can check by hand are worth more than one clever one on the query that
 * decides who gets paid.
 */
export async function outstandingBalances(): Promise<OwedRow[]> {
  const [merchRows, raiseRows, payoutRows] = await Promise.all([
    Order.aggregate<{ _id: mongoose.Types.ObjectId; net: number }>([
      { $match: { status: { $in: [...EARNING_ORDER_STATUSES] } } },
      { $unwind: '$sellerShares' },
      { $group: { _id: '$sellerShares.seller', net: { $sum: '$sellerShares.netMinor' } } },
    ]),
    Contribution.aggregate<{ _id: mongoose.Types.ObjectId; net: number }>([
      { $match: { status: 'paid' } },
      { $group: { _id: '$beneficiary', net: { $sum: '$netMinor' } } },
    ]),
    Payout.aggregate<{ _id: mongoose.Types.ObjectId; total: number }>([
      { $group: { _id: '$seller', total: { $sum: '$amountMinor' } } },
    ]),
  ]);

  const earned = new Map<string, number>();
  for (const row of [...merchRows, ...raiseRows]) {
    const key = row._id.toString();
    earned.set(key, (earned.get(key) ?? 0) + row.net);
  }

  const paid = new Map(payoutRows.map((row) => [row._id.toString(), row.total]));

  return [...earned.entries()]
    .map(([sellerId, earnedMinor]) => {
      const paidOutMinor = paid.get(sellerId) ?? 0;
      return { sellerId, earnedMinor, paidOutMinor, owedMinor: earnedMinor - paidOutMinor };
    })
    .filter((row) => row.owedMinor > 0)
    .sort((a, b) => b.owedMinor - a.owedMinor);
}
