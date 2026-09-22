import type { Request, Response } from 'express';
import mongoose, { type FilterQuery } from 'mongoose';
import { env } from '../config/env';
import { Comment } from '../models/Comment';
import { Item, type IItem } from '../models/Item';
import { ItemRevision } from '../models/ItemRevision';
import { Vote } from '../models/Vote';
import { toItemResponse, toRevisionResponse } from '../serializers';
import { assertCategory } from './category.controller';
import { audit } from '../services/audit';
import { evaluateBadges } from '../services/badges';
import { recordRevision, snapshotOf } from '../services/revisions';
import { recordView } from '../services/views';
import { ApiError } from '../utils/ApiError';
import { toDateKey } from '../utils/date';
import { uniqueSlug } from '../utils/slug';
import type {
  CreateItemInput,
  ListItemsQuery,
  ReleaseItemInput,
  RescheduleItemInput,
  SetFutureGenInput,
  UpdateItemInput,
  UpdateRevenueInput,
} from '../validators/item.validators';

/* `verified` is load-bearing in this projection. `toPublicUser` reads it, so
   leaving it out does not omit the field — it sends `verified: false` for every
   account, which is a wrong answer rather than a missing one. */
const SUBMITTER_FIELDS = 'name username avatarUrl headline verified';

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
  if (query.futureGen !== undefined) filter.futureGen = query.futureGen;

  /*
   * Date scoping, as a prefix match on the denormalised day key.
   *
   * A full day is an equality match; a year or month is an anchored prefix. The
   * value is already validated to be digits and dashes only, so nothing a
   * caller sends can become a regex — and the field is indexed, so an anchored
   * prefix still uses it.
   */
  if (query.on) {
    filter.launchDateKey = query.on.length === 10 ? query.on : new RegExp(`^${query.on}`);
  }

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

  /*
   * The view is counted here, in the request that fetched the launch — not by
   * a beacon the client fires.
   *
   * A client-side ping is a second endpoint, a second thing to rate limit, and
   * a number anybody can raise with a loop in a console. Counting the fetch
   * that renders the page means the count is a byproduct of the page existing.
   * `recordView` decides what qualifies (see services/views.ts) and never
   * throws, so it can sit in this Promise.all and cost no extra latency.
   */
  const [voted, related, siblings, counted] = await Promise.all([
    votedIdsFor(req.user?._id.toString(), [item]),
    Item.find({ _id: { $ne: item._id }, category: item.category })
      .sort({ voteCount: -1 })
      .limit(3)
      .populate('submittedBy', SUBMITTER_FIELDS),
    /* Every version of this product, newest first. Includes this one, so the
       strip can mark the current entry without a second lookup. Trimmed to the
       fields a strip renders rather than serialising whole launches. */
    Item.find({ lineage: item.lineage ?? item._id })
      .sort({ launchDate: -1 })
      .select('slug name version launchDate voteCount ratingAvg ratingSum reviewCount'),
    recordView(item, req),
  ]);

  res.json({
    success: true,
    data: {
      ...toItemResponse(item, voted),
      /* The document was read before the increment landed, so the viewer's own
         visit is added back on. Without it every reader is shown a number that
         is one behind the page they are looking at. */
      viewCount: (item.viewCount ?? 0) + (counted ? 1 : 0),
      related: related.map((relatedItem) => toItemResponse(relatedItem)),
      /* Omitted entirely when a product has only ever launched once — a
         "versions" list of one is not a version history, and the client should
         not have to special-case it. */
      versions:
        siblings.length > 1
          ? siblings.map((sibling) => ({
              slug: sibling.slug,
              name: sibling.name,
              version: sibling.version,
              launchDate: sibling.launchDate,
              voteCount: sibling.voteCount,
              ratingAvg: Math.round(sibling.ratingAvg * 10) / 10,
              reviewCount: sibling.reviewCount,
              current: sibling.slug === item.slug,
            }))
          : [],
      /*
       * Rating across every version, derived rather than stored.
       *
       * A review is written about the version in front of the reviewer, so it
       * stays on that version — but a reader asking "is this product any good"
       * means the product, not the release. Summing the stored ratingSum and
       * reviewCount answers that without a second source of truth to drift, the
       * same reasoning the seller balance uses.
       */
      allVersions: siblings.reduce(
        (total, sibling) => {
          const reviews = total.reviewCount + sibling.reviewCount;
          const sum = total.ratingSum + sibling.ratingSum;
          return {
            voteCount: total.voteCount + sibling.voteCount,
            reviewCount: reviews,
            ratingSum: sum,
            ratingAvg: reviews > 0 ? Math.round((sum / reviews) * 10) / 10 : 0,
          };
        },
        { voteCount: 0, reviewCount: 0, ratingSum: 0, ratingAvg: 0 },
      ),
    },
  });
}

