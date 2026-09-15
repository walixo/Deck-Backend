import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * One player's best score on one game.
 *
 * A row per player per game, not a row per run. A leaderboard of every attempt
 * is a leaderboard of whoever played most — one good player fills all ten
 * places and nobody else can see where they stand. Keeping only the best makes
 * the top ten ten different people.
 *
 * Scores are self-reported by the browser and cannot be otherwise: the games
 * run entirely on the client, so there is no server-side simulation to check
 * them against. The bound below rejects the absurd; it does not make this
 * trustworthy, and nothing here should ever gate a reward.
 */
export interface IScore extends Document {
  _id: mongoose.Types.ObjectId;
  game: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  score: number;
  /** When the best was set — not when the row was created. */
  achievedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Well past any real run, and far short of an overflow. */
export const MAX_SCORE = 10_000_000;

const scoreSchema = new Schema<IScore>(
  {
    game: { type: Schema.Types.ObjectId, ref: 'Game', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    score: { type: Number, required: true, min: 0, max: MAX_SCORE },
    achievedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

/* One row per player per game — enforced by the database, not by the handler
   remembering to check. Two runs finishing at once cannot make two rows. */
scoreSchema.index({ game: 1, user: 1 }, { unique: true });

/* The leaderboard's only query. */
scoreSchema.index({ game: 1, score: -1, achievedAt: 1 });

export const Score: Model<IScore> =
  mongoose.models.Score ?? mongoose.model<IScore>('Score', scoreSchema);
