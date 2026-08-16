import type { Request, Response } from 'express';
import { Comment } from '../models/Comment';
import { Item, type IItem } from '../models/Item';
import { toCommentResponse } from '../serializers';
import { audit } from '../services/audit';
import { evaluateBadges } from '../services/badges';
import { ApiError } from '../utils/ApiError';
import type { CreateCommentInput } from '../validators/comment.validators';

const AUTHOR_FIELDS = 'name username avatarUrl headline';

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
  }

  res.json({ success: true, data: { id: comment._id.toString() } });
}
