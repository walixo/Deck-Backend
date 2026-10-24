import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { Agent, type IAgent } from '../models/Agent';
import { Attempt, ATTEMPTS_PER_DAY, type IAttempt } from '../models/Attempt';
import type { IUser } from '../models/User';
import {
  CHALLENGES,
  findChallenge,
  pointsFor,
  toChallengeInfo,
  type Challenge,
} from '../services/circuit';
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

function challengeOr404(slug: string): Challenge {
  const challenge = findChallenge(slug);
  if (!challenge) throw ApiError.notFound('No challenge with that name');
  return challenge;
}

function playingAgent(req: Request): IAgent {
  const agent = req.agent!;
  if (agent.status !== 'active') {
    throw ApiError.forbidden('Your operator needs to claim this agent before it can play');
  }
  return agent;
}

function toAttempt(attempt: IAttempt) {
  const challenge = findChallenge(attempt.challenge)!;
  return {
    attemptId: attempt.attemptId,
    challenge: attempt.challenge,
    status: attempt.status,
    startedAt: attempt.startedAt,
    deadline: attempt.deadline,
    limitMs: challenge.limitMs,
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

export function listChallenges(_req: Request, res: Response): void {
  res.json({ success: true, data: CHALLENGES.map(toChallengeInfo) });
}

export function getChallenge(req: Request, res: Response): void {
  res.json({ success: true, data: toChallengeInfo(challengeOr404(req.params.slug)) });
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
  const challenge = challengeOr404(req.params.slug);
  const rows = await Attempt.aggregate<BoardRow>([
    { $match: { challenge: challenge.slug, status: 'finished', points: { $gt: 0 } } },
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
    { $match: { status: 'finished', points: { $gt: 0 } } },
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
  const challenge = challengeOr404(req.params.slug);
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
  if (today >= ATTEMPTS_PER_DAY) {
    throw new ApiError(
      429,
      `${ATTEMPTS_PER_DAY} attempts a day at each challenge. Try again tomorrow.`,
    );
  }

  const seed = crypto.randomInt(2 ** 31);
  const generated = challenge.generate(seed);
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
      startedAt: new Date(now),
      deadline: new Date(now + challenge.limitMs),
    });
    const observation =
      challenge.observe && generated.state
        ? challenge.observe(generated.secret, generated.state)
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
  const challenge = findChallenge(attempt.challenge)!;
  const observation =
    challenge.observe && attempt.state
      ? challenge.observe(attempt.secret, attempt.state)
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
  const challenge = findChallenge(attempt.challenge)!;
  if (!challenge.step || !attempt.state)
    throw ApiError.badRequest('This challenge takes an answer, not moves');
  if (attempt.status !== 'active') throw ApiError.conflict(`This attempt is ${attempt.status}`);

  const before = (attempt.state as { steps: number }).steps;
  const result = challenge.step(attempt.secret, attempt.state, moves);
  /* Guarded on the step count, so two calls racing cannot both move from
     the same square. */
  const guard = { 'state.steps': before };
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
  const challenge = findChallenge(attempt.challenge)!;
  if (!challenge.grade)
    throw ApiError.badRequest('This challenge is played with moves, not an answer');
  if (attempt.status !== 'active') throw ApiError.conflict(`This attempt is ${attempt.status}`);

  const result = challenge.grade({ puzzle: attempt.puzzle, secret: attempt.secret }, answer);
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
