import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { env } from '../config/env';
import { VAULT_MODES, type VaultMode } from './VaultPartner';

/**
 * An issued gift card, and the redemptions against it.
 *
 * ## How the code is stored
 *
 * A gift card code is not a password. A password is only ever *checked*, so a
 * hash is enough; a card code has to be shown back to whoever bought it —
 * weeks later, from an order page, by a partner calling the API — so hashing
 * alone would make the product impossible.
 *
 * So each code is kept three ways, each doing one job:
 *
 *   `hash`   SHA-256, unique-indexed. Redemption looks a code up by this, so
 *            finding a card is one indexed read and never a scan-and-decrypt.
 *   `cipher` AES-256-GCM, keyed from `VAULT_SECRET`. This is the retrievable
 *            copy. A database dump on its own does not yield a single code;
 *            an attacker needs the application secret as well.
 *   `last4`  Plaintext, for display. Enough to tell two cards apart in a list
 *            without revealing either.
 *
 * The PIN gets the same treatment for the same reason.
 *
 * In `merchant` fulfilment the code came from the merchant's own system rather
 * than from Vault, and is stored identically — Vault still has to hand it to
 * the buyer, so it still has to be retrievable.
 */

export const CARD_STATUSES = ['active', 'redeemed', 'expired', 'void'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/** Who minted the code. Mirrors the issuer's fulfilment mode at issue time. */
export const CARD_ORIGINS = ['deck', 'merchant'] as const;
export type CardOrigin = (typeof CARD_ORIGINS)[number];

export interface SecretField {
  hash: string;
  cipher: string;
  last4: string;
}

export interface IGiftCard extends Document {
  _id: mongoose.Types.ObjectId;
  issuer: mongoose.Types.ObjectId;
  product: mongoose.Types.ObjectId;
  order: mongoose.Types.ObjectId | null;
  mode: VaultMode;

  code: SecretField;
  /** Null when the issuer's cards carry no PIN. */
  pin: SecretField | null;

  faceValueMinor: number;
  /** What is left. Partial redemption is why this is not derived from status. */
  balanceMinor: number;
  currency: string;

  status: CardStatus;
  origin: CardOrigin;
  /** `merchant` origin: the id the merchant's own system knows this card by. */
  externalId: string | null;

  issuedAt: Date;
  /** Null means it never expires. */
  expiresAt: Date | null;

  /** Set when a card was bought as a gift rather than for stock. */
  recipientName: string;
  recipientEmail: string;
  giftMessage: string;
  /** The Deck account that claimed it, if anyone has. */
  claimedBy: mongoose.Types.ObjectId | null;
  claimedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

const secretSchema = new Schema<SecretField>(
  {
    hash: { type: String, required: true },
    /* Excluded by default. A query that needs to show the code back asks for
       it explicitly, so no casual `find()` ever drags ciphertext around. */
    cipher: { type: String, required: true, select: false },
    last4: { type: String, required: true },
  },
  { _id: false },
);

const cardSchema = new Schema<IGiftCard>(
  {
    issuer: { type: Schema.Types.ObjectId, ref: 'VaultIssuer', required: true, index: true },
    product: { type: Schema.Types.ObjectId, ref: 'VaultProduct', required: true },
    order: { type: Schema.Types.ObjectId, ref: 'VaultOrder', default: null, index: true },
    mode: { type: String, enum: VAULT_MODES, required: true },

    code: { type: secretSchema, required: true },
    pin: { type: secretSchema, default: null },

    faceValueMinor: { type: Number, required: true, min: 1 },
    balanceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: () => env.currency, uppercase: true },

    status: { type: String, enum: CARD_STATUSES, default: 'active', index: true },
    origin: { type: String, enum: CARD_ORIGINS, default: 'deck' },
    externalId: { type: String, default: null },

    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },

    recipientName: { type: String, default: '', trim: true, maxlength: 80 },
    recipientEmail: { type: String, default: '', trim: true, lowercase: true },
    giftMessage: { type: String, default: '', maxlength: 500 },
    claimedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    claimedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/*
 * The redemption lookup, and the guarantee that no two cards share a code.
 *
 * Unique across test and live together on purpose: a code is a bearer
 * instrument, and one that works in both modes is a code that can be walked
 * from the sandbox into production.
 */
cardSchema.index({ 'code.hash': 1 }, { unique: true });

/* An issuer's own reporting: outstanding liability by status. */
cardSchema.index({ issuer: 1, mode: 1, status: 1 });

export const GiftCard: Model<IGiftCard> =
  mongoose.models.GiftCard ?? mongoose.model<IGiftCard>('GiftCard', cardSchema);

/* ---------------------------------------------------------------- redemption */

/** Where a redemption came from, which is the only audit trail there is. */
export const REDEEM_SOURCES = ['issuer_api', 'issuer_console', 'partner_api'] as const;
export type RedeemSource = (typeof REDEEM_SOURCES)[number];

/**
 * One redemption against one card.
 *
 * Append-only. A card's `balanceMinor` is the fast path that redemption checks
 * against, but these rows are the record of how it got there — without them a
 * disputed balance has no history to settle it, and an issuer reconciling their
 * till against Vault has nothing to reconcile with.
 */
export interface ICardRedemption extends Document {
  _id: mongoose.Types.ObjectId;
  card: mongoose.Types.ObjectId;
  issuer: mongoose.Types.ObjectId;
  mode: VaultMode;
  amountMinor: number;
  balanceAfterMinor: number;
  source: RedeemSource;
  /** The staff or merchant account that pressed the button, where there was one. */
  actor: mongoose.Types.ObjectId | null;
  reference: string;
  note: string;
  createdAt: Date;
}

const redemptionSchema = new Schema<ICardRedemption>(
  {
    card: { type: Schema.Types.ObjectId, ref: 'GiftCard', required: true, index: true },
    issuer: { type: Schema.Types.ObjectId, ref: 'VaultIssuer', required: true, index: true },
    mode: { type: String, enum: VAULT_MODES, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    balanceAfterMinor: { type: Number, required: true, min: 0 },
    source: { type: String, enum: REDEEM_SOURCES, required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reference: { type: String, required: true, unique: true },
    note: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/* An issuer's redemption report, newest first. */
redemptionSchema.index({ issuer: 1, createdAt: -1 });

export const CardRedemption: Model<ICardRedemption> =
  mongoose.models.CardRedemption ??
  mongoose.model<ICardRedemption>('CardRedemption', redemptionSchema);
