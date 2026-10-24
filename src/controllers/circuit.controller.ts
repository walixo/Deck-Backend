import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { Agent, type IAgent } from '../models/Agent';
import { AgentGame, type IAgentGame } from '../models/AgentGame';
import { Attempt, ATTEMPTS_PER_DAY, type IAttempt } from '../models/Attempt';
import type { IUser } from '../models/User';
import {
  CHALLENGES,
  findChallenge,
  pointsFor,
  toChallengeInfo,
  type Challenge,
} from '../services/circuit';
import { communityChallenge, type Version } from '../services/circuit/community';
import { ChallengeError } from '../services/circuit/community/protocol';
import { ApiError } from '../utils/ApiError';
import type { MovesInput, SubmitInput } from '../validators/circuit.validators';

/**
 * Deck Circuit: challenges, attempts and the boards.
 *
 * The agent half runs on an AgentID key (`/api/agents/v1`); the boards and
 * the challenge list are public (`/api/agents`). Grading happens here and
 * only here — an agent sends answers and moves, never scores.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Practice runs at community games get more room: developers iterate. */
const TEST_ATTEMPTS_PER_DAY = 200;

const loadGame = (slug: string) =>
  AgentGame.findOne({ slug }).select('+signingSecret').populate('owner', 'gameId');

/* Owners arrive populated or as bare IDs depending on the query; compare IDs. */
const idOf = (ref: unknown) => String((ref as { _id?: unknown } | null)?._id ?? ref);

const ownsGame = (agent: IAgent | undefined, game: IAgentGame) =>
  Boolean(agent?.owner && game.owner && idOf(game.owner) === idOf(agent.owner));

/** A community game's failure, said plainly — and never a 500. */
function challengeFailed(error: unknown): never {
  if (error instanceof ChallengeError) {
    throw new ApiError(502, `The challenge did not answer correctly: ${error.message}`);
  }
  throw error;
}

/** A challenge anyone may read: built-in, or a community game that is approved. */
async function publicChallenge(slug: string): Promise<Challenge> {
  const builtIn = findChallenge(slug);
  if (builtIn) return builtIn;
  const game = await loadGame(slug);
  if (!game?.live || game.status === 'retired')
    throw ApiError.notFound('No challenge with that name');
  return communityChallenge(game, 'live');
}

/**
 * What this agent plays at this slug. Built-ins are the same for everyone.
 * A community game's approved version is for everyone; its operator's own
 * agents play the draft instead, as practice that never reaches a board.
 */
async function challengeForAgent(
  slug: string,
  agent: IAgent,
): Promise<{ challenge: Challenge; test: boolean; version: Version | null }> {
  const builtIn = findChallenge(slug);
  if (builtIn) return { challenge: builtIn, test: false, version: null };
  const game = await loadGame(slug);
  if (!game || game.status === 'retired') throw ApiError.notFound('No challenge with that name');
  if (ownsGame(agent, game)) {
    return { challenge: communityChallenge(game, 'draft'), test: true, version: 'draft' };
  }
  if (!game.live) throw ApiError.notFound('No challenge with that name');
  return { challenge: communityChallenge(game, 'live'), test: false, version: 'live' };
}

/** The challenge an existing attempt was started on, in the version it used. */
async function challengeForAttempt(attempt: IAttempt): Promise<Challenge> {
  const builtIn = findChallenge(attempt.challenge);
  if (builtIn) return builtIn;
  const game = await loadGame(attempt.challenge);
  if (!game) throw ApiError.notFound('That challenge no longer exists');
  try {
    return communityChallenge(game, attempt.version ?? 'live');
  } catch (error) {
    return challengeFailed(error);
  }
}

function playingAgent(req: Request): IAgent {
  const agent = req.agent!;
  if (agent.status !== 'active') {
    throw ApiError.forbidden('Your operator needs to claim this agent before it can play');
  }
  return agent;
}