export async function createItem(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateItemInput;
  const launchDate = input.launchDate ?? new Date();

  await assertCategory(input.category);

  const slug = await uniqueSlug(input.name, async (candidate) => {
    const exists = await Item.exists({ slug: candidate });
    return exists !== null;
  });

  const item = await Item.create({
    ...input,
    repoUrl: input.repoUrl || undefined,
    logoUrl: input.logoUrl || undefined,
    coverUrl: input.coverUrl || undefined,
    wallColour: input.wallColour || undefined,
    videoUrl: input.videoUrl || undefined,
    slug,
    launchDate,
    launchDateKey: toDateKey(launchDate),
    submittedBy: req.user!._id,
  });

  await item.populate('submittedBy', SUBMITTER_FIELDS);

  /* Revision 1: the launch as posted. Awaited, unlike badges, because without
     it the first edit would have nothing to diff against and the history would
     start at version 2 with no origin. */
  await recordRevision({ item, editor: req.user!, role: 'owner' });

  void evaluateBadges(req.user!._id);

  res.status(201).json({ success: true, data: toItemResponse(item) });
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  /* `note` describes the edit, not the launch — split off so the assign below
     cannot write it onto the document. */
  const { note, ...input } = req.body as UpdateItemInput;
  const item = await Item.findById(req.params.id);
  if (!item) throw ApiError.notFound('We could not find that launch');

  const user = req.user!;
  const isOwner = item.submittedBy.toString() === user._id.toString();
  if (!isOwner && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who launched this can edit it');
  }

  /*
   * A launch is editable for a few hours, then it sets.
   *
   * This replaced a rule that froze only the name and category, and only once
   * votes had arrived. That was aimed at the right problem — bait-and-switch,
   * collecting votes as one thing and becoming another — but it solved it
   * badly: a launch with no votes yet could be rewritten wholesale, and one
   * with votes could still have its entire pitch swapped, which is most of what
   * anybody actually reads.
   *
   * A window is simpler and covers both. Inside it everything is editable,
   * because the first thing anybody does after publishing is find the typo.
   * Outside it nothing is, because the text people voted on should be the text
   * that stays — and changing the product has a supported path: ship a release.
   *
   * Staff are exempt. Moderation sometimes means fixing a launch long after the
   * window shuts, and those edits are audited and appear in the public history.
   */
  const windowMs = env.editWindowHours * 60 * 60 * 1000;
  const closesAt = new Date(item.launchDate.getTime() + windowMs);

  if (isOwner && windowMs > 0 && Date.now() > closesAt.getTime()) {
    throw ApiError.badRequest(
      `Launches can be edited for ${env.editWindowHours} hours after posting. This one has set — ship a new version to change it.`,
    );
  }

  if (input.category && input.category !== item.category) {
    await assertCategory(input.category);
  }

  /* An empty wall colour is "go back to sampling my logo", not a blank hex.
     Assigning undefined unsets the path; assigning '' would store a value that
     every reader has to special-case. */
  if (input.wallColour === '') input.wallColour = undefined;
  if (input.videoUrl === '') input.videoUrl = undefined;

  /* Taken before the assign below, or the diff compares the document to itself
     and every edit records as "nothing changed". */
  const previous = snapshotOf(item);

  /* No launchDate here on purpose — the schema drops it, and moving a launch
     between boards is an audited admin action. See rescheduleItem. */
  Object.assign(item, input);

  await item.save();
  await item.populate('submittedBy', SUBMITTER_FIELDS);

  const version = await recordRevision({
    item,
    previous,
    editor: user,
    role: isOwner ? 'owner' : 'admin',
    note,
  });

  /* Only when staff edit a launch that is not theirs. The maker editing their
     own is ordinary, and logging it would drown the entries that matter — the
     revision history covers that case now, and it is public. */
  if (!isOwner) {
    await audit(req, {
      action: 'item.edited',
      targetType: 'item',
      targetId: item._id,
      targetLabel: item.name,
      summary: `Edited "${item.name}", a launch belonging to someone else`,
      after: { fields: Object.keys(input), revision: version },
    });
  }

  res.json({ success: true, data: toItemResponse(item) });
}

