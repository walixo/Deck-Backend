import mongoose, { Schema, type Document, type Model } from 'mongoose';
import type { ProductType } from './GameProduct';

/**
 * One player buying one product in one game.
 *
 * The product's name, type and price are copied on at the moment of purchase,
 * like an order line: a developer renaming or repricing a product next week
 * must not rewrite what somebody already paid for. The split is frozen the
 * same way — the developer's share is what it was when the money moved.
 *
 * Test purchases (`mode: 'test'`) never touch Bachs and never earn anything.
 * They exist so a developer can build the whole purchase flow, webhook and
 * all, without spending money or waiting for review.
 */
export const GAME_PURCHASE_STATUSES = ['pending', 'paid', 'failed'] as const;
export type GamePurchaseStatus = (typeof GAME_PURCHASE_STATUSES)[number];

export const WEBHOOK_STATES = ['none', 'pending', 'delivered', 'failed'] as const;
export type WebhookState = (typeof WEBHOOK_STATES)[number];

/** Attempts before a delivery is given up on. The developer can still poll. */
export const MAX_WEBHOOK_ATTEMPTS = 6;

export interface IGamePurchase extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  game: mongoose.Types.ObjectId;
  /** Who is paid — the game's author when the purchase was made. */
  developer: mongoose.Types.ObjectId;
  product: mongoose.Types.ObjectId;
  productId: string;
  productName: string;
  productType: ProductType;
  user: mongoose.Types.ObjectId;
  playerId: string;
  mode: 'test' | 'live';
  email: string;

  priceMinor: number;
  currency: string;
  developerShareMinor: number;
  platformFeeMinor: number;

  status: GamePurchaseStatus;
  checkoutId?: string;
  chargeId?: string;
  paidAt: Date | null;
  /** Set when the developer's server confirms it has handed the item over. */
  deliveredAt: Date | null;

  webhook: {
    state: WebhookState;
    attempts: number;
    lastAttemptAt: Date | null;
    nextAttemptAt: Date | null;
    lastStatus: number | null;
    lastError: string;
  };

  createdAt: Date;
  updatedAt: Date;
}

const gamePurchaseSchema = new Schema<IGamePurchase>(
  {
    reference: { type: String, required: true, unique: true },
    game: { type: Schema.Types.ObjectId, ref: 'Game', required: true, index: true },
    developer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: Schema.Types.ObjectId, ref: 'GameProduct', required: true },
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    productType: { type: String, enum: ['one_off', 'consumable'], required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    playerId: { type: String, required: true },
    mode: { type: String, enum: ['test', 'live'], required: true },
    email: { type: String, default: '' },

    priceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    developerShareMinor: { type: Number, required: true, min: 0 },
    platformFeeMinor: { type: Number, required: true, min: 0 },

    status: { type: String, enum: GAME_PURCHASE_STATUSES, default: 'pending' },
    checkoutId: { type: String, index: true, sparse: true },
    chargeId: { type: String },
    paidAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },

    webhook: {
      state: { type: String, enum: WEBHOOK_STATES, default: 'none' },
      attempts: { type: Number, default: 0 },
      lastAttemptAt: { type: Date, default: null },
      nextAttemptAt: { type: Date, default: null },
      lastStatus: { type: Number, default: null },
      lastError: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

/* What a player owns in a game — the SDK's entitlement check. */
gamePurchaseSchema.index({ game: 1, playerId: 1, status: 1 });
/* The ledger: a developer's paid, live sales. */
gamePurchaseSchema.index({ developer: 1, status: 1, mode: 1 });
/* The retry job's queue. */
gamePurchaseSchema.index({ 'webhook.state': 1, 'webhook.nextAttemptAt': 1 });

export const GamePurchase: Model<IGamePurchase> =
  mongoose.models.GamePurchase ?? mongoose.model<IGamePurchase>('GamePurchase', gamePurchaseSchema);
