import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { MatchCall, MatchReport } from '../models/MatchCall';
import { MatchDay, MatchProfile } from '../models/MatchProfile';
import { User } from '../models/User';
import { audit } from '../services/audit';
import * as hub from '../services/matchHub';
import { hoursAt, matchDay } from '../services/matchHours';
import { ApiError } from '../utils/ApiError';
import type { MatchPauseInput, MatchSectionInput } from '../validators/match.validators';

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
      .select('matchedAt startedAt endReason revealedAt maleWaitMs femaleWaitMs extended')
      .lean(),
    MatchReport.find({ createdAt: { $gte: since } })
      .select('createdAt')
      .lean(),
    MatchDay.find({ day: { $gte: matchDay(since.getTime()) } }).lean(),
  ]);

  const blank = () => ({
    calls: 0,
    connected: 0,
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
