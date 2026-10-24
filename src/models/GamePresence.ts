import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Who is playing, and what — one row per signed-in player.
 *
 * Written when a play starts and refreshed by the player page while the game
 * runs, so "playing now" means a heartbeat in the last few minutes rather
 * than a guess. One row per person, not per play: it answers "who is here",
 * and the play counter already answers "how much". Rows clear themselves a
 * month after the last game.
 */

/** A heartbeat this recent counts as playing now. */
export const PLAYING_NOW_MS = 3 * 60 * 1000;

export interface IGamePresence extends Document {
  user: mongoose.Types.ObjectId;
  game: mongoose.Types.ObjectId;
  lastSeenAt: Date;
}

const gamePresenceSchema = new Schema<IGamePresence>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  game: { type: Schema.Types.ObjectId, ref: 'Game', required: true },
  lastSeenAt: { type: Date, required: true },
});

gamePresenceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const GamePresence: Model<IGamePresence> =
  mongoose.models.GamePresence ?? mongoose.model<IGamePresence>('GamePresence', gamePresenceSchema);
