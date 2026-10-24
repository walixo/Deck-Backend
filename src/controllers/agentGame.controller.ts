import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import {
  AgentGame,
  AgentGameModule,
  MAX_AGENT_GAMES_PER_OWNER,
  type IAgentGame,
} from '../models/AgentGame';
import type { IUser } from '../models/User';
import { CHALLENGES } from '../services/circuit';
import { configOf, runChecks } from '../services/circuit/community';
import { assertCallable } from '../services/circuit/community/hosted';
import { ChallengeError } from '../services/circuit/community/protocol';
import { inspectModule } from '../services/circuit/community/wasm';
import { ApiError } from '../utils/ApiError';
import type {
  CreateAgentGameInput,
  ReviewAgentGameInput,
  UpdateAgentGameInput,
} from '../validators/agentGame.validators';

/**
 * Building a Deck Circuit challenge: the developer's half (create, configure,
 * upload, check, submit) and staff review. Everything here runs on the Deck
 * session; agents only ever meet the result as a challenge.
 */

const mintSecret = () => `acs_${crypto.randomBytes(24).toString('base64url')}`;

function toView(game: IAgentGame, extra: Record<string, unknown> = {}) {
  const owner = game.owner as unknown as IUser | null;
  return {
    slug: game.slug,
    title: game.title,
    kind: game.kind,
    summary: game.summary,
    rules: game.rules,
    answerFormat: game.answerFormat,
    limitMs: game.limitMs,
    runtime: game.runtime,
    endpointUrl: game.endpointUrl,
    moduleSha: game.moduleSha,
    status: game.status,
    base: game.base,
    secretHint: game.secretHint,
    live: game.live,
    updatePending: game.updatePending,
    checks: game.checks,
    reviewNote: game.reviewNote,
    reviewedAt: game.reviewedAt,
    author: owner?.gameId?.handle ? { handle: owner.gameId.handle } : null,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    ...extra,
  };
}

/** The game, if the signed-in person made it (or is staff). */
async function ownGame(req: Request, withSecret = false): Promise<IAgentGame> {
  const query = AgentGame.findOne({ slug: req.params.slug }).populate('owner', 'gameId');
  if (withSecret) query.select('+signingSecret');
  const game = await query;
  const owner = game?.owner as unknown as IUser | null;
  const mine = owner && String(owner._id) === String(req.user!._id);
  if (!game || (!mine && req.user!.role !== 'admin')) {
    throw ApiError.notFound('No challenge of yours with that name');
  }
  return game;
}

const asBadRequest = (error: unknown): never => {
  if (error instanceof ChallengeError) throw ApiError.badRequest(error.message);
  throw error;
};

export async function listMyAgentGames(req: Request, res: Response): Promise<void> {
  const games = await AgentGame.find({ owner: req.user!._id })
    .sort({ updatedAt: -1 })
    .populate('owner', 'gameId');
  res.json({ success: true, data: games.map((g) => toView(g)) });
}

export async function getAgentGame(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: toView(await ownGame(req)) });
}

export async function createAgentGame(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateAgentGameInput;
  if (
    CHALLENGES.some((c) => c.slug === input.slug) ||
    (await AgentGame.exists({ slug: input.slug }))
  ) {
    throw ApiError.conflict('That name is taken — choose another');
  }
  const open = await AgentGame.countDocuments({ owner: req.user!._id, status: { $ne: 'retired' } });
  if (open >= MAX_AGENT_GAMES_PER_OWNER) {
    throw ApiError.badRequest(
      `You can build up to ${MAX_AGENT_GAMES_PER_OWNER} challenges at a time`,
    );
  }
  if (input.runtime === 'hosted' && input.endpointUrl) {
    await assertCallable(input.endpointUrl).catch(asBadRequest);
  }
  const secret = mintSecret();
  const game = await AgentGame.create({
    slug: input.slug,
    owner: req.user!._id,
    title: input.title,
    kind: input.kind,
    summary: input.summary,
    rules: input.rules,
    answerFormat: input.answerFormat,
    limitMs: input.limitMinutes * 60_000,
    runtime: input.runtime,
    endpointUrl: input.endpointUrl ?? '',
    signingSecret: secret,
    secretHint: secret.slice(-4),
  });
  await game.populate('owner', 'gameId');
  /* The secret is shown here and never again; it can be rotated. */
  res.status(201).json({ success: true, data: toView(game, { signingSecret: secret }) });
}

/* Changing any of these means the last checks no longer describe the game. */
const BEHAVIOUR = ['kind', 'runtime', 'endpointUrl'] as const;

