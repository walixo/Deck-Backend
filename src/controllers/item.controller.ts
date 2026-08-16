import type { Request, Response } from 'express';
import mongoose, { type FilterQuery } from 'mongoose';
import { Comment } from '../models/Comment';
import { Item, type IItem } from '../models/Item';
import { Vote } from '../models/Vote';
import { toItemResponse } from '../serializers';
import { audit } from '../services/audit';
import { evaluateBadges } from '../services/badges';
import { ApiError } from '../utils/ApiError';
import { toDateKey } from '../utils/date';
import { uniqueSlug } from '../utils/slug';
import type {
  CreateItemInput,
  ListItemsQuery,
  UpdateItemInput,
} from '../validators/item.validators';

const SUBMITTER_FIELDS = 'name username avatarUrl headline';

/** Which item ids the current viewer has already upvoted. */
async function votedIdsFor(userId: string | undefined, items: IItem[]): Promise<Set<string>> {
  if (!userId || items.length === 0) return new Set();
  const votes = await Vote.find({
    user: userId,
    item: { $in: items.map((item) => item._id) },
  }).select('item');
  return new Set(votes.map((vote) => vote.item.toString()));
}

function buildFilter(query: ListItemsQuery): FilterQuery<IItem> {
  const filter: FilterQuery<IItem> = {};

  if (query.category) filter.category = query.category;
  if (query.pricing) filter.pricing = query.pricing;
  if (query.tag) filter.tags = query.tag;
  if (query.featured !== undefined) filter.featured = query.featured;

  if (query.search) {
    const pattern = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { name: pattern },
      { tagline: pattern },
      { description: pattern },
      { tags: pattern },
    ];
  }

  return filter;
}

/** Recency-weighted popularity, so a fresh launch can outrank an older favourite. */
async function trendingIds(
  filter: FilterQuery<IItem>,
  skip: number,
  limit: number,
): Promise<mongoose.Types.ObjectId[]> {
  const results = await Item.aggregate<{ _id: mongoose.Types.ObjectId }>([
    { $match: filter },
    {
      $addFields: {
        ageHours: {
          $max: [{ $divide: [{ $subtract: [new Date(), '$launchDate'] }, 3_600_000] }, 0],
        },
      },
    },
    {
      $addFields: {
        trendingScore: {
          $divide: [
            { $add: ['$voteCount', { $multiply: ['$commentCount', 2] }, 1] },
            { $pow: [{ $add: ['$ageHours', 4] }, 1.2] },
          ],
        },
      },
    },
    { $sort: { trendingScore: -1, voteCount: -1, _id: 1 } },
    { $skip: skip },
    { $limit: limit },
    { $project: { _id: 1 } },
  ]);

  return results.map((row) => row._id);
}

export async function listItems(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListItemsQuery;
  const filter = buildFilter(query);
  const skip = (query.page - 1) * query.limit;

  const [total, items] = await Promise.all([
    Item.countDocuments(filter),
    (async (): Promise<IItem[]> => {
      if (query.sort === 'trending') {
        const ids = await trendingIds(filter, skip, query.limit);
        if (ids.length === 0) return [];
        const docs = await Item.find({ _id: { $in: ids } }).populate(
          'submittedBy',
          SUBMITTER_FIELDS,
        );
        const order = new Map(ids.map((id, index) => [id.toString(), index]));
        return docs.sort(
          (a, b) => (order.get(a._id.toString()) ?? 0) - (order.get(b._id.toString()) ?? 0),
        );
      }

      const sortMap: Record<Exclude<ListItemsQuery['sort'], 'trending'>, Record<string, 1 | -1>> = {
        newest: { launchDate: -1, createdAt: -1 },
        top: { voteCount: -1, launchDate: -1 },
        discussed: { commentCount: -1, voteCount: -1 },
      };

      return Item.find(filter)
        .sort(sortMap[query.sort])
        .skip(skip)
        .limit(query.limit)
        .populate('submittedBy', SUBMITTER_FIELDS);
    })(),
  ]);

  const voted = await votedIdsFor(req.user?._id.toString(), items);

  res.json({
    success: true,
    data: items.map((item) => toItemResponse(item, voted)),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + items.length < total,
    },
  });
}

