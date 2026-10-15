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
 * Two kinds, distinguished by `provider`:
 *
 *  - `bachs` — automatic. The transfer run sends cleared earnings to the
 *    seller's Bachs sub-account and writes one of these. This is the only kind
 *    created now.
 *  - `manual` — the history from before sub-accounts, when staff sent a bank
 *    transfer by hand and recorded it here. Kept because it is the record of
 *    money that really left, and every balance still subtracts it.
 *
 * A `bachs` payout is written *before* Bachs is called, as `pending`, and its
 * own id is the idempotency key for the transfer. That ordering is the whole
 * defence against paying twice: if the process dies after Bachs moves the
 * money but before this row is updated, the next run finds the pending row
 * and repeats the identical request — and Bachs returns the transfer it
 * already made rather than making another. Pending rows count as paid out in
 * every balance, so nothing is ever re-sent on the strength of a crash.
 */
export interface IPayout extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  seller: mongoose.Types.ObjectId;
  amountMinor: number;
  currency: string;
  provider: 'manual' | 'bachs';
  /**
   * `pending` from the moment the row is written until Bachs answers. `failed`
   * means Bachs refused the transfer outright (an insufficient balance, an
   * inactive capability); a failed row stops counting as paid out, so the
   * money becomes available to the next run again.
   */
  status: 'pending' | 'paid' | 'failed';
  /** Bachs's transfer (`tr_…`), once it exists. */
  transferId?: string;
  /** For `bachs`, the sub-account id; for `manual`, staff's free-text note of
      where the money went. */
  destination?: string;
  note?: string;
  paidAt: Date;
  /** Staff who recorded a manual payout. Absent on automatic transfers. */
  recordedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const payoutSchema = new Schema<IPayout>(
  {
    reference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, default: CURRENCY, uppercase: true },
    provider: { type: String, enum: ['manual', 'bachs'], default: 'manual' },
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'paid', index: true },
    transferId: { type: String, trim: true },
    destination: { type: String, trim: true, maxlength: 200 },
    note: { type: String, trim: true, maxlength: 400 },
    paidAt: { type: Date, required: true, default: Date.now },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

/** A seller's payout history reads newest first. */
payoutSchema.index({ seller: 1, paidAt: -1 });

export const Payout: Model<IPayout> =
  mongoose.models.Payout ?? mongoose.model<IPayout>('Payout', payoutSchema);
