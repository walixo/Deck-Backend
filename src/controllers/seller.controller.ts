import type { Request, Response } from 'express';
import { CURRENCY, PLATFORM_FEE_PERCENT } from '../constants';
import { MerchProduct } from '../models/MerchProduct';
import { balanceFor } from '../services/ledger';
import { ApiError } from '../utils/ApiError';

/**
 * What a seller has earned, what Deck has sent them, and what is still owed.
 *
 * Deck collects every payment, so the last of those is a debt on Deck's books
 * rather than money already in their bank. The UI has to be plain about that
 * distinction, and so does this payload — hence `paidOutMinor` and `owedMinor`
 * as separate figures rather than one ambiguous "earnings" number.
 */
export async function getMyEarnings(req: Request, res: Response): Promise<void> {
  const userId = req.user!._id;

  const [balance, listingCounts] = await Promise.all([
    balanceFor(userId),
    MerchProduct.aggregate<{ _id: string; count: number }>([
      { $match: { seller: userId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  res.json({
    success: true,
    data: {
      currency: CURRENCY,
      feePercent: PLATFORM_FEE_PERCENT,
      merch: {
        netMinor: balance.merchNetMinor,
        shippingMinor: balance.merchShippingMinor,
        feeMinor: balance.merchFeeMinor,
        orders: balance.orders,
      },
      fundraise: {
        netMinor: balance.fundraiseNetMinor,
        feeMinor: balance.fundraiseFeeMinor,
        contributions: balance.contributions,
      },
      earnedMinor: balance.earnedMinor,
      paidOutMinor: balance.paidOutMinor,
      owedMinor: balance.owedMinor,
      listings: Object.fromEntries(listingCounts.map((row) => [row._id, row.count])),
    },
  });
}

/**
 * Kept as an explicit 410 rather than deleted.
 *
 * Payout accounts existed for one release. A browser holding a stale bundle
 * would otherwise call a route that no longer exists and get a generic 404,
 * which reads as "something is broken" instead of "this went away".
 */
export function payoutAccountsRetired(): never {
  throw new ApiError(410, 'Deck pays sellers out directly now — no payout account is needed');
}
