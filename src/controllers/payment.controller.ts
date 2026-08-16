import type { Request, Response } from 'express';
import { AdCampaign, type IAdCampaign } from '../models/AdCampaign';
import { Contribution, type IContribution } from '../models/Contribution';
import { Item } from '../models/Item';
import { MerchProduct } from '../models/MerchProduct';
import { Order, type IOrder } from '../models/Order';
import {
  verifyTransaction,
  verifyWebhookSignature,
  type VerifiedTransaction,
} from '../services/paystack';
import { evaluateBadges } from '../services/badges';
import { toAdCampaignResponse, toContributionResponse, toOrderResponse } from '../serializers';
import { ApiError } from '../utils/ApiError';

/** Puts reserved stock back when a payment does not complete. */
export async function releaseStock(order: IOrder): Promise<void> {
  await Promise.all(
    order.lines.map((line) =>
      MerchProduct.updateOne(
        { _id: line.product, 'variants.sku': line.sku },
        { $inc: { 'variants.$.stock': line.quantity } },
      ),
    ),
  );
}

/**
 * Applies a verified Paystack result to an order.
 *
 * Idempotent on purpose: the callback and the webhook routinely both arrive for
 * the same transaction, and a retried webhook can arrive days later. Anything
 * already settled returns untouched rather than double-releasing stock.
 */
export async function applyVerifiedPayment(
  order: IOrder,
  verified: VerifiedTransaction,
): Promise<IOrder> {
  if (order.status !== 'awaiting_payment') return order;

  if (verified.status === 'success') {
    /*
     * Confirm the provider charged what we asked for. A mismatch means the
     * transaction was tampered with or belongs to a different order, so it is
     * never treated as payment for this one.
     */
    if (verified.amountMinor !== order.totalMinor || verified.currency !== order.currency) {
      throw new ApiError(
        409,
        'The payment amount did not match this order. Nothing has been charged to you — please contact support.',
      );
    }

    order.status = 'paid';
    /* Every seller in this basket may have just made their first sale. */
    for (const share of order.sellerShares) void evaluateBadges(share.seller);
    order.payment = {
      ...(order.payment ?? { provider: 'paystack', reference: order.reference }),
      provider: 'paystack',
      reference: order.payment?.reference ?? order.reference,
      paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
      channel: verified.channel ?? undefined,
      amountMinor: verified.amountMinor,
    };
    await order.save();
    return order;
  }

  // Anything Paystack considers terminal frees the stock back up.
  if (verified.status === 'failed' || verified.status === 'abandoned') {
    order.status = 'cancelled';
    await order.save();
    await releaseStock(order);
  }

  return order;
}

/**
 * Applies a verified Paystack result to a contribution.
 *
 * The launch's running total is incremented here and nowhere else, inside the
 * same `pending` guard that makes this idempotent. The callback and the webhook
 * both arrive for every transaction, and webhooks retry for days — without that
 * guard a single ₦5,000 contribution would land on the progress bar twice.
 *
 * Keep-what-you-raise means there is no unwinding: once this runs, the money is
 * the launcher's and the total never goes back down.
 */
export async function applyVerifiedContribution(
  contribution: IContribution,
  verified: VerifiedTransaction,
): Promise<IContribution> {
  if (contribution.status !== 'pending') return contribution;

  if (verified.status === 'success') {
    // Same tamper check as orders: the provider must have charged what we asked.
    if (
      verified.amountMinor !== contribution.amountMinor ||
      verified.currency !== contribution.currency
    ) {
      throw new ApiError(
        409,
        'The payment amount did not match this contribution. Please contact support.',
      );
    }

    contribution.status = 'paid';
    contribution.paidAt = verified.paidAt ? new Date(verified.paidAt) : new Date();
    contribution.channel = verified.channel ?? undefined;
    await contribution.save();

    /* The backer's tally, and the launcher's target, both just moved. */
    void evaluateBadges(contribution.contributor);
    void evaluateBadges(contribution.beneficiary);

    await Item.updateOne(
      { _id: contribution.item },
      {
        $inc: {
          'fundraise.raisedMinor': contribution.amountMinor,
          'fundraise.contributorCount': 1,
        },
      },
    );
    return contribution;
  }

  if (verified.status === 'failed' || verified.status === 'abandoned') {
    contribution.status = 'failed';
    await contribution.save();
  }

  return contribution;
}

/**
 * Applies a verified Paystack result to an ad campaign.
 *
 * Same guard as the other two: idempotent on `awaiting_payment`, so the browser
 * callback and the webhook — which both arrive, and which retry for days —
 * cannot start a seven-day run twice.
 *
 * The window is re-anchored on payment rather than on booking. Someone who
 * books on Monday, is approved on Wednesday and pays on Friday has bought seven
 * days from Friday, not the four that would be left of the original window.
 */