/**
 * The edit history of a launch, newest first.
 *
 * Public and unauthenticated on purpose. The point of keeping it is that a
 * reader deciding whether to trust a launch can see whether its pitch has been
 * rewritten since the votes arrived — a history only its author can read would
 * not do that job.
 *
 * Fetched by slug to match every other read on this resource, so the item page
 * does not have to hold an id to ask for it.
 */
export async function listItemRevisions(req: Request, res: Response): Promise<void> {
  const item = await Item.findOne({ slug: req.params.slug }).select('_id');
  if (!item) throw ApiError.notFound('We could not find that launch');

  const revisions = await ItemRevision.find({ item: item._id })
    .sort({ version: -1 })
    .populate('editedBy', 'name username avatarUrl verified');

  res.json({ success: true, data: revisions.map(toRevisionResponse) });
}

/**
 * Ships a new version of an existing product.
 *
 * A release is a *new launch*, not an edit — its own slug, its own board day,
 * its own votes, its own comments — tied to the previous one by `lineage`. That
 * separation is what makes the model work:
 *
 *  - Votes are unique per (item, user), so a fresh document is what lets past
 *    supporters vote again. Correct: it is a new launch day, not a second vote
 *    on the old one.
 *  - The daily board and the badge aggregations already key on `launchDateKey`,
 *    so neither needs to learn anything about versions.
 *  - Comments and reviews stay attached to the version they were written about,
 *    which is the only place they are true.
 *
 * What deliberately does not carry over is the fundraise. Money state is never
 * duplicated — a new version starts opted out, and the old raise keeps whatever
 * it raised. `featured` does not carry either; that is Deck's call, not the
 * maker's, and inheriting it would let one editorial decision run forever.
 */
