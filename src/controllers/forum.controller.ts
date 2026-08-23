import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Reply, Topic } from '../models/Topic';
import { toReplyResponse, toTopicResponse, toTopicSummary } from '../serializers';
import { audit } from '../services/audit';
import { ApiError } from '../utils/ApiError';
import { uniqueSlug } from '../utils/slug';
import type {
  CreateReplyInput,
  CreateTopicInput,
  ListTopicsQuery,
  ModerateTopicInput,
  UpdateTopicInput,
} from '../validators/forum.validators';

const AUTHOR_FIELDS = 'name username avatarUrl headline verified';

/**
 * The topic list.
 *
 * Sorted by last activity, not by creation, with pinned topics first. A forum
 * ordered by creation date is a forum where a thread nobody has touched in a
 * month sits above the argument happening right now — the whole point of the
 * index is to show where the conversation is.
 */
export async function listTopics(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListTopicsQuery;
  const skip = (query.page - 1) * query.limit;

  const filter: mongoose.FilterQuery<typeof Topic> = {};
  if (query.section) filter.section = query.section;
  if (query.search) {
    /* Escaped before it reaches the regex: an unescaped `(` from a search box
       is a thrown SyntaxError, and worse patterns are a denial of service. */
    const pattern = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: pattern }, { body: pattern }];
  }

  const [total, topics] = await Promise.all([
    Topic.countDocuments(filter),
    Topic.find(filter)
      .sort({ pinned: -1, lastReplyAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate('author', AUTHOR_FIELDS)
      .populate('lastReplyBy', AUTHOR_FIELDS),
  ]);

  res.json({
    success: true,
    data: topics.map(toTopicSummary),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + topics.length < total,
    },
  });
}

/** One topic and every reply on it, oldest first. */
export async function getTopic(req: Request, res: Response): Promise<void> {
  const topic = await Topic.findOne({ slug: req.params.slug }).populate('author', AUTHOR_FIELDS);
  if (!topic) throw ApiError.notFound('We could not find that topic');

  const replies = await Reply.find({ topic: topic._id })
    .sort({ createdAt: 1 })
    .populate('author', AUTHOR_FIELDS);

  res.json({
    success: true,
    data: { ...toTopicResponse(topic), replies: replies.map(toReplyResponse) },
  });
}

export async function createTopic(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateTopicInput;

  const slug = await uniqueSlug(input.title, async (candidate) => {
    const exists = await Topic.exists({ slug: candidate });
    return exists !== null;
  });

  const topic = await Topic.create({
    title: input.title,
    body: input.body,
    section: input.section,
    slug,
    author: req.user!._id,
  });

  await topic.populate('author', AUTHOR_FIELDS);

  res.status(201).json({ success: true, data: toTopicResponse(topic) });
}

/**
 * Edits a topic. Author or staff.
 *
 * The section is editable too — a question posted under Show is the single most
 * common thing anybody gets wrong here, and making them delete and repost would
 * throw away the replies.
 */
export async function updateTopic(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateTopicInput;

  const topic = await Topic.findOne({ slug: req.params.slug });
  if (!topic) throw ApiError.notFound('We could not find that topic');

  const user = req.user!;
  const isAuthor = topic.author.toString() === user._id.toString();
  if (!isAuthor && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who posted this can edit it');
  }

  /* A locked topic is closed to its author as well as to repliers. Staff can
     still edit — that is usually why it was locked. */
  if (topic.locked && user.role !== 'admin') {
    throw ApiError.badRequest('This topic is locked');
  }

  if (input.title !== undefined) topic.title = input.title;
  if (input.body !== undefined) topic.body = input.body;
  if (input.section !== undefined) topic.section = input.section;

  await topic.save();
  await topic.populate('author', AUTHOR_FIELDS);

  if (!isAuthor) {
    await audit(req, {
      action: 'topic.edited',
      targetType: 'topic',
      targetId: topic._id,
      targetLabel: topic.title,
      summary: `Edited "${topic.title}", a topic belonging to someone else`,
      after: { fields: Object.keys(input) },
    });
  }

  res.json({ success: true, data: toTopicResponse(topic) });
}

