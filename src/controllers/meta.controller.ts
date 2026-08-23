import type { Request, Response } from 'express';
import { Item } from '../models/Item';
import { User } from '../models/User';
import { Vote } from '../models/Vote';

/** Headline numbers for the landing page. */
export async function getStats(_req: Request, res: Response): Promise<void> {
  const [launches, makers, votes, todayLaunches] = await Promise.all([
    Item.countDocuments(),
    User.countDocuments(),
    Vote.countDocuments(),
    Item.countDocuments({ launchDateKey: new Date().toISOString().slice(0, 10) }),
  ]);

  res.json({ success: true, data: { launches, makers, votes, todayLaunches } });
}

/** Most used tags, for the tag cloud. */
export async function getTags(_req: Request, res: Response): Promise<void> {
  const rows = await Item.aggregate<{ _id: string; count: number }>([
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 24 },
  ]);

  res.json({ success: true, data: rows.map((row) => ({ tag: row._id, count: row.count })) });
}
