import type { Request, Response } from 'express';
import { AdCampaign, type IAdCampaign } from '../models/AdCampaign';
import { Contribution, type IContribution } from '../models/Contribution';
import { Game } from '../models/Game';
import { GamePurchase, type IGamePurchase } from '../models/GamePurchase';
import { Item } from '../models/Item';
import { MerchProduct } from '../models/MerchProduct';
import { Order, type IOrder } from '../models/Order';
import { WebhookEvent } from '../models/WebhookEvent';
import {
  getCheckout,
  toMinor,
  verifyWebhook,
  type BachsEvent,
  type VerifiedPayment,
} from '../services/bachs';
import { handleConnectEvent } from '../services/payouts';
import { nextOpening } from '../services/adInventory';
import { evaluateBadges } from '../services/badges';
import { formatMinor, notify } from '../services/notify';
import { toAdCampaignResponse, toContributionResponse, toOrderResponse } from '../serializers';
import { markGamePurchasePaid, toPurchaseResponse } from './gamePlatform.controller';
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
 * The tamper check every flow shares.
 *
 * The provider must have collected at least what was asked, in the right
 * currency. `>=` rather than `===` because Bachs reports genuine overpayment
 * (`OVERPAID`) as its own success state — the customer paid in full and then
 * some, and refusing to fulfil would punish them for it. Underpayment never
 * passes: Bachs's `ACCEPTED` covers amounts other than the one due, and a
 * short payment is not payment for this order.
 */
function coversAmount(verified: VerifiedPayment, amountMinor: number, currency: string): boolean {
  return verified.amountMinor >= amountMinor && verified.currency === currency;
}

/**
 * Applies a verified payment to an order.
 *
 * Idempotent on purpose: the return redirect and the webhook routinely both
 * arrive for the same payment, Bachs sends `checkout.completed` and
 * `collection.succeeded` for one checkout in either order, and deliveries are
 * at-least-once. Anything already settled returns untouched rather than
 * double-releasing stock.
 */
export async function applyVerifiedPayment(
  order: IOrder,
  verified: VerifiedPayment,
): Promise<IOrder> {
  if (order.status !== 'awaiting_payment') return order;

  if (verified.status === 'success') {
    /*
     * Confirm the provider charged what we asked for. A mismatch means the
     * payment was tampered with or belongs to a different order, so it is
     * never treated as payment for this one.
     */
    if (!coversAmount(verified, order.totalMinor, order.currency)) {
      throw new ApiError(
        409,
        'The payment amount did not match this order. Nothing has been charged to you — please contact support.',
      );
    }

    order.status = 'paid';
    /* Every seller in this basket may have just made their first sale. */
    for (const share of order.sellerShares) void evaluateBadges(share.seller);
    order.payment = {
      ...(order.payment ?? { provider: 'bachs', reference: order.reference }),
      provider: 'bachs',
      reference: order.payment?.reference ?? order.reference,
      chargeId: verified.chargeId ?? order.payment?.chargeId,
      paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
      amountMinor: verified.amountMinor,
    };
    await order.save();
    return order;
  }

  /*
   * A `failed` result releases the stock. It only ever comes from the sweep
   * (see services/payments-sweep), which reports failure once the checkout has
   * expired unpaid — never from a single declined card, which the customer can
   * retry inside the same checkout.
   */
  if (verified.status === 'failed') {
    order.status = 'cancelled';
    await order.save();
    await releaseStock(order);
  }

  return order;
}

