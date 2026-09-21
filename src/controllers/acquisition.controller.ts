import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { ACQUISITION_FEE_PERCENT, CURRENCY } from '../constants';
import { Acquisition, Bid, type IAcquisition } from '../models/Acquisition';
import { Item } from '../models/Item';
import { toAcquisitionResponse, toAcquisitionSummary, toBidResponse } from '../serializers';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { ApiError } from '../utils/ApiError';
import type {
  CreateAcquisitionInput,
  CreateBidInput,
  ListAcquisitionsQuery,
  ReviewAcquisitionInput,
  UpdateAcquisitionInput,
} from '../validators/acquisition.validators';

const SELLER_FIELDS = 'name username avatarUrl headline verified';
const ITEM_FIELDS = 'name slug tagline logoUrl wallColour category voteCount';

/** Deck's cut of an agreed price, rounded once so fee + net is exactly gross. */
export function acquisitionFee(grossMinor: number): { feeMinor: number; netMinor: number } {
  const gross = Math.max(0, Math.round(grossMinor));
  const feeMinor = Math.round((gross * ACQUISITION_FEE_PERCENT) / 100);
  return { feeMinor, netMinor: gross - feeMinor };
}

/**
 * The public board. Approved and sold listings only.
 *
 * Sold ones stay visible rather than being hidden. A marketplace where
 * completed deals vanish looks permanently empty, and "three sold this quarter"
 * is the single most useful thing a seller deciding whether to list can see.
 * They are excluded from the default sort's top by being filtered on status in
 * the UI, not here — the API tells the truth and the page chooses.
 */
export async function listAcquisitions(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListAcquisitionsQuery;
  const skip = (query.page - 1) * query.limit;

  const filter: mongoose.FilterQuery<IAcquisition> = { status: { $in: ['approved', 'sold'] } };
  if (query.maxPrice !== undefined) filter.askingMinor = { $lte: query.maxPrice * 100 };

  /*
   * Search runs against the *launch*, not the listing.
   *
   * Somebody looking for "a CRM" is searching for a product, and the words that
   * would match live on the item — its name and tagline — while the listing
   * holds why the founder is leaving. Two queries rather than an aggregation
   * because the item set is small and a $lookup here would be harder to read
   * for no measurable gain.
   */
  if (query.search) {
    const pattern = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const items = await Item.find({ $or: [{ name: pattern }, { tagline: pattern }] })
      .select('_id')
      .limit(200);
    filter.item = { $in: items.map((item) => item._id) };
  }

  const sortMap: Record<ListAcquisitionsQuery['sort'], Record<string, 1 | -1>> = {
    newest: { createdAt: -1 },
    'price-high': { askingMinor: -1 },
    'price-low': { askingMinor: 1 },
    'most-bids': { bidCount: -1, askingMinor: -1 },
  };

  const [total, listings] = await Promise.all([
    Acquisition.countDocuments(filter),
    Acquisition.find(filter)
      .sort(sortMap[query.sort])
      .skip(skip)
      .limit(query.limit)
      .populate('item', ITEM_FIELDS)
      .populate('seller', SELLER_FIELDS),
  ]);

  res.json({
    success: true,
    data: listings.map(toAcquisitionSummary),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + listings.length < total,
      feePercent: ACQUISITION_FEE_PERCENT,
    },
  });
}

/**
 * One listing.
 *
 * A pending or rejected listing is readable by its seller and by staff, and is
 * a 404 to everybody else — the same shape the blog uses for drafts. Answering
 * 403 would let anyone confirm that a given product is quietly up for sale,
 * which is exactly the fact a seller is trusting Deck to keep until it is
 * approved.
 */
export async function getAcquisition(req: Request, res: Response): Promise<void> {
  const listing = await Acquisition.findOne({ slug: req.params.slug })
    .populate('item', ITEM_FIELDS)
    .populate('seller', SELLER_FIELDS);

  if (!listing) throw ApiError.notFound('We could not find that listing');

  const viewer = req.user;
  const isSeller = viewer && listing.seller._id.toString() === viewer._id.toString();
  const isStaff = viewer?.role === 'admin';
  const isPublic = listing.status === 'approved' || listing.status === 'sold';

  if (!isPublic && !isSeller && !isStaff) {
    throw ApiError.notFound('We could not find that listing');
  }

  /* Offers are the seller's to read, not the room's. Everybody else gets the
     count and the highest, which are already on the summary — see the note on
     the Bid model for why publishing the list would suppress offers. */
  const bids =
    isSeller || isStaff
      ? await Bid.find({ acquisition: listing._id, status: { $ne: 'withdrawn' } })
          .sort({ amountMinor: -1 })
          .populate('bidder', SELLER_FIELDS)
      : [];

  /* A buyer can always see their own offer, wherever it sits in the list. */
  const own =
    viewer && !isSeller
      ? await Bid.findOne({ acquisition: listing._id, bidder: viewer._id, status: 'active' })
      : null;

  res.json({
    success: true,
    data: {
      ...toAcquisitionResponse(listing),
      bids: bids.map(toBidResponse),
      yourBid: own ? toBidResponse(own) : null,
    },
  });
}

