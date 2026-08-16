import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { CATEGORIES, PRICING_MODELS, type Category, type PricingModel } from '../constants';

/**
 * The launcher's optional fundraise.
 *
 * Off by default and never implied — a launch has to opt in, and can opt back
 * out. `raisedMinor` and `contributorCount` are denormalised running totals,
 * incremented only when Paystack confirms a payment, so the progress bar costs
 * no aggregation on every page view.
 */
export interface IFundraise {
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
  gallery: string[];
  makers: string[];
  submittedBy: mongoose.Types.ObjectId;
  launchDate: Date;
  launchDateKey: string;
  featured: boolean;
  voteCount: number;
  commentCount: number;
  reviewCount: number;
  ratingSum: number;
  ratingAvg: number;
  fundraise: IFundraise;
  createdAt: Date;
  updatedAt: Date;
}

const fundraiseSchema = new Schema<IFundraise>(
  {
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
    category: { type: String, required: true, enum: CATEGORIES, index: true },
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 24 }],
    pricing: { type: String, enum: PRICING_MODELS, default: 'free' },
    websiteUrl: { type: String, required: true, trim: true },
    repoUrl: { type: String, trim: true },
    logoUrl: { type: String, trim: true },
    coverUrl: { type: String, trim: true },
    gallery: [{ type: String, trim: true }],
    makers: [{ type: String, trim: true, maxlength: 60 }],
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    launchDate: { type: Date, default: Date.now, index: true },
    // Denormalised UTC day (YYYY-MM-DD) so daily leaderboards are a cheap indexed lookup.
    launchDateKey: { type: String, required: true, index: true },
    featured: { type: Boolean, default: false, index: true },
    voteCount: { type: Number, default: 0, min: 0, index: true },
    commentCount: { type: Number, default: 0, min: 0 },
    reviewCount: { type: Number, default: 0, min: 0 },
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

export const Item: Model<IItem> = mongoose.models.Item ?? mongoose.model<IItem>('Item', itemSchema);
