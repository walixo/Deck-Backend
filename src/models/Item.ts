import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { PRICING_MODELS, type Category, type PricingModel } from '../constants';

/**
 * The launcher's optional fundraise.
 *
 * Off by default and never implied — a launch has to opt in, and can opt back
 * out. `raisedMinor` and `contributorCount` are denormalised running totals,
 * incremented only when Paystack confirms a payment, so the progress bar costs
 * no aggregation on every page view.
 */
export interface FundraiseApplication {
  purpose?: string;
  useOfFunds?: string;
  timeline?: string;
  contact?: string;
}

export interface IFundraise {
  status: 'none' | 'pending' | 'approved' | 'rejected';
  application?: FundraiseApplication;
  appliedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: mongoose.Types.ObjectId | null;
  reviewNote?: string;
  enabled: boolean;
  targetMinor: number;
  raisedMinor: number;
  contributorCount: number;
  pitch?: string;
  /** Set when the launcher stops accepting money without deleting the history. */
  closedAt?: Date | null;
}

export interface IItem extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  category: Category;
  tags: string[];
  pricing: PricingModel;
  websiteUrl: string;
  repoUrl?: string;
  logoUrl?: string;
  coverUrl?: string;
  /** Hex the launcher picked for their wall panel. Absent means sample the logo. */
  wallColour?: string;
  /** A YouTube or Vimeo link. Played in the gallery, behind cookie consent. */
  videoUrl?: string;
  gallery: string[];
  makers: string[];
  submittedBy: mongoose.Types.ObjectId;
  lineage: mongoose.Types.ObjectId;
  version?: string;
  supersedes: mongoose.Types.ObjectId | null;
  launchDate: Date;
  launchDateKey: string;
  featured: boolean;
  /** On Future Gen: the showcase for young African hardware makers. Staff-set. */
  futureGen: boolean;
  voteCount: number;
  commentCount: number;
  reviewCount: number;
  editCount: number;
  ratingSum: number;
  ratingAvg: number;
  fundraise: IFundraise;
  createdAt: Date;
  updatedAt: Date;
}

/*
 * A fundraise is applied for, not switched on.
 *
 * `enabled` used to be the maker's own checkbox, which meant anyone could start
 * taking money from strangers on Deck's rails with no review at all. It is now
 * derived from `status`: only an approved application turns it on, and the
 * maker's remaining control is whether to pause a raise they already have.
 *
 *   none → pending → approved
 *                  ↘ rejected → (may apply again)
 */
const fundraiseSchema = new Schema<IFundraise>(
  {
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none',
      index: true,
    },
    /* What they told us when they applied. Kept after approval — a reviewer
       looking at a dispute months later needs the case that was made. */
    application: {
      purpose: { type: String, trim: true, maxlength: 600 },
      useOfFunds: { type: String, trim: true, maxlength: 600 },
      timeline: { type: String, trim: true, maxlength: 200 },
      contact: { type: String, trim: true, maxlength: 160 },
    },
    appliedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNote: { type: String, trim: true, maxlength: 300 },

    enabled: { type: Boolean, default: false },
    targetMinor: { type: Number, default: 0, min: 0 },
    raisedMinor: { type: Number, default: 0, min: 0 },
    contributorCount: { type: Number, default: 0, min: 0 },
    pitch: { type: String, trim: true, maxlength: 600 },
    closedAt: { type: Date, default: null },
  },
  { _id: false },
);