/**
 * Lists a launch for acquisition. Owner only, and it starts as an application.
 *
 * Staff review for the same reason fundraises are reviewed: an approved listing
 * carries Deck's name on somebody's asking price, and the first fraudulent
 * listing is Deck's problem regardless of who wrote it.
 */
export async function createAcquisition(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateAcquisitionInput;

  const item = await Item.findOne({ slug: req.params.slug });
  if (!item) throw ApiError.notFound('We could not find that launch');

  const user = req.user!;
  if (item.submittedBy.toString() !== user._id.toString()) {
    throw ApiError.forbidden('Only the person who launched this can list it');
  }

  const existing = await Acquisition.findOne({ item: item._id });
  if (existing) {
    /* Re-listing after a rejection or a withdrawal is normal and should not
       need a new launch. Anything else is a duplicate. */
    if (existing.status === 'rejected' || existing.status === 'withdrawn') {
      Object.assign(existing, toDocument(input), {
        status: 'pending',
        appliedAt: new Date(),
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: undefined,
      });
      await existing.save();
      await existing.populate('item', ITEM_FIELDS);
      await existing.populate('seller', SELLER_FIELDS);
      res.status(200).json({ success: true, data: toAcquisitionResponse(existing) });
      return;
    }

    throw ApiError.badRequest(
      existing.status === 'sold'
        ? 'This launch has already been sold through Deck'
        : 'This launch is already listed',
    );
  }

  const listing = await Acquisition.create({
    ...toDocument(input),
    item: item._id,
    /* The launch's slug at listing time. Copied rather than joined so the
       acquisition URL survives the product being renamed. */
    slug: item.slug,
    seller: user._id,
    currency: CURRENCY,
  });

  await listing.populate('item', ITEM_FIELDS);
  await listing.populate('seller', SELLER_FIELDS);

  res.status(201).json({ success: true, data: toAcquisitionResponse(listing) });
}

/** Maps the validated body onto document fields, converting money to minor. */
function toDocument(input: Partial<CreateAcquisitionInput>) {
  const doc: Record<string, unknown> = {};
  if (input.asking !== undefined) doc.askingMinor = input.asking * 100;
  if (input.negotiable !== undefined) doc.negotiable = input.negotiable;
  if (input.reason !== undefined) doc.reason = input.reason;
  if (input.assets !== undefined) doc.assets = input.assets;
  if (input.monthlyRevenue !== undefined) doc.monthlyRevenueMinor = input.monthlyRevenue * 100;
  if (input.monthlyCost !== undefined) doc.monthlyCostMinor = input.monthlyCost * 100;
  if (input.activeUsers !== undefined) doc.activeUsers = input.activeUsers;
  if (input.notes !== undefined) doc.notes = input.notes || undefined;
  return doc;
}

/** Edits a listing. Seller or staff, and not once it is sold. */
export async function updateAcquisition(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateAcquisitionInput;

  const listing = await Acquisition.findOne({ slug: req.params.slug });
  if (!listing) throw ApiError.notFound('We could not find that listing');

  const user = req.user!;
  const isSeller = listing.seller.toString() === user._id.toString();
  if (!isSeller && user.role !== 'admin') {
    throw ApiError.forbidden('Only the seller can edit this listing');
  }

  if (listing.status === 'sold') {
    throw ApiError.badRequest('This one is sold — its terms are part of the record now');
  }

  Object.assign(listing, toDocument(input));
  await listing.save();
  await listing.populate('item', ITEM_FIELDS);
  await listing.populate('seller', SELLER_FIELDS);

  res.json({ success: true, data: toAcquisitionResponse(listing) });
}

/**
 * Takes a listing down. Seller withdraws; staff removes.
 *
 * Neither deletes. A withdrawn listing keeps its bids so a buyer can still see
 * what happened to the offer they made, and a removed one keeps the evidence
 * behind the removal. Both are invisible on the board.
 */
