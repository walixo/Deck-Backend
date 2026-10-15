import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Something a game sells: a level pack, a skin, a bag of coins.
 *
 * The developer names it with their own `productId` — the string their code
 * already uses — and the SDK asks to buy it by that name. Deck sets the price
 * from this row, never from the request, so a player cannot buy a ₦5,000 pack
 * for ₦1 by editing a postMessage.
 *
 * `one_off` is owned forever once bought (a level pack); `consumable` can be
 * bought again and again (coins), and it is the developer's server that
 * credits it, then marks the purchase delivered.
 */
export const PRODUCT_TYPES = ['one_off', 'consumable'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export interface IGameProduct extends Document {
  _id: mongoose.Types.ObjectId;
  game: mongoose.Types.ObjectId;
  productId: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  type: ProductType;
  /** Retired products stay for the purchase history; they cannot be bought. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const gameProductSchema = new Schema<IGameProduct>(
  {
    game: { type: Schema.Types.ObjectId, ref: 'Game', required: true },
    productId: { type: String, required: true, trim: true, lowercase: true, maxlength: 48 },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    description: { type: String, default: '', trim: true, maxlength: 240 },
    priceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    type: { type: String, enum: PRODUCT_TYPES, default: 'one_off' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/* A product id means one thing within a game. */
gameProductSchema.index({ game: 1, productId: 1 }, { unique: true });

export const GameProduct: Model<IGameProduct> =
  mongoose.models.GameProduct ?? mongoose.model<IGameProduct>('GameProduct', gameProductSchema);
