import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { CATEGORY_ICONS, type CategoryIconKey } from '../constants';

/**
 * A launch category.
 *
 * Was a TypeScript enum baked into the schema, the validators and the frontend's
 * label map — which meant adding one was a code change and a deploy. Deck is a
 * launch board; the shape of "what kind of thing is this" moves faster than
 * releases do, so it belongs in the database.
 *
 * The trade is that `Item.category` can no longer be a Mongoose `enum`. Validity
 * is checked in the controller against this collection instead, which is one
 * indexed lookup on a handful of documents and buys the ability to add a
 * category without shipping anything.
 *
 * `icon` is a key into a curated set rather than an uploaded image. An icon set
 * has to hold together — one stroke weight, one optical size, inheriting the
 * theme's colour so it works on both canvases. Thirty consistent options beat
 * unlimited inconsistent ones, and it means a new category can never arrive
 * with a 400×400 PNG that breaks in dark mode.
 */
export interface ICategory extends Document {
  _id: mongoose.Types.ObjectId;
  slug: string;
  label: string;
  icon: CategoryIconKey;
  /** Short line shown on the category page. */
  blurb?: string;
  /** Ascending. Ties fall back to label. */
  order: number;
  /**
   * Retired categories stay readable but cannot be chosen for a new launch.
   * Hard-deleting would orphan every launch that used it.
   */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<ICategory>(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 40,
    },
    label: { type: String, required: true, trim: true, maxlength: 40 },
    icon: { type: String, required: true, enum: Object.keys(CATEGORY_ICONS) },
    blurb: { type: String, trim: true, maxlength: 160 },
    order: { type: Number, default: 100 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

/* The only read that matters: the picker and the strip, in display order. */
categorySchema.index({ active: 1, order: 1, label: 1 });

export const Category: Model<ICategory> =
  mongoose.models.Category ?? mongoose.model<ICategory>('Category', categorySchema);