/** Deletes a topic and everything on it. Author or staff. */
export async function deleteTopic(req: Request, res: Response): Promise<void> {
  const topic = await Topic.findOne({ slug: req.params.slug });
  if (!topic) throw ApiError.notFound('We could not find that topic');

  const user = req.user!;
  const isAuthor = topic.author.toString() === user._id.toString();
  if (!isAuthor && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who posted this can delete it');
  }

  /* Replies go with it. Leaving them would orphan other people's writing behind
     a topic that no longer renders — invisible, undeletable, and still in the
     database. */
  await Reply.deleteMany({ topic: topic._id });
  await topic.deleteOne();

  if (!isAuthor) {
    await audit(req, {
      action: 'topic.deleted',
      targetType: 'topic',
      targetId: topic._id,
      targetLabel: topic.title,
      summary: `Deleted "${topic.title}", a topic belonging to someone else`,
      before: { section: topic.section, replies: topic.replyCount },
    });
  }

  res.json({ success: true, data: { deleted: true } });
}

/** Pin and lock. Staff only, audited — these change what other people can do. */
export async function moderateTopic(req: Request, res: Response): Promise<void> {
  const { pinned, locked, note } = req.body as ModerateTopicInput;

  const topic = await Topic.findOne({ slug: req.params.slug });
  if (!topic) throw ApiError.notFound('We could not find that topic');

  const before = { pinned: topic.pinned, locked: topic.locked };
  if (pinned !== undefined) topic.pinned = pinned;
  if (locked !== undefined) topic.locked = locked;
  await topic.save();
  await topic.populate('author', AUTHOR_FIELDS);

  await audit(req, {
    action: 'topic.moderated',
    targetType: 'topic',
    targetId: topic._id,
    targetLabel: topic.title,
    summary: `Set "${topic.title}" to ${topic.pinned ? 'pinned' : 'unpinned'}, ${
      topic.locked ? 'locked' : 'unlocked'
    } — ${note}`,
    before,
    after: { pinned: topic.pinned, locked: topic.locked, note },
  });

  res.json({ success: true, data: toTopicResponse(topic) });
}

export async function createReply(req: Request, res: Response): Promise<void> {
  const { body } = req.body as CreateReplyInput;

  const topic = await Topic.findOne({ slug: req.params.slug });
  if (!topic) throw ApiError.notFound('We could not find that topic');
  if (topic.locked) throw ApiError.badRequest('This topic is locked — no new replies');

  const reply = await Reply.create({ topic: topic._id, author: req.user!._id, body });

  /*
   * The counters, updated in one atomic operation.
   *
   * `updateOne` with `$inc` rather than read-modify-write on the document:
   * two people replying at the same moment would otherwise both read the same
   * count and both write count+1, losing a reply from the total. The list sorts
   * on `lastReplyAt`, so getting this wrong is visible.
   */
  await Topic.updateOne(
    { _id: topic._id },
    { $inc: { replyCount: 1 }, $set: { lastReplyAt: reply.createdAt, lastReplyBy: req.user!._id } },
  );

  await reply.populate('author', AUTHOR_FIELDS);

  res.status(201).json({ success: true, data: toReplyResponse(reply) });
}

/** Deletes a reply. Author or staff. */
export async function deleteReply(req: Request, res: Response): Promise<void> {
  const reply = await Reply.findById(req.params.id);
  if (!reply) throw ApiError.notFound('We could not find that reply');

  const user = req.user!;
  const isAuthor = reply.author.toString() === user._id.toString();
  if (!isAuthor && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who wrote this can delete it');
  }

  const topicId = reply.topic;
  await reply.deleteOne();

  /* Floored at zero. A count that has drifted below the real number of replies
     — from an old bug, a script, a restore — would otherwise go negative and
     render as "-1 replies". */
  await Topic.updateOne({ _id: topicId, replyCount: { $gt: 0 } }, { $inc: { replyCount: -1 } });

  if (!isAuthor) {
    await audit(req, {
      action: 'reply.deleted',
      targetType: 'topic',
      targetId: topicId,
      targetLabel: 'Forum reply',
      summary: `Removed a forum reply written by someone else`,
      before: { body: reply.body.slice(0, 200) },
    });
  }

  res.json({ success: true, data: { deleted: true } });
}
