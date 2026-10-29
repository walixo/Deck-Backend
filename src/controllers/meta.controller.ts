import type { Request, Response } from 'express';
import { DISPLAY_CURRENCIES, getRates } from '../services/rates';
import { Item } from '../models/Item';
import { User } from '../models/User';
import { Vote } from '../models/Vote';
import { INDEX_ACCOUNT_USERNAME } from '../constants';
import { COMPETING } from '../utils/itemScope';

/**
 * Headline numbers for the landing page.
 *
 * These are the community's numbers, and they decide when the hero starts
 * quoting figures at all (see the frontend's STATS_SHOWN_FROM). So listings Deck
 * imported are left out of "launches" — nobody launched them here — and the
 * Deck Index account that owns them is left out of "makers". Votes stay whole:
 * a vote on an imported listing is still a real person voting.
 */
export async function getStats(_req: Request, res: Response): Promise<void> {
  const [launches, makers, votes, todayLaunches] = await Promise.all([
    Item.countDocuments(COMPETING),
    User.countDocuments({ username: { $ne: INDEX_ACCOUNT_USERNAME } }),
    Vote.countDocuments(),
    Item.countDocuments({ ...COMPETING, launchDateKey: new Date().toISOString().slice(0, 10) }),
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

/**
 * Display exchange rates.
 *
 * Public and uncredentialled: these are the same numbers for everybody, and
 * gating them behind a session would only mean signed-out readers see naira
 * they cannot read. Cached upstream for a day — see services/rates.
 */
export async function getExchangeRates(_req: Request, res: Response): Promise<void> {
  const table = await getRates();
  res.json({ success: true, data: { ...table, currencies: DISPLAY_CURRENCIES } });
}
