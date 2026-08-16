import mongoose from 'mongoose';
import { BADGES, type BadgeMetric } from '../constants/badges';
import { BadgeAward } from '../models/BadgeAward';
import { Comment } from '../models/Comment';
import { Contribution } from '../models/Contribution';
import { Item } from '../models/Item';
import { Order } from '../models/Order';
import { Vote } from '../models/Vote';

export type BadgeMetrics = Record<BadgeMetric, number>;

/**
 * Everything the badge definitions can be measured against.
 *
 * Gathered in one pass so evaluating fifteen badges costs one round of queries
 * rather than fifteen. Every count is read from the source rows — there is no
 * denormalised "badge progress" to fall out of step.
 */
export async function metricsFor(userId: mongoose.Types.ObjectId | string): Promise<BadgeMetrics> {
  const user = new mongoose.Types.ObjectId(userId);

  const [items, votesGiven, commentsWritten, contributionsMade, merchSold] = await Promise.all([
    /* launchDateKey is load-bearing: the board-finish aggregation matches on it,
       and leaving it out of the projection silently makes every day unmatchable. */
    Item.find({ submittedBy: user }).select(
      'voteCount ratingAvg reviewCount fundraise launchDateKey',
    ),
    Vote.countDocuments({ user }),
    Comment.countDocuments({ user }),
    Contribution.countDocuments({ contributor: user, status: 'paid' }),
    Order.countDocuments({
      status: { $in: ['paid', 'shipped', 'delivered'] },
      'sellerShares.seller': user,
    }),
  ]);

  const itemIds = items.map((item) => item._id);

  /*
   * Board finishes are counted from the launches themselves rather than from a
   * stored history: a launch's rank on its own day is whatever its vote count
   * says relative to that day's others. Done as one aggregation over the days
   * this person actually launched on, so it does not scan the whole board.
   */
  const finishes = itemIds.length
    ? await Item.aggregate<{ _id: string; ranked: { id: string; votes: number }[] }>([
        {
          $match: {
            launchDateKey: { $in: [...new Set(items.map((i) => i.launchDateKey))] },
          },
        },
        { $sort: { voteCount: -1 } },
        {
          $group: {
            _id: '$launchDateKey',
            ranked: { $push: { id: '$_id', votes: '$voteCount' } },
          },
        },
      ])
    : [];

  const mine = new Set(itemIds.map((id) => id.toString()));
  let topFinishes = 0;
  let podiumFinishes = 0;

  for (const day of finishes) {
    /* A day with no votes cast has no winner — every launch on it is tied at
       zero, and calling the first one "number one" would be an accident of
       insertion order rather than an achievement. */
    const top3 = day.ranked.slice(0, 3).filter((entry) => entry.votes > 0);
    if (top3[0] && mine.has(top3[0].id.toString())) topFinishes += 1;
    if (top3.some((entry) => mine.has(entry.id.toString()))) podiumFinishes += 1;
  }

  return {
    launches: items.length,
    votesReceived: items.reduce((total, item) => total + item.voteCount, 0),
    topFinishes,
    podiumFinishes,
    wellReviewed: items.filter((item) => item.reviewCount >= 5 && item.ratingAvg >= 4.5).length,
    commentsWritten,
    votesGiven,
    contributionsMade,
    fundraiseFunded: items.filter(
      (item) =>
        item.fundraise.enabled &&
        item.fundraise.targetMinor > 0 &&
        item.fundraise.raisedMinor >= item.fundraise.targetMinor,
    ).length,
    merchSold,
  };
}

/**
 * Awards whatever this person has newly earned, and returns just the new ones.
 *
 * **Never throws.** Same reasoning as the audit recorder: this runs as a side
 * effect of voting, commenting and buying, and a badge that failed to save is
 * not a reason to fail the vote. It is also self-healing — the next evaluation
 * awards anything a previous one missed, so a swallowed failure costs a delay
 * rather than the badge.
 *
 * Callers that want the result (a profile view) can await it; callers that are
 * only triggering it (a vote) can let it run.
 */
export async function evaluateBadges(userId: mongoose.Types.ObjectId | string): Promise<string[]> {
  try {
    const user = new mongoose.Types.ObjectId(userId);

    const [metrics, existing] = await Promise.all([
      metricsFor(user),
      BadgeAward.find({ user }).select('badge'),
    ]);

    const held = new Set(existing.map((award) => award.badge));
    const earned = BADGES.filter(
      (badge) => !held.has(badge.id) && metrics[badge.metric] >= badge.threshold,
    );

    if (earned.length === 0) return [];

    /*
     * `ordered: false` so one clash does not abandon the rest, and the duplicate
     * key error is expected rather than exceptional: two concurrent evaluations
     * can both decide the same badge is new, and the unique index is what makes
     * only one of them stick.
     */
    try {
      await BadgeAward.insertMany(
        earned.map((badge) => ({
          user,
          badge: badge.id,
          value: metrics[badge.metric],
          earnedAt: new Date(),
        })),
        { ordered: false },
      );
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 11000) throw error;
    }

    return earned.map((badge) => badge.id);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[badges] evaluation failed for', String(userId), error);
    return [];
  }
}