/**
 * Applies a verified payment to a contribution.
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
  verified: VerifiedPayment,
): Promise<IContribution> {
  if (contribution.status !== 'pending') return contribution;

  if (verified.status === 'success') {
    // Same tamper check as orders: the provider must have charged what we asked.
    if (!coversAmount(verified, contribution.amountMinor, contribution.currency)) {
      throw new ApiError(
        409,
        'The payment amount did not match this contribution. Please contact support.',
      );
    }

    contribution.status = 'paid';
    contribution.paidAt = verified.paidAt ? new Date(verified.paidAt) : new Date();
    contribution.chargeId = verified.chargeId ?? contribution.chargeId;
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

    /* Only once the money has actually settled. Notifying on the attempt
       would announce contributions that never arrived. */
    const funded = await Item.findById(contribution.item).select('name slug');
    if (funded) {
      void notify({
        user: contribution.beneficiary,
        actor: contribution.contributor,
        kind: 'fundraise.contribution',
        title: `${formatMinor(contribution.amountMinor, contribution.currency)} towards ${funded.name}`,
        body: 'A new contribution just landed on your fundraise.',
        link: `/item/${funded.slug}`,
      });
    }

    return contribution;
  }

  /* As for orders: only the sweep reports `failed`, after the checkout expired. */
  if (verified.status === 'failed') {
    contribution.status = 'failed';
    await contribution.save();
  }

  return contribution;
}

/**
 * Applies a verified payment to an ad campaign.
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
  verified: VerifiedPayment,
): Promise<IAdCampaign> {
  if (campaign.status !== 'awaiting_payment') return campaign;

  if (verified.status === 'success') {
    if (!coversAmount(verified, campaign.priceMinor, campaign.currency)) {
      throw new ApiError(
        409,
        'The payment amount did not match this campaign. Please contact support.',
      );
    }

    const requested = campaign.startAt.getTime() < Date.now() ? new Date() : campaign.startAt;
    /* The backstop for two advertisers paying for the last seat in the same
       minute (see services/adInventory). Money has already moved, so rather
       than overbook the slot, the later payment starts at the next opening —
       usually `requested` itself — and still gets every day it paid for. */
    const startAt = await nextOpening(campaign.placement, campaign.days, requested, campaign._id);

    campaign.status = 'live';
    campaign.paidAt = verified.paidAt ? new Date(verified.paidAt) : new Date();
    campaign.chargeId = verified.chargeId ?? campaign.chargeId;
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
 * Applies a verified payment to an in-game purchase.
 *
 * Same guard and the same amount check as the rest. Settling it starts the
 * developer's `purchase.paid` webhook — see `markGamePurchasePaid`.
 */
export async function applyVerifiedGamePurchase(
  purchase: IGamePurchase,
  verified: VerifiedPayment,
): Promise<IGamePurchase> {
  if (purchase.status !== 'pending') return purchase;

  if (verified.status === 'success') {
    if (!coversAmount(verified, purchase.priceMinor, purchase.currency)) {
      throw new ApiError(
        409,
        'The payment amount did not match this purchase. Please contact support.',
      );
    }
    return markGamePurchasePaid(purchase, { paidAt: verified.paidAt, chargeId: verified.chargeId });
  }

  /* Only the sweep reports `failed`, after the checkout expired unpaid. */
  if (verified.status === 'failed') {
    purchase.status = 'failed';
    await purchase.save();
  }
  return purchase;
}

/**
 * Asks Bachs about a checkout, if there is one to ask about.
 *
 * `null` for a record with no checkout id — rows from the Paystack era, or an
 * order created while payments were unconfigured. Those keep whatever status
 * they already have; there is no provider left to ask about them.
 */
async function confirmWithProvider(
  checkoutId: string | undefined,
): Promise<VerifiedPayment | null> {
  return checkoutId ? getCheckout(checkoutId) : null;
}

/**
 * Confirms a payment when the customer returns from the hosted checkout.
 *
 * Their browser's claim of success is not trusted — only the provider's
 * answer is. This exists so the order page updates the moment they land,
 * rather than waiting on the webhook; the webhook remains the source of truth
 * and settles anything this misses.
 */
export async function verifyOrderPayment(req: Request, res: Response): Promise<void> {
  const reference = req.params.reference.toUpperCase();

  /* One return URL serves every flow, so the reference decides which this is. */
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

  const purchase = await GamePurchase.findOne({ reference });
  if (purchase) {
    await verifyGamePurchasePayment(req, res, purchase);
    return;
  }

  const order = await Order.findOne({ reference });
  if (!order) throw ApiError.notFound('We could not find that payment');

  const user = req.user!;
  if (order.user.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('That order belongs to someone else');
  }

  const verified =
    order.status === 'awaiting_payment'
      ? await confirmWithProvider(order.payment?.checkoutId)
      : null;
  const updated = verified ? await applyVerifiedPayment(order, verified) : order;

  res.json({ success: true, data: { kind: 'order', ...toOrderResponse(updated) } });
}

