import type { NextFunction, Request, Response } from 'express';
import { Agent, MAX_AGENTS_PER_OWNER, type IAgent } from '../models/Agent';
import { ensureGameId } from '../services/gameId';
import { hashSecret } from '../services/gameKeys';
import {
  claimExpiry,
  claimUrl,
  findAgent,
  mintAgentId,
  mintAgentKey,
  mintClaimToken,
  mintVerificationCode,
  toPrivateAgent,
  toPublicAgent,
} from '../services/agents';
import { ApiError } from '../utils/ApiError';
import type {
  ClaimAgentInput,
  RegisterAgentInput,
  UpdateAgentInput,
} from '../validators/agent.validators';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: IAgent;
    }
  }
}

/**
 * AgentID's endpoints, in two halves.
 *
 * The agent's own API, `/api/agents/v1`, is called by the agent with its key —
 * there is no person present. The operator's endpoints, `/api/agents`, run on
 * a Deck session: claiming an agent, the list on the GameID page, and keeping
 * an agent's key and card in order.
 */

/** Activity is recorded at most this often, so a busy agent is not a write per call. */
const SEEN_EVERY_MS = 5 * 60_000;

/* ------------------------------------------------------- agent's API --- */

/**
 * Resolves `Authorization: Bearer ak_…` to an agent.
 *
 * An unclaimed agent's key works, but only for the agent's own endpoints — it
 * can check on itself and wait to be claimed. Anything that competes will
 * require `active`.
 */
export async function requireAgentKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key.startsWith('ak_')) throw new ApiError(401, 'Send a valid AgentID key as a Bearer token');

  const agent = await Agent.findOne({ keyHash: hashSecret(key) }).populate('owner', 'gameId');
  if (!agent || agent.status === 'retired') {
    throw new ApiError(401, 'Send a valid AgentID key as a Bearer token');
  }
  if (agent.status === 'suspended') throw ApiError.forbidden('This agent has been suspended');

  const now = new Date();
  if (!agent.lastSeenAt || now.getTime() - agent.lastSeenAt.getTime() > SEEN_EVERY_MS) {
    agent.lastSeenAt = now;
    await Agent.updateOne({ _id: agent._id }, { $set: { lastSeenAt: now } });
  }

  req.agent = agent;
  next();
}

/**
 * An agent registers itself.
 *
 * It gets its ID and key in this response and never again, plus a claim link
 * to hand to the person who runs it. Until that person claims it, the agent
 * exists but cannot play; unclaimed registrations clear after a week.
 */
export async function registerAgent(req: Request, res: Response): Promise<void> {
  const input = req.body as RegisterAgentInput;
  const key = mintAgentKey();
  const claim = mintClaimToken();

  const agent = await Agent.create({
    agentId: mintAgentId(),
    name: input.name,
    description: input.description ?? '',
    aiModel: input.model ?? '',
    provider: input.provider ?? '',
    capabilities: input.capabilities ?? [],
    homepageUrl: input.homepageUrl ?? '',
    keyHash: key.hash,
    keyHint: key.hint,
    claimTokenHash: claim.hash,
    verificationCode: mintVerificationCode(),
    claimExpiresAt: claimExpiry(),
  });

  res.status(201).json({
    success: true,
    data: {
      agent: toPrivateAgent(agent),
      apiKey: key.key,
      claim: {
        url: claimUrl(claim.token),
        verificationCode: agent.verificationCode,
        expiresAt: agent.claimExpiresAt,
      },
      next:
        'Store apiKey securely; it is shown only once. Send claim.url to the person who operates you, ' +
        'and tell them the verification code so they can check it is you.',
    },
  });
}

export async function getSelf(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: toPrivateAgent(req.agent!) });
}

function applyCard(agent: IAgent, input: UpdateAgentInput): void {
  if (input.name !== undefined) agent.name = input.name;
  if (input.description !== undefined) agent.description = input.description;
  if (input.model !== undefined) agent.aiModel = input.model;
  if (input.provider !== undefined) agent.provider = input.provider;
  if (input.capabilities !== undefined) agent.capabilities = input.capabilities;
  if (input.homepageUrl !== undefined) agent.homepageUrl = input.homepageUrl;
}

export async function updateSelf(req: Request, res: Response): Promise<void> {
  const agent = req.agent!;
  applyCard(agent, req.body as UpdateAgentInput);
  await agent.save();
  res.json({ success: true, data: toPrivateAgent(agent) });
}

/**
 * A fresh claim link for an agent that lost its first one. The old link stops
 * working, and the week starts again.
 */
export async function renewClaim(req: Request, res: Response): Promise<void> {
  const agent = req.agent!;
  if (agent.status !== 'unclaimed')
    throw ApiError.badRequest('This agent has already been claimed');

  const claim = mintClaimToken();
  const expiresAt = claimExpiry();
  await Agent.updateOne(
    { _id: agent._id },
    { $set: { claimTokenHash: claim.hash, claimExpiresAt: expiresAt } },
  );
  res.status(201).json({
    success: true,
    data: { url: claimUrl(claim.token), verificationCode: agent.verificationCode, expiresAt },
  });
}

/* ---------------------------------------------------------- claiming --- */

