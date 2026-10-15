import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A short-lived proof, handed to a game in the browser, that a real Deck
 * player is at the keyboard.
 *
 * The game passes the token to its own server, which asks Deck's server API
 * who it belongs to. That round trip is the point: anything the browser says
 * about who is playing can be forged, and this cannot.
 *
 * Fifteen minutes, stored as a hash, removed by a TTL index. The SDK fetches a
 * fresh one whenever the game asks, so a long session never sits on a token
 * old enough to be worth stealing.
 */
export const SESSION_TTL_MS = 15 * 60 * 1000;

export interface IGameSession extends Document {
  _id: mongoose.Types.ObjectId;
  tokenHash: string;
  game: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  playerId: string;
  mode: 'test' | 'live';
  expiresAt: Date;
  createdAt: Date;
}

const gameSessionSchema = new Schema<IGameSession>(
  {
    tokenHash: { type: String, required: true, unique: true },
    game: { type: Schema.Types.ObjectId, ref: 'Game', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    playerId: { type: String, required: true },
    mode: { type: String, enum: ['test', 'live'], required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/* Mongo deletes each one at its own expiry. Lookups still check `expiresAt`,
   because the TTL monitor only runs once a minute. */
gameSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GameSession: Model<IGameSession> =
  mongoose.models.GameSession ?? mongoose.model<IGameSession>('GameSession', gameSessionSchema);
