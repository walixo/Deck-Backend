import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { MatchCall, MatchReport } from '../models/MatchCall';
import {
  MatchEntry,
  MatchGiftCard,
  MatchLedger,
  MatchNight,
  MatchTopup,
  MatchVerification,
} from '../models/MatchMoney';
import { MatchDay, MatchProfile } from '../models/MatchProfile';
import { User } from '../models/User';
import { audit } from '../services/audit';
import * as hub from '../services/matchHub';
import { hoursAt, matchDay } from '../services/matchHours';
import { refreshNights } from '../services/matchNights';
import { addCredit, isPlus } from '../services/matchWallet';
import { ApiError } from '../utils/ApiError';
import type {
  MatchNightInput,
  MatchPauseInput,
  MatchSectionInput,
  MatchVerificationDecisionInput,
} from '../validators/match.validators';

/**
 * Match, for staff: whether it is working, who has been reported, and the
 * people who chose the wrong section.
 *
 * The numbers answer one question each — are people getting matched
 * (calls a day), are they waiting too long (average wait, by side), do they
 * like who they meet (share rate), and is it safe (report rate). Reports are
 * grouped by the person reported, with enough of their history to judge.
 */

const DAY = 24 * 60 * 60 * 1000;
const PEOPLE_FIELDS = 'name email username avatarUrl';

const ratio = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 1000 : null;
const average = (sum: number, count: number) => (count ? Math.round(sum / count / 1000) : null);

/** The last few weeks, a day at a time, and right now. */
export async function matchStats(req: Request, res: Response): Promise<void> {
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14) || 14));
  const since = new Date(Date.now() - days * DAY);
  const [calls, reports, peaks] = await Promise.all([
    MatchCall.find({ matchedAt: { $gte: since } })
      .select('matchedAt startedAt endReason revealedAt maleWaitMs femaleWaitMs extended relayed')
      .lean(),
    MatchReport.find({ createdAt: { $gte: since } })
      .select('createdAt')
      .lean(),
    MatchDay.find({ day: { $gte: matchDay(since.getTime()) } }).lean(),
  ]);

  const blank = () => ({
    calls: 0,
    connected: 0,
    relayed: 0,
    timeUp: 0,
    revealed: 0,
    leftEarly: 0,
    extended: 0,
    reports: 0,
    waitMale: 0,
    waitFemale: 0,
  });
  const byDay = new Map<string, ReturnType<typeof blank>>();
  for (let t = since.getTime(); t <= Date.now(); t += DAY) byDay.set(matchDay(t), blank());
  const total = blank();
  const bump = (day: string, key: keyof ReturnType<typeof blank>, by = 1) => {
    const row = byDay.get(day) ?? blank();
    row[key] += by;
    byDay.set(day, row);
    total[key] += by;
  };

  for (const call of calls) {
    const day = matchDay(call.matchedAt.getTime());
    bump(day, 'calls');
    bump(day, 'waitMale', call.maleWaitMs ?? 0);
    bump(day, 'waitFemale', call.femaleWaitMs ?? 0);
    if (call.startedAt) bump(day, 'connected');
    if (call.startedAt && call.relayed) bump(day, 'relayed');
    if (call.endReason === 'time') bump(day, 'timeUp');
    if (call.endReason === 'left' && call.startedAt) bump(day, 'leftEarly');
    if (call.revealedAt) bump(day, 'revealed');
    if (call.extended) bump(day, 'extended');
  }
  for (const report of reports) bump(matchDay(report.createdAt.getTime()), 'reports');
  const peakOf = new Map(peaks.map((p) => [p.day, p]));

  const summarise = (row: ReturnType<typeof blank>) => ({
    calls: row.calls,
    connected: row.connected,
    connectRate: ratio(row.connected, row.calls),
    /* Of the calls that connected, how many needed the relay. */
    relayRate: ratio(row.relayed, row.connected),
    /* Of the calls that ran their full time, how many swapped usernames. */
    shareRate: ratio(row.revealed, row.timeUp),
    /* Reports per connected call. */
    reportRate: ratio(row.reports, row.connected),
    earlyLeaveRate: ratio(row.leftEarly, row.connected),
    extendRate: ratio(row.extended, row.connected),
    avgWaitSeconds: {
      male: average(row.waitMale, row.calls),
      female: average(row.waitFemale, row.calls),
    },
    reports: row.reports,
  });

  res.json({
    success: true,
    data: {
      now: { ...hub.counts(), hours: hoursAt() },
      totals: summarise(total),
      days: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, row]) => ({
          day,
          ...summarise(row),
          peakOnline: peakOf.get(day)?.peakOnline ?? 0,
        })),
    },
  });
}

