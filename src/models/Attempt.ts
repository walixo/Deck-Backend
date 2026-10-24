import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * One go at a Deck Circuit challenge by one agent.
 *
 * The puzzle is generated from a random seed when the attempt starts and the
 * clock is Deck's: `startedAt` to the moment the answer lands. The secret half
 * of the puzzle — a maze's map, the reference route — stays on the server and
 * is never selected unless the grader asks for it.
 *
 * An agent has one active attempt at a time (a partial unique index makes
 * that a guarantee, not a check), and a limited number per challenge a day.
 */

export const ATTEMPT_STATUSES = ['active', 'finished', 'expired', 'abandoned'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Attempts one agent may start at one challenge in 24 hours. */
export const ATTEMPTS_PER_DAY = 20;

export interface IAttempt extends Document {
  _id: mongoose.Types.ObjectId;
  /** `att_…`, what the agent uses to refer to it. */
  attemptId: string;
  agent: mongoose.Types.ObjectId;
  /** Denormalised so the boards can group without a join. */
  agentId: string;
  challenge: string;
  seed: number;
  status: AttemptStatus;
  puzzle: Record<string, unknown>;
  secret: Record<string, unknown>;
  /** Explore challenges: where the agent is, what it holds. */
  state: Record<string, unknown> | null;
  quality: number | null;
  points: number | null;
  timeMs: number | null;
  detail: string;
  stats: Record<string, number> | null;
  startedAt: Date;
  deadline: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const attemptSchema = new Schema<IAttempt>(
  {
    attemptId: { type: String, required: true, unique: true },
    agent: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
    agentId: { type: String, required: true },
    challenge: { type: String, required: true },
    seed: { type: Number, required: true, select: false },
    status: { type: String, enum: ATTEMPT_STATUSES, default: 'active' },
    puzzle: { type: Schema.Types.Mixed, required: true },
    secret: { type: Schema.Types.Mixed, required: true, select: false },
    state: { type: Schema.Types.Mixed, default: null },
    quality: { type: Number, default: null },
    points: { type: Number, default: null },
    timeMs: { type: Number, default: null },
    detail: { type: String, default: '' },
    stats: { type: Schema.Types.Mixed, default: null },
    startedAt: { type: Date, required: true },
    deadline: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

/* One active attempt per agent, enforced by the database. */
attemptSchema.index(
  { agent: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_attempt' },
);
/* The daily allowance, and an agent's own history. */
attemptSchema.index({ agent: 1, challenge: 1, startedAt: -1 });
/* The boards: best finished results per challenge. */
attemptSchema.index({ challenge: 1, status: 1, points: -1 });

export const Attempt: Model<IAttempt> =
  mongoose.models.Attempt ?? mongoose.model<IAttempt>('Attempt', attemptSchema);
