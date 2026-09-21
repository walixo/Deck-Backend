import type { Request, Response } from 'express';
import { Comment, type IComment } from '../models/Comment';
import { Item, type IItem } from '../models/Item';
import type { IUser } from '../models/User';
import { toCommentResponse } from '../serializers';
import { audit } from '../services/audit';
import { evaluateBadges } from '../services/badges';
import { excerpt, notify } from '../services/notify';
import { ApiError } from '../utils/ApiError';
import type { CreateCommentInput } from '../validators/comment.validators';

/* `verified` is load-bearing in this projection. `toPublicUser` reads it, so
   leaving it out does not omit the field — it sends `verified: false` for every
   account, which is a wrong answer rather than a missing one. */
const AUTHOR_FIELDS = 'name username avatarUrl headline verified';

/** Recomputes comment/review counters from the source of truth. */
async function syncItemCounters(item: IItem): Promise<void> {
  const [commentCount, ratings] = await Promise.all([
    Comment.countDocuments({ item: item._id }),
    Comment.aggregate<{ _id: null; count: number; sum: number }>([
      { $match: { item: item._id, rating: { $ne: null } } },
      { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: '$rating' } } },
    ]),
  ]);

  const summary = ratings[0] ?? { count: 0, sum: 0 };

  item.commentCount = commentCount;
  item.reviewCount = summary.count;
  item.ratingSum = summary.sum;
  item.ratingAvg = summary.count > 0 ? summary.sum / summary.count : 0;

  await item.save();
}

/**
 * Tells whoever has a stake in a new comment that it exists.
 *
 * Up to two people, and never the same person twice: the launch's owner hears
 * that their launch was commented on or reviewed, and the author of the parent
 * comment hears that they got a reply. When the owner *is* the parent author
 * — somebody replying to a maker on the maker's own launch — only the reply is
 * sent, because being told twice about one comment reads as a bug.
 *
 * Not awaited by the caller. See `services/notify`.
 */
async function announceComment(
  author: IUser,
  item: IItem,
  comment: IComment,
  parent?: string | null,
): Promise<void> {
  const link = `/item/${item.slug}#discussion`;
  const told = new Set<string>();

  if (parent) {
    const parentComment = await Comment.findById(parent).select('user');
    if (parentComment) {
      told.add(parentComment.user.toString());
      await notify({
        user: parentComment.user,
        actor: author._id,
        kind: 'comment.replied',
        title: `${author.name} replied to your comment on ${item.name}`,
        body: excerpt(comment.body),
        link,
      });
    }
  }

  if (told.has(item.submittedBy.toString())) return;

  /* A comment carrying a rating is a review, and reads differently to its
     recipient — "rated it 4 stars" is the headline, not "said something". */
  await notify({
    user: item.submittedBy,
    actor: author._id,
    kind: comment.rating ? 'review.received' : 'comment.received',
    title: comment.rating
      ? `${author.name} reviewed ${item.name} — ${comment.rating}/5`
      : `${author.name} commented on ${item.name}`,
    body: excerpt(comment.body),
    link,
  });
}

export async function listComments(req: Request, res: Response): Promise<void> {
  const item = await Item.findOne({ slug: req.params.slug }).select('_id');
  if (!item) throw ApiError.notFound('We could not find that launch');

  const comments = await Comment.find({ item: item._id })
    .sort({ createdAt: -1 })
    .populate('user', AUTHOR_FIELDS);

  res.json({ success: true, data: comments.map(toCommentResponse) });
}

export async function createComment(req: Request, res: Response): Promise<void> {
  const { body, rating, parent } = req.body as CreateCommentInput;

  const item = await Item.findOne({ slug: req.params.slug });
  if (!item) throw ApiError.notFound('We could not find that launch');

  if (parent) {
    const parentComment = await Comment.findOne({ _id: parent, item: item._id });
    if (!parentComment) throw ApiError.badRequest('That comment no longer exists');
  }

  // Replies are part of a discussion, not a rating of the item itself.
  const comment = await Comment.create({
    item: item._id,
    user: req.user!._id,
    body,
    rating: parent ? undefined : rating,
    parent: parent ?? null,
  });

  await Promise.all([comment.populate('user', AUTHOR_FIELDS), syncItemCounters(item)]);

  void evaluateBadges(req.user!._id);
  void announceComment(req.user!, item, comment, parent);

  res.status(201).json({ success: true, data: toCommentResponse(comment) });
}

export async function deleteComment(req: Request, res: Response): Promise<void> {
  const comment = await Comment.findById(req.params.commentId);
  if (!comment) throw ApiError.notFound('That comment no longer exists');

  const user = req.user!;
  if (comment.user.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('You can only delete your own comments');
  }

  const item = await Item.findById(comment.item);

  const body = comment.body;

  await Comment.deleteMany({ $or: [{ _id: comment._id }, { parent: comment._id }] });
  if (item) await syncItemCounters(item);

  /* Moderation — staff removing somebody else's words — is worth a record.
     Someone deleting their own comment is not. */
  if (user.role === 'admin' && comment.user.toString() !== user._id.toString()) {
    await audit(req, {
      action: 'comment.deleted',
      targetType: 'comment',
      targetId: comment._id,
      targetLabel: item ? `Comment on ${item.name}` : 'Comment',
      summary: `Removed a comment: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"`,
      before: { body },
    });

    /* Told, not just logged. The terms give people a right to appeal a
       moderation decision, and an appeal right nobody knows they need to
       exercise is not one — silently vanishing somebody's words is how a
       community stops trusting its moderators. */
    void notify({
      user: comment.user,
      kind: 'content.moderated',
      title: 'A comment of yours was removed',
      body: item
        ? `Your comment on ${item.name} was removed by Deck staff.`
        : 'One of your comments was removed by Deck staff.',
      link: '/terms#enforcement',
    });
  }

  res.json({ success: true, data: { id: comment._id.toString() } });
}
