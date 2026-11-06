import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Match's money: prepaid credit and what it is spent on.
 *
 * Match charges in moments — a minute added while two people are laughing, a
 * rose after the usernames appear. Sending someone to a checkout page there
 * would end the call, so people top up credit beforehand (the only step that
 * goes through Bachs) and everything else spends it instantly.
 *
 * The balance itself lives on the profile (`MatchProfile.creditMinor`) and is
 * only ever changed by a guarded `$inc`, so it can never go below zero however
 * requests race. Every change is also written here, to `MatchLedger`, so any
 * balance can be explained line by line.
 */

/* ------------------------------------------------------------- top-ups --- */

export const MATCH_TOPUP_STATUSES = ['pending', 'paid', 'failed'] as const;
export type MatchTopupStatus = (typeof MATCH_TOPUP_STATUSES)[number];

export interface IMatchTopup extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  user: mongoose.Types.ObjectId;
  amountMinor: number;
  currency: string;
  status: MatchTopupStatus;
  /** `test` only where Bachs is not configured outside production. */
  mode: 'live' | 'test';
  checkoutId?: string;
  checkoutUrl?: string;
  chargeId?: string;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const topupSchema = new Schema<IMatchTopup>(
  {
    reference: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    status: { type: String, enum: MATCH_TOPUP_STATUSES, default: 'pending' },
    mode: { type: String, enum: ['live', 'test'], required: true },
    checkoutId: { type: String, index: true, sparse: true },
    checkoutUrl: { type: String },
    chargeId: { type: String },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const MatchTopup: Model<IMatchTopup> =
  mongoose.models.MatchTopup ?? mongoose.model<IMatchTopup>('MatchTopup', topupSchema);

/* -------------------------------------------------------------- ledger --- */

export const MATCH_LEDGER_KINDS = [
  'topup',
  'minute',
  'gift',
  'entry',
  'badge',
  'plus',
  'refund',
  'giftcard',
] as const;
export type MatchLedgerKind = (typeof MATCH_LEDGER_KINDS)[number];

export interface IMatchLedger extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  kind: MatchLedgerKind;
  /** Positive adds credit, negative spends it. Kobo. */
  amountMinor: number;
  balanceAfterMinor: number;
  /** What it was for: a call id, a top-up reference, a night's date. */
  ref: string;
  note: string;
  /** How the change split across the credit pots, signed like amountMinor. */
  pots: { bonus?: number; gift?: number; paid?: number };
  createdAt: Date;
}

const ledgerSchema = new Schema<IMatchLedger>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: MATCH_LEDGER_KINDS, required: true },
    amountMinor: { type: Number, required: true },
    balanceAfterMinor: { type: Number, required: true },
    ref: { type: String, default: '' },
    note: { type: String, default: '' },
    pots: {
      bonus: { type: Number },
      gift: { type: Number },
      paid: { type: Number },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
ledgerSchema.index({ user: 1, ref: 1 });
ledgerSchema.index({ user: 1, createdAt: -1 });
ledgerSchema.index({ kind: 1, createdAt: -1 });

export const MatchLedger: Model<IMatchLedger> =
  mongoose.models.MatchLedger ?? mongoose.model<IMatchLedger>('MatchLedger', ledgerSchema);

/* --------------------------------------------------------------- gifts --- */

export const MATCH_GIFTS = ['rose', 'drink'] as const;
export type MatchGiftKind = (typeof MATCH_GIFTS)[number];

/** A rose or a drink, sent to someone you swapped usernames with. */
export interface IMatchGift extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string;
  from: mongoose.Types.ObjectId;
  to: mongoose.Types.ObjectId;
  gift: MatchGiftKind;
  priceMinor: number;
  createdAt: Date;
}

