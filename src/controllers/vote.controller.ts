import type { Request, Response } from 'express';
import { Item } from '../models/Item';
import { Vote } from '../models/Vote';
import { evaluateBadges } from '../services/badges';
import { ApiError } from '../utils/ApiError';

/** Toggles the viewer's upvote and returns the fresh count. */
export async function toggleVote(req: Request, res: Response): Promise<void> {
  const item = await Item.findById(req.params.id);
  if (!item) throw ApiError.notFound('We could not find that launch');

  const userId = req.user!._id;
  const existing = await Vote.findOne({ item: item._id, user: userId });

  if (existing) {
    await existing.deleteOne();
    item.voteCount = Math.max(0, item.voteCount - 1);
  } else {
    await Vote.create({ item: item._id, user: userId });
    item.voteCount += 1;
  }

  await item.save();

  /* Both sides can cross a line here: the voter's own tally, and the
     maker's votes-received. Not awaited — a badge is never worth
     delaying the response that told someone their vote landed. */
  void evaluateBadges(userId);
  void evaluateBadges(item.submittedBy);

  res.json({
    success: true,
    data: { itemId: item._id.toString(), voteCount: item.voteCount, hasVoted: !existing },
  });
}
