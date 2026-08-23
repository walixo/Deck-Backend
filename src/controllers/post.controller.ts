import type { Request, Response } from 'express';
import { Post } from '../models/Post';
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

  /* A draft is readable by staff — that is how it gets previewed — and by
     nobody else. Answering 404 rather than 403 keeps unpublished titles from
     being enumerable by anyone who can guess a slug. */
  const isStaff = req.user?.role === 'admin';
  const isLive = post.status === 'published' && post.publishedAt && post.publishedAt <= new Date();
  if (!isLive && !isStaff) throw ApiError.notFound('We could not find that post');

  res.json({ success: true, data: toPostResponse(post) });
}

/* ------------------------------------------------------------------ staff --- */

export async function listAllPosts(_req: Request, res: Response): Promise<void> {
  const posts = await Post.find().sort({ createdAt: -1 }).populate('author', AUTHOR_FIELDS);
  res.json({ success: true, data: posts.map(toPostSummary) });
}

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

  await audit(req, {
    action: 'post.created',
    targetType: 'post',
    targetId: post._id,
    targetLabel: post.title,
    summary: `Created the post "${post.title}" as a ${post.status}`,
  });

  res.status(201).json({ success: true, data: toPostResponse(post) });
}

export async function updatePost(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdatePostInput;

  const post = await Post.findById(req.params.id);
  if (!post) throw ApiError.notFound('We could not find that post');

  const wasPublished = post.status === 'published';

  Object.assign(post, input);

  /* Publishing for the first time stamps the date; unpublishing keeps it, so a
     post that goes back to draft and out again does not silently jump the feed. */
  if (input.status === 'published' && !post.publishedAt) post.publishedAt = new Date();

  await post.save();
  await post.populate('author', AUTHOR_FIELDS);

  const nowPublished = post.status === 'published';
  if (wasPublished !== nowPublished) {
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

  const label = post.title;
  await post.deleteOne();

  await audit(req, {
    action: 'post.deleted',
    targetType: 'post',
    targetId: post._id,
    targetLabel: label,
    summary: `Deleted the post "${label}"`,
  });

  res.json({ success: true, data: { id: post._id.toString() } });
}
