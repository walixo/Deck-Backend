import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { CHALLENGE_KINDS, type ChallengeKind } from '../services/circuit/types';

/**
 * A Deck Circuit challenge built by someone outside Deck.
 *
 * Two ways to run one, behind the same contract — generate a puzzle from a
 * seed, grade an answer (or apply moves), and optionally solve, for the
 * checks:
 *   hosted — Deck calls the developer's HTTPS endpoint, signing every request.
 *   wasm   — the developer uploads a pure WebAssembly module, and Deck runs it
 *            in a sandbox inside its own API.
 *
 * Deck keeps everything that makes the board mean something: the seed, the
 * clock, the stored secret half of each puzzle, the grading record and the
 * board itself.
 *
 * The game has two copies of its configuration. The draft is what the
 * developer edits and tests with their own agents. `live` is a snapshot taken
 * when staff approve it, and is what everyone else plays — so a reviewed game
 * cannot be changed quietly. Changes to the draft reach `live` only through
 * another review. (A hosted game's server can still change what it computes;
 * that is the trade the hosted runtime makes, and why the checks re-run.)
 */

export const AGENT_GAME_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'retired'] as const;
export type AgentGameStatus = (typeof AGENT_GAME_STATUSES)[number];

export const AGENT_GAME_RUNTIMES = ['hosted', 'wasm'] as const;
export type AgentGameRuntime = (typeof AGENT_GAME_RUNTIMES)[number];

/** Games one person may have in draft or review at once. */
export const MAX_AGENT_GAMES_PER_OWNER = 5;

export interface AgentGameConfig {
  title: string;
  kind: ChallengeKind;
  summary: string;
  rules: string[];
  answerFormat: string;
  limitMs: number;
  runtime: AgentGameRuntime;
  endpointUrl: string;
  /** SHA-256 of the WebAssembly module, hex. */
  moduleSha: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface IAgentGame extends Document, AgentGameConfig {
  _id: mongoose.Types.ObjectId;
  slug: string;
  owner: mongoose.Types.ObjectId;
  status: AgentGameStatus;
  /** Set by staff at approval; 100–500. */
  base: number;
  /** Signs hosted requests. Stored so Deck can sign; never shown again after minting. */
  signingSecret: string;
  secretHint: string;
  /** The approved snapshot everyone else plays. Null until first approval. */
  live: AgentGameConfig | null;
  /** True while a changed draft of an approved game waits for review. */
  updatePending: boolean;
  checks: { at: Date; passed: boolean; results: CheckResult[] } | null;
  reviewNote: string;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const configFields = {
  title: { type: String, required: true, trim: true, maxlength: 60 },
  kind: { type: String, enum: CHALLENGE_KINDS, required: true },
  summary: { type: String, required: true, trim: true, maxlength: 160 },
  rules: { type: [String], default: [] },
  answerFormat: { type: String, required: true, maxlength: 400 },
  limitMs: { type: Number, required: true, min: 60_000, max: 30 * 60_000 },
  runtime: { type: String, enum: AGENT_GAME_RUNTIMES, required: true },
  endpointUrl: { type: String, default: '' },
  moduleSha: { type: String, default: '' },
};

const agentGameSchema = new Schema<IAgentGame>(
  {
    slug: { type: String, required: true, unique: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: AGENT_GAME_STATUSES, default: 'draft' },
    base: { type: Number, default: 300, min: 100, max: 500 },
    ...configFields,
    signingSecret: { type: String, required: true, select: false },
    secretHint: { type: String, required: true },
    live: { type: new Schema(configFields, { _id: false }), default: null },
    updatePending: { type: Boolean, default: false },
    checks: { type: Schema.Types.Mixed, default: null },
    reviewNote: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

agentGameSchema.index({ status: 1, updatedAt: -1 });

export const AgentGame: Model<IAgentGame> =
  mongoose.models.AgentGame ?? mongoose.model<IAgentGame>('AgentGame', agentGameSchema);

/**
 * An uploaded WebAssembly module, kept by its hash. Immutable: a new upload
 * is a new row, so the version a game was approved with is always there.
 */
export interface IAgentGameModule extends Document {
  game: mongoose.Types.ObjectId;
  sha: string;
  size: number;
  bytes: Buffer;
  exports: string[];
  createdAt: Date;
}

const moduleSchema = new Schema<IAgentGameModule>(
  {
    game: { type: Schema.Types.ObjectId, ref: 'AgentGame', required: true },
    sha: { type: String, required: true },
    size: { type: Number, required: true },
    bytes: { type: Buffer, required: true },
    exports: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

moduleSchema.index({ game: 1, sha: 1 }, { unique: true });

export const AgentGameModule: Model<IAgentGameModule> =
  mongoose.models.AgentGameModule ??
  mongoose.model<IAgentGameModule>('AgentGameModule', moduleSchema);
