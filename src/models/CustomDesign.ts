import mongoose, { Schema, type Document, type Model } from 'mongoose';
import type { ArtworkAnalysis } from '../services/artwork';

/**
 * Somebody's own artwork, and the thing they want it printed on.
 *
 * **Reviewed before it is made, not after.** Deck is printing and posting a
 * physical object with a stranger's image on it — the one place on Deck where
 * getting copyright or content wrong produces a parcel with Deck's return
 * address on it. So a design is submitted, a human looks at it, and only then
 * can it be ordered. Same gate as a fundraise, for the same reason: Deck's name
 * is on the outcome.
 *
 * The analysis is stored alongside rather than recomputed, because it is the
 * evidence behind the decision. If a print comes back soft, the record says
 * what the file was and what the buyer was told about it at the time.
 */

export const CUSTOM_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;
export type CustomStatus = (typeof CUSTOM_STATUSES)[number];

/** What Deck will print on. Priced in `PRODUCTS` below. */
export const CUSTOM_PRODUCTS = ['sticker', 'sticker-sheet', 'tee', 'hoodie'] as const;
export type CustomProduct = (typeof CUSTOM_PRODUCTS)[number];

export const CUSTOM_PLACEMENTS = ['centre-chest', 'left-chest', 'full-front', 'back'] as const;
export type CustomPlacement = (typeof CUSTOM_PLACEMENTS)[number];

export interface ICustomDesign extends Document {
  _id: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  /** A short human-readable code, so support can talk about it out loud. */
  reference: string;
  name: string;
  /** The uploaded PNG, as an /uploads path. */
  artworkUrl: string;
  analysis: ArtworkAnalysis;

  product: CustomProduct;
  garment: string;
  placement: CustomPlacement;
  /** Print width as a percentage of the printable area. */
  scale: number;
  size?: string;

  priceMinor: number;
  currency: string;

  /**
   * An AI-generated lifestyle scene, if one has been made.
   *
   * A separate field from `artworkUrl` on purpose: one is the file that gets
   * printed and the other is a photograph that does not exist. Conflating them
   * is how an illustration ends up at a printer.
   */
  lifestyleUrl?: string;
  lifestylePrompt?: string;

  status: CustomStatus;
  reviewNote?: string;
  reviewedAt: Date | null;
  reviewedBy: mongoose.Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

const customDesignSchema = new Schema<ICustomDesign>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    artworkUrl: { type: String, required: true, trim: true },
    /* Mixed, because the analysis shape belongs to the service that produces it
       and duplicating its fields here would mean two definitions to keep in
       step for a blob nothing queries on. */
    analysis: { type: Schema.Types.Mixed, required: true },

    product: { type: String, enum: CUSTOM_PRODUCTS, required: true },
    garment: { type: String, required: true, trim: true },
    placement: { type: String, enum: CUSTOM_PLACEMENTS, default: 'centre-chest' },
    scale: { type: Number, default: 60, min: 10, max: 100 },
    size: { type: String, trim: true, maxlength: 8 },

    priceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },

    lifestyleUrl: { type: String, trim: true },
    /* Kept so a render can be explained, and reproduced, after the fact. */
    lifestylePrompt: { type: String, trim: true, maxlength: 2000 },

    status: { type: String, enum: CUSTOM_STATUSES, default: 'draft', index: true },
    reviewNote: { type: String, trim: true, maxlength: 300 },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

/* The two lists: a person's own designs, and the review queue. */
customDesignSchema.index({ owner: 1, createdAt: -1 });
customDesignSchema.index({ status: 1, createdAt: 1 });

export const CustomDesign: Model<ICustomDesign> =
  mongoose.models.CustomDesign ??
  mongoose.model<ICustomDesign>('CustomDesign', customDesignSchema);
