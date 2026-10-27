import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * One two-minute conversation on Match, kept for the record: who talked, for
 * how long, how it ended, and whether they swapped LagosLife usernames.
 *
 * The voices themselves never touch Deck — they travel browser to browser —
 * so there is nothing here to listen back to. The live state of a call lives
 * in the match hub; this is written when it starts and when it ends.
 */

export const MATCH_END_REASONS = ['time', 'left', 'no-connection', 'reported'] as const;
export type MatchEndReason = (typeof MATCH_END_REASONS)[number];

export interface IMatchCall extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string;
  /** Always one man and one woman. */
  male: mongoose.Types.ObjectId;
  female: mongoose.Types.ObjectId;
  matchedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  endReason: MatchEndReason | null;
  /** Who pressed share. Usernames are revealed only when both did. */
  sharedBy: mongoose.Types.ObjectId[];
  revealedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const callSchema = new Schema<IMatchCall>(
  {
    callId: { type: String, required: true, unique: true },
    male: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    female: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    matchedAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, enum: MATCH_END_REASONS, default: null },
    sharedBy: { type: [Schema.Types.ObjectId], default: [] },
    revealedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const MatchCall: Model<IMatchCall> =
  mongoose.models.MatchCall ?? mongoose.model<IMatchCall>('MatchCall', callSchema);

/* ----------------------------------------------------------- reports --- */

export const MATCH_REPORT_REASONS = ['abusive', 'sexual', 'underage', 'spam', 'other'] as const;
export type MatchReportReason = (typeof MATCH_REPORT_REASONS)[number];

export interface IMatchReport extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string;
  reporter: mongoose.Types.ObjectId;
  reported: mongoose.Types.ObjectId;
  reason: MatchReportReason;
  note: string;
  createdAt: Date;
}

const reportSchema = new Schema<IMatchReport>(
  {
    callId: { type: String, required: true },
    reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reported: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, enum: MATCH_REPORT_REASONS, required: true },
    note: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
/* One report per person per call. */
reportSchema.index({ callId: 1, reporter: 1 }, { unique: true });

export const MatchReport: Model<IMatchReport> =
  mongoose.models.MatchReport ?? mongoose.model<IMatchReport>('MatchReport', reportSchema);
