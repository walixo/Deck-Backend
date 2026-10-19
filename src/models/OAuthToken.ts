import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * An access token and its refresh token, issued together.
 *
 * Both are opaque random strings, stored as hashes. Access tokens live an
 * hour; refresh tokens thirty days, and rotate — every refresh issues a new
 * pair and retires the old one. Each chain of rotations shares a `family`, so
 * if a retired refresh token is ever presented again (someone kept a copy),
 * the whole family is revoked: the thief and the player are both signed out,
 * and the player simply signs in again.
 */
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IOAuthToken extends Document {
  _id: mongoose.Types.ObjectId;
  accessHash: string;
  refreshHash: string;
  app: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  scopes: string[];
  family: string;
  /** The code this family began with — revoked together if it is replayed. */
  code: mongoose.Types.ObjectId | null;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const oauthTokenSchema = new Schema<IOAuthToken>(
  {
    accessHash: { type: String, required: true, unique: true },
    refreshHash: { type: String, required: true, unique: true },
    app: { type: Schema.Types.ObjectId, ref: 'OAuthApp', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    scopes: { type: [String], required: true },
    family: { type: String, required: true, index: true },
    code: { type: Schema.Types.ObjectId, ref: 'OAuthCode', default: null },
    accessExpiresAt: { type: Date, required: true },
    refreshExpiresAt: { type: Date, required: true },
    rotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

oauthTokenSchema.index({ user: 1, app: 1 });
/* A family's last refresh token expiring is the end of it; tidy a day later. */
oauthTokenSchema.index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const OAuthToken: Model<IOAuthToken> =
  mongoose.models.OAuthToken ?? mongoose.model<IOAuthToken>('OAuthToken', oauthTokenSchema);
