import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { env } from '../config/env';
import { VAULT_MODES, type VaultMode } from './VaultPartner';

/**
 * An order for cards, from either side of the product.
 *
 * Both buyers go through this one model. A partner ordering 500 cards over the
 * API and a person buying one as a gift on the storefront differ in how they
 * pay and in nothing else — same issuer, same product, same minting, same
 * settlement owed to the merchant. Two models would mean two of each of those.
 *
 * ## The money
 *
 * Face value is what the card is worth to whoever holds it. The buyer pays
 * less — that discount is the issuer's offer and the distributor's margin.
 * Deck's fee comes out of what is left.
 *
 *     faceTotal    10,000   what the cards are worth
 *     discount        800   the issuer's 8% offer
 *     charged       9,200   what the buyer's wallet is debited
 *     platformFee     276   Deck's 3% of the charge
 *     issuerNet     8,924   what the issuer is owed at settlement
 *
 * Every one is stored rather than recomputed on read, because a percentage
 * that changes later must not silently rewrite the history of orders placed
 * under the old one.
 */

export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'failed', 'refunded'] as const;
export type VaultOrderStatus = (typeof ORDER_STATUSES)[number];

export const BUYER_KINDS = ['partner', 'consumer'] as const;
export type BuyerKind = (typeof BUYER_KINDS)[number];

export interface IVaultOrder extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  mode: VaultMode;
  buyerKind: BuyerKind;
  /** Exactly one of these is set, per `buyerKind`. */
  partner: mongoose.Types.ObjectId | null;
  user: mongoose.Types.ObjectId | null;

  issuer: mongoose.Types.ObjectId;
  product: mongoose.Types.ObjectId;
  quantity: number;
  unitFaceMinor: number;

  faceTotalMinor: number;
  discountMinor: number;
  chargedMinor: number;
  platformFeeMinor: number;
  issuerNetMinor: number;
  currency: string;

  status: VaultOrderStatus;
  failureReason: string;

  /**
   * The partner's own key for this request.
   *
   * Minting cards costs real money and is not reversible by retrying, so a
   * partner whose request times out must be able to send it again and get the
   * first order back rather than a second one. Unique per partner, sparse
   * because consumer orders have none.
   */
  idempotencyKey: string | null;

  /** Consumer orders: what Bachs calls the payment. */
  paymentReference: string | null;

  /** Gift details, carried onto every card the order mints. */
  recipientName: string;
  recipientEmail: string;
  giftMessage: string;

  fulfilledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<IVaultOrder>(
  {
    reference: { type: String, required: true, unique: true },
    mode: { type: String, enum: VAULT_MODES, required: true },
    buyerKind: { type: String, enum: BUYER_KINDS, required: true },
    partner: { type: Schema.Types.ObjectId, ref: 'VaultPartner', default: null, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    issuer: { type: Schema.Types.ObjectId, ref: 'VaultIssuer', required: true, index: true },
    product: { type: Schema.Types.ObjectId, ref: 'VaultProduct', required: true },
    quantity: { type: Number, required: true, min: 1, max: 1000 },
    unitFaceMinor: { type: Number, required: true, min: 1 },

    faceTotalMinor: { type: Number, required: true, min: 0 },
    discountMinor: { type: Number, required: true, min: 0, default: 0 },
    chargedMinor: { type: Number, required: true, min: 0 },
    platformFeeMinor: { type: Number, required: true, min: 0, default: 0 },
    issuerNetMinor: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: () => env.currency, uppercase: true },

    status: { type: String, enum: ORDER_STATUSES, default: 'pending', index: true },
    failureReason: { type: String, default: '', maxlength: 400 },

    idempotencyKey: { type: String, default: null },
    paymentReference: { type: String, default: null },

    recipientName: { type: String, default: '', trim: true, maxlength: 80 },
    recipientEmail: { type: String, default: '', trim: true, lowercase: true },
    giftMessage: { type: String, default: '', maxlength: 500 },

    fulfilledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/*
 * One order per partner per idempotency key.
 *
 * Partial, not merely sparse: `sparse` would still let two consumer orders
 * with a null key collide on the index in some versions, and a partial filter
 * states the actual rule — this applies only to rows that have a key.
 */
orderSchema.index(
  { partner: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

/* An issuer's sales report, and a partner's order list: same shape. */
orderSchema.index({ issuer: 1, mode: 1, createdAt: -1 });
orderSchema.index({ partner: 1, mode: 1, createdAt: -1 });

/* Settlement: what an issuer is owed is the sum over fulfilled live orders. */
orderSchema.index({ issuer: 1, status: 1, mode: 1 });

orderSchema.pre('validate', function enforceBuyer(next) {
  if (this.buyerKind === 'partner' && !this.partner) {
    return next(new Error('A partner order needs a partner'));
  }
  if (this.buyerKind === 'consumer' && !this.user) {
    return next(new Error('A consumer order needs a buyer'));
  }
  return next();
});

export const VaultOrder: Model<IVaultOrder> =
  mongoose.models.VaultOrder ?? mongoose.model<IVaultOrder>('VaultOrder', orderSchema);