export async function getSpotlight(req: Request, res: Response): Promise<void> {
  const items = await Item.find({ featured: true })
    .sort({ launchDate: -1 })
    .limit(6)
    .populate('submittedBy', SUBMITTER_FIELDS);

  const voted = await votedIdsFor(req.user?._id.toString(), items);

  res.json({ success: true, data: items.map((item) => toItemResponse(item, voted)) });
}

export async function getItem(req: Request, res: Response): Promise<void> {
  const { slug } = req.params;

  const item = await Item.findOne({ slug }).populate('submittedBy', SUBMITTER_FIELDS);
  if (!item) throw ApiError.notFound('We could not find that launch');

  const [voted, related] = await Promise.all([
    votedIdsFor(req.user?._id.toString(), [item]),
    Item.find({ _id: { $ne: item._id }, category: item.category })
      .sort({ voteCount: -1 })
      .limit(3)
      .populate('submittedBy', SUBMITTER_FIELDS),
  ]);

  res.json({
    success: true,
    data: {
      ...toItemResponse(item, voted),
      related: related.map((relatedItem) => toItemResponse(relatedItem)),
    },
  });
}

export async function createItem(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateItemInput;
  const launchDate = input.launchDate ?? new Date();

  const slug = await uniqueSlug(input.name, async (candidate) => {
    const exists = await Item.exists({ slug: candidate });
    return exists !== null;
  });

  const item = await Item.create({
    ...input,
    repoUrl: input.repoUrl || undefined,
    logoUrl: input.logoUrl || undefined,
    coverUrl: input.coverUrl || undefined,
    slug,
    launchDate,
    launchDateKey: toDateKey(launchDate),
    submittedBy: req.user!._id,
  });

  await item.populate('submittedBy', SUBMITTER_FIELDS);

  void evaluateBadges(req.user!._id);

  res.status(201).json({ success: true, data: toItemResponse(item) });
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateItemInput;
  const item = await Item.findById(req.params.id);
  if (!item) throw ApiError.notFound('We could not find that launch');

  const user = req.user!;
  if (item.submittedBy.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who launched this can edit it');
  }

  Object.assign(item, input);
  if (input.launchDate) item.launchDateKey = toDateKey(input.launchDate);

  await item.save();
  await item.populate('submittedBy', SUBMITTER_FIELDS);

  /* Only when staff edit a launch that is not theirs. The maker editing their
     own is ordinary, and logging it would drown the entries that matter. */
  if (user.role === 'admin' && item.submittedBy.toString() !== user._id.toString()) {
    await audit(req, {
      action: 'item.edited',
      targetType: 'item',
      targetId: item._id,
      targetLabel: item.name,
      summary: `Edited "${item.name}", a launch belonging to someone else`,
      after: { fields: Object.keys(input) },
    });
  }

  res.json({ success: true, data: toItemResponse(item) });
}

export async function deleteItem(req: Request, res: Response): Promise<void> {
  const item = await Item.findById(req.params.id);
  if (!item) throw ApiError.notFound('We could not find that launch');

  const user = req.user!;
  if (item.submittedBy.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who launched this can delete it');
  }

  const wasOwner = item.submittedBy.toString() === user._id.toString();
  /* Captured before the delete: afterwards there is nothing left to describe. */
  const label = item.name;

  await Promise.all([
    Comment.deleteMany({ item: item._id }),
    Vote.deleteMany({ item: item._id }),
    item.deleteOne(),
  ]);

  if (user.role === 'admin' && !wasOwner) {
    await audit(req, {
      action: 'item.deleted',
      targetType: 'item',
      targetId: item._id,
      targetLabel: label,
      summary: `Deleted "${label}", a launch belonging to someone else`,
      before: { slug: item.slug, voteCount: item.voteCount },
    });
  }

  res.json({ success: true, data: { id: item._id.toString() } });
}
