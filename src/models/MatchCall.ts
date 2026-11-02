import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * One two-minute conversation on Match, kept for the record: who talked, for
 * how long, how it ended, and whether they swapped usernames.
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
  /** Who ended it, when one person did (left or reported). */
  endedBy: mongoose.Types.ObjectId | null;
  /** How long each had waited in line before this match. */
  maleWaitMs: number;
  femaleWaitMs: number;
  /** Both pressed +1 minute. */
  extended: boolean;
  /** How many minutes were added; the first is free, later ones paid. */
  extensions: number;
  /** The audio went through the TURN relay because a direct route failed. */
  relayed: boolean;
  /** How the call sounded from each side, as each browser reported it at the end. */
  quality: { male: MatchCallQuality | null; female: MatchCallQuality | null };
  /** Who pressed share. Usernames are revealed only when both did. */
  sharedBy: mongoose.Types.ObjectId[];
  revealedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One side's report: which way the audio went, how much was lost or patched
 * over (concealed — garbled audio shows up here), jitter and round trip, and
 * the device in broad strokes. No audio, no content.
 */
export interface MatchCallQuality {
  connected: boolean;
  route: 'direct' | 'relay' | 'none';
  lossPct: number | null;
  concealedPct: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  heardSeconds: number | null;
  os: string;
  browser: string;
  at: Date;
}

const qualitySchema = new Schema<MatchCallQuality>(
  {
    connected: { type: Boolean, required: true },
    route: { type: String, enum: ['direct', 'relay', 'none'], required: true },
    lossPct: { type: Number, default: null },
    concealedPct: { type: Number, default: null },
    jitterMs: { type: Number, default: null },
    rttMs: { type: Number, default: null },
    heardSeconds: { type: Number, default: null },
    os: { type: String, default: '' },
    browser: { type: String, default: '' },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const callSchema = new Schema<IMatchCall>(
  {
    callId: { type: String, required: true, unique: true },
    male: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    female: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    matchedAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, enum: MATCH_END_REASONS, default: null },
    endedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    maleWaitMs: { type: Number, default: 0 },
    femaleWaitMs: { type: Number, default: 0 },
    extended: { type: Boolean, default: false },
    extensions: { type: Number, default: 0 },
    relayed: { type: Boolean, default: false },
    quality: {
      male: { type: qualitySchema, default: null },
      female: { type: qualitySchema, default: null },
    },
    sharedBy: { type: [Schema.Types.ObjectId], default: [] },
    revealedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
callSchema.index({ matchedAt: -1 });

export const MatchCall: Model<IMatchCall> =
  mongoose.models.MatchCall ?? mongoose.model<IMatchCall>('MatchCall', callSchema);

/* ----------------------------------------------------------- reports --- */

export const MATCH_REPORT_REASONS = ['abusive', 'sexual', 'underage', 'spam', 'other'] as const;
export type MatchReportReason = (typeof MATCH_REPORT_REASONS)[number];

/** Open until staff look; dismissed reports stop counting towards a pause. */
export const MATCH_REPORT_STATUSES = ['open', 'actioned', 'dismissed'] as const;
export type MatchReportStatus = (typeof MATCH_REPORT_STATUSES)[number];

export interface IMatchReport extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string;
  reporter: mongoose.Types.ObjectId;
  reported: mongoose.Types.ObjectId;
  reason: MatchReportReason;
  note: string;
  status: MatchReportStatus;
  reviewedAt: Date | null;
  createdAt: Date;
}

const reportSchema = new Schema<IMatchReport>(
  {
    callId: { type: String, required: true },
    reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reported: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, enum: MATCH_REPORT_REASONS, required: true },
    note: { type: String, default: '', maxlength: 500 },
    status: { type: String, enum: MATCH_REPORT_STATUSES, default: 'open', index: true },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
/* One report per person per call. */
reportSchema.index({ callId: 1, reporter: 1 }, { unique: true });

export const MatchReport: Model<IMatchReport> =
  mongoose.models.MatchReport ?? mongoose.model<IMatchReport>('MatchReport', reportSchema);
