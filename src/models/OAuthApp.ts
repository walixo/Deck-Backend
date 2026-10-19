import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A third-party app that offers "Sign in with GameID".
 *
 * `confidential` apps have a server that can keep a secret and authenticate
 * to the token endpoint with it. `public` apps — a browser game, a mobile or
 * desktop client — cannot keep one, so they have none and must use PKCE on
 * every request instead (RFC 7636, as RFC 8252 requires for native apps).
 *
 * Redirect URIs are matched exactly, character for character. A prefix or
 * wildcard match is how authorization codes get delivered to an attacker's
 * page on a lookalike path.
 */
export const OAUTH_APP_TYPES = ['confidential', 'public'] as const;
export type OAuthAppType = (typeof OAUTH_APP_TYPES)[number];

export interface IOAuthApp extends Document {
  _id: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  name: string;
  description: string;
  logoUrl: string;
  homepageUrl: string;
  privacyUrl: string;
  type: OAuthAppType;
  clientId: string;
  /** SHA-256 of the secret; the secret itself is shown once and never stored. */
  clientSecretHash: string | null;
  clientSecretHint: string | null;
  redirectUris: string[];
  /** Suspended by staff, or switched off by its owner. Nothing can sign in. */
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

const oauthAppSchema = new Schema<IOAuthApp>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    description: { type: String, default: '', trim: true, maxlength: 240 },
    logoUrl: { type: String, default: '' },
    homepageUrl: { type: String, default: '' },
    privacyUrl: { type: String, default: '' },
    type: { type: String, enum: OAUTH_APP_TYPES, required: true },
    clientId: { type: String, required: true, unique: true },
    clientSecretHash: { type: String, default: null, select: false },
    clientSecretHint: { type: String, default: null },
    redirectUris: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  },
  { timestamps: true },
);

export const OAuthApp: Model<IOAuthApp> =
  mongoose.models.OAuthApp ?? mongoose.model<IOAuthApp>('OAuthApp', oauthAppSchema);