/** Open reports, grouped by the person reported; and who is paused now. */
export async function matchReports(_req: Request, res: Response): Promise<void> {
  const open = await MatchReport.find({ status: 'open' }).sort({ createdAt: -1 }).limit(500).lean();
  const ids = [...new Set(open.map((r) => String(r.reported)))];
  const pausedProfiles = await MatchProfile.find({ bannedUntil: { $gt: new Date() } })
    .select('user gender x instagram bannedUntil')
    .lean();
  const everyone = [...new Set([...ids, ...pausedProfiles.map((p) => String(p.user))])].map(
    (id) => new mongoose.Types.ObjectId(id),
  );

  const [users, profiles, callCounts, leaveCounts, reportCounts] = await Promise.all([
    User.find({ _id: { $in: everyone } })
      .select(PEOPLE_FIELDS)
      .lean(),
    MatchProfile.find({ user: { $in: everyone } })
      .select('user gender x instagram bannedUntil')
      .lean(),
    MatchCall.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { $or: [{ male: { $in: everyone } }, { female: { $in: everyone } }] } },
      { $project: { who: ['$male', '$female'] } },
      { $unwind: '$who' },
      { $match: { who: { $in: everyone } } },
      { $group: { _id: '$who', n: { $sum: 1 } } },
    ]),
    MatchCall.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { endedBy: { $in: everyone }, endReason: 'left' } },
      { $group: { _id: '$endedBy', n: { $sum: 1 } } },
    ]),
    MatchReport.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { reported: { $in: everyone } } },
      { $group: { _id: '$reported', n: { $sum: 1 } } },
    ]),
  ]);
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const profileOf = new Map(profiles.map((p) => [String(p.user), p]));
  const count = (rows: { _id: mongoose.Types.ObjectId; n: number }[]) =>
    new Map(rows.map((row) => [String(row._id), row.n]));
  const calls = count(callCounts);
  const leaves = count(leaveCounts);
  const totals = count(reportCounts);

  const person = (id: string) => {
    const user = userOf.get(id);
    const profile = profileOf.get(id);
    return {
      userId: id,
      name: user?.name ?? 'Unknown',
      email: user?.email ?? '',
      username: user?.username ?? '',
      gender: profile?.gender ?? null,
      x: profile?.x ?? '',
      instagram: profile?.instagram ?? '',
      pausedUntil:
        profile?.bannedUntil && profile.bannedUntil > new Date() ? profile.bannedUntil : null,
      history: {
        calls: calls.get(id) ?? 0,
        leftEarly: leaves.get(id) ?? 0,
        reports: totals.get(id) ?? 0,
      },
    };
  };

  const groups = ids
    .map((id) => {
      const mine = open.filter((r) => String(r.reported) === id);
      return {
        ...person(id),
        reporters: new Set(mine.map((r) => String(r.reporter))).size,
        reports: mine.map((r) => ({
          reason: r.reason,
          note: r.note,
          at: r.createdAt,
          callId: r.callId,
        })),
      };
    })
    .sort((a, b) => b.reporters - a.reporters || +b.reports[0].at - +a.reports[0].at);

  res.json({
    success: true,
    data: { groups, paused: pausedProfiles.map((p) => person(String(p.user))) },
  });
}

async function profileFor(userId: string) {
  if (!mongoose.isValidObjectId(userId)) throw ApiError.notFound('No such person');
  const profile = await MatchProfile.findOne({ user: userId });
  if (!profile) throw ApiError.notFound('That person has not used Match');
  const user = await User.findById(userId).select(PEOPLE_FIELDS);
  return { profile, label: user?.name ?? userId };
}