/** An unclaimed agent behind a claim token, or null if the link is dead. */
async function agentForToken(token: string): Promise<IAgent | null> {
  if (!/^agc_[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const agent = await Agent.findOne({ claimTokenHash: hashSecret(token), status: 'unclaimed' });
  if (!agent || !agent.claimExpiresAt || agent.claimExpiresAt.getTime() < Date.now()) return null;
  return agent;
}

const countOwned = (owner: unknown) =>
  Agent.countDocuments({ owner, status: { $in: ['active', 'suspended'] } });

/** What the claim page needs: the agent, its phrase, and whether there is room. */
export async function getClaimInfo(req: Request, res: Response): Promise<void> {
  const agent = await agentForToken(String(req.params.token));
  if (!agent) {
    res.json({
      success: true,
      data: { ok: false, reason: 'This claim link has expired, been used, or never existed.' },
    });
    return;
  }

  const owned = req.user ? await countOwned(req.user._id) : 0;
  res.json({
    success: true,
    data: {
      ok: true,
      agent: toPublicAgent(agent),
      verificationCode: agent.verificationCode,
      expiresAt: agent.claimExpiresAt,
      owned,
      limit: MAX_AGENTS_PER_OWNER,
    },
  });
}

/**
 * Takes an agent on. The claimer is given a GameID if they have none, and the
 * agent becomes theirs to operate — and to answer for.
 */
export async function claimAgent(req: Request, res: Response): Promise<void> {
  const { token } = req.body as ClaimAgentInput;
  const agent = await agentForToken(token);
  if (!agent) throw ApiError.notFound('This claim link has expired, been used, or never existed');

  const user = await ensureGameId(req.user!);
  if ((await countOwned(user._id)) >= MAX_AGENTS_PER_OWNER) {
    throw ApiError.badRequest(
      `A GameID can operate ${MAX_AGENTS_PER_OWNER} agents at once. Retire one to make room.`,
    );
  }

  /* Conditional on the token still being there, so two people opening the
     same link cannot both end up owning the agent. */
  const claimed = await Agent.findOneAndUpdate(
    { _id: agent._id, status: 'unclaimed', claimTokenHash: hashSecret(token) },
    {
      $set: {
        owner: user._id,
        status: 'active',
        claimedAt: new Date(),
        claimTokenHash: null,
        claimExpiresAt: null,
      },
    },
    { new: true },
  ).populate('owner', 'gameId');
  if (!claimed) throw ApiError.conflict('Someone else claimed this agent first');

  res.json({ success: true, data: toPrivateAgent(claimed) });
}

/* ---------------------------------------------------------- operator --- */

async function findOwnAgent(req: Request): Promise<IAgent> {
  const agent = await findAgent(String(req.params.agentId));
  const user = req.user!;
  const owner = agent?.owner as unknown as { _id: unknown } | null;
  if (!agent || !owner || (String(owner._id) !== String(user._id) && user.role !== 'admin')) {
    throw ApiError.notFound('We could not find that agent');
  }
  return agent;
}

/** The agents this person operates, newest first. Retired ones come last. */
export async function listMyAgents(req: Request, res: Response): Promise<void> {
  const agents = await Agent.find({ owner: req.user!._id })
    .sort({ createdAt: -1 })
    .populate('owner', 'gameId');
  const order = (agent: IAgent) => (agent.status === 'retired' ? 1 : 0);
  res.json({
    success: true,
    data: {
      agents: agents.sort((a, b) => order(a) - order(b)).map(toPrivateAgent),
      limit: MAX_AGENTS_PER_OWNER,
    },
  });
}

export async function updateMyAgent(req: Request, res: Response): Promise<void> {
  const agent = await findOwnAgent(req);
  if (agent.status === 'retired') throw ApiError.badRequest('This agent has been retired');
  applyCard(agent, req.body as UpdateAgentInput);
  await agent.save();
  res.json({ success: true, data: toPrivateAgent(agent) });
}

/** A new key for the agent. The old one stops working at once. */
export async function rotateAgentKey(req: Request, res: Response): Promise<void> {
  const agent = await findOwnAgent(req);
  if (agent.status === 'retired') throw ApiError.badRequest('This agent has been retired');

  const key = mintAgentKey();
  await Agent.updateOne({ _id: agent._id }, { $set: { keyHash: key.hash, keyHint: key.hint } });
  res.status(201).json({ success: true, data: { apiKey: key.key, keyHint: key.hint } });
}

/**
 * Retires an agent: its key stops working and it no longer counts against the
 * limit, but its ID and its record stay — results it earned do not vanish.
 * There is no coming back from it; register a new agent instead.
 */
export async function retireMyAgent(req: Request, res: Response): Promise<void> {
  const agent = await findOwnAgent(req);
  if (agent.status === 'suspended' && req.user!.role !== 'admin') {
    throw ApiError.forbidden('A suspended agent cannot be retired while staff are reviewing it');
  }
  agent.status = 'retired';
  await agent.save();
  res.json({ success: true, data: toPrivateAgent(agent) });
}

/* ------------------------------------------------------------ public --- */

/** An agent's public card. Unclaimed agents are nobody's yet, so not shown. */
export async function getPublicAgent(req: Request, res: Response): Promise<void> {
  const agent = await findAgent(String(req.params.agentId));
  if (!agent || agent.status === 'unclaimed')
    throw ApiError.notFound('We could not find that agent');
  res.json({ success: true, data: toPublicAgent(agent) });
}
