import mongoose, { Schema, type Document, type Model } from 'mongoose';
import {
  CURRENCY,
  MERCH_CATEGORIES,
  MERCH_STATUSES,
  type MerchCategory,
  type MerchStatus,
} from '../constants';

/**
 * A buyable variant of a product — one size/colour combination, with its own
 * stock count. `sku` is the stable identifier the cart and orders reference, so
 * renaming a size never orphans an order line.
 */
export interface IMerchVariant {
  sku: string;
  size?: string;
  colour?: string;
  stock: number;
}

export interface IMerchProduct extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  category: MerchCategory;
  /** Integer minor units (cents). Never a float. */
  priceMinor: number;
  currency: string;
  images: string[];
  variants: IMerchVariant[];
  /** Null for Deck's own merch; a user for everything they list themselves. */
  seller: mongoose.Types.ObjectId | null;
  status: MerchStatus;
  rejectionReason?: string;
  reviewedAt?: Date;
  featured: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const variantSchema = new Schema<IMerchVariant>(
  {
    sku: { type: String, required: true, trim: true, uppercase: true },
    size: { type: String, trim: true },
    colour: { type: String, trim: true },
    stock: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const merchProductSchema = new Schema<IMerchProduct>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    tagline: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    category: { type: String, required: true, enum: MERCH_CATEGORIES, index: true },
    priceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: CURRENCY, uppercase: true },
    images: [{ type: String, trim: true }],
    variants: {
      type: [variantSchema],
      validate: [
        (value: IMerchVariant[]) => value.length > 0,
        'A product needs at least one variant',
      ],
    },
    /**
     * Whose product this is. Deck's own catalogue leaves this null, which is
     * also what tells checkout there is nobody to split the payment to.
     */
    seller: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    /** Review state, set by Deck. Distinct from `active`, which is the seller's. */
    status: { type: String, enum: MERCH_STATUSES, default: 'pending', index: true },
    rejectionReason: { type: String, trim: true, maxlength: 400 },
    reviewedAt: Date,
    featured: { type: Boolean, default: false, index: true },
    /** Soft delete: keeps order history intact when a product is retired. */
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

merchProductSchema.index({ name: 'text', tagline: 'text', description: 'text' });

/** The shop's hot path: approved and switched on. */
merchProductSchema.index({ status: 1, active: 1, featured: -1, createdAt: -1 });

/** SKUs must be unique across the catalogue, not just within one product. */
merchProductSchema.index({ 'variants.sku': 1 }, { unique: true, sparse: true });

export const MerchProduct: Model<IMerchProduct> =
  mongoose.models.MerchProduct ?? mongoose.model<IMerchProduct>('MerchProduct', merchProductSchema);
