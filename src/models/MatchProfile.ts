import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A person's Match settings: which section they talk from, the LagosLife
 * username they may choose to share, and who they never want to hear again.
 *
 * Gender is set once. It decides who a person is matched with, so letting it
 * change at will would let anyone hop queues; someone who chose wrong asks
 * (`sectionRequest`) and staff switch it.
 */

export const MATCH_GENDERS = ['male', 'female'] as const;
export type MatchGender = (typeof MATCH_GENDERS)[number];

export interface IMatchProfile extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  gender: MatchGender;
  /** Without the @. Empty until they add one; needed only to share. */
  lagosLife: string;
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
  createdAt: Date;
  updatedAt: Date;
}

const profileSchema = new Schema<IMatchProfile>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    gender: { type: String, enum: MATCH_GENDERS, required: true },
    lagosLife: { type: String, default: '', trim: true, maxlength: 30 },
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