export async function releaseItem(req: Request, res: Response): Promise<void> {
  const { version, changelog, ...draft } = req.body as ReleaseItemInput;

  await assertCategory(draft.category);

  const from = await Item.findOne({ slug: req.params.slug });
  if (!from) throw ApiError.notFound('We could not find that launch');

  const user = req.user!;
  const lineage = from.lineage ?? from._id;

  /* The newest version in the chain, which is what a release actually extends —
     releasing from an old version's page should still append to the end. */
  const latest = await Item.findOne({ lineage }).sort({ launchDate: -1 });
  if (!latest) throw ApiError.notFound('We could not find that launch');

  const isOwner = latest.submittedBy.toString() === user._id.toString();
  if (!isOwner && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who launched this can ship a new version');
  }

  /*
   * Cooldown, measured from the newest version rather than the one being
   * released from. Otherwise the check is trivially skipped by opening the
   * original launch's page and releasing from there.
   *
   * Admins are not exempt: the limit exists to keep the board honest, and staff
   * shipping their own product are as capable of farming it as anyone.
   */
  const cooldownMs = env.releaseCooldownDays * 24 * 60 * 60 * 1000;
  const readyAt = new Date(latest.launchDate.getTime() + cooldownMs);
  if (cooldownMs > 0 && Date.now() < readyAt.getTime()) {
    const daysLeft = Math.ceil((readyAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    throw ApiError.badRequest(
      `"${latest.name}" launched too recently. You can ship a new version in ${daysLeft} ${
        daysLeft === 1 ? 'day' : 'days'
      }.`,
    );
  }

  const slug = await uniqueSlug(draft.name, async (candidate) => {
    const exists = await Item.exists({ slug: candidate });
    return exists !== null;
  });

  const launchDate = new Date();

  const item = await Item.create({
    ...draft,
    repoUrl: draft.repoUrl || undefined,
    logoUrl: draft.logoUrl || undefined,
    coverUrl: draft.coverUrl || undefined,
    wallColour: draft.wallColour || undefined,
    videoUrl: draft.videoUrl || undefined,
    slug,
    version,
    lineage,
    supersedes: latest._id,
    launchDate,
    launchDateKey: toDateKey(launchDate),
    /* The release belongs to whoever shipped it. An admin releasing on someone
       else's behalf would otherwise silently take ownership of the product. */
    submittedBy: latest.submittedBy,
  });

  await item.populate('submittedBy', SUBMITTER_FIELDS);

  await recordRevision({
    item,
    editor: user,
    role: isOwner ? 'owner' : 'admin',
    note: changelog,
  });

  void evaluateBadges(latest.submittedBy);

  res.status(201).json({ success: true, data: toItemResponse(item) });
}

/**
 * Moves a launch to a different board day. Staff only, always recorded.
 *
 * This is the one operation that can rewrite history: `launchDateKey` decides
 * which daily board a launch competes on, and the board-finish badges aggregate
 * over it. Moving a launch that already has votes changes who topped that day.
 *
 * That is occasionally the right thing to do — a launch posted against the
 * wrong timezone, a duplicate cleaned up — so the capability stays. What it
 * does not get to be is silent, or something a maker can do to their own entry.
 * Hence: admin gate, a mandatory reason, and an audit entry carrying both the
 * old key and the new one.
 */
/**
 * Puts a launch on Future Gen, or takes it off. Staff only, always audited.
 *
 * Not an edit, so it does not go through `updateItem` and does not create a
 * revision: nothing the maker wrote changes, and a revision history full of
 * "staff toggled a flag" entries would bury the edits that are actually about
 * the product. Same reasoning as rescheduling, which lives next door.
 */
export async function setFutureGen(req: Request, res: Response): Promise<void> {
  const { futureGen, note } = req.body as SetFutureGenInput;

  const item = await Item.findById(req.params.id);
  if (!item) throw ApiError.notFound('We could not find that launch');

  if (item.futureGen === futureGen) {
    throw ApiError.badRequest(
      futureGen ? 'That launch is already on Future Gen' : 'That launch is not on Future Gen',
    );
  }

  item.futureGen = futureGen;
  await item.save();
  await item.populate('submittedBy', SUBMITTER_FIELDS);

  await audit(req, {
    action: futureGen ? 'futuregen.added' : 'futuregen.removed',
    targetType: 'item',
    targetId: item._id,
    targetLabel: item.name,
    summary: futureGen
      ? `Added "${item.name}" to Future Gen — ${note}`
      : `Removed "${item.name}" from Future Gen — ${note}`,
    after: { futureGen, note },
  });

  res.json({ success: true, data: toItemResponse(item) });
}

export async function rescheduleItem(req: Request, res: Response): Promise<void> {
  const { launchDate, reason } = req.body as RescheduleItemInput;

  const item = await Item.findById(req.params.id);
  if (!item) throw ApiError.notFound('We could not find that launch');

  const from = item.launchDateKey;
  const to = toDateKey(launchDate);

  if (from === to) {
    throw ApiError.badRequest('That launch is already on that board');
  }

  item.launchDate = launchDate;
  item.launchDateKey = to;
  await item.save();
  await item.populate('submittedBy', SUBMITTER_FIELDS);

  await audit(req, {
    action: 'item.rescheduled',
    targetType: 'item',
    targetId: item._id,
    targetLabel: item.name,
    summary: `Moved "${item.name}" from the ${from} board to ${to} — ${reason}`,
    before: { launchDateKey: from },
    after: { launchDateKey: to, voteCount: item.voteCount, reason },
  });

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

  /* The history goes with the launch. It exists to hold an author to what they
     published, not to outlive the publication — keeping the drafts of a deleted
     launch would preserve exactly the text they asked to be rid of. */
  await Promise.all([
    Comment.deleteMany({ item: item._id }),
    Vote.deleteMany({ item: item._id }),
    ItemRevision.deleteMany({ item: item._id }),
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

/**
 * Publishes, updates or withdraws the maker's revenue figure.
 *
 * Its own endpoint, deliberately outside the edit window that freezes
 * everything else on a launch. That window exists so the pitch people voted on
 * stays the pitch — but revenue is not a claim about what the product *is*, it
 * is a measurement that goes out of date by standing still. Freezing it four
 * hours after launch would guarantee every figure on the site was stale, which
 * is worse than not showing one.
 *
 * No revision is recorded. `ItemRevision` is a history of the authored launch,
 * and filling it with monthly metric updates would bury the edits it exists to
 * expose. The audit trail keeps the record instead.
 */
export async function updateRevenue(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateRevenueInput;

  const item = await Item.findOne({ slug: req.params.slug });
  if (!item) throw ApiError.notFound('We could not find that launch');

  const user = req.user!;
  const isOwner = item.submittedBy.toString() === user._id.toString();
  if (!isOwner && user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who launched this can report its revenue');
  }

  const before = {
    disclosed: item.revenue.disclosed,
    monthlyMinor: item.revenue.monthlyMinor,
  };

  if (input.disclosed) {
    item.revenue.disclosed = true;
    /* Whole units in, minor units stored. Rounded rather than truncated, and
       done once here — never carried through anything as a float. */
    item.revenue.monthlyMinor = Math.round((input.monthly ?? 0) * 100);
    if (input.currency) item.revenue.currency = input.currency;
    /* Pre-revenue cannot also be profitable. Rejecting it would be pedantic
       over a checkbox nobody meant to tick, so it is quietly impossible. */
    item.revenue.profitable = Boolean(input.profitable) && item.revenue.monthlyMinor > 0;
    item.revenue.reportedAt = new Date();
  } else {
    /* Withdrawn, not zeroed. Zero is a real answer — pre-revenue — so taking
       the figure down has to clear the flag, not set the number to nothing. */
    item.revenue.disclosed = false;
    item.revenue.monthlyMinor = 0;
    item.revenue.profitable = false;
    item.revenue.reportedAt = null;
  }

  await item.save();

  /* Audited even when the owner does it. A public revenue claim that changes
     silently is exactly the kind of thing a dispute later turns on. */
  await audit(req, {
    action: 'item.revenue',
    targetType: 'item',
    targetId: item._id,
    targetLabel: item.name,
    summary: input.disclosed
      ? `Reported ${item.revenue.monthlyMinor / 100} ${item.revenue.currency}/mo on "${item.name}"`
      : `Withdrew the revenue figure on "${item.name}"`,
    before,
    after: { disclosed: item.revenue.disclosed, monthlyMinor: item.revenue.monthlyMinor },
  });

  res.json({ success: true, data: toItemResponse(item) });
}
