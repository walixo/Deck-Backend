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
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
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