async function verifyAdPayment(req: Request, res: Response, campaign: IAdCampaign): Promise<void> {
  const user = req.user!;
  if (campaign.advertiser.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('That campaign belongs to someone else');
  }

  const verified =
    campaign.status === 'awaiting_payment' ? await confirmWithProvider(campaign.checkoutId) : null;
  const updated = verified ? await applyVerifiedAdPayment(campaign, verified) : campaign;

  res.json({ success: true, data: { kind: 'ad', ...toAdCampaignResponse(updated) } });
}

async function verifyGamePurchasePayment(
  req: Request,
  res: Response,
  purchase: IGamePurchase,
): Promise<void> {
  const user = req.user!;
  if (!purchase.user.equals(user._id) && user.role !== 'admin') {
    throw ApiError.forbidden('That purchase belongs to someone else');
  }

  const verified =
    purchase.status === 'pending' ? await confirmWithProvider(purchase.checkoutId) : null;
  const updated = verified ? await applyVerifiedGamePurchase(purchase, verified) : purchase;

  /* The game's slug, so the return page can send the player back to it. */
  const game = await Game.findById(updated.game).select('slug title');
  res.json({
    success: true,
    data: {
      kind: 'game',
      game: game?.slug ?? null,
      gameTitle: game?.title ?? '',
      ...toPurchaseResponse(updated),
    },
  });
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

  const verified =
    contribution.status === 'pending' ? await confirmWithProvider(contribution.checkoutId) : null;
  const updated = verified ? await applyVerifiedContribution(contribution, verified) : contribution;

  /*
   * The launch's slug, so the return page can send the backer back to the
   * launch they backed. Without it every contribution used to land on the
   * order page, which only knows orders — so a backer who had just paid was
   * shown "could not find that order".
   */
  const item = await Item.findById(updated.item).select('slug');

  res.json({
    success: true,
    data: {
      kind: 'contribution',
      itemSlug: item?.slug ?? null,
      ...toContributionResponse(updated),
    },
  });
}

/* -------------------------------------------------------------- webhook --- */

interface PaymentEventData {
  checkout_id?: string | null;
  reference?: string | null;
  charge_id?: string | null;
  status?: string;
  payment_status?: string;
  amount?: string;
  currency?: string | null;
  completed_at?: string | null;
  charge?: { id?: string } | null;
}

/**
 * Turns a payment event into the same shape `getCheckout` returns.
 *
 * Two events mean money arrived, per the docs: `collection.succeeded` (status
 * `SUCCEEDED`, `OVERPAID`, or `ACCEPTED` for an amount other than the one due)
 * and `checkout.completed` with `payment_status: "paid"`. Either can arrive
 * first and both arrive for one checkout; the apply functions are idempotent,
 * so whichever lands second finds the work done.
 *
 * The signed payload is trusted as-is. The signature *is* the authentication,
 * and Bachs names the webhook as the source of truth — re-asking the API would
 * add a round trip and a second thing that can fail, and prove nothing new.
 * `ACCEPTED` is passed through as success deliberately: the amount check in
 * `coversAmount` is what decides whether a short payment counts.
 */
function paymentFromEvent(event: BachsEvent): VerifiedPayment | null {
  const data = event.data as PaymentEventData;
  if (!data.amount) return null;

  if (event.type === 'collection.succeeded') {
    const collected = ['SUCCEEDED', 'OVERPAID', 'ACCEPTED'].includes(data.status ?? '');
    if (!collected) return null;
    return {
      status: 'success',
      amountMinor: toMinor(data.amount),
      currency: data.currency ?? '',
      paidAt: event.created_at,
      chargeId: data.charge_id ?? null,
    };
  }

  if (event.type === 'checkout.completed' && data.payment_status === 'paid') {
    return {
      status: 'success',
      amountMinor: toMinor(data.amount),
      currency: data.currency ?? '',
      paidAt: data.completed_at ?? event.created_at,
      chargeId: data.charge?.id ?? null,
    };
  }

  /*
   * Deliberately ignored: `collection.failed`. A failed collection is one
   * declined attempt, and the customer can try again inside the same
   * checkout. Cancelling on it would release the stock — and then a retry that
   * succeeds would find the order cancelled and refuse money that had already
   * moved. Expiry is handled by the sweep, which asks Bachs first.
   */
  return null;
}

