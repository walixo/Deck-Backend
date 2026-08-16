import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { CURRENCY } from '../constants';

/**
 * A disbursement Deck has made to a seller.
 *
 * Deck collects every payment and owes sellers their share, so this is the
 * other half of that debt: a record of money actually sent.
 *
 * Deliberately the *only* thing stored about a balance. What a seller is owed
 * is derived — everything they have earned, minus everything recorded here —
 * rather than kept as a running total. A stored balance is a second source of
 * truth that drifts the first time an update fails halfway, and on a ledger
 * that nobody external reconciles, a drift is invisible until someone is short.
 *
 * Recorded by hand by staff after the transfer leaves the bank. Deck arranges
 * the transfer out of band; `destination` is a free-text note of where it went.
 */
export interface IPayout extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  seller: mongoose.Types.ObjectId;
  amountMinor: number;
  currency: string;
  /** Free text: bank, account, transfer id — whatever staff need to trace it. */
  destination?: string;
  note?: string;
  paidAt: Date;
  recordedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const payoutSchema = new Schema<IPayout>(
  {
    reference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, default: CURRENCY, uppercase: true },
    destination: { type: String, trim: true, maxlength: 200 },
    note: { type: String, trim: true, maxlength: 400 },
    paidAt: { type: Date, required: true, default: Date.now },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

/** A seller's payout history reads newest first. */
payoutSchema.index({ seller: 1, paidAt: -1 });

export const Payout: Model<IPayout> =
  mongoose.models.Payout ?? mongoose.model<IPayout>('Payout', payoutSchema);
