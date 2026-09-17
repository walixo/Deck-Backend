import type { Request, Response } from 'express';
import { Item } from '../models/Item';
import { ItemViewDaily } from '../models/ItemViewDaily';
import { addDays, startOfUtcDay, toDateKey } from '../utils/date';
import type { LaunchViewsQuery } from '../validators/analytics.validators';

/**
 * Every launch this maker has posted, with its view count broken out by day.
 *
 * One request for the whole page rather than one per launch. A maker with
 * twenty launches would otherwise open twenty connections to draw twenty
 * sparklines, and the query is the same shape either way — the compound index
 * on `{ item, dateKey }` covers "these launches, this range" exactly as well
 * as it covers one.
 *
 * The axis is returned alongside the series and every series is padded to it,
 * so the client never has to reconcile a sparse result against a calendar. A
 * day with no views is a real zero and has to be drawn as one: a chart that
 * silently closes the gaps turns a dead week into a straight line between two
 * good days.
 */
export async function getMyLaunchViews(req: Request, res: Response): Promise<void> {
  const { days } = req.query as unknown as LaunchViewsQuery;

  const items = await Item.find({ submittedBy: req.user!._id })
    .select('slug name logoUrl viewCount launchDate')
    .sort({ launchDate: -1 });

  /* Oldest first, ending today. Built from the axis rather than from whatever
     rows came back, because the empty days are the informative ones. */
  const today = startOfUtcDay(new Date());
  const axis = Array.from({ length: days }, (_, index) =>
    toDateKey(addDays(today, index - (days - 1))),
  );

  /* `dateKey` is a string, and YYYY-MM-DD sorts lexicographically the same way
     it sorts chronologically — which is the whole reason for that format. So a
     range query on it is a range scan on the index, no dates parsed. */
  const rows = items.length
    ? await ItemViewDaily.find({
        item: { $in: items.map((item) => item._id) },
        dateKey: { $gte: axis[0], $lte: axis[axis.length - 1] },
      }).select('item dateKey views')
    : [];

  const byItem = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = row.item.toString();
    const found = byItem.get(key) ?? new Map<string, number>();
    found.set(row.dateKey, row.views);
    byItem.set(key, found);
  }

  res.json({
    success: true,
    data: {
      days: axis,
      launches: items.map((item) => {
        const daily = byItem.get(item._id.toString());
        const series = axis.map((dateKey) => daily?.get(dateKey) ?? 0);

        return {
          id: item._id.toString(),
          slug: item.slug,
          name: item.name,
          logoUrl: item.logoUrl,
          /*
           * `total` is the lifetime figure off the launch itself, not the sum
           * of `series` — the window is thirty days and most launches are
           * older than that. They are allowed to disagree, and a maker reading
           * "1,204 all time / 86 in the last 30 days" is being told two true
           * things rather than one rounded one.
           */
          total: item.viewCount ?? 0,
          windowViews: series.reduce((sum, value) => sum + value, 0),
          series,
        };
      }),
    },
  });
}
