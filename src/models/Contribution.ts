import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { CONTRIBUTION_STATUSES, CURRENCY, type ContributionStatus } from '../constants';

/**
 * One person backing one launch.
 *
 * Keep-what-you-raise: a contribution that Paystack confirms is final. There is
 * no pledge state and no deadline to miss, so nothing here ever needs to be
 * unwound — which is also why the launch's running total can be incremented on
 * confirmation and trusted from then on.
 *
 * The fee split is frozen onto the row at creation. Deck's percentage can
 * change later; what this contributor was actually charged and what the
 * launcher was actually sent must not.
 */
export interface IContribution extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  item: mongoose.Types.ObjectId;
  /** The launcher the money settles to. */
  beneficiary: mongoose.Types.ObjectId;
  contributor: mongoose.Types.ObjectId;
  email: string;
  amountMinor: number;
  platformFeeMinor: number;
  netMinor: number;
  currency: string;
  status: ContributionStatus;
  message?: string;
  /** Hides the name on the supporters list. The row still knows who paid. */
  anonymous: boolean;
  authorizationUrl?: string;
  paidAt?: Date;
  channel?: string;
  createdAt: Date;
  updatedAt: Date;
}

const contributionSchema = new Schema<IContribution>(
  {
    reference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    beneficiary: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contributor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    amountMinor: { type: Number, required: true, min: 0 },
    platformFeeMinor: { type: Number, required: true, min: 0, default: 0 },
    netMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: CURRENCY, uppercase: true },
    status: { type: String, enum: CONTRIBUTION_STATUSES, default: 'pending', index: true },
    message: { type: String, trim: true, maxlength: 280 },
    anonymous: { type: Boolean, default: false },
    authorizationUrl: { type: String, trim: true },
    paidAt: Date,
    channel: String,
  },
  { timestamps: true },
);

/** Supporter lists read newest-first within one launch. */
contributionSchema.index({ item: 1, status: 1, createdAt: -1 });

export const Contribution: Model<IContribution> =
  mongoose.models.Contribution ?? mongoose.model<IContribution>('Contribution', contributionSchema);