/**
 * Applies a verified payment to whichever record owns it.
 *
 * Looked up by our reference first — Bachs echoes it on every payment event —
 * and by checkout id only when the reference is missing, which the docs allow
 * for (both fields are nullable on the events).
 */
async function settle(
  reference: string | null | undefined,
  checkoutId: string | null | undefined,
  verified: VerifiedPayment,
): Promise<void> {
  const ref = reference?.toUpperCase();
  if (!ref && !checkoutId) return;

  const contribution = await Contribution.findOne(ref ? { reference: ref } : { checkoutId });
  if (contribution) {
    await applyVerifiedContribution(contribution, verified);
    return;
  }

  const campaign = await AdCampaign.findOne(ref ? { reference: ref } : { checkoutId });
  if (campaign) {
    await applyVerifiedAdPayment(campaign, verified);
    return;
  }

  const purchase = await GamePurchase.findOne(ref ? { reference: ref } : { checkoutId });
  if (purchase) {
    await applyVerifiedGamePurchase(purchase, verified);
    return;
  }

  const order = await Order.findOne(
    ref ? { reference: ref } : { 'payment.checkoutId': checkoutId },
  );
  if (order) await applyVerifiedPayment(order, verified);
}

/**
 * Bachs webhook.
 *
 * The signature covers the raw body, so this route is mounted with a raw body
 * parser ahead of the JSON one — re-serialising parsed JSON changes the bytes.
 *
 * Response codes are chosen for Bachs's retry rules: 2xx is success, 5xx is retried (up to five tries over ~80
 * minutes), and other 4xx are not retried at all.
 *
 *  - Bad signature → 401, never retried. It is not from Bachs.
 *  - Already processed → 200. Delivery is at-least-once.
 *  - A permanent problem with this payment (an amount that does not match)
 *    → logged loudly, recorded, 200. Retrying cannot fix it.
 *  - Anything unexpected → 500, so Bachs retries. The old handler answered 200
 *    whatever happened, which meant a database hiccup lost the payment.
 *
 * The event id is recorded only *after* success, so a failed attempt is free
 * to run again on the retry.
 */
export async function bachsWebhook(req: Request, res: Response): Promise<void> {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw)) {
    res.status(400).json({ success: false, error: { message: 'Expected a raw body' } });
    return;
  }

  const event = verifyWebhook(raw, (name) => req.header(name));
  if (!event) {
    res.status(401).json({ success: false, error: { message: 'Invalid signature' } });
    return;
  }

  if (await WebhookEvent.exists({ eventId: event.id })) {
    res.json({ success: true, data: { duplicate: true } });
    return;
  }

  let note: string | undefined;
  try {
    if (event.type.startsWith('account.') || event.type.startsWith('capability.')) {
      await handleConnectEvent(event);
    } else {
      const verified = paymentFromEvent(event);
      if (verified) {
        const data = event.data as PaymentEventData;
        await settle(data.reference, data.checkout_id, verified);
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.statusCode < 500) {
      /* Permanent — most often an amount that does not match the order. */
      note = error.message;
      // eslint-disable-next-line no-console
      console.error(`[bachs] ${event.type} ${event.id} could not be applied:`, error.message);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[bachs] ${event.type} ${event.id} failed, asking for a retry:`, error);
      res.status(500).json({ success: false, error: { message: 'Temporary failure' } });
      return;
    }
  }

  /* Two deliveries racing can both get here; the unique index decides. */
  await WebhookEvent.create({ eventId: event.id, type: event.type, note }).catch(() => undefined);
  res.json({ success: true, data: { received: true } });
}
