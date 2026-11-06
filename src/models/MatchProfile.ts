import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A person's Match settings: which section they talk from, the X and
 * Instagram usernames they may choose to share, and who they never want to
 * hear again.
 *
 * Gender is set once. It decides who a person is matched with, so letting it
 * change at will would let anyone hop queues; someone who chose wrong asks
 * (`sectionRequest`) and staff switch it.
 */

export const MATCH_GENDERS = ['male', 'female'] as const;
export type MatchGender = (typeof MATCH_GENDERS)[number];

/** Where two people carry on after a call. Either may be empty, not both, to share. */
export interface MatchHandles {
  x: string;
  instagram: string;
}

/** How someone pays for time past the free minutes: by the second, or by the whole minute. */
export const MATCH_BILLINGS = ['second', 'minute'] as const;
export type MatchBilling = (typeof MATCH_BILLINGS)[number];

/**
 * Where credit came from, spent in this order: Deck's free credit first,
 * then gift card credit, then credit people paid for. `creditMinor` is
 * always their sum, and is the only balance anyone is shown.
 */
export const MATCH_POTS = ['bonus', 'gift', 'paid'] as const;
export type MatchPot = (typeof MATCH_POTS)[number];
export type MatchPots = Record<MatchPot, number>;

export interface IMatchProfile extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  gender: MatchGender;
  /** Usernames without the @. Empty until added; at least one is needed to share. */
  x: string;
  instagram: string;
  /** When they confirmed they are 18 or older. */
  adultAt: Date;
  /** People this person blocked, by user id. Matching skips them both ways. */
  blocked: mongoose.Types.ObjectId[];
  /** Set by repeated reports or by staff; no matching until it passes. */
  bannedUntil: Date | null;
  /** A request to staff to switch section, for someone who chose wrong. */
  sectionRequest: { note: string; at: Date } | null;
  /** When this person was last pinged that someone is free — once an evening. */
  pingedAt: Date | null;
  /** Prepaid Match credit, kobo: the sum of `pots`, and the balance people see. */
  creditMinor: number;
  /** The same credit by where it came from; spent bonus → gift → paid. */
  pots: MatchPots;
  /** Paid time past the free minutes: per second (₦2/s) or per minute (₦100). */
  billing: MatchBilling;
  /** ISO 3166 country code they chose, e.g. NG. Empty until asked. Matching prefers the same one. */
  country: string;
  /** Match+ runs until this moment; null or past means not a member. */
  plusUntil: Date | null;
  /** When staff approved their selfie check; shown as a Verified badge. */
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const profileSchema = new Schema<IMatchProfile>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    gender: { type: String, enum: MATCH_GENDERS, required: true },
    x: { type: String, default: '', trim: true, maxlength: 15 },
    instagram: { type: String, default: '', trim: true, maxlength: 30 },
    adultAt: { type: Date, required: true },
    blocked: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
    bannedUntil: { type: Date, default: null },
    sectionRequest: {
      type: new Schema(
        { note: { type: String, default: '', maxlength: 300 }, at: Date },
        { _id: false },
      ),
      default: null,
    },
    pingedAt: { type: Date, default: null },
    creditMinor: { type: Number, default: 0, min: 0 },
    pots: {
      bonus: { type: Number, default: 0, min: 0 },
      gift: { type: Number, default: 0, min: 0 },
      paid: { type: Number, default: 0, min: 0 },
    },
    billing: { type: String, enum: MATCH_BILLINGS, default: 'second' },
    country: { type: String, default: '', uppercase: true, match: /^([A-Z]{2})?$/ },
    plusUntil: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const MatchProfile: Model<IMatchProfile> =
  mongoose.models.MatchProfile ?? mongoose.model<IMatchProfile>('MatchProfile', profileSchema);

/* ---------------------------------------------------- push subscriptions --- */

/**
 * A browser that asked to be pinged when someone is free on Match. One per
 * device; a subscription the push service reports gone is deleted.
 */
export interface IMatchPush extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: Date;
}

const pushSchema = new Schema<IMatchPush>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const MatchPush: Model<IMatchPush> =
  mongoose.models.MatchPush ?? mongoose.model<IMatchPush>('MatchPush', pushSchema);

/* ------------------------------------------------------------- the days --- */

/** The most people online at once on a Match evening (Lagos date). */
export interface IMatchDay extends Document {
  day: string;
  peakOnline: number;
  peakMale: number;
  peakFemale: number;
}

const daySchema = new Schema<IMatchDay>({
  day: { type: String, required: true, unique: true },
  peakOnline: { type: Number, default: 0 },
  peakMale: { type: Number, default: 0 },
  peakFemale: { type: Number, default: 0 },
});

export const MatchDay: Model<IMatchDay> =
  mongoose.models.MatchDay ?? mongoose.model<IMatchDay>('MatchDay', daySchema);
