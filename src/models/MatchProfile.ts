import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A person's Match settings: which section they talk from, the LagosLife
 * username they may choose to share, and who they never want to hear again.
 *
 * Gender is set once. It decides who a person is matched with, so letting it
 * change at will would let anyone hop queues; a mistake is fixed by staff.
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
  },
  { timestamps: true },
);

export const MatchProfile: Model<IMatchProfile> =
  mongoose.models.MatchProfile ?? mongoose.model<IMatchProfile>('MatchProfile', profileSchema);
