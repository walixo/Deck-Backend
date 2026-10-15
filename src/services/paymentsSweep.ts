import { AdCampaign } from '../models/AdCampaign';
import { Contribution } from '../models/Contribution';
import { GamePurchase } from '../models/GamePurchase';
import { Order } from '../models/Order';
import {
  applyVerifiedAdPayment,
  applyVerifiedContribution,
  applyVerifiedGamePurchase,
  applyVerifiedPayment,
} from '../controllers/payment.controller';
import { CHECKOUT_LIFETIME_MINUTES, getCheckout, type VerifiedPayment } from './bachs';

/**
 * Settles checkouts nobody finished, and catches payments a webhook missed.
 *
 * Under Paystack, an abandoned basket was cancelled when Paystack reported it
 * `abandoned`. Bachs documents no event for a checkout expiring, so without
 * this an abandoned order would hold its stock reserved forever.
 *
 * Every candidate is checked with Bachs before anything happens to it, and
 * only two outcomes act:
 *
 *  - **Paid.** The webhook was lost or delayed past retry. The order is
 *    settled exactly as the webhook would have settled it. This makes the
 *    sweep a reconciliation pass as well as a cleanup one.
 *  - **Expired.** Past its own `expires_at` and not completed — it can never be
 *    paid now. Cancelled, stock released.
 *
 * Anything else is left alone for the next pass. In particular a status this
 * code does not recognise is *not* treated as failure: the status enum is
 * undocumented, and cancelling a paid order because Bachs used an unfamiliar
 * word is the one mistake here that would cost a customer money.
 */

/* A margin past the checkout's own lifetime, so nothing is swept while it
   could still, just, be paid. */
const SWEEP_AFTER_MS = (CHECKOUT_LIFETIME_MINUTES + 30) * 60 * 1000;

/** Orders created while payments were unconfigured have nothing to ask
    Bachs about, and nothing can pay them. Given a day before release. */
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

const EXPIRED: VerifiedPayment = {
  status: 'failed',
  amountMinor: 0,
  currency: '',
  paidAt: null,
  chargeId: null,
};

export interface SweepResult {
  settled: number;
  expired: number;
  orphansReleased: number;
}

export async function sweepExpiredCheckouts(now = new Date()): Promise<SweepResult> {
  const result: SweepResult = { settled: 0, expired: 0, orphansReleased: 0 };
  const cutoff = new Date(now.getTime() - SWEEP_AFTER_MS);

  /* Bounded per pass, so one slow pass cannot hold the scheduler indefinitely
     and a backlog drains over a few runs instead of hammering the API. */
  const orders = await Order.find({
    status: 'awaiting_payment',
    'payment.checkoutId': { $exists: true },
    createdAt: { $lt: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  for (const order of orders) {
    try {
      const verified = await getCheckout(order.payment!.checkoutId!);
      if (verified.status === 'success') {
        await applyVerifiedPayment(order, verified);
        result.settled += 1;
      } else if (verified.expired) {
        await applyVerifiedPayment(order, EXPIRED);
        result.expired += 1;
      }
    } catch (error) {
      /* One bad order must not stop the rest of the pass. */
      // eslint-disable-next-line no-console
      console.error(`[sweep] order ${order.reference}:`, error);
    }
  }

  const orphans = await Order.find({
    status: 'awaiting_payment',
    'payment.checkoutId': { $exists: false },
    createdAt: { $lt: new Date(now.getTime() - ORPHAN_AFTER_MS) },
  }).limit(50);

  for (const order of orphans) {
    await applyVerifiedPayment(order, EXPIRED);
    result.orphansReleased += 1;
  }

  const contributions = await Contribution.find({
    status: 'pending',
    checkoutId: { $exists: true },
    createdAt: { $lt: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  for (const contribution of contributions) {
    try {
      const verified = await getCheckout(contribution.checkoutId!);
      if (verified.status === 'success') {
        await applyVerifiedContribution(contribution, verified);
        result.settled += 1;
      } else if (verified.expired) {
        await applyVerifiedContribution(contribution, EXPIRED);
        result.expired += 1;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[sweep] contribution ${contribution.reference}:`, error);
    }
  }

  /* In-game purchases: settle the paid, fail the expired, like contributions. */
  const purchases = await GamePurchase.find({
    status: 'pending',
    mode: 'live',
    checkoutId: { $exists: true },
    createdAt: { $lt: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  for (const purchase of purchases) {
    try {
      const verified = await getCheckout(purchase.checkoutId!);
      if (verified.status === 'success') {
        await applyVerifiedGamePurchase(purchase, verified);
        result.settled += 1;
      } else if (verified.expired) {
        await applyVerifiedGamePurchase(purchase, EXPIRED);
        result.expired += 1;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[sweep] game purchase ${purchase.reference}:`, error);
    }
  }

  /*
   * Ad campaigns: reconciliation only, never cancellation. An approved slot
   * stays payable by design — the advertiser can open a fresh checkout — so an
   * expired one is simply left. But a paid one whose webhook went missing
   * would sit unlaunched with the money taken, which is worth a pass.
   */
  const campaigns = await AdCampaign.find({
    status: 'awaiting_payment',
    checkoutId: { $exists: true },
    createdAt: { $lt: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  for (const campaign of campaigns) {
    try {
      const verified = await getCheckout(campaign.checkoutId!);
      if (verified.status === 'success') {
        await applyVerifiedAdPayment(campaign, verified);
        result.settled += 1;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[sweep] ad ${campaign.reference}:`, error);
    }
  }

  return result;
}
