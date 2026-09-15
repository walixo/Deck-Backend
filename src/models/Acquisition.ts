import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A launch offered for sale, and the offers made on it.
 *
 * **Why a collection rather than a subdocument.** The fundraise lives inside
 * `Item` because it is one block of state with no children and is only ever
 * read alongside the launch it belongs to. An acquisition is neither: it has
 * bids hanging off it, and the acquisitions page sorts and filters across every
 * listing by asking price and bid count — queries that would mean scanning
 * every launch on Deck if this were embedded.
 *
 * **What Deck is and is not doing here.** Deck lists the product, takes the
 * offers, and records the agreed price and its 8%. Deck does **not** hold the
 * money. Escrow is a licensed activity in every jurisdiction Deck operates in,
 * and running a six-figure business sale through a card processor built for
 * ₦5,000 t-shirts would be wrong on both counts. Accepting a bid produces a
 * signed record of what was agreed and what Deck is owed; settlement and
 * transfer happen between the two parties, and Deck invoices its commission
 * against that record. The UI says so plainly rather than implying an escrow
 * that does not exist.
 */

export const ACQUISITION_STATUSES = [
  /** Applied for, waiting on staff. Not visible to anybody but the seller. */
  'pending',
  /** Live on the acquisitions page and taking offers. */
  'approved',
  'rejected',
  /** An offer was accepted. Stays readable; takes no new bids. */
  'sold',
  /** Pulled by the seller. Same as sold for visibility, different in meaning. */
  'withdrawn',
] as const;
export type AcquisitionStatus = (typeof ACQUISITION_STATUSES)[number];

/** What is included in the sale. A fixed list so listings are comparable. */
export const ACQUISITION_ASSETS = [
  'source',
  'domain',
  'users',
  'revenue',
  'brand',
  'socials',
  'contracts',
  'support',
] as const;
export type AcquisitionAsset = (typeof ACQUISITION_ASSETS)[number];

export interface IAcquisition extends Document {
  _id: mongoose.Types.ObjectId;
  item: mongoose.Types.ObjectId;
  /** Copied from the launch at listing time so the URL survives a rename. */
  slug: string;
  seller: mongoose.Types.ObjectId;
  status: AcquisitionStatus;

  /** The asking price. This is the figure the page sets in display type. */
  askingMinor: number;
  currency: string;
  /** Whether the seller will look at offers under the asking price. */
  negotiable: boolean;

  /** Why they are selling. The first thing a buyer reads. */
  reason: string;
  /** What the buyer actually gets. */
  assets: AcquisitionAsset[];
  /** Trailing-twelve-month revenue, if any. Zero means pre-revenue, not unknown. */
  monthlyRevenueMinor: number;
  monthlyCostMinor: number;
  activeUsers: number;
  /** Anything else — stack, hosting, handover terms. */
  notes?: string;

  /** Denormalised so the index costs one query. */
  bidCount: number;
  highestBidMinor: number;

  appliedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: mongoose.Types.ObjectId | null;
  reviewNote?: string;

  /** Set when a bid is accepted. The record Deck invoices its commission against. */
  soldAt: Date | null;
  soldMinor: number;
  soldFeeMinor: number;
  soldTo: mongoose.Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

const acquisitionSchema = new Schema<IAcquisition>(
  {
    /* One listing per launch, enforced by the index rather than by a check in
       the controller — two concurrent submissions would both pass a check. */
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true, unique: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ACQUISITION_STATUSES, default: 'pending', index: true },

    askingMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    negotiable: { type: Boolean, default: true },

    reason: { type: String, required: true, trim: true, minlength: 40, maxlength: 1500 },
    assets: [{ type: String, enum: ACQUISITION_ASSETS }],
    monthlyRevenueMinor: { type: Number, default: 0, min: 0 },
    monthlyCostMinor: { type: Number, default: 0, min: 0 },
    activeUsers: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, maxlength: 1500 },

    bidCount: { type: Number, default: 0, min: 0 },
    highestBidMinor: { type: Number, default: 0, min: 0 },

    appliedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNote: { type: String, trim: true, maxlength: 300 },

    soldAt: { type: Date, default: null },
    soldMinor: { type: Number, default: 0, min: 0 },
    /* Stored, not recomputed at read time. The commission rate can change, and
       a deal agreed at 8% must still say 8% after it does. */
    soldFeeMinor: { type: Number, default: 0, min: 0 },
    soldTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

/* The board's two sorts: by price and by activity, both within a status. */
acquisitionSchema.index({ status: 1, askingMinor: -1 });
acquisitionSchema.index({ status: 1, createdAt: -1 });

export const Acquisition: Model<IAcquisition> =
  mongoose.models.Acquisition ?? mongoose.model<IAcquisition>('Acquisition', acquisitionSchema);

/**
 * One offer on a listing.
 *
 * **An offer, not a payment.** Nothing is charged when a bid is placed and
 * nothing is held. Calling it a bid is the familiar word; what it is, legally,
 * is an expression of interest at a number, and the copy says so — because a
 * buyer who thinks they have committed funds and a seller who thinks they have
 * received them are the two halves of a dispute Deck would be in the middle of.
 *
 * Amounts are visible to the seller and to staff. The public page shows the
 * count and the highest, never the list. Publishing every offer turns a private
 * negotiation into an auction where the second bidder can read the first
 * bidder's ceiling, which suppresses offers rather than raising them.
 */
export const BID_STATUSES = ['active', 'withdrawn', 'accepted', 'declined'] as const;
export type BidStatus = (typeof BID_STATUSES)[number];

export interface IBid extends Document {
  _id: mongoose.Types.ObjectId;
  acquisition: mongoose.Types.ObjectId;
  bidder: mongoose.Types.ObjectId;
  amountMinor: number;
  currency: string;
  /** The pitch: who they are and what they would do with it. */
  message: string;
  status: BidStatus;
  createdAt: Date;
  updatedAt: Date;
}

const bidSchema = new Schema<IBid>(
  {
    acquisition: { type: Schema.Types.ObjectId, ref: 'Acquisition', required: true, index: true },
    bidder: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    message: { type: String, required: true, trim: true, minlength: 20, maxlength: 1500 },
    status: { type: String, enum: BID_STATUSES, default: 'active', index: true },
  },
  { timestamps: true },
);

/* Highest first, which is the only order a seller wants to read them in. */
bidSchema.index({ acquisition: 1, amountMinor: -1 });
/* One live offer per person per listing. Raising a bid replaces it rather than
   stacking, so a seller's list is people, not a history of one person's mind. */
bidSchema.index(
  { acquisition: 1, bidder: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

export const Bid: Model<IBid> = mongoose.models.Bid ?? mongoose.model<IBid>('Bid', bidSchema);
