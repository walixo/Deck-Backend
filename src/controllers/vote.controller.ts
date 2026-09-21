import type { Request, Response } from 'express';
import { Item } from '../models/Item';
import { Vote } from '../models/Vote';
import { evaluateBadges } from '../services/badges';
import { milestoneFor, notify } from '../services/notify';
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

  /*
   * Milestones only — never "somebody upvoted you".
   *
   * On a launch having a good day that would fire every few seconds, and each
   * one says nothing on its own. Crossing 100 says something. Guarded on the
   * vote being added rather than removed, so a launch hovering on the
   * threshold cannot ring the bell every time one person changes their mind.
   */
  const milestone = existing ? null : milestoneFor(item.voteCount);
  if (milestone) {
    void notify({
      user: item.submittedBy,
      kind: 'launch.milestone',
      title: `${item.name} passed ${milestone} votes`,
      body: 'Your launch is picking up. Have a look at where the traffic is coming from.',
      link: '/settings/launches',
    });
  }

  res.json({
    success: true,
    data: { itemId: item._id.toString(), voteCount: item.voteCount, hasVoted: !existing },
  });
}
