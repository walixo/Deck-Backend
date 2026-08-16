import type { Request, Response } from 'express';
import { Item, type IItem } from '../models/Item';
import { Vote } from '../models/Vote';
import { toItemResponse } from '../serializers';
import { addDays, parseDateParam, startOfUtcDay, toDateKey } from '../utils/date';

const SUBMITTER_FIELDS = 'name username avatarUrl headline';

async function votedIdsFor(userId: string | undefined, items: IItem[]): Promise<Set<string>> {
  if (!userId || items.length === 0) return new Set();
  const votes = await Vote.find({
    user: userId,
    item: { $in: items.map((item) => item._id) },
  }).select('item');
  return new Set(votes.map((vote) => vote.item.toString()));
}

/** Ranked launches for a single UTC day. */
export async function getDailyLeaderboard(req: Request, res: Response): Promise<void> {
  const date = parseDateParam(req.query.date as string | undefined);
  const dateKey = toDateKey(date);
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 50);

  const items = await Item.find({ launchDateKey: dateKey })
    .sort({ voteCount: -1, commentCount: -1, createdAt: 1 })
    .limit(limit)
    .populate('submittedBy', SUBMITTER_FIELDS);

  const voted = await votedIdsFor(req.user?._id.toString(), items);
  const today = toDateKey(new Date());

  res.json({
    success: true,
    data: items.map((item, index) => ({ rank: index + 1, ...toItemResponse(item, voted) })),
    meta: {
      date: dateKey,
      isToday: dateKey === today,
      previousDate: toDateKey(addDays(startOfUtcDay(date), -1)),
      nextDate: dateKey === today ? null : toDateKey(addDays(startOfUtcDay(date), 1)),
      totalLaunches: await Item.countDocuments({ launchDateKey: dateKey }),
    },
  });
}

/** Top launches across a rolling window — the "all time / week / month" board. */
export async function getPeriodLeaderboard(req: Request, res: Response): Promise<void> {
  const period = (req.query.period as string) ?? 'week';
  const limit = Math.min(Number(req.query.limit ?? 10) || 10, 50);

  const days = period === 'month' ? 30 : period === 'year' ? 365 : period === 'all' ? null : 7;
  const filter = days === null ? {} : { launchDate: { $gte: addDays(new Date(), -days) } };

  const items = await Item.find(filter)
    .sort({ voteCount: -1, commentCount: -1 })
    .limit(limit)
    .populate('submittedBy', SUBMITTER_FIELDS);

  const voted = await votedIdsFor(req.user?._id.toString(), items);

  res.json({
    success: true,
    data: items.map((item, index) => ({ rank: index + 1, ...toItemResponse(item, voted) })),
    meta: { period, days },
  });
}

/** Recent days that actually have launches — powers the leaderboard date switcher. */
export async function getLeaderboardDates(_req: Request, res: Response): Promise<void> {
  const rows = await Item.aggregate<{ _id: string; count: number; votes: number }>([
    { $group: { _id: '$launchDateKey', count: { $sum: 1 }, votes: { $sum: '$voteCount' } } },
    { $sort: { _id: -1 } },
    { $limit: 14 },
  ]);

  res.json({
    success: true,
    data: rows.map((row) => ({ date: row._id, launches: row.count, votes: row.votes })),
  });
}