const giftSchema = new Schema<IMatchGift>(
  {
    callId: { type: String, required: true, index: true },
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    gift: { type: String, enum: MATCH_GIFTS, required: true },
    priceMinor: { type: Number, required: true, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const MatchGift: Model<IMatchGift> =
  mongoose.models.MatchGift ?? mongoose.model<IMatchGift>('MatchGift', giftSchema);

/* -------------------------------------------------------------- nights --- */

/**
 * One evening's extras, set by staff: a sponsor's line on the countdown and
 * the waiting screen, and/or a theme people pay a small entry to join.
 */
export interface IMatchNight extends Document {
  _id: mongoose.Types.ObjectId;
  /** The Lagos date it applies to, `YYYY-MM-DD`. */
  day: string;
  sponsor: { name: string; line: string; url: string } | null;
  theme: { title: string; blurb: string; entryMinor: number } | null;
  createdAt: Date;
  updatedAt: Date;
}

const nightSchema = new Schema<IMatchNight>(
  {
    day: { type: String, required: true, unique: true },
    sponsor: {
      type: new Schema(
        {
          name: { type: String, required: true, maxlength: 60 },
          line: { type: String, default: '', maxlength: 140 },
          url: { type: String, default: '', maxlength: 300 },
        },
        { _id: false },
      ),
      default: null,
    },
    theme: {
      type: new Schema(
        {
          title: { type: String, required: true, maxlength: 60 },
          blurb: { type: String, default: '', maxlength: 200 },
          entryMinor: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

export const MatchNight: Model<IMatchNight> =
  mongoose.models.MatchNight ?? mongoose.model<IMatchNight>('MatchNight', nightSchema);

/** Someone paid into a themed night. One per person per night. */
export interface IMatchEntry extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  day: string;
  priceMinor: number;
  createdAt: Date;
}

const entrySchema = new Schema<IMatchEntry>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },
    priceMinor: { type: Number, required: true, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
entrySchema.index({ user: 1, day: 1 }, { unique: true });

export const MatchEntry: Model<IMatchEntry> =
  mongoose.models.MatchEntry ?? mongoose.model<IMatchEntry>('MatchEntry', entrySchema);

/* -------------------------------------------------------- verification --- */

export const MATCH_VERIFICATION_STATUSES = ['draft', 'pending', 'approved', 'declined'] as const;
export type MatchVerificationStatus = (typeof MATCH_VERIFICATION_STATUSES)[number];

/**
 * A selfie check for the Verified badge: a photo of the person making a pose
 * Match picked for them, so it cannot be any old picture of someone else.
 *
 * The photo is kept here, in the database, rather than on the public image
 * host — it is only ever shown to staff — and it is deleted the moment staff
 * decide. Only the decision is kept.
 */
export interface IMatchVerification extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  /** The pose they were asked for, e.g. "a peace sign". */
  prompt: string;
  photo: Buffer | null;
  photoType: string;
  status: MatchVerificationStatus;
  priceMinor: number;
  /** Why it was declined, shown to them. */
  note: string;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const verificationSchema = new Schema<IMatchVerification>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    prompt: { type: String, required: true },
    photo: { type: Buffer, default: null, select: false },
    photoType: { type: String, default: '' },
    status: { type: String, enum: MATCH_VERIFICATION_STATUSES, default: 'draft' },
    priceMinor: { type: Number, default: 0 },
    note: { type: String, default: '', maxlength: 300 },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
verificationSchema.index({ status: 1, submittedAt: 1 });

export const MatchVerification: Model<IMatchVerification> =
  mongoose.models.MatchVerification ??
  mongoose.model<IMatchVerification>('MatchVerification', verificationSchema);

/* ---------------------------------------------------------- gift cards --- */

export const MATCH_GIFT_CARD_STATUSES = [
  'pending',
  'active',
  'redeemed',
  'failed',
  'void',
] as const;
export type MatchGiftCardStatus = (typeof MATCH_GIFT_CARD_STATUSES)[number];
export type MatchGiftCardKind = 'credit' | 'plus';

/**
 * A Match gift card: credit or Match+ days, bought for someone else (or
 * handed out by Deck for a sponsor) and claimed with a one-time code.
 *
 * Paid ones go through Bachs exactly like a top-up: `pending` until the money
 * is confirmed, then `active` and redeemable until `expiresAt`. Redeeming
 * flips `active` to `redeemed` in one guarded update, so a code shared twice
 * still pays out once. The code is a bearer secret, so it is never selected
 * unless asked for: only its buyer and staff ever see it.
 */
export interface IMatchGiftCard extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  code: string;
  product: string;
  kind: MatchGiftCardKind;
  /** Credit it adds, kobo; 0 for a Match+ card. */
  valueMinor: number;
  /** Match+ days it adds; 0 for a credit card. */
  plusDays: number;
  /** What was paid for it, kobo; 0 for cards Deck issued. */
  priceMinor: number;
  currency: string;
  status: MatchGiftCardStatus;
  /** `issued` for cards staff created; `test` where Bachs is not configured. */
  mode: 'live' | 'test' | 'issued';
  buyer: mongoose.Types.ObjectId | null;
  toName: string;
  fromName: string;
  message: string;
  /** Staff's note for an issued batch: the sponsor, the giveaway. */
  batch: string;
  checkoutId?: string;
  checkoutUrl?: string;
  chargeId?: string;
  paidAt: Date | null;
  expiresAt: Date | null;
  redeemedBy: mongoose.Types.ObjectId | null;
  redeemedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const giftCardSchema = new Schema<IMatchGiftCard>(
  {
    reference: { type: String, required: true, unique: true },
    code: { type: String, required: true, unique: true, select: false },
    product: { type: String, required: true },
    kind: { type: String, enum: ['credit', 'plus'], required: true },
    valueMinor: { type: Number, default: 0, min: 0 },
    plusDays: { type: Number, default: 0, min: 0 },
    priceMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, required: true },
    status: { type: String, enum: MATCH_GIFT_CARD_STATUSES, default: 'pending' },
    mode: { type: String, enum: ['live', 'test', 'issued'], required: true },
    buyer: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    toName: { type: String, default: '', maxlength: 40 },
    fromName: { type: String, default: '', maxlength: 40 },
    message: { type: String, default: '', maxlength: 140 },
    batch: { type: String, default: '', maxlength: 80 },
    checkoutId: { type: String, index: true, sparse: true },
    checkoutUrl: { type: String },
    chargeId: { type: String },
    paidAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    redeemedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    redeemedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
giftCardSchema.index({ status: 1, createdAt: -1 });

export const MatchGiftCard: Model<IMatchGiftCard> =
  mongoose.models.MatchGiftCard ?? mongoose.model<IMatchGiftCard>('MatchGiftCard', giftCardSchema);

/* ------------------------------------------------------ brand gift cards --- */

/**
 * Another company's gift card that Match sells (Chowdeck, Jumia…), bought
 * from Reloadly. Staff sync the catalogue and switch on the ones to offer;
 * this keeps Reloadly's product as it was last synced, so the shop doesn't
 * ask Reloadly every time someone looks.
 */
export interface IMatchBrandProduct extends Document {
  _id: mongoose.Types.ObjectId;
  productId: number;
  name: string;
  brand: string;
  logoUrl: string;
  countryCode: string;
  recipientCurrency: string;
  senderCurrency: string;
  /** FIXED: only `denominations`; RANGE: anything from `min` to `max`. */
  denominationType: 'FIXED' | 'RANGE';
  denominations: number[];
  /** What Reloadly charges, in sender currency, for each fixed denomination. */
  senderPrices: Record<string, number>;
  min: number | null;
  max: number | null;
  senderFee: number;
  /** Reloadly's discount to Deck, percent: Deck's margin before any markup. */
  discountPct: number;
  redeemInstruction: string;
  /** On sale in Match. */
  enabled: boolean;
  /** Added on top of Reloadly's price, percent. */
  markupPct: number;
  syncedAt: Date;
}

const brandProductSchema = new Schema<IMatchBrandProduct>(
  {
    productId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    brand: { type: String, required: true },
    logoUrl: { type: String, default: '' },
    countryCode: { type: String, required: true },
    recipientCurrency: { type: String, required: true },
    senderCurrency: { type: String, required: true },
    denominationType: { type: String, enum: ['FIXED', 'RANGE'], required: true },
    denominations: { type: [Number], default: [] },
    senderPrices: { type: Schema.Types.Mixed, default: {} },
    min: { type: Number, default: null },
    max: { type: Number, default: null },
    senderFee: { type: Number, default: 0 },
    discountPct: { type: Number, default: 0 },
    redeemInstruction: { type: String, default: '' },
    enabled: { type: Boolean, default: false },
    markupPct: { type: Number, default: 0, min: 0, max: 100 },
    syncedAt: { type: Date, required: true },
  },
  { timestamps: false },
);

export const MatchBrandProduct: Model<IMatchBrandProduct> =
  mongoose.models.MatchBrandProduct ??
  mongoose.model<IMatchBrandProduct>('MatchBrandProduct', brandProductSchema);

export const MATCH_BRAND_ORDER_STATUSES = [
  'pending', // checkout opened, not paid
  'paid', // paid; being bought from Reloadly
  'fulfilled', // the code is in
  'failed', // the payment failed
  'stuck', // paid but Reloadly couldn't fill it yet: staff retry or refund
  'refunded',
] as const;
export type MatchBrandOrderStatus = (typeof MATCH_BRAND_ORDER_STATUSES)[number];

/**
 * One brand card bought in Match. Paid through Bachs like a top-up; only once
 * the money is confirmed is the card bought from Reloadly, with this order's
 * reference as Reloadly's `customIdentifier`, so a retry can always find out
 * whether the first attempt went through before ordering again. The code is
 * a bearer secret: never selected unless asked for, shown only to the buyer.
 */
export interface IMatchBrandOrder extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  buyer: mongoose.Types.ObjectId;
  productId: number;
  brand: string;
  productName: string;
  logoUrl: string;
  /** The card's value, in the brand's currency. */
  faceValue: number;
  faceCurrency: string;
  /** What the buyer paid, kobo. */
  priceMinor: number;
  currency: string;
  toName: string;
  status: MatchBrandOrderStatus;
  mode: 'live' | 'test';
  checkoutId?: string;
  checkoutUrl?: string;
  paidAt: Date | null;
  reloadlyTransactionId: number | null;
  /** What Reloadly charged Deck, in its currency, after its discount. */
  costAmount: number | null;
  costCurrency: string;
  code: { cardNumber: string; pinCode: string; redemptionUrl: string } | null;
  redeemInstruction: string;
  /** Why it is stuck, for staff. */
  problem: string;
  attempts: number;
  /** One worker at a time buys the card; this is its claim. */
  lockedUntil: Date | null;
  fulfilledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const brandOrderSchema = new Schema<IMatchBrandOrder>(
  {
    reference: { type: String, required: true, unique: true },
    buyer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: Number, required: true },
    brand: { type: String, required: true },
    productName: { type: String, required: true },
    logoUrl: { type: String, default: '' },
    faceValue: { type: Number, required: true },
    faceCurrency: { type: String, required: true },
    priceMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    toName: { type: String, default: '', maxlength: 40 },
    status: { type: String, enum: MATCH_BRAND_ORDER_STATUSES, default: 'pending' },
    mode: { type: String, enum: ['live', 'test'], required: true },
    checkoutId: { type: String, index: true, sparse: true },
    checkoutUrl: { type: String },
    paidAt: { type: Date, default: null },
    reloadlyTransactionId: { type: Number, default: null },
    costAmount: { type: Number, default: null },
    costCurrency: { type: String, default: '' },
    code: {
      type: new Schema(
        { cardNumber: String, pinCode: String, redemptionUrl: String },
        { _id: false },
      ),
      default: null,
      select: false,
    },
    redeemInstruction: { type: String, default: '' },
    problem: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    fulfilledAt: { type: Date, default: null },
  },
  { timestamps: true },
);
brandOrderSchema.index({ status: 1, createdAt: -1 });

export const MatchBrandOrder: Model<IMatchBrandOrder> =
  mongoose.models.MatchBrandOrder ??
  mongoose.model<IMatchBrandOrder>('MatchBrandOrder', brandOrderSchema);
