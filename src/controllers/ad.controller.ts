import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import {
  AD_DAY_RATE_MINOR,
  AD_DURATIONS,
  AD_PLACEMENT_LABELS,
  AD_PLACEMENTS,
  AD_SLOT_CAPACITY,
  CURRENCY,
  type AdPlacement,
} from '../constants';
import { AdCampaign } from '../models/AdCampaign';
import { Item } from '../models/Item';
import { assertSlotOpen } from '../services/adInventory';
import { audit } from '../services/audit';
import { bachsConfigured, checkoutReturnUrls, createCheckout } from '../services/bachs';
import { toAdCampaignResponse, toServedAdResponse } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type { CreateAdInput, PullAdInput, RejectAdInput } from '../validators/ad.validators';
import { assertClaimed } from '../utils/itemScope';

/** Same alphabet as every other Deck reference: no 0/O/1/I. */
function adReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  return `AD-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The public rate card, so the form can quote a price before anything is sent. */
export function getRateCard(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: {
      currency: CURRENCY,
      durations: AD_DURATIONS,
      /* How many ads share a slot at once, so the form can say whether a
         booking buys the slot outright or a turn in a rotation. */
      capacity: AD_SLOT_CAPACITY,
      placements: AD_PLACEMENTS.map((placement) => ({
        placement,
        label: AD_PLACEMENT_LABELS[placement],
        dayRateMinor: AD_DAY_RATE_MINOR[placement],
        prices: AD_DURATIONS.map((days) => ({
          days,
          priceMinor: AD_DAY_RATE_MINOR[placement] * days,
        })),
      })),
    },
  });
}

/**
 * Books a placement.
 *
 * Priced here from the rate card, never from the payload. The campaign lands in
 * review unpaid: Deck looks at it first, and only then is there anything to pay.
 * That ordering is what keeps a rejection from becoming a refund.
 */
export async function createAd(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateAdInput;
  const user = req.user!;

  const item = await Item.findOne({ slug: input.itemSlug });
  if (!item) throw ApiError.notFound('We could not find that launch');

  if (item.submittedBy.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('You can only advertise your own launches');
  }
  assertClaimed(item, 'advertise it');

  const startAt = input.startAt ? new Date(input.startAt) : new Date();
  if (startAt.getTime() < Date.now() - DAY_MS) {
    throw ApiError.badRequest('A campaign cannot start in the past');
  }

  /* Before anything is written: an ad that could not run on these dates
     should not reach the review queue at all. */
  await assertSlotOpen(input.placement, startAt, input.days);

  const priceMinor = AD_DAY_RATE_MINOR[input.placement] * input.days;

  const campaign = await AdCampaign.create({
    reference: adReference(),
    advertiser: user._id,
    item: item._id,
    placement: input.placement,
    headline: input.headline,
    body: input.body,
    imageUrl: input.imageUrl || undefined,
    ctaLabel: input.ctaLabel,
    days: input.days,
    startAt,
    endAt: new Date(startAt.getTime() + input.days * DAY_MS),
    priceMinor,
    currency: CURRENCY,
    status: 'pending_review',
  });

  await campaign.populate('item', 'name slug logoUrl');

  res.status(201).json({ success: true, data: toAdCampaignResponse(campaign) });
}

/** The advertiser's own campaigns, with their numbers. */
export async function listMyAds(req: Request, res: Response): Promise<void> {
  const campaigns = await AdCampaign.find({ advertiser: req.user!._id })
    .populate('item', 'name slug logoUrl')
    .sort({ createdAt: -1 });

  res.json({ success: true, data: campaigns.map(toAdCampaignResponse) });
}

/**
 * Opens payment for an approved campaign.
 *
 * Only reachable once review has passed, so nobody can pay for something that
 * was never going to run. The window is re-anchored to now if the approval took
 * long enough that the requested start has already gone by — an advertiser
 * should get the days they paid for, not the days that were left.
 */
export async function payForAd(req: Request, res: Response): Promise<void> {
  const campaign = await AdCampaign.findOne({ reference: req.params.reference.toUpperCase() });
  if (!campaign) throw ApiError.notFound('We could not find that campaign');

  const user = req.user!;
  if (campaign.advertiser.toString() !== user._id.toString()) {
    throw ApiError.forbidden('That campaign belongs to someone else');
  }
  if (campaign.status !== 'awaiting_payment') {
    throw ApiError.badRequest(
      campaign.status === 'pending_review'
        ? 'This campaign is still being reviewed'
        : 'This campaign is not waiting on payment',
    );
  }
  if (campaign.startAt.getTime() < Date.now()) {
    campaign.startAt = new Date();
    campaign.endAt = new Date(Date.now() + campaign.days * DAY_MS);
  }

  /* The authoritative check. The slot may have been bought by somebody else
     since this was booked, and it is far better to say so here than to take
     the money for dates that are gone. Ahead of the configuration check, so
     the advertiser hears about their dates rather than about the server. */
  await assertSlotOpen(campaign.placement, campaign.startAt, campaign.days, campaign._id);

  if (!bachsConfigured()) {
    throw ApiError.badRequest('Payments are not configured on this server');
  }

  const checkout = await createCheckout({
    amountMinor: campaign.priceMinor,
    currency: campaign.currency,
    email: user.email,
    name: user.name,
    reference: campaign.reference,
    ...checkoutReturnUrls(campaign.reference),
    metadata: { kind: 'ad', adId: campaign.id, placement: campaign.placement },
  });

  campaign.authorizationUrl = checkout.checkoutUrl;
  campaign.checkoutId = checkout.checkoutId;
  await campaign.save();

  res.json({
    success: true,
    data: { ...toAdCampaignResponse(campaign), authorizationUrl: checkout.checkoutUrl },
  });
}

/* ------------------------------------------------------------- serving --- */

/**
 * The ad for one slot, or nothing.
 *
 * Rotation is least-served-first. Random would be simpler but leaves delivery
 * uneven over a short run — an advertiser who bought seven days should not get
 * a third of another's impressions because a coin kept landing badly.
 *
 * The impression is counted with a targeted `$inc` rather than a read-modify-
 * write, so two simultaneous page loads cannot both read 40 and both write 41.
 */
export async function serveAd(req: Request, res: Response): Promise<void> {
  const placement = req.params.placement as AdPlacement;
  if (!AD_PLACEMENTS.includes(placement)) {
    throw ApiError.badRequest('That is not a placement');
  }

  const now = new Date();
  const campaign = await AdCampaign.findOne({
    placement,
    status: 'live',
    startAt: { $lte: now },
    endAt: { $gt: now },
  })
    .sort({ impressions: 1, createdAt: 1 })
    .populate('item', 'name slug logoUrl');

  if (!campaign) {
    /* No paid ad. The client falls back to its own filler from here — the
       server's job is only to say the slot is unsold. */
    res.json({ success: true, data: null });
    return;
  }

  await AdCampaign.updateOne({ _id: campaign._id }, { $inc: { impressions: 1 } });

  res.json({ success: true, data: toServedAdResponse(campaign) });
}

/**
 * Records a click and hands back where to go.
 *
 * The destination comes from the campaign's own launch, not from the request —
 * a paid slot that redirected wherever the caller asked would be an open
 * redirect wearing Deck's endorsement.
 */
export async function recordAdClick(req: Request, res: Response): Promise<void> {
  const campaign = await AdCampaign.findOne({
    reference: req.params.reference.toUpperCase(),
  }).populate('item', 'slug');

  if (!campaign) throw ApiError.notFound('We could not find that campaign');

  await AdCampaign.updateOne({ _id: campaign._id }, { $inc: { clicks: 1 } });

  const item = campaign.item as unknown as { slug?: string };
  res.json({ success: true, data: { href: item.slug ? `/item/${item.slug}` : '/' } });
}

/* --------------------------------------------------------------- staff --- */

export async function listPendingAds(_req: Request, res: Response): Promise<void> {
  const campaigns = await AdCampaign.find({ status: 'pending_review' })
    .populate('item', 'name slug logoUrl')
    .populate('advertiser', 'username name avatarUrl')
    .sort({ createdAt: 1 });

  res.json({ success: true, data: campaigns.map(toAdCampaignResponse) });
}

export async function reviewAd(req: Request, res: Response): Promise<void> {
  const campaign = await AdCampaign.findOne({ reference: req.params.reference.toUpperCase() });
  if (!campaign) throw ApiError.notFound('We could not find that campaign');

  if (campaign.status !== 'pending_review') {
    throw ApiError.badRequest('That campaign has already been reviewed');
  }

  const approving = req.path.endsWith('/approve');
  const { reason } = (req.body ?? {}) as RejectAdInput;

  campaign.status = approving ? 'awaiting_payment' : 'rejected';
  campaign.rejectionReason = approving ? undefined : reason;
  campaign.reviewedAt = new Date();
  await campaign.save();

  await audit(req, {
    action: approving ? 'ad.approved' : 'ad.rejected',
    targetType: 'ad',
    targetId: campaign.reference,
    targetLabel: `${campaign.reference} — "${campaign.headline}"`,
    summary: approving
      ? `Approved ad "${campaign.headline}" for the ${campaign.placement} slot`
      : `Rejected ad "${campaign.headline}": ${reason}`,
    before: { status: 'pending_review' },
    after: { status: campaign.status, rejectionReason: campaign.rejectionReason },
  });

  await campaign.populate('item', 'name slug logoUrl');

  res.json({ success: true, data: toAdCampaignResponse(campaign) });
}

/**
 * Everything paid for that has not finished: running now, or booked to start.
 *
 * The other half of the staff view. The review queue only ever shows campaigns
 * before money moves; this is where a campaign lives afterwards, and where it
 * can be pulled.
 */
export async function listRunningAds(_req: Request, res: Response): Promise<void> {
  const campaigns = await AdCampaign.find({ status: 'live', endAt: { $gt: new Date() } })
    .populate('item', 'name slug logoUrl')
    .populate('advertiser', 'username name avatarUrl')
    .sort({ startAt: 1 });

  res.json({ success: true, data: campaigns.map(toAdCampaignResponse) });
}

/**
 * Takes a paid campaign down, now.
 *
 * For what review missed — a creative that turns out to mislead, a launch that
 * was removed, a complaint that holds up. It stops serving on the next slot
 * request (pages that already hold the ad keep it for up to the five minutes
 * the client caches a slot).
 *
 * Only a live campaign can be pulled. An approved one still waiting on payment
 * is left alone on purpose: its advertiser may be at checkout
 * right now, and cancelling underneath them would take their money for an ad
 * that can no longer run.
 *
 * It does not refund. Deck has no refund flow, so whatever the advertiser is
 * owed for the unused days has to be returned from the Bachs dashboard; the
 * audit entry records the days left so that figure is not a guess.
 */
export async function pullAd(req: Request, res: Response): Promise<void> {
  const campaign = await AdCampaign.findOne({ reference: req.params.reference.toUpperCase() });
  if (!campaign) throw ApiError.notFound('We could not find that campaign');

  const now = Date.now();
  if (campaign.status !== 'live' || campaign.endAt.getTime() <= now) {
    throw ApiError.badRequest('Only a paid campaign that has not finished can be pulled');
  }

  const { reason } = req.body as PullAdInput;
  const unusedFrom = Math.max(now, campaign.startAt.getTime());
  const daysLeft = Math.ceil((campaign.endAt.getTime() - unusedFrom) / DAY_MS);

  campaign.status = 'cancelled';
  campaign.cancelReason = reason;
  campaign.cancelledAt = new Date(now);
  await campaign.save();

  await audit(req, {
    action: 'ad.pulled',
    targetType: 'ad',
    targetId: campaign.reference,
    targetLabel: `${campaign.reference} — "${campaign.headline}"`,
    summary: `Pulled ad "${campaign.headline}" from the ${campaign.placement} slot with ${daysLeft} of ${campaign.days} days left: ${reason}`,
    before: { status: 'live' },
    after: { status: 'cancelled', cancelReason: reason, daysLeft, priceMinor: campaign.priceMinor },
  });

  await campaign.populate('item', 'name slug logoUrl');

  res.json({ success: true, data: toAdCampaignResponse(campaign) });
}
