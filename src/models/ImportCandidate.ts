import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { PRICING_MODELS, type PricingModel } from '../constants';

/**
 * A product Deck might list, waiting for a person to check it.
 *
 * Nothing an importer finds goes straight onto the site. A scraper is wrong in
 * ways that are embarrassing in public — a dead domain, a parked page, a
 * founder attributed to the wrong company, a description lifted from a press
 * article — so every candidate lands here first and becomes a launch only when
 * staff publish it. The same shape as every other review queue on Deck: the
 * cheap mistake is a rejected row, not a correction issued after the fact.
 *
 * `domain` is the duplicate key. Two candidates for the same product usually
 * differ in every field a person typed (the name's casing, a tagline) and agree
 * on the one a machine read: the website's host.
 */
export const IMPORT_STATUSES = ['pending', 'published', 'rejected'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface ICandidateFounder {
  name: string;
  headline?: string;
  /** Link to an existing founder record instead of creating a new one. */
  founderId?: mongoose.Types.ObjectId;
  links: { label: string; url: string }[];
}

export interface IImportCandidate extends Document {
  _id: mongoose.Types.ObjectId;
  status: ImportStatus;
  name: string;
  tagline: string;
  description: string;
  websiteUrl: string;
  domain: string;
  category: string;
  country?: string;
  tags: string[];
  pricing: PricingModel;
  logoUrl?: string;
  /** When the product actually launched, if known. Becomes the launch date. */
  launchedAt?: Date;
  founders: ICandidateFounder[];
  sourceUrls: string[];
  /** How it got here: `manual`, `csv`, or the name of an automated source. */
  origin: string;
  notes?: string;
  addedBy?: mongoose.Types.ObjectId;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  rejectionReason?: string;
  /** The launch it became, once published. */
  item?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const candidateFounderSchema = new Schema<ICandidateFounder>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    headline: { type: String, trim: true, maxlength: 100 },
    founderId: { type: Schema.Types.ObjectId, ref: 'Founder' },
    links: [
      {
        _id: false,
        label: { type: String, required: true, trim: true, maxlength: 30 },
        url: { type: String, required: true, trim: true, maxlength: 300 },
      },
    ],
  },
  { _id: false },
);

const importCandidateSchema = new Schema<IImportCandidate>(
  {
    status: { type: String, enum: IMPORT_STATUSES, default: 'pending', index: true },
    name: { type: String, required: true, trim: true, maxlength: 70 },
    tagline: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    websiteUrl: { type: String, required: true, trim: true },
    domain: { type: String, required: true, lowercase: true, trim: true, index: true },
    category: { type: String, required: true, trim: true },
    country: { type: String, trim: true, uppercase: true, match: /^[A-Z]{2}$/ },
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 24 }],
    pricing: { type: String, enum: PRICING_MODELS, default: 'free' },
    logoUrl: { type: String, trim: true },
    launchedAt: Date,
    founders: { type: [candidateFounderSchema], default: [] },
    sourceUrls: [{ type: String, trim: true, maxlength: 500 }],
    origin: { type: String, required: true, trim: true, maxlength: 40, default: 'manual' },
    notes: { type: String, trim: true, maxlength: 1000 },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    rejectionReason: { type: String, trim: true, maxlength: 400 },
    item: { type: Schema.Types.ObjectId, ref: 'Item' },
  },
  { timestamps: true },
);

/* The queue reads oldest-first within a status. */
importCandidateSchema.index({ status: 1, createdAt: 1 });

export const ImportCandidate: Model<IImportCandidate> =
  mongoose.models.ImportCandidate ??
  mongoose.model<IImportCandidate>('ImportCandidate', importCandidateSchema);
