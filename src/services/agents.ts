import crypto from 'node:crypto';
import { Agent, CLAIM_TTL_MS, type IAgent } from '../models/Agent';
import type { IUser } from '../models/User';
import { hashSecret } from './gameKeys';
import { issuer } from './gameId';

/**
 * AgentID's secrets and shapes. Keys and claim tokens follow the games
 * platform's rule: random from the OS, stored only as a SHA-256 hash, shown
 * once. See `gameKeys.ts` for why a plain hash is right for random secrets.
 */

const random = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');

/** `agt_` and sixteen lowercase hex characters. Short enough to read out. */
export const mintAgentId = (): string => `agt_${crypto.randomBytes(8).toString('hex')}`;

/** `ak_…` — the agent's API key. */
export function mintAgentKey(): { key: string; hash: string; hint: string } {
  const key = `ak_${random(32)}`;
  return { key, hash: hashSecret(key), hint: key.slice(-4) };
}

/** `agc_…` — the one-time token in a claim link. */
export function mintClaimToken(): { token: string; hash: string } {
  const token = `agc_${random(24)}`;
  return { token, hash: hashSecret(token) };
}

/* Short, unambiguous words: the phrase is read off one screen and checked
   against another, so nothing in it should look like anything else. */
const WORDS = [
  'amber',
  'birch',
  'cedar',
  'delta',
  'ember',
  'fjord',
  'grove',
  'harbor',
  'indigo',
  'juniper',
  'kestrel',
  'lumen',
  'meadow',
  'nimbus',
  'orbit',
  'prism',
  'quartz',
  'reef',
  'sable',
  'tundra',
  'umber',
  'vertex',
  'willow',
  'zephyr',
];

/** e.g. `reef-4821`. */
export function mintVerificationCode(): string {
  return `${WORDS[crypto.randomInt(WORDS.length)]}-${crypto.randomInt(1000, 10000)}`;
}

export const claimExpiry = (): Date => new Date(Date.now() + CLAIM_TTL_MS);

/** Where a person goes to claim an agent. Lives on the frontend, under GameID. */
export const claimUrl = (token: string): string => `${issuer()}/gameid/agents/claim/${token}`;

type Operator = { handle: string } | null;

function operatorOf(agent: IAgent): Operator {
  const owner = agent.owner as unknown as IUser | null;
  if (!owner || typeof owner !== 'object' || !('gameId' in owner)) return null;
  return owner.gameId?.handle ? { handle: owner.gameId.handle } : null;
}

/** What anyone may see: the card, who operates it, and when it joined. */
export function toPublicAgent(agent: IAgent) {
  return {
    agentId: agent.agentId,
    name: agent.name,
    description: agent.description,
    model: agent.aiModel,
    provider: agent.provider,
    capabilities: agent.capabilities,
    homepageUrl: agent.homepageUrl,
    status: agent.status,
    operator: operatorOf(agent),
    claimedAt: agent.claimedAt,
    createdAt: agent.createdAt,
  };
}

/** What the agent and its operator see on top: the key hint and activity. */
export function toPrivateAgent(agent: IAgent) {
  return {
    ...toPublicAgent(agent),
    keyHint: agent.keyHint,
    lastSeenAt: agent.lastSeenAt,
    claim:
      agent.status === 'unclaimed'
        ? { verificationCode: agent.verificationCode, expiresAt: agent.claimExpiresAt }
        : null,
  };
}

/** Finds an agent by ID with its operator's GameID handle attached. */
export function findAgent(agentId: string) {
  return Agent.findOne({ agentId }).populate('owner', 'gameId');
}