const itemSchema = new Schema<IItem>(
  {
    name: { type: String, required: true, trim: true, maxlength: 70 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    tagline: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    /* No `enum`: categories are rows now, not a union. Existence is checked
       in the controller — see assertCategory. */
    category: { type: String, required: true, trim: true, index: true },
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 24 }],
    pricing: { type: String, enum: PRICING_MODELS, default: 'free' },
    websiteUrl: { type: String, required: true, trim: true },
    repoUrl: { type: String, trim: true },
    logoUrl: { type: String, trim: true },
    coverUrl: { type: String, trim: true },
    /*
     * The launch wall panel's colour, chosen rather than sampled.
     *
     * Stored as a plain hex and validated as one. The client still puts it
     * through the same contrast pass an extracted colour gets, so what is kept
     * here is the maker's intent — not the adjusted value — and re-deriving it
     * stays possible if the floor ever moves.
     */
    wallColour: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^#[0-9a-f]{6}$/, 'Pick a colour as a six-digit hex, like #b8a9fa'],
    },
    /*
     * A link to a video, not a hosted file.
     *
     * `config/uploads.ts` accepts images only, verified by magic bytes, and
     * widening it to video means new signatures, a much larger size cap and a
     * streaming story — a lot of surface for a field most launches leave empty.
     * A link costs none of that, and the player is gated on cookie consent
     * because an embed is a third party watching the visit.
     */
    videoUrl: { type: String, trim: true },
    gallery: [{ type: String, trim: true }],
    makers: [{ type: String, trim: true, maxlength: 60 }],
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /*
     * Which product this launch is a version of.
     *
     * Points at the first launch in the chain; the first one points at itself,
     * so `Item.find({ lineage })` returns every version including the original
     * with no special case for "is this the root". Self-referential rather than
     * a separate Product collection: each release is already a full launch with
     * its own slug, board day, votes and comments, so the only thing a parent
     * document would add is a join.
     */
    lineage: { type: Schema.Types.ObjectId, ref: 'Item', index: true },
    /** Maker-supplied label, e.g. "2.0". Absent on a product's first launch. */
    version: { type: String, trim: true, maxlength: 24 },
    /** The launch this one supersedes. Null for the original. */
    supersedes: { type: Schema.Types.ObjectId, ref: 'Item', default: null },
    launchDate: { type: Date, default: Date.now, index: true },
    // Denormalised UTC day (YYYY-MM-DD) so daily leaderboards are a cheap indexed lookup.
    launchDateKey: { type: String, required: true, index: true },
    featured: { type: Boolean, default: false, index: true },
    /*
     * Future Gen membership.
     *
     * A flag on a launch rather than a collection of its own, because a Future
     * Gen prototype IS a launch: it wants votes, comments, a fundraise, a
     * version history and a board day, and every one of those already exists
     * here. A parallel model would have to grow all of it again and would drift
     * the first time one of them changed.
     *
     * Staff-set, like `featured`. The page is a curated showcase with a
     * fundraise attached — self-declaration is the wrong gate for something
     * that ends with strangers sending money.
     */
    futureGen: { type: Boolean, default: false, index: true },
    voteCount: { type: Number, default: 0, min: 0, index: true },
    commentCount: { type: Number, default: 0, min: 0 },
    reviewCount: { type: Number, default: 0, min: 0 },
    /* Edits only — revision 1 is the launch as posted, not a change to it. Lets
       the item page decide whether to offer a history without querying for one. */
    editCount: { type: Number, default: 0, min: 0 },
    ratingSum: { type: Number, default: 0, min: 0 },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    fundraise: { type: fundraiseSchema, default: () => ({}) },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

itemSchema.index({ name: 'text', tagline: 'text', description: 'text', tags: 'text' });
itemSchema.index({ launchDateKey: 1, voteCount: -1 });
/* Every version of a product, newest first — the version strip's only query. */
itemSchema.index({ lineage: 1, launchDate: -1 });

/*
 * A launch with no lineage is the start of its own.
 *
 * Cannot be a schema default: the value is the document's own `_id`, which does
 * not exist until it is being created. Doing it here rather than in the
 * controller means a seed, a script or a future handler cannot produce a launch
 * that belongs to no chain — which would make it invisible to its own version
 * strip.
 */
itemSchema.pre('save', function setLineage(next) {
  if (!this.lineage) this.lineage = this._id;
  next();
});

export const Item: Model<IItem> = mongoose.models.Item ?? mongoose.model<IItem>('Item', itemSchema);
