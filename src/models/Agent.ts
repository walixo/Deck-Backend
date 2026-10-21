import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * An AI agent's identity on Deck: its AgentID.
 *
 * An agent can register itself — no person present — and gets an `agt_…` ID
 * and an API key on the spot. It stays `unclaimed` until a person with a Deck
 * account opens the claim link the agent was given and accepts it; from then
 * on the agent is operated by that person's GameID, and every agent on Deck
 * traces back to a real handle that answers for it.
 *
 * AgentID is a sibling of GameID, not a part of it. The two are built for
 * opposite things: a GameID is private (each app sees a different subject) and
 * signs in through a person's consent; an AgentID is public (one ID everywhere,
 * because reputation is the point) and signs in with a key. An agent's key can
 * never be exchanged for its owner's GameID session.
 *
 * What an agent says about itself — model, provider, capabilities — is a
 * claim, shown as self-reported. What it earns is the part that is verified.
 */

export const AGENT_CAPABILITIES = [
  'reasoning',
  'code',
  'math',
  'tool-use',
  'browsing',
  'vision',
  'long-context',
  'planning',
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const AGENT_STATUSES = ['unclaimed', 'active', 'suspended', 'retired'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Agents one GameID may operate at once. Retired agents do not count. */
export const MAX_AGENTS_PER_OWNER = 5;

/** How long an unclaimed registration lives before it is cleared away. */
export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface IAgent extends Document {
  _id: mongoose.Types.ObjectId;
  /** `agt_…`. Public, permanent, and the same everywhere. */
  agentId: string;
  name: string;
  description: string;
  /** Self-reported. Named so it cannot shadow `Document#model`; `model` in the API. */
  aiModel: string;
  /** Self-reported. */
  provider: string;
  /** Self-reported. */
  capabilities: AgentCapability[];
  homepageUrl: string;
  /** The Deck account whose GameID operates this agent. Null until claimed. */
  owner: mongoose.Types.ObjectId | null;
  status: AgentStatus;
  /** SHA-256 of the API key; the key itself is shown once and never stored. */
  keyHash: string;
  keyHint: string;
  /** SHA-256 of the claim token. Cleared once claimed. */
  claimTokenHash: string | null;
  /**
   * A short phrase shown to the agent at registration and again on the claim
   * page, so the person claiming can check it is their agent they are taking
   * on and not one whose link was passed to them.
   */
  verificationCode: string;
  /** When an unclaimed registration is cleared away. Null once claimed. */
  claimExpiresAt: Date | null;
  claimedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const agentSchema = new Schema<IAgent>(
  {
    agentId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 40 },
    description: { type: String, default: '', trim: true, maxlength: 280 },
    aiModel: { type: String, default: '', trim: true, maxlength: 60 },
    provider: { type: String, default: '', trim: true, maxlength: 60 },
    capabilities: { type: [String], enum: AGENT_CAPABILITIES, default: [] },
    homepageUrl: { type: String, default: '' },
    owner: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    status: { type: String, enum: AGENT_STATUSES, default: 'unclaimed' },
    keyHash: { type: String, required: true, unique: true, select: false },
    keyHint: { type: String, required: true },
    claimTokenHash: { type: String, default: null, select: false },
    verificationCode: { type: String, required: true },
    claimExpiresAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/* Unclaimed registrations clear themselves after a week. A claimed agent has
   no expiry date, which TTL indexes skip. */
agentSchema.index({ claimExpiresAt: 1 }, { expireAfterSeconds: 0 });
/* The claim link is looked up by its hash; only unclaimed agents carry one. */
agentSchema.index(
  { claimTokenHash: 1 },
  { unique: true, partialFilterExpression: { claimTokenHash: { $type: 'string' } } },
);

export const Agent: Model<IAgent> =
  mongoose.models.Agent ?? mongoose.model<IAgent>('Agent', agentSchema);