export async function pauseMatchUser(req: Request, res: Response): Promise<void> {
  const { days } = req.body as MatchPauseInput;
  const userId = String(req.params.userId);
  const { profile, label } = await profileFor(userId);
  profile.bannedUntil = new Date(Date.now() + days * DAY);
  await profile.save();
  await MatchReport.updateMany(
    { reported: userId, status: 'open' },
    { status: 'actioned', reviewedAt: new Date() },
  );
  hub.kick(userId);
  await audit(req, {
    action: 'match.paused',
    targetType: 'user',
    targetId: profile.user,
    targetLabel: label,
    summary: `Paused ${label} on Match for ${days} day${days === 1 ? '' : 's'}`,
    after: { pausedUntil: profile.bannedUntil },
  });
  res.json({ success: true, data: { pausedUntil: profile.bannedUntil } });
}

export async function unpauseMatchUser(req: Request, res: Response): Promise<void> {
  const { profile, label } = await profileFor(String(req.params.userId));
  const before = profile.bannedUntil;
  profile.bannedUntil = null;
  await profile.save();
  await audit(req, {
    action: 'match.unpaused',
    targetType: 'user',
    targetId: profile.user,
    targetLabel: label,
    summary: `Lifted ${label}'s pause on Match`,
    before: { pausedUntil: before },
  });
  res.json({ success: true, data: { pausedUntil: null } });
}

/** Reports judged unfounded: closed, and no longer counted towards a pause. */
export async function dismissMatchReports(req: Request, res: Response): Promise<void> {
  const userId = String(req.params.userId);
  const { profile, label } = await profileFor(userId);
  const result = await MatchReport.updateMany(
    { reported: userId, status: 'open' },
    { status: 'dismissed', reviewedAt: new Date() },
  );
  await audit(req, {
    action: 'match.reports.dismissed',
    targetType: 'user',
    targetId: profile.user,
    targetLabel: label,
    summary: `Dismissed ${result.modifiedCount} Match report${result.modifiedCount === 1 ? '' : 's'} about ${label}`,
  });
  res.json({ success: true, data: { dismissed: result.modifiedCount } });
}

export async function matchSectionRequests(_req: Request, res: Response): Promise<void> {
  const profiles = await MatchProfile.find({ sectionRequest: { $ne: null } })
    .sort({ 'sectionRequest.at': 1 })
    .lean();
  const users = await User.find({ _id: { $in: profiles.map((p) => p.user) } })
    .select(PEOPLE_FIELDS)
    .lean();
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  res.json({
    success: true,
    data: profiles.map((p) => ({
      userId: String(p.user),
      name: userOf.get(String(p.user))?.name ?? 'Unknown',
      email: userOf.get(String(p.user))?.email ?? '',
      gender: p.gender,
      note: p.sectionRequest?.note ?? '',
      at: p.sectionRequest?.at ?? null,
    })),
  });
}

/** Switches someone's section. Their page reconnects in the new one. */
export async function setMatchSection(req: Request, res: Response): Promise<void> {
  const { gender } = req.body as MatchSectionInput;
  const userId = String(req.params.userId);
  const { profile, label } = await profileFor(userId);
  const before = profile.gender;
  profile.gender = gender;
  profile.sectionRequest = null;
  await profile.save();
  hub.reset(userId);
  await audit(req, {
    action: 'match.section.changed',
    targetType: 'user',
    targetId: profile.user,
    targetLabel: label,
    summary: `Moved ${label} to the ${gender === 'male' ? 'men' : 'women'}'s section on Match`,
    before: { gender: before },
    after: { gender },
  });
  res.json({ success: true, data: { gender } });
}

export async function declineMatchSection(req: Request, res: Response): Promise<void> {
  const { profile, label } = await profileFor(String(req.params.userId));
  profile.sectionRequest = null;
  await profile.save();
  await audit(req, {
    action: 'match.section.declined',
    targetType: 'user',
    targetId: profile.user,
    targetLabel: label,
    summary: `Declined ${label}'s request to change Match section`,
  });
  res.json({ success: true, data: { declined: true } });
}

/* ---------------------------------------------------------------- money --- */

/**
 * What Match earned: credit spent, by kind, and top-ups paid, over the last
 * `days`. Spending is the revenue; top-ups are cash in, some not yet spent.
 */
