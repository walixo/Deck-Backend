import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Who a Deck user is to one game.
 *
 * A developer never learns a player's Deck id, email or username — only this
 * `playerId`, which is random, stable for that person in that game, and
 * different in every other game. Two developers comparing notes cannot join
 * their players up, and a leaked id from one game says nothing in another.
 *
 * Test play gets its own id (`t_…`) so a developer's testing never lands in
 * their live data, and live ids (`p_…`) never appear in a test environment.
 */
export interface IGamePlayer extends Document {
  _id: mongoose.Types.ObjectId;
  game: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  mode: 'test' | 'live';
  playerId: string;
  createdAt: Date;
}

const gamePlayerSchema = new Schema<IGamePlayer>(
  {
    game: { type: Schema.Types.ObjectId, ref: 'Game', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mode: { type: String, enum: ['test', 'live'], required: true },
    playerId: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

gamePlayerSchema.index({ game: 1, user: 1, mode: 1 }, { unique: true });

export const GamePlayer: Model<IGamePlayer> =
  mongoose.models.GamePlayer ?? mongoose.model<IGamePlayer>('GamePlayer', gamePlayerSchema);
