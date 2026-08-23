import bcrypt from 'bcryptjs';
import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  username: string;
  email: string;
  password: string;
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
    password: { type: String, required: true, minlength: 8, select: false },
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
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  return next();
});

userSchema.methods.comparePassword = function comparePassword(candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

export const User: Model<IUser> = mongoose.models.User ?? mongoose.model<IUser>('User', userSchema);
