import type { Request, Response } from 'express';
import { MatchCall, MatchReport } from '../models/MatchCall';
import { MatchProfile, type IMatchProfile } from '../models/MatchProfile';
import * as hub from '../services/matchHub';
import { ApiError } from '../utils/ApiError';
import type {
  CreateMatchProfileInput,
  MatchReportInput,
  MatchSignalInput,
  UpdateMatchProfileInput,
} from '../validators/match.validators';

/**
 * Match — match.onedeck.africa: two voices, two minutes.
 *
 * Signed in with Google through Deck's own accounts. A person says once
 * whether they are a man or a woman and confirms they are an adult; from then
 * on they open a stream (`stream`), join their line (`joinQueue`) and the
 * match hub does the rest. See `services/matchHub.ts` for the live half.
 */

/** Distinct people reporting someone within this window ban them for a week. */
const REPORTS_TO_BAN = 3;
const REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BAN_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNAL_MAX_BYTES = 16 * 1024;

const banned = (profile: IMatchProfile) =>
  Boolean(profile.bannedUntil && profile.bannedUntil.getTime() > Date.now());

function toProfileResponse(profile: IMatchProfile) {
  return {
    gender: profile.gender,
    lagosLife: profile.lagosLife,
    bannedUntil: banned(profile) ? profile.bannedUntil : null,
  };
}

const presence = (profile: IMatchProfile): hub.Presence => ({
  userId: String(profile.user),
  gender: profile.gender,
  handle: profile.lagosLife,
  blocked: profile.blocked.map(String),
});

/** The caller's profile, ready to match — or a reason they cannot. */
async function ready(req: Request): Promise<IMatchProfile> {
  const profile = await MatchProfile.findOne({ user: req.user!._id });
  if (!profile) throw ApiError.badRequest('Set up Match first');
  if (banned(profile)) throw ApiError.forbidden('Your account is paused after reports');
  return profile;
}

/** How many people are on Match now. Public: the landing page shows it. */
export function online(_req: Request, res: Response): void {
  res.json({ success: true, data: hub.counts() });
}

export async function getMe(req: Request, res: Response): Promise<void> {
  const profile = await MatchProfile.findOne({ user: req.user!._id });
  res.json({ success: true, data: profile ? toProfileResponse(profile) : null });
}

/** First visit: gender and the adult check. */
export async function createMe(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateMatchProfileInput;
  const existing = await MatchProfile.findOne({ user: req.user!._id });
  if (existing) {
    if (existing.gender !== input.gender) {
      throw ApiError.conflict('Your section is already set');
    }
    if (input.lagosLife !== undefined) existing.lagosLife = input.lagosLife;
    await existing.save();
    hub.update(presence(existing));
    res.json({ success: true, data: toProfileResponse(existing) });
    return;
  }
  const profile = await MatchProfile.create({
    user: req.user!._id,
    gender: input.gender,
    lagosLife: input.lagosLife ?? '',
    adultAt: new Date(),
  });
  res.status(201).json({ success: true, data: toProfileResponse(profile) });
}

/** Changes the LagosLife username. The section stays as it was set. */
export async function updateMe(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateMatchProfileInput;
  const profile = await MatchProfile.findOne({ user: req.user!._id });
  if (!profile) throw ApiError.badRequest('Set up Match first');
  if (input.gender && input.gender !== profile.gender) {
    throw ApiError.conflict('Your section is already set');
  }
  profile.lagosLife = input.lagosLife;
  await profile.save();
  hub.update(presence(profile));
  res.json({ success: true, data: toProfileResponse(profile) });
}

/** The live line: counts, the queue, matches, call set-up, the clock. */
export async function stream(req: Request, res: Response): Promise<void> {
  const profile = await ready(req);
  hub.attach(presence(profile), res);
}

export async function joinQueue(req: Request, res: Response): Promise<void> {
  await ready(req);
  res.json({ success: true, data: hub.enqueue(String(req.user!._id)) });
}

export function leaveQueue(req: Request, res: Response): void {
  hub.dequeue(String(req.user!._id));
  res.json({ success: true, data: { left: true } });
}

export function signal(req: Request, res: Response): void {
  const input = req.body as MatchSignalInput;
  if (JSON.stringify(input.data).length > SIGNAL_MAX_BYTES) {
    throw ApiError.badRequest('That message is too large');
  }
  hub.relay(String(req.user!._id), String(req.params.callId), input.data);
  res.json({ success: true, data: { sent: true } });
}

export function connected(req: Request, res: Response): void {
  hub.connected(String(req.user!._id), String(req.params.callId));
  res.json({ success: true, data: { ok: true } });
}

export function leaveCall(req: Request, res: Response): void {
  hub.leave(String(req.user!._id), String(req.params.callId));
  res.json({ success: true, data: { left: true } });
}

export async function share(req: Request, res: Response): Promise<void> {
  const profile = await ready(req);
  const callId = String(req.params.callId);
  const result = hub.share(String(req.user!._id), callId, profile.lagosLife);
  await MatchCall.updateOne(
    { callId },
    {
      $addToSet: { sharedBy: req.user!._id },
      ...(result.revealed ? { $set: { revealedAt: new Date() } } : {}),
    },
  );
  res.json({ success: true, data: result });
}

/**
 * Reports the other person. They are blocked for the reporter at once, a live
 * call ends, and three different reporters within a week pause their account.
 */
export async function report(req: Request, res: Response): Promise<void> {
  const input = req.body as MatchReportInput;
  const me = String(req.user!._id);
  const callId = String(req.params.callId);
  const other = hub.partner(me, callId);

  try {
    await MatchReport.create({
      callId,
      reporter: me,
      reported: other,
      reason: input.reason,
      note: input.note ?? '',
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }

  const mine = await MatchProfile.findOneAndUpdate(
    { user: me },
    { $addToSet: { blocked: other } },
    { new: true },
  );
  if (mine) hub.update(presence(mine));
  try {
    hub.leave(me, callId, 'reported');
  } catch {
    /* Already over. */
  }

  const reporters = await MatchReport.distinct('reporter', {
    reported: other,
    createdAt: { $gt: new Date(Date.now() - REPORT_WINDOW_MS) },
  });
  if (reporters.length >= REPORTS_TO_BAN) {
    await MatchProfile.updateOne({ user: other }, { bannedUntil: new Date(Date.now() + BAN_MS) });
    hub.kick(other);
  }
  res.json({ success: true, data: { reported: true, blocked: true } });
}

/** Everyone the caller swapped usernames with, newest first. */
export async function matches(req: Request, res: Response): Promise<void> {
  const me = req.user!._id;
  const calls = await MatchCall.find({
    revealedAt: { $ne: null },
    $or: [{ male: me }, { female: me }],
  })
    .sort({ revealedAt: -1 })
    .limit(30);
  const others = calls.map((call) => (String(call.male) === String(me) ? call.female : call.male));
  const profiles = await MatchProfile.find({ user: { $in: others } }).select('user lagosLife');
  const handles = new Map(profiles.map((p) => [String(p.user), p.lagosLife]));
  res.json({
    success: true,
    data: calls
      .map((call, index) => ({
        handle: handles.get(String(others[index])) ?? '',
        at: call.revealedAt,
      }))
      .filter((match) => match.handle),
  });
}