export async function withdrawAcquisition(req: Request, res: Response): Promise<void> {
  const listing = await Acquisition.findOne({ slug: req.params.slug });
  if (!listing) throw ApiError.notFound('We could not find that listing');

  const user = req.user!;
  const isSeller = listing.seller.toString() === user._id.toString();
  if (!isSeller && user.role !== 'admin') {
    throw ApiError.forbidden('Only the seller can withdraw this listing');
  }

  if (listing.status === 'sold') {
    throw ApiError.badRequest('A completed sale cannot be withdrawn');
  }

  listing.status = 'withdrawn';
  await listing.save();

  /* Every live offer is declined with it, so nobody is left believing their
     offer is still in front of somebody. */
  await Bid.updateMany({ acquisition: listing._id, status: 'active' }, { status: 'declined' });

  if (!isSeller) {
    await audit(req, {
      action: 'acquisition.removed',
      targetType: 'acquisition',
      targetId: listing._id,
      targetLabel: listing.slug,
      summary: `Removed the acquisition listing for "${listing.slug}"`,
      before: { status: 'approved', askingMinor: listing.askingMinor },
    });
  }

  res.json({ success: true, data: { withdrawn: true } });
}

/* -------------------------------------------------------------- staff --- */

export async function listAcquisitionApplications(req: Request, res: Response): Promise<void> {
  const listings = await Acquisition.find()
    .sort({ status: 1, appliedAt: -1 })
    .populate('item', ITEM_FIELDS)
    .populate('seller', SELLER_FIELDS);

  const pending = listings.filter((entry) => entry.status === 'pending');
  const live = listings.filter((entry) => entry.status === 'approved');
  const closed = listings.filter((entry) => entry.status === 'sold');

  res.json({
    success: true,
    data: {
      pending: pending.map(toAcquisitionResponse),
      live: live.map(toAcquisitionSummary),
      sold: closed.map(toAcquisitionSummary),
      totals: {
        feePercent: ACQUISITION_FEE_PERCENT,
        listedMinor: live.reduce((sum, entry) => sum + entry.askingMinor, 0),
        soldMinor: closed.reduce((sum, entry) => sum + entry.soldMinor, 0),
        earnedMinor: closed.reduce((sum, entry) => sum + entry.soldFeeMinor, 0),
        openBids: live.reduce((sum, entry) => sum + entry.bidCount, 0),
      },
    },
  });
}

export async function reviewAcquisition(req: Request, res: Response): Promise<void> {
  const { approve, note } = req.body as ReviewAcquisitionInput;

  const listing = await Acquisition.findOne({ slug: req.params.slug });
  if (!listing) throw ApiError.notFound('We could not find that listing');

  if (listing.status !== 'pending') {
    throw ApiError.badRequest('There is no application waiting on that listing');
  }

  listing.status = approve ? 'approved' : 'rejected';
  listing.reviewedAt = new Date();
  listing.reviewedBy = req.user!._id;
  listing.reviewNote = note;
  await listing.save();

  await listing.populate('item', ITEM_FIELDS);
  await listing.populate('seller', SELLER_FIELDS);

  await audit(req, {
    action: approve ? 'acquisition.approved' : 'acquisition.rejected',
    targetType: 'acquisition',
    targetId: listing._id,
    targetLabel: listing.slug,
    summary: approve
      ? `Approved "${listing.slug}" for acquisition at ${listing.askingMinor / 100} — ${note}`
      : `Turned down the acquisition listing for "${listing.slug}" — ${note}`,
    after: { askingMinor: listing.askingMinor, feePercent: ACQUISITION_FEE_PERCENT, note },
  });

  void notify({
    user: listing.seller,
    kind: 'acquisition.reviewed',
    title: approve
      ? `Your acquisition listing is live`
      : `Your acquisition listing was not approved`,
    body: approve
      ? 'Buyers can see it and make offers now.'
      : note?.trim() || 'Staff reviewed the listing and could not approve it.',
    link: `/acquisitions/${listing.slug}`,
  });

  res.json({ success: true, data: toAcquisitionResponse(listing) });
}

/* --------------------------------------------------------------- bids --- */

/**
 * Makes an offer.
 *
 * Nothing is charged and nothing is held — see the note on the Bid model. One
 * live offer per person per listing: a second submission replaces the first, so
 * the seller reads a list of interested people rather than a history of one
 * person changing their mind.
 */
