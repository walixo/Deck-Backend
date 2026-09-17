import bcrypt from 'bcryptjs';
import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { OAUTH_PROVIDERS, type OAuthProvider } from '../constants';

/** A provider account bound to this Deck account. */
export interface IIdentity {
  provider: OAuthProvider;
  /** The provider's own immutable id for the account — never the email. */
  providerId: string;
  linkedAt: Date;
}

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  username: string;
  email: string;
  /*
   * Absent on accounts that have only ever signed in through a provider.
   *
   * `comparePassword` returns false when it is missing rather than throwing,
   * so a password attempt against a GitHub-only account fails the way a wrong
   * password does — which is the right answer, and is also what stops the
   * login form from becoming an oracle for which accounts have passwords.
   */
  password?: string;
  identities: IIdentity[];
  avatarUrl?: string;
  bio?: string;
  headline?: string;
  websiteUrl?: string;
  role: 'user' | 'admin';
  /** Staff-granted mark that this account is who it says it is. */
  verified: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: [/^[a-z0-9_]+$/, 'Usernames can only contain letters, numbers and underscores'],
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    /*
     * Not required, because a GitHub or Google account never sets one.
     *
     * The register endpoint still demands a password — that is enforced in the
     * validator, where it belongs, because it is a rule about that one way of
     * creating an account rather than about what an account is.
     */
    password: { type: String, minlength: 8, select: false },

    /*
     * Which provider accounts can sign in as this user.
     *
     * Keyed on the provider's immutable id rather than on the email, because
     * an email is a thing people change and a thing an attacker may be able to
     * claim on a provider that does not verify it. The email is used once, at
     * link time, and never trusted again after that.
     *
     * An array rather than two optional fields so a third provider is a row
     * and not a migration.
     */
    identities: {
      type: [
        {
          _id: false,
          provider: { type: String, enum: OAUTH_PROVIDERS, required: true },
          providerId: { type: String, required: true },
          linkedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    avatarUrl: { type: String, trim: true },
    bio: { type: String, trim: true, maxlength: 280 },
    headline: { type: String, trim: true, maxlength: 80 },
    websiteUrl: { type: String, trim: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },

    /*
     * Verification is about identity, not standing. It says Deck checked that
     * this account belongs to who it claims — nothing about whether their
     * launches are any good, which is what votes and reviews are for.
     *
     * Deliberately separate from `role`: a verified account is usually not
     * staff, and conflating the two would either hand badges to admins or
     * privileges to verified makers.
     */
    verified: { type: Boolean, default: false, index: true },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.pre('save', async function hashPassword(next) {
  /* Nothing to hash on a provider-only account, and `bcrypt.hash(undefined)`
     throws — which would make every save of such an account fail. */
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 10);
  return next();
});

userSchema.methods.comparePassword = async function comparePassword(
  candidate: string,
): Promise<boolean> {
  /* No hash means this account has no password to compare against — a
     provider-only account. Answer "no", identically to a wrong password. */
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

/* The lookup every social sign-in does: "which account owns this provider
   id". Unique across the collection, so one GitHub account cannot end up
   attached to two Deck accounts — sparse because most users have neither. */
userSchema.index(
  { 'identities.provider': 1, 'identities.providerId': 1 },
  { unique: true, sparse: true },
);

export const User: Model<IUser> = mongoose.models.User ?? mongoose.model<IUser>('User', userSchema);