export async function updateAgentGame(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateAgentGameInput;
  const game = await ownGame(req);
  if (game.status === 'retired') throw ApiError.conflict('This challenge is retired');
  if (
    input.runtime === 'hosted' ||
    (input.endpointUrl && (input.runtime ?? game.runtime) === 'hosted')
  ) {
    const url = input.endpointUrl ?? game.endpointUrl;
    if (url) await assertCallable(url).catch(asBadRequest);
  }
  const { limitMinutes, ...rest } = input;
  const behaviourChanged = BEHAVIOUR.some(
    (key) => rest[key] !== undefined && rest[key] !== game[key],
  );
  Object.assign(game, rest);
  if (limitMinutes !== undefined) game.limitMs = limitMinutes * 60_000;
  if (behaviourChanged) game.checks = null;
  /* A rejected game goes back to being a draft once it changes; an approved
     one keeps its live version until the change is reviewed. */
  if (game.status === 'rejected') game.status = 'draft';
  if (game.status === 'pending') game.status = 'draft';
  game.updatePending = false;
  await game.save();
  res.json({ success: true, data: toView(game) });
}

export async function uploadModule(req: Request, res: Response): Promise<void> {
  const game = await ownGame(req);
  if (game.status === 'retired') throw ApiError.conflict('This challenge is retired');
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    throw ApiError.badRequest(
      'Send the module as the request body, with Content-Type: application/wasm',
    );
  }
  const bytes = req.body as Buffer;
  const { sha, exports } = await inspectModule(bytes, game.kind).catch(asBadRequest);
  await AgentGameModule.updateOne(
    { game: game._id, sha },
    { $setOnInsert: { game: game._id, sha, size: bytes.length, bytes, exports } },
    { upsert: true },
  );
  game.runtime = 'wasm';
  if (game.moduleSha !== sha) game.checks = null;
  game.moduleSha = sha;
  if (game.status === 'rejected' || game.status === 'pending') game.status = 'draft';
  game.updatePending = false;
  await game.save();
  res.json({ success: true, data: toView(game, { module: { sha, size: bytes.length, exports } }) });
}

export async function rotateSecret(req: Request, res: Response): Promise<void> {
  const game = await ownGame(req, true);
  const secret = mintSecret();
  game.signingSecret = secret;
  game.secretHint = secret.slice(-4);
  await game.save();
  res.json({ success: true, data: { signingSecret: secret, secretHint: game.secretHint } });
}

export async function checkAgentGame(req: Request, res: Response): Promise<void> {
  const game = await ownGame(req, true);
  const report = await runChecks(game);
  game.checks = { at: new Date(), ...report };
  await game.save();
  res.json({ success: true, data: toView(game) });
}

export async function submitAgentGame(req: Request, res: Response): Promise<void> {
  const game = await ownGame(req);
  if (game.status === 'retired') throw ApiError.conflict('This challenge is retired');
  if (!game.checks?.passed)
    throw ApiError.badRequest('Run the checks and pass them all before submitting');
  if (game.status === 'approved') {
    if (JSON.stringify(configOf(game, 'draft')) === JSON.stringify(game.live)) {
      throw ApiError.badRequest('Nothing has changed since it was approved');
    }
    game.updatePending = true;
  } else {
    game.status = 'pending';
  }
  await game.save();
  res.json({ success: true, data: toView(game) });
}

/** Never approved: deleted outright. Approved: retired, so its results stay on record. */
export async function removeAgentGame(req: Request, res: Response): Promise<void> {
  const game = await ownGame(req);
  if (!game.live) {
    await AgentGameModule.deleteMany({ game: game._id });
    await game.deleteOne();
    res.json({ success: true, data: { deleted: true } });
    return;
  }
  game.status = 'retired';
  game.updatePending = false;
  await game.save();
  res.json({ success: true, data: toView(game) });
}

/* ------------------------------------------------------------- staff --- */

export async function listAgentGamesForReview(req: Request, res: Response): Promise<void> {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const filter =
    status === 'pending'
      ? { $or: [{ status: 'pending' }, { status: 'approved', updatePending: true }] }
      : { status };
  const games = await AgentGame.find(filter).sort({ updatedAt: 1 }).populate('owner', 'gameId');
  res.json({ success: true, data: games.map((g) => toView(g)) });
}

export async function reviewAgentGame(req: Request, res: Response): Promise<void> {
  const { decision, note, base } = req.body as ReviewAgentGameInput;
  const game = await AgentGame.findOne({ slug: req.params.slug }).populate('owner', 'gameId');
  if (!game) throw ApiError.notFound('No challenge with that name');
  const waiting = game.status === 'pending' || (game.status === 'approved' && game.updatePending);
  if (!waiting) throw ApiError.conflict('This challenge is not waiting for review');
  if (decision === 'approve') {
    if (!game.checks?.passed) throw ApiError.badRequest('Its checks have not passed');
    game.live = configOf(game, 'draft');
    game.status = 'approved';
    if (base !== undefined) game.base = base;
  } else if (game.status === 'pending') {
    game.status = 'rejected';
  }
  game.updatePending = false;
  game.reviewNote = note ?? '';
  game.reviewedAt = new Date();
  await game.save();
  res.json({ success: true, data: toView(game) });
}