export async function createBid(req: Request, res: Response): Promise<void> {
  const { amount, message } = req.body as CreateBidInput;

  const listing = await Acquisition.findOne({ slug: req.params.slug });
  if (!listing) throw ApiError.notFound('We could not find that listing');

  if (listing.status !== 'approved') {
    throw ApiError.badRequest(
      listing.status === 'sold' ? 'This one has already sold' : 'This listing is not taking offers',
    );
  }

  const user = req.user!;
  if (listing.seller.toString() === user._id.toString()) {
    throw ApiError.badRequest('You cannot bid on your own listing');
  }

  const amountMinor = amount * 100;

  /*
   * A firm asking price means what it says.
   *
   * When the seller has marked the listing non-negotiable, an offer below the
   * asking price is refused here rather than passed on — otherwise "not
   * negotiable" is decoration and the seller ends up declining lowballs by
   * hand, which is the work they were trying to avoid.
   */
  if (!listing.negotiable && amountMinor < listing.askingMinor) {
    throw ApiError.badRequest(
      'The seller has set a firm price. Offers below the asking price are not accepted on this one.',
    );
  }

  /* Replace rather than insert — the unique partial index would reject a second
     active bid anyway, and a clear update beats catching a duplicate-key error. */
  const bid = await Bid.findOneAndUpdate(
    { acquisition: listing._id, bidder: user._id, status: 'active' },
    { amountMinor, currency: listing.currency, message, status: 'active' },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).populate('bidder', SELLER_FIELDS);

  await refreshBidTotals(listing._id);

  res.status(201).json({ success: true, data: toBidResponse(bid) });
}

/** Withdraws your own offer. */
export async function withdrawBid(req: Request, res: Response): Promise<void> {
  const bid = await Bid.findById(req.params.id);
  if (!bid) throw ApiError.notFound('We could not find that offer');

  if (bid.bidder.toString() !== req.user!._id.toString()) {
    throw ApiError.forbidden('That is not your offer');
  }
  if (bid.status !== 'active') throw ApiError.badRequest('That offer is no longer open');

  bid.status = 'withdrawn';
  await bid.save();
  await refreshBidTotals(bid.acquisition);

  res.json({ success: true, data: { withdrawn: true } });
}

/**
 * Accepts an offer. Seller only.
 *
 * This is the moment the deal becomes a record: the agreed price and Deck's
 * commission at the rate in force are written onto the listing and never
 * recomputed. Everything else on the listing is closed at the same time, so no
 * other bidder is left with an offer that looks live.
 *
 * Audited, because it is the event Deck later invoices against.
 */
export async function acceptBid(req: Request, res: Response): Promise<void> {
  const listing = await Acquisition.findOne({ slug: req.params.slug });
  if (!listing) throw ApiError.notFound('We could not find that listing');

  if (listing.seller.toString() !== req.user!._id.toString()) {
    throw ApiError.forbidden('Only the seller can accept an offer');
  }
  if (listing.status !== 'approved') {
    throw ApiError.badRequest('This listing is not taking offers');
  }

  const bid = await Bid.findOne({
    _id: req.params.id,
    acquisition: listing._id,
    status: 'active',
  }).populate('bidder', SELLER_FIELDS);

  if (!bid) throw ApiError.notFound('That offer is no longer open');

  const { feeMinor } = acquisitionFee(bid.amountMinor);

  bid.status = 'accepted';
  await bid.save();

  listing.status = 'sold';
  listing.soldAt = new Date();
  listing.soldMinor = bid.amountMinor;
  listing.soldFeeMinor = feeMinor;
  listing.soldTo = bid.bidder._id;
  await listing.save();

  await Bid.updateMany(
    { acquisition: listing._id, status: 'active' },
    { status: 'declined' },
  );

  await listing.populate('item', ITEM_FIELDS);
  await listing.populate('seller', SELLER_FIELDS);

  await audit(req, {
    action: 'acquisition.sold',
    targetType: 'acquisition',
    targetId: listing._id,
    targetLabel: listing.slug,
    summary:
      `"${listing.slug}" sold for ${bid.amountMinor / 100} ${listing.currency} — ` +
      `Deck's ${ACQUISITION_FEE_PERCENT}% is ${feeMinor / 100}`,
    after: {
      soldMinor: bid.amountMinor,
      feeMinor,
      feePercent: ACQUISITION_FEE_PERCENT,
      buyer: bid.bidder._id.toString(),
    },
  });

  res.json({ success: true, data: toAcquisitionResponse(listing) });
}

/**
 * Recomputes the denormalised bid figures from the bids themselves.
 *
 * Derived rather than incremented, unlike the forum's reply count. A bid can be
 * replaced, withdrawn or declined, so an `$inc` would need a matching decrement
 * on four different paths and would drift the first time one was missed — and
 * the number it would drift on is the one buyers use to judge demand. One
 * aggregation over a handful of rows is cheap enough to be worth being right.
 */
async function refreshBidTotals(acquisitionId: mongoose.Types.ObjectId): Promise<void> {
  const [totals] = await Bid.aggregate<{ count: number; highest: number }>([
    { $match: { acquisition: acquisitionId, status: 'active' } },
    { $group: { _id: null, count: { $sum: 1 }, highest: { $max: '$amountMinor' } } },
  ]);

  await Acquisition.updateOne(
    { _id: acquisitionId },
    { bidCount: totals?.count ?? 0, highestBidMinor: totals?.highest ?? 0 },
  );
}
