import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A badge somebody has earned.
 *
 * Stored rather than derived, which is the opposite of how Deck treats the
 * seller ledger — and for a reason. A balance should always reflect the rows
 * behind it, so recomputing it is a feature. An achievement is a fact about the
 * past: you *did* top the board, you *did* ship your twenty-fifth launch. If
 * one of those launches is deleted next year, that day still happened, and a
 * derived badge would quietly take it back.
 *
 * Storing it also gives the two things a live count cannot: the date it was
 * earned, and a moment to tell someone about it.
 */
export interface IBadgeAward extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  badge: string;
  /** What the counter stood at when it tipped over. Useful, and it dates well. */
  value: number;
  earnedAt: Date;
}

const badgeAwardSchema = new Schema<IBadgeAward>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    badge: { type: String, required: true, trim: true },
    value: { type: Number, required: true, min: 0 },
    earnedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

/**
 * One award per badge per person, enforced by the database.
 *
 * The evaluator can run concurrently — two requests finishing at once both
 * seeing the same fresh milestone — and this is what stops that becoming two
 * identical trophies. The insert is written to expect the clash.
 */
badgeAwardSchema.index({ user: 1, badge: 1 }, { unique: true });
badgeAwardSchema.index({ user: 1, earnedAt: -1 });

export const BadgeAward: Model<IBadgeAward> =
  mongoose.models.BadgeAward ?? mongoose.model<IBadgeAward>('BadgeAward', badgeAwardSchema);
