import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A player's standing consent for one app — what it may see.
 *
 * Remembered so a returning player is not asked the same question every time
 * they sign in. Asking for more than was granted shows the consent screen
 * again; revoking a grant from GameID settings signs that app out everywhere.
 */
export interface IOAuthGrant extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  app: mongoose.Types.ObjectId;
  scopes: string[];
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const oauthGrantSchema = new Schema<IOAuthGrant>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    app: { type: Schema.Types.ObjectId, ref: 'OAuthApp', required: true },
    scopes: { type: [String], required: true },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

oauthGrantSchema.index({ user: 1, app: 1 }, { unique: true });

export const OAuthGrant: Model<IOAuthGrant> =
  mongoose.models.OAuthGrant ?? mongoose.model<IOAuthGrant>('OAuthGrant', oauthGrantSchema);
