import type { Request, Response } from 'express';
import { Comment } from '../models/Comment';
import { Item } from '../models/Item';
import { User } from '../models/User';
import { Vote } from '../models/Vote';
import { toItemResponse, toPublicUser } from '../serializers';
import { BADGES } from '../constants/badges';
import { BadgeAward } from '../models/BadgeAward';
import { evaluateBadges, metricsFor } from '../services/badges';
import { ApiError } from '../utils/ApiError';

const SUBMITTER_FIELDS = 'name username avatarUrl headline';

export async function getUserProfile(req: Request, res: Response): Promise<void> {
  const user = await User.findOne({ username: req.params.username.toLowerCase() });
  if (!user) throw ApiError.notFound('We could not find that profile');

  /*
   * Evaluated on view as well as on action. The action hooks are what make a
   * badge appear promptly; this is the backstop that means a hook that was
   * missed, or added after the fact, still resolves the first time anybody
   * looks — so the trophy case is never permanently wrong.
   */
  await evaluateBadges(user._id);

  const [items, votesGiven, commentsWritten, awards, metrics] = await Promise.all([
    Item.find({ submittedBy: user._id })
      .sort({ launchDate: -1 })
      .populate('submittedBy', SUBMITTER_FIELDS),
    Vote.countDocuments({ user: user._id }),
    Comment.countDocuments({ user: user._id }),
    BadgeAward.find({ user: user._id }).sort({ earnedAt: -1 }),
    metricsFor(user._id),
  ]);

  const earned = new Map(awards.map((award) => [award.badge, award]));

  const votesReceived = items.reduce((total, item) => total + item.voteCount, 0);

  const viewerVotes = req.user
    ? new Set(
        (
          await Vote.find({ user: req.user._id, item: { $in: items.map((i) => i._id) } }).select(
            'item',
          )
        ).map((vote) => vote.item.toString()),
      )
    : new Set<string>();

  res.json({
    success: true,
    data: {
      user: toPublicUser(user),
      items: items.map((item) => toItemResponse(item, viewerVotes)),
      stats: {
        launches: items.length,
        votesReceived,
        votesGiven,
        commentsWritten,
      },
      /*
       * Every badge, earned or not, with progress on the ones still open. A
       * trophy case that hides what you have not won yet is just a list — the
       * unearned entries are the part that tells you what to do next.
       */
      badges: BADGES.map((badge) => {
        const award = earned.get(badge.id);
        return {
          id: badge.id,
          name: badge.name,
          description: badge.description,
          family: badge.family,
          mark: badge.mark,
          threshold: badge.threshold,
          earned: Boolean(award),
          earnedAt: award?.earnedAt,
          progress: Math.min(metrics[badge.metric], badge.threshold),
        };
      }),
    },
  });
}

/** Leaderboard of makers by total votes received across their launches. */
export async function getTopMakers(_req: Request, res: Response): Promise<void> {
  const rows = await Item.aggregate<{
    _id: string;
    launches: number;
    votes: number;
    user: { name: string; username: string; avatarUrl?: string; headline?: string }[];
  }>([
    {
      $group: {
        _id: '$submittedBy',
        launches: { $sum: 1 },
        votes: { $sum: '$voteCount' },
      },
    },
    { $sort: { votes: -1, launches: -1 } },
    { $limit: 8 },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
        pipeline: [{ $project: { name: 1, username: 1, avatarUrl: 1, headline: 1 } }],
      },
    },
  ]);

  res.json({
    success: true,
    data: rows
      .filter((row) => row.user.length > 0)
      .map((row, index) => ({
        rank: index + 1,
        launches: row.launches,
        votes: row.votes,
        user: {
          id: row._id.toString(),
          name: row.user[0].name,
          username: row.user[0].username,
          avatarUrl: row.user[0].avatarUrl,
          headline: row.user[0].headline,
        },
      })),
  });
}
