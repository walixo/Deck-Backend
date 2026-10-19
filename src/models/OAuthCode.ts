import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A one-time authorization code, alive for ten minutes.
 *
 * Stored as a hash. Everything the token endpoint must check is pinned here
 * at authorization time — the redirect URI, the scopes, the PKCE challenge,
 * the nonce — so the exchange can only ever produce exactly what the player
 * agreed to, for exactly the app and address they agreed to it for.
 *
 * `usedAt` makes it single-use. A second attempt to use a code is treated as
 * a sign it was stolen, and revokes whatever the first use issued (RFC 6749
 * section 4.1.2).
 */
export const CODE_TTL_MS = 10 * 60 * 1000;

export interface IOAuthCode extends Document {
  _id: mongoose.Types.ObjectId;
  codeHash: string;
  app: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string | null;
  nonce: string | null;
  authTime: Date;
  usedAt: Date | null;
  expiresAt: Date;
}

const oauthCodeSchema = new Schema<IOAuthCode>({
  codeHash: { type: String, required: true, unique: true },
  app: { type: Schema.Types.ObjectId, ref: 'OAuthApp', required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  redirectUri: { type: String, required: true },
  scopes: { type: [String], required: true },
  codeChallenge: { type: String, default: null },
  nonce: { type: String, default: null },
  authTime: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});

/* Kept an hour past expiry rather than deleted at it, so a late replay of a
   used code is still recognised as a replay and not as an unknown code. */
oauthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });

export const OAuthCode: Model<IOAuthCode> =
  mongoose.models.OAuthCode ?? mongoose.model<IOAuthCode>('OAuthCode', oauthCodeSchema);
