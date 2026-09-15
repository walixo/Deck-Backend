import type { Request, Response } from 'express';
import { Post, type IPost } from '../models/Post';
import type { IUser } from '../models/User';
import { toPostResponse, toPostSummary } from '../serializers';
import { audit } from '../services/audit';
import { ApiError } from '../utils/ApiError';
import { uniqueSlug } from '../utils/slug';
import type { CreatePostInput, ListPostsQuery, UpdatePostInput } from '../validators/post.validators';

const AUTHOR_FIELDS = 'name username avatarUrl headline verified';

/**
 * The public feed: published posts only, newest first.
 *
 * Drafts are excluded by the query rather than filtered after fetching, so an
 * unpublished post is never in a payload that could be logged, cached or
 * accidentally serialised. The staff list is a separate endpoint.
 */
export async function listPosts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListPostsQuery;
  const skip = (query.page - 1) * query.limit;

  const filter = {
    status: 'published' as const,
    /* Scheduled posts are written but not yet due. Comparing here rather than
       trusting `status` means a future-dated post goes live on its own. */
    publishedAt: { $lte: new Date() },
    ...(query.tag ? { tags: query.tag } : {}),
  };

  const [total, posts] = await Promise.all([
    Post.countDocuments(filter),
    Post.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate('author', AUTHOR_FIELDS),
  ]);

  res.json({
    success: true,
    data: posts.map(toPostSummary),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + posts.length < total,
    },
  });
}

export async function getPost(req: Request, res: Response): Promise<void> {
  const post = await Post.findOne({ slug: req.params.slug }).populate('author', AUTHOR_FIELDS);
  if (!post) throw ApiError.notFound('We could not find that post');

  /*
   * A draft is readable by its author and by staff, and by nobody else.
   *
   * The author clause is new: while only staff could write, "staff can preview"
   * covered every case. Now that anybody can, a writer who could not open their
   * own unpublished draft would have no way to read it back.
   *
   * Answering 404 rather than 403 keeps unpublished titles from being
   * enumerable by anyone who can guess a slug.
   */
  const viewer = req.user;
  const isStaff = viewer?.role === 'admin';
  const isAuthor = Boolean(viewer) && post.author._id.toString() === viewer!._id.toString();
  const isLive = post.status === 'published' && post.publishedAt && post.publishedAt <= new Date();

  if (!isLive && !isStaff && !isAuthor) throw ApiError.notFound('We could not find that post');

  res.json({ success: true, data: toPostResponse(post) });
}

/* ------------------------------------------------------------------ staff --- */

export async function listAllPosts(_req: Request, res: Response): Promise<void> {
  const posts = await Post.find().sort({ createdAt: -1 }).populate('author', AUTHOR_FIELDS);
  res.json({ success: true, data: posts.map(toPostSummary) });
}

/**
 * Writes a post. Open to every signed-in account.
 *
 * Published straight away rather than into a review queue. Deck reviews the
 * things that end in money changing hands or an object in the post; an article
 * is neither, and putting writing behind a queue is how a blog with one
 * contributor stays a blog with one contributor. Staff can unpublish, and that
 * is audited.
 */
export async function createPost(req: Request, res: Response): Promise<void> {
  const input = req.body as CreatePostInput;

  const slug = await uniqueSlug(input.title, async (candidate) => {
    const exists = await Post.exists({ slug: candidate });
    return exists !== null;
  });

  const post = await Post.create({
    ...input,
    slug,
    author: req.user!._id,
    /* Publishing without an explicit date means "now". Storing the moment
       rather than leaving it null keeps the feed's sort key always present. */
    publishedAt:
      input.status === 'published' ? (input.publishedAt ?? new Date()) : (input.publishedAt ?? null),
  });

  await post.populate('author', AUTHOR_FIELDS);

  res.status(201).json({ success: true, data: toPostResponse(post) });
}

/**
 * Anyone may write; only the author or staff may change what was written.
 *
 * This check did not exist while `/posts` lived behind `requireAdmin` — the
 * route was the guard. Opening writing to everybody makes the route no longer
 * sufficient, and a handler that trusts a middleware which has since moved is
 * exactly how an authorisation hole opens without anybody editing the handler.
 */
function assertCanEdit(post: IPost, user: IUser): boolean {
  const isAuthor = post.author.toString() === user._id.toString();
  if (!isAuthor && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who wrote this can change it');
  }
  return isAuthor;
}

export async function updatePost(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdatePostInput;

  const post = await Post.findById(req.params.id);
  if (!post) throw ApiError.notFound('We could not find that post');

  const isAuthor = assertCanEdit(post, req.user!);
  const wasPublished = post.status === 'published';

  Object.assign(post, input);

  /* Publishing for the first time stamps the date; unpublishing keeps it, so a
     post that goes back to draft and out again does not silently jump the feed. */
  if (input.status === 'published' && !post.publishedAt) post.publishedAt = new Date();

  await post.save();
  await post.populate('author', AUTHOR_FIELDS);

  const nowPublished = post.status === 'published';
  /* Staff acting on somebody else's post is the event worth recording. An
     author publishing their own writing is ordinary, and logging every one
     would bury the moderation entries under them. */
  if (wasPublished !== nowPublished && !isAuthor) {
    await audit(req, {
      action: nowPublished ? 'post.published' : 'post.unpublished',
      targetType: 'post',
      targetId: post._id,
      targetLabel: post.title,
      summary: nowPublished
        ? `Published "${post.title}"`
        : `Took "${post.title}" back to draft`,
    });
  }

  res.json({ success: true, data: toPostResponse(post) });
}

export async function deletePost(req: Request, res: Response): Promise<void> {
  const post = await Post.findById(req.params.id);
  if (!post) throw ApiError.notFound('We could not find that post');

  const isAuthor = assertCanEdit(post, req.user!);

  const label = post.title;
  await post.deleteOne();

  /* Only when staff remove somebody else's writing. An author deleting their
     own draft is not a moderation event. */
  if (!isAuthor) {
    await audit(req, {
      action: 'post.deleted',
      targetType: 'post',
      targetId: post._id,
      targetLabel: label,
      summary: `Deleted "${label}", a post written by someone else`,
    });
  }

  res.json({ success: true, data: { id: post._id.toString() } });
}

/**
 * Everything you have written, drafts included.
 *
 * Separate from the public feed, which filters to published-and-due. A writer
 * needs to see the draft they abandoned last week; nobody else does.
 */
export async function listMyPosts(req: Request, res: Response): Promise<void> {
  const posts = await Post.find({ author: req.user!._id })
    .sort({ createdAt: -1 })
    .populate('author', AUTHOR_FIELDS);

  res.json({ success: true, data: posts.map(toPostSummary) });
}
