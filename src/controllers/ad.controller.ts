import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import {
  AD_DAY_RATE_MINOR,
  AD_DURATIONS,
  AD_PLACEMENT_LABELS,
  AD_PLACEMENTS,
  CURRENCY,
  type AdPlacement,
} from '../constants';
import { AdCampaign } from '../models/AdCampaign';
import { Item } from '../models/Item';
import { audit } from '../services/audit';
import { initializeTransaction, paystackConfigured } from '../services/paystack';
import { toAdCampaignResponse, toServedAdResponse } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type { CreateAdInput, RejectAdInput } from '../validators/ad.validators';

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

  const startAt = input.startAt ? new Date(input.startAt) : new Date();
  if (startAt.getTime() < Date.now() - DAY_MS) {
    throw ApiError.badRequest('A campaign cannot start in the past');
  }

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
  if (!paystackConfigured()) {
    throw ApiError.badRequest('Card payments are not configured on this server');
  }

  if (campaign.startAt.getTime() < Date.now()) {
    campaign.startAt = new Date();
    campaign.endAt = new Date(Date.now() + campaign.days * DAY_MS);
  }

  const transaction = await initializeTransaction({
    email: user.email,
    amountMinor: campaign.priceMinor,
    reference: campaign.reference,
    currency: campaign.currency,
    callbackUrl: `${env.paystackCallbackUrl}?reference=${campaign.reference}`,
    metadata: { adId: campaign.id, kind: 'ad', placement: campaign.placement },
  });

  campaign.authorizationUrl = transaction.authorizationUrl;
  await campaign.save();

  res.json({
    success: true,
    data: { ...toAdCampaignResponse(campaign), authorizationUrl: transaction.authorizationUrl },
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
