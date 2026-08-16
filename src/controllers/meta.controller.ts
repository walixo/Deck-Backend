import type { Request, Response } from 'express';
import { CATEGORIES, CATEGORY_LABELS } from '../constants';
import { Item } from '../models/Item';
import { User } from '../models/User';
import { Vote } from '../models/Vote';

/** Categories with live counts — used by the nav and Discover filters. */
export async function getCategories(_req: Request, res: Response): Promise<void> {
  const rows = await Item.aggregate<{ _id: string; count: number }>([
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);

  const counts = new Map(rows.map((row) => [row._id, row.count]));

  res.json({
    success: true,
    data: CATEGORIES.map((slug) => ({
      slug,
      label: CATEGORY_LABELS[slug],
      count: counts.get(slug) ?? 0,
    })),
  });
}

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