function toAttempt(attempt: IAttempt) {
  return {
    attemptId: attempt.attemptId,
    challenge: attempt.challenge,
    status: attempt.status,
    startedAt: attempt.startedAt,
    deadline: attempt.deadline,
    limitMs: attempt.limitMs ?? findChallenge(attempt.challenge)?.limitMs ?? null,
    test: attempt.test ?? false,
    finishedAt: attempt.finishedAt,
    quality: attempt.quality,
    points: attempt.points,
    timeMs: attempt.timeMs,
    detail: attempt.detail,
    stats: attempt.stats,
  };
}

/** Closes an attempt whose clock has run out. Returns it as it now stands. */
async function settle(attempt: IAttempt): Promise<IAttempt> {
  if (attempt.status !== 'active' || attempt.deadline.getTime() > Date.now()) return attempt;
  const expired = {
    status: 'expired' as const,
    quality: 0,
    points: 0,
    timeMs: attempt.deadline.getTime() - attempt.startedAt.getTime(),
    detail: 'Time ran out',
    finishedAt: attempt.deadline,
  };
  const { modifiedCount } = await Attempt.updateOne(
    { _id: attempt._id, status: 'active' },
    { $set: expired },
  );
  /* Updated in place, so a caller holding the secret keeps it. If something
     else finished it first, read back what that was. */
  if (modifiedCount) return Object.assign(attempt, expired);
  return (await Attempt.findById(attempt._id).select('+secret'))!;
}

async function ownAttempt(req: Request, withSecret = false): Promise<IAttempt> {
  const query = Attempt.findOne({ attemptId: req.params.attemptId, agent: req.agent!._id });
  if (withSecret) query.select('+secret');
  const attempt = await query;
  if (!attempt) throw ApiError.notFound('No attempt of yours with that ID');
  return settle(attempt);
}

/** Writes a result, once: a second finish for the same attempt loses. */
async function finish(
  attempt: IAttempt,
  challenge: Challenge,
  result: { quality: number; detail: string; stats?: Record<string, number> },
  extra: Record<string, unknown> = {},
  guard: Record<string, unknown> = {},
): Promise<IAttempt> {
  const now = new Date();
  const timeMs = now.getTime() - attempt.startedAt.getTime();
  const done = await Attempt.findOneAndUpdate(
    { _id: attempt._id, status: 'active', ...guard },
    {
      $set: {
        ...extra,
        status: 'finished',
        quality: result.quality,
        points: pointsFor(challenge, result.quality, timeMs),
        timeMs,
        detail: result.detail,
        stats: result.stats ?? null,
        finishedAt: now,
      },
    },
    { new: true },
  );
  if (!done) throw ApiError.conflict('This attempt has already finished');
  return done;
}

/* ------------------------------------------------------------ public --- */

/**
 * The built-in challenges and every approved community one. Called with an
 * agent key, it adds the drafts the agent's operator is building, marked as
 * practice.
 */
export async function listChallenges(req: Request, res: Response): Promise<void> {
  const approved = await AgentGame.find({ status: { $ne: 'retired' }, live: { $ne: null } })
    .select('+signingSecret')
    .populate('owner', 'gameId')
    .sort({ reviewedAt: 1 });
  const community = approved.map((game) => ({
    ...toChallengeInfo(communityChallenge(game, 'live')),
    community: true,
  }));
  const owner = req.agent?.owner;
  const drafts = owner
    ? await AgentGame.find({ owner, status: { $ne: 'retired' } })
        .select('+signingSecret')
        .populate('owner', 'gameId')
    : [];
  const practice = drafts.map((game) => ({
    ...toChallengeInfo(communityChallenge(game, 'draft')),
    community: true,
    practice: true,
    status: game.status,
  }));
  res.json({
    success: true,
    data: [...CHALLENGES.map(toChallengeInfo), ...community, ...practice],
  });
}

export async function getChallenge(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: toChallengeInfo(await publicChallenge(req.params.slug)) });
}

type BoardRow = {
  _id: IAgent['_id'];
  points: number;
  quality?: number;
  timeMs?: number;
  at?: Date;
  played?: number;
};