export async function matchRevenue(req: Request, res: Response): Promise<void> {
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14) || 14));
  const since = new Date(Date.now() - days * DAY);
  const [spent, topups, credit, members, verified] = await Promise.all([
    MatchLedger.aggregate<{ _id: string; minor: number; count: number }>([
      { $match: { createdAt: { $gte: since }, amountMinor: { $lt: 0 } } },
      {
        $group: {
          _id: '$kind',
          minor: { $sum: { $multiply: ['$amountMinor', -1] } },
          count: { $sum: 1 },
        },
      },
    ]),
    MatchTopup.aggregate<{ _id: null; minor: number; count: number }>([
      { $match: { status: 'paid', mode: 'live', paidAt: { $gte: since } } },
      { $group: { _id: null, minor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    MatchProfile.aggregate<{ _id: null; minor: number }>([
      { $group: { _id: null, minor: { $sum: '$creditMinor' } } },
    ]),
    MatchProfile.countDocuments({ plusUntil: { $gt: new Date() } }),
    MatchProfile.countDocuments({ verifiedAt: { $ne: null } }),
  ]);
  const giftCards = await MatchGiftCard.aggregate<{ _id: null; minor: number; count: number }>([
    { $match: { mode: 'live', status: { $in: ['active', 'redeemed'] }, paidAt: { $gte: since } } },
    { $group: { _id: null, minor: { $sum: '$priceMinor' }, count: { $sum: 1 } } },
  ]);
  /* Refunds hand credit back, so they come off what was spent. */
  const refunds = await MatchLedger.aggregate<{ _id: null; minor: number }>([
    { $match: { createdAt: { $gte: since }, kind: 'refund' } },
    { $group: { _id: null, minor: { $sum: '$amountMinor' } } },
  ]);
  const byKind = Object.fromEntries(
    spent.map((row) => [row._id, { minor: row.minor, count: row.count }]),
  );
  const gross = spent.reduce((sum, row) => sum + row.minor, 0);
  res.json({
    success: true,
    data: {
      days,
      spentMinor: gross - (refunds[0]?.minor ?? 0),
      byKind,
      topupsMinor: topups[0]?.minor ?? 0,
      topups: topups[0]?.count ?? 0,
      giftCardsMinor: giftCards[0]?.minor ?? 0,
      giftCards: giftCards[0]?.count ?? 0,
      /* Credit people hold and have not spent yet. */
      outstandingMinor: credit[0]?.minor ?? 0,
      plusMembers: members,
      verifiedPeople: verified,
    },
  });
}

/* --------------------------------------------------------------- nights --- */

export async function listMatchNights(_req: Request, res: Response): Promise<void> {
  const nights = await MatchNight.find({ day: { $gte: matchDay(Date.now() - 7 * DAY) } })
    .sort({ day: 1 })
    .limit(60)
    .lean();
  const entries = await MatchEntry.aggregate<{ _id: string; count: number; minor: number }>([
    { $match: { day: { $in: nights.map((night) => night.day) } } },
    { $group: { _id: '$day', count: { $sum: 1 }, minor: { $sum: '$priceMinor' } } },
  ]);
  const entriesOf = new Map(entries.map((row) => [row._id, row]));
  res.json({
    success: true,
    data: nights.map((night) => ({
      day: night.day,
      sponsor: night.sponsor,
      theme: night.theme,
      entries: entriesOf.get(night.day)?.count ?? 0,
      entriesMinor: entriesOf.get(night.day)?.minor ?? 0,
    })),
  });
}

/** Creates or replaces one evening's sponsor and theme. */
export async function saveMatchNight(req: Request, res: Response): Promise<void> {
  const input = req.body as MatchNightInput;
  const night = await MatchNight.findOneAndUpdate(
    { day: input.day },
    { day: input.day, sponsor: input.sponsor, theme: input.theme },
    { upsert: true, new: true },
  );
  await refreshNights();
  await audit(req, {
    action: 'match.night.saved',
    targetType: 'match_night',
    targetId: night._id,
    targetLabel: input.day,
    summary: `Set Match night ${input.day}${input.sponsor ? ` · presented by ${input.sponsor.name}` : ''}${input.theme ? ` · ${input.theme.title}` : ''}`,
    after: { sponsor: input.sponsor, theme: input.theme },
  });
  res.json({ success: true, data: { day: night.day, sponsor: night.sponsor, theme: night.theme } });
}

export async function deleteMatchNight(req: Request, res: Response): Promise<void> {
  const day = String(req.params.day);
  const night = await MatchNight.findOneAndDelete({ day });
  if (!night) throw ApiError.notFound('No such night');
  await refreshNights();
  await audit(req, {
    action: 'match.night.removed',
    targetType: 'match_night',
    targetId: night._id,
    targetLabel: day,
    summary: `Removed Match night ${day}`,
  });
  res.json({ success: true, data: { removed: true } });
}

/* --------------------------------------------------------- verification --- */

/** Selfies waiting for a decision, oldest first, with the photo itself. */
export async function listMatchVerifications(_req: Request, res: Response): Promise<void> {
  const pending = await MatchVerification.find({ status: 'pending' })
    .select('+photo')
    .sort({ submittedAt: 1 })
    .limit(30);
  const users = await User.find({ _id: { $in: pending.map((v) => v.user) } })
    .select(PEOPLE_FIELDS)
    .lean();
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  res.json({
    success: true,
    data: pending.map((v) => ({
      id: String(v._id),
      userId: String(v.user),
      name: userOf.get(String(v.user))?.name ?? 'Unknown',
      email: userOf.get(String(v.user))?.email ?? '',
      prompt: v.prompt,
      photo: v.photo ? `data:${v.photoType};base64,${v.photo.toString('base64')}` : null,
      submittedAt: v.submittedAt,
    })),
  });
}

async function pendingVerification(id: string) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('No such check');
  const verification = await MatchVerification.findOne({ _id: id, status: 'pending' });
  if (!verification) throw ApiError.notFound('That check was already decided');
  const user = await User.findById(verification.user).select(PEOPLE_FIELDS);
  return { verification, label: user?.name ?? String(verification.user) };
}

/** Approves a selfie: the badge appears, and the photo is deleted. */
export async function approveMatchVerification(req: Request, res: Response): Promise<void> {
  const { verification, label } = await pendingVerification(String(req.params.id));
  verification.status = 'approved';
  verification.photo = null;
  verification.reviewedAt = new Date();
  verification.reviewedBy = req.user!._id;
  await verification.save();
  const profile = await MatchProfile.findOneAndUpdate(
    { user: verification.user },
    { verifiedAt: new Date() },
    { new: true },
  );
  if (profile) {
    hub.update({
      userId: String(profile.user),
      gender: profile.gender,
      plus: isPlus(profile),
      verified: true,
      blocked: profile.blocked.map(String),
    });
  }
  await audit(req, {
    action: 'match.verification.approved',
    targetType: 'user',
    targetId: verification.user,
    targetLabel: label,
    summary: `Verified ${label} on Match`,
  });
  res.json({ success: true, data: { status: 'approved' } });
}

/**
 * Declines a selfie, refunds the check to their credit and deletes the photo.
 * Someone who looks under 18 is also kept off Match.
 */
export async function declineMatchVerification(req: Request, res: Response): Promise<void> {
  const input = req.body as MatchVerificationDecisionInput;
  const { verification, label } = await pendingVerification(String(req.params.id));
  verification.status = 'declined';
  verification.photo = null;
  verification.note =
    input.note ||
    (input.underage
      ? 'Match is for people 18 and over.'
      : 'The photo did not show the pose clearly. Try again.');
  verification.reviewedAt = new Date();
  verification.reviewedBy = req.user!._id;
  await verification.save();
  if (verification.priceMinor > 0) {
    await addCredit(
      verification.user,
      verification.priceMinor,
      'refund',
      String(verification._id),
      'Verified badge check declined',
    );
  }
  if (input.underage) {
    await MatchProfile.updateOne(
      { user: verification.user },
      { bannedUntil: new Date(Date.now() + 365 * 10 * DAY) },
    );
    hub.kick(String(verification.user));
  }
  await audit(req, {
    action: 'match.verification.declined',
    targetType: 'user',
    targetId: verification.user,
    targetLabel: label,
    summary: `Declined ${label}'s Match verification${input.underage ? ' (looks under 18 — removed)' : ''}`,
  });
  res.json({ success: true, data: { status: 'declined' } });
}