export async function applyVerifiedAdPayment(
  campaign: IAdCampaign,
  verified: VerifiedTransaction,
): Promise<IAdCampaign> {
  if (campaign.status !== 'awaiting_payment') return campaign;

  if (verified.status === 'success') {
    if (verified.amountMinor !== campaign.priceMinor || verified.currency !== campaign.currency) {
      throw new ApiError(
        409,
        'The payment amount did not match this campaign. Please contact support.',
      );
    }

    const startAt = campaign.startAt.getTime() < Date.now() ? new Date() : campaign.startAt;

    campaign.status = 'live';
    campaign.paidAt = verified.paidAt ? new Date(verified.paidAt) : new Date();
    campaign.startAt = startAt;
    campaign.endAt = new Date(startAt.getTime() + campaign.days * 24 * 60 * 60 * 1000);
    await campaign.save();
    return campaign;
  }

  /* A failed payment leaves it payable rather than cancelling it — the slot was
     approved, and the advertiser may simply try another card. */
  return campaign;
}

/**
 * Confirms an order by asking Paystack directly. Called when the customer
 * returns from checkout — their browser's claim of success is not trusted, only
 * the provider's answer is.
 */
export async function verifyOrderPayment(req: Request, res: Response): Promise<void> {
  const reference = req.params.reference.toUpperCase();

  /* One callback URL serves every flow, so the reference decides which this is. */
  const contribution = await Contribution.findOne({ reference });
  if (contribution) {
    await verifyContributionPayment(req, res, contribution);
    return;
  }

  const campaign = await AdCampaign.findOne({ reference });
  if (campaign) {
    await verifyAdPayment(req, res, campaign);
    return;
  }

  const order = await Order.findOne({ reference });
  if (!order) throw ApiError.notFound('We could not find that payment');

  const user = req.user!;
  if (order.user.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('That order belongs to someone else');
  }

  if (order.status !== 'awaiting_payment') {
    res.json({ success: true, data: toOrderResponse(order) });
    return;
  }

  const verified = await verifyTransaction(order.payment?.reference ?? order.reference);
  const updated = await applyVerifiedPayment(order, verified);

  res.json({ success: true, data: { kind: 'order', ...toOrderResponse(updated) } });
}

async function verifyAdPayment(req: Request, res: Response, campaign: IAdCampaign): Promise<void> {
  const user = req.user!;
  if (campaign.advertiser.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('That campaign belongs to someone else');
  }

  if (campaign.status !== 'awaiting_payment') {
    res.json({ success: true, data: { kind: 'ad', ...toAdCampaignResponse(campaign) } });
    return;
  }

  const verified = await verifyTransaction(campaign.reference);
  const updated = await applyVerifiedAdPayment(campaign, verified);

  res.json({ success: true, data: { kind: 'ad', ...toAdCampaignResponse(updated) } });
}

async function verifyContributionPayment(
  req: Request,
  res: Response,
  contribution: IContribution,
): Promise<void> {
  const user = req.user!;
  if (contribution.contributor.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('That contribution belongs to someone else');
  }

  if (contribution.status !== 'pending') {
    res.json({
      success: true,
      data: { kind: 'contribution', ...toContributionResponse(contribution) },
    });
    return;
  }

  const verified = await verifyTransaction(contribution.reference);
  const updated = await applyVerifiedContribution(contribution, verified);

  res.json({ success: true, data: { kind: 'contribution', ...toContributionResponse(updated) } });
}

/**
 * Paystack webhook. The signature is an HMAC of the raw request body, so this
 * route is mounted with a raw body parser ahead of the JSON one — re-serialising
 * parsed JSON would change the bytes and never match.
 *
 * Always answers 200 once the signature checks out: Paystack retries on any
 * other status, and a bookkeeping error on our side should not cause a retry
 * storm. Failures are logged instead.
 */
export async function paystackWebhook(req: Request, res: Response): Promise<void> {
  const raw = req.body as Buffer;
  const signature = req.header('x-paystack-signature');

  if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, signature)) {
    res.status(401).json({ success: false, error: { message: 'Invalid signature' } });
    return;
  }

  let event: { event?: string; data?: { reference?: string } };
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ success: false, error: { message: 'Malformed payload' } });
    return;
  }

  const reference = event.data?.reference;
  if (!reference || !event.event?.startsWith('charge.')) {
    res.json({ success: true, data: { ignored: true } });
    return;
  }

  try {
    const upper = reference.toUpperCase();

    const contribution = await Contribution.findOne({ reference: upper });
    const campaign = contribution ? null : await AdCampaign.findOne({ reference: upper });

    if (contribution) {
      if (contribution.status === 'pending') {
        // Re-verify rather than trusting the payload's own status field.
        const verified = await verifyTransaction(reference);
        await applyVerifiedContribution(contribution, verified);
      }
    } else if (campaign) {
      if (campaign.status === 'awaiting_payment') {
        const verified = await verifyTransaction(reference);
        await applyVerifiedAdPayment(campaign, verified);
      }
    } else {
      const order = await Order.findOne({ reference: upper });
      if (order && order.status === 'awaiting_payment') {
        const verified = await verifyTransaction(reference);
        await applyVerifiedPayment(order, verified);
      }
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[paystack] webhook handling failed:', error);
  }

  res.json({ success: true, data: { received: true } });
}