/** Agent cards for board rows, leaving out anyone suspended. */
async function withAgents<T extends BoardRow>(rows: T[]) {
  const agents = await Agent.find({ _id: { $in: rows.map((r) => r._id) } }).populate(
    'owner',
    'gameId',
  );
  const byId = new Map(agents.map((a) => [String(a._id), a]));
  return rows
    .map((row) => {
      const agent = byId.get(String(row._id));
      if (!agent || agent.status === 'suspended') return null;
      const owner = agent.owner as unknown as IUser | null;
      const { _id, ...rest } = row;
      void _id;
      return {
        agent: {
          agentId: agent.agentId,
          name: agent.name,
          status: agent.status,
          operator: owner?.gameId?.handle ? { handle: owner.gameId.handle } : null,
        },
        ...rest,
      };
    })
    .filter(Boolean)
    .map((row, index) => ({ rank: index + 1, ...row! }));
}

/** Each agent's best result at one challenge, best first; ties go to the faster. */
export async function challengeBoard(req: Request, res: Response): Promise<void> {
  const challenge = await publicChallenge(req.params.slug);
  const rows = await Attempt.aggregate<BoardRow>([
    {
      $match: {
        challenge: challenge.slug,
        status: 'finished',
        points: { $gt: 0 },
        test: { $ne: true },
      },
    },
    { $sort: { points: -1, timeMs: 1 } },
    {
      $group: {
        _id: '$agent',
        points: { $first: '$points' },
        quality: { $first: '$quality' },
        timeMs: { $first: '$timeMs' },
        at: { $first: '$finishedAt' },
      },
    },
    { $sort: { points: -1, timeMs: 1 } },
    { $limit: 25 },
  ]);
  res.json({
    success: true,
    data: { challenge: toChallengeInfo(challenge), rows: await withAgents(rows) },
  });
}

/** The season: each agent's best at every challenge, added up. */
export async function seasonBoard(_req: Request, res: Response): Promise<void> {
  const rows = await Attempt.aggregate<BoardRow>([
    { $match: { status: 'finished', points: { $gt: 0 }, test: { $ne: true } } },
    { $group: { _id: { agent: '$agent', challenge: '$challenge' }, best: { $max: '$points' } } },
    { $group: { _id: '$_id.agent', points: { $sum: '$best' }, played: { $sum: 1 } } },
    { $sort: { points: -1 } },
    { $limit: 25 },
  ]);
  res.json({ success: true, data: { rows: await withAgents(rows) } });
}

/* ------------------------------------------------------------- agent --- */

export async function startAttempt(req: Request, res: Response): Promise<void> {
  const agent = playingAgent(req);
  const { challenge, test, version } = await challengeForAgent(req.params.slug, agent);
  const now = Date.now();

  /* Anything left running past its clock is closed first, so it neither
     blocks this start nor lingers as "active". */
  const overdue = await Attempt.find({
    agent: agent._id,
    status: 'active',
    deadline: { $lte: new Date(now) },
  });
  await Promise.all(overdue.map(settle));

  const today = await Attempt.countDocuments({
    agent: agent._id,
    challenge: challenge.slug,
    startedAt: { $gt: new Date(now - DAY_MS) },
  });
  const allowance = test ? TEST_ATTEMPTS_PER_DAY : ATTEMPTS_PER_DAY;
  if (today >= allowance) {
    throw new ApiError(429, `${allowance} attempts a day at each challenge. Try again tomorrow.`);
  }

  const seed = crypto.randomInt(2 ** 31);
  const generated = await Promise.resolve(challenge.generate(seed)).catch(challengeFailed);
  try {
    const attempt = await Attempt.create({
      attemptId: `att_${crypto.randomBytes(8).toString('hex')}`,
      agent: agent._id,
      agentId: agent.agentId,
      challenge: challenge.slug,
      seed,
      puzzle: generated.puzzle,
      secret: generated.secret,
      state: generated.state ?? null,
      limitMs: challenge.limitMs,
      test,
      version,
      startedAt: new Date(now),
      deadline: new Date(now + challenge.limitMs),
    });
    const observation =
      challenge.observe && generated.state
        ? await Promise.resolve(
            challenge.observe(generated.secret, generated.state, generated.puzzle),
          ).catch(challengeFailed)
        : undefined;
    res.status(201).json({
      success: true,
      data: {
        attempt: toAttempt(attempt),
        puzzle: generated.puzzle,
        ...(observation && { observation }),
      },
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const active = await Attempt.findOne({ agent: agent._id, status: 'active' });
      throw ApiError.conflict(
        `Finish or abandon your active attempt first${active ? `: ${active.attemptId} (${active.challenge})` : ''}`,
      );
    }
    throw error;
  }
}

export async function listMyAttempts(req: Request, res: Response): Promise<void> {
  const filter: Record<string, unknown> = { agent: req.agent!._id };
  if (typeof req.query.challenge === 'string') filter.challenge = req.query.challenge;
  const attempts = await Attempt.find(filter).sort({ startedAt: -1 }).limit(25);
  const settled = await Promise.all(attempts.map(settle));
  res.json({ success: true, data: settled.map(toAttempt) });
}

export async function getAttempt(req: Request, res: Response): Promise<void> {
  const attempt = await ownAttempt(req, true);
  const challenge = await challengeForAttempt(attempt);
  const observation =
    challenge.observe && attempt.state
      ? await Promise.resolve(
          challenge.observe(attempt.secret, attempt.state, attempt.puzzle),
        ).catch(challengeFailed)
      : undefined;
  res.json({
    success: true,
    data: {
      attempt: toAttempt(attempt),
      puzzle: attempt.puzzle,
      ...(observation && { observation }),
    },
  });
}

export async function moveAttempt(req: Request, res: Response): Promise<void> {
  const { moves } = req.body as MovesInput;
  const attempt = await ownAttempt(req, true);
  const challenge = await challengeForAttempt(attempt);
  if (!challenge.step || !attempt.state)
    throw ApiError.badRequest('This challenge takes an answer, not moves');
  if (attempt.status !== 'active') throw ApiError.conflict(`This attempt is ${attempt.status}`);

  const result = await Promise.resolve(
    challenge.step(attempt.secret, attempt.state, moves, attempt.puzzle),
  ).catch(challengeFailed);
  /* Guarded on the last write, so two calls racing cannot both move from the
     same square — whatever shape a challenge's state takes. */
  const guard = { updatedAt: attempt.updatedAt };
  let saved: IAttempt | null;
  if (result.finished) {
    saved = await finish(attempt, challenge, result.finished, { state: result.state }, guard).catch(
      () => null,
    );
  } else {
    saved = await Attempt.findOneAndUpdate(
      { _id: attempt._id, status: 'active', ...guard },
      { $set: { state: result.state } },
      { new: true },
    );
  }
  if (!saved) throw ApiError.conflict('Another move landed first — read the attempt and try again');
  res.json({ success: true, data: { attempt: toAttempt(saved), observation: result.observation } });
}

export async function submitAttempt(req: Request, res: Response): Promise<void> {
  const { answer } = req.body as SubmitInput;
  const attempt = await ownAttempt(req, true);
  const challenge = await challengeForAttempt(attempt);
  if (!challenge.grade)
    throw ApiError.badRequest('This challenge is played with moves, not an answer');
  if (attempt.status !== 'active') throw ApiError.conflict(`This attempt is ${attempt.status}`);

  /* A community grader that fails leaves the attempt open, so the agent can
     submit again before its deadline. */
  const result = await Promise.resolve(
    challenge.grade({ puzzle: attempt.puzzle, secret: attempt.secret }, answer),
  ).catch(challengeFailed);
  const done = await finish(attempt, challenge, result);
  res.json({ success: true, data: { attempt: toAttempt(done) } });
}

export async function abandonAttempt(req: Request, res: Response): Promise<void> {
  const attempt = await ownAttempt(req);
  if (attempt.status !== 'active') throw ApiError.conflict(`This attempt is ${attempt.status}`);
  const now = new Date();
  const done = await Attempt.findOneAndUpdate(
    { _id: attempt._id, status: 'active' },
    {
      $set: {
        status: 'abandoned',
        quality: 0,
        points: 0,
        timeMs: now.getTime() - attempt.startedAt.getTime(),
        detail: 'Abandoned',
        finishedAt: now,
      },
    },
    { new: true },
  );
  if (!done) throw ApiError.conflict('This attempt has already finished');
  res.json({ success: true, data: { attempt: toAttempt(done) } });
}
