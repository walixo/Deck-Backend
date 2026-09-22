/* eslint-disable no-console */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { Comment } from '../models/Comment';
import { Category } from '../models/Category';
import { Item } from '../models/Item';
import { ItemRevision } from '../models/ItemRevision';
import { ItemView } from '../models/ItemView';
import { ItemViewDaily } from '../models/ItemViewDaily';
import { Notification } from '../models/Notification';
import { AdCampaign } from '../models/AdCampaign';
import { AuditEvent } from '../models/AuditEvent';
import { Contribution } from '../models/Contribution';
import { MerchProduct } from '../models/MerchProduct';
import { Payout } from '../models/Payout';
import { Order } from '../models/Order';
import { User } from '../models/User';
import { Vote } from '../models/Vote';
import { SEED_CATEGORIES } from '../constants';
import { addDays, startOfUtcDay, toDateKey } from '../utils/date';
import { snapshotOf } from '../services/revisions';
import { slugify } from '../utils/slug';
import { seedComments, seedItems, seedUsers } from './data';
import { seedMerch } from './merch.data';

/** How many days of view history the seed lays down. Matches the dashboard's
    default window, so a fresh database draws a full chart rather than a stub. */
const DAILY_WINDOW = 30;
const startOfToday = startOfUtcDay(new Date());

/** Deterministic pseudo-random generator so reseeding produces the same demo state. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

async function seed(): Promise<void> {
  await connectDatabase();

  console.log('[seed] clearing existing collections');
  await Promise.all([
    Comment.deleteMany({}),
    Vote.deleteMany({}),
    Item.deleteMany({}),
    Category.deleteMany({}),
    ItemRevision.deleteMany({}),
    ItemView.deleteMany({}),
    ItemViewDaily.deleteMany({}),
    Notification.deleteMany({}),
    User.deleteMany({}),
    MerchProduct.deleteMany({}),
    Order.deleteMany({}),
    Contribution.deleteMany({}),
    AdCampaign.deleteMany({}),
    /* The trail is append-only in the app; the seed wipes the whole database
       by design, and orphaned entries would reference deleted accounts. */
    AuditEvent.collection.drop().catch(() => undefined),
    Payout.deleteMany({}),
  ]);

  console.log(`[seed] creating ${SEED_CATEGORIES.length} categories`);
  await Category.insertMany(SEED_CATEGORIES.map((c) => ({ ...c })));

  console.log(`[seed] creating ${seedUsers.length} users`);
  // create() runs the password-hashing hook; insertMany would not.
  const users = await User.create(seedUsers);

  // Ada is staff, so the merch catalogue can be managed with a seeded login.
  users[0].role = 'admin';
  await users[0].save();

  const random = makeRandom(20260730);
  const now = new Date();

  console.log(`[seed] creating ${seedItems.length} items`);
  const items = await Item.create(
    seedItems.map((item, index) => {
      const launchDate = addDays(now, -item.daysAgo);
      // Spread launches through the day so same-day ordering is stable but varied.
      launchDate.setUTCHours(6 + (index % 12), (index * 7) % 60, 0, 0);

      return {
        name: item.name,
        slug: slugify(item.name),
        tagline: item.tagline,
        description: item.description,
        category: item.category,
        pricing: item.pricing,
        websiteUrl: item.websiteUrl,
        repoUrl: item.repoUrl,
        tags: item.tags,
        makers: item.makers,
        featured: item.featured ?? false,
        launchDate,
        launchDateKey: toDateKey(launchDate),
        submittedBy: users[index % users.length]._id,
      };
    }),
  );

  /* Revision 1 for each: the launch as posted. Without it the first edit of a
     seeded launch would mint a version 1 holding the edited text. */
  console.log('[seed] recording launch history');
  await ItemRevision.insertMany(
    items.map((item, index) => ({
      item: item._id,
      version: 1,
      snapshot: snapshotOf(item),
      changed: [],
      editedBy: item.submittedBy,
      editedByName: users[index % users.length].name,
      editedByRole: 'owner',
      createdAt: item.launchDate,
    })),
  );

  console.log('[seed] casting votes');
  const votes: { item: unknown; user: unknown; createdAt: Date }[] = [];

  for (const item of items) {
    // Newer launches get fewer accumulated votes, which keeps the boards believable.
    const ageDays = Math.max(
      0,
      Math.round((now.getTime() - item.launchDate.getTime()) / 86_400_000),
    );
    const ceiling = Math.min(users.length, 3 + Math.round(random() * (users.length - 3)));
    const target = ageDays === 0 ? Math.max(1, Math.round(ceiling * 0.6)) : ceiling;

    const shuffled = [...users].sort(() => random() - 0.5).slice(0, target);
    for (const user of shuffled) {
      votes.push({ item: item._id, user: user._id, createdAt: item.launchDate });
    }

    item.voteCount = shuffled.length;
  }

  await Vote.insertMany(votes);

  console.log('[seed] writing comments and reviews');
  const comments: Record<string, unknown>[] = [];
  const ratingTotals = new Map<string, { count: number; sum: number }>();

  items.forEach((item, itemIndex) => {
    const commentCount = Math.round(random() * 4);

    for (let i = 0; i < commentCount; i += 1) {
      const author = users[(itemIndex + i * 3) % users.length];
      if (author._id.equals(item.submittedBy)) continue;

      // Roughly two thirds of comments carry a star rating (i.e. are reviews).
      const isReview = random() > 0.34;
      const rating = isReview ? 3 + Math.round(random() * 2) : undefined;

      comments.push({
        item: item._id,
        user: author._id,
        body: seedComments[(itemIndex * 3 + i) % seedComments.length],
        rating,
        parent: null,
        createdAt: addDays(item.launchDate, 0),
      });

      if (rating) {
        const totals = ratingTotals.get(item.id) ?? { count: 0, sum: 0 };
        totals.count += 1;
        totals.sum += rating;
        ratingTotals.set(item.id, totals);
      }
    }
  });

  await Comment.insertMany(comments);

  console.log('[seed] updating denormalised counters');
  const dailyViews: { item: (typeof items)[number]['_id']; dateKey: string; views: number }[] = [];
  await Promise.all(
    items.map(async (item) => {
      const totals = ratingTotals.get(item.id) ?? { count: 0, sum: 0 };
      item.commentCount = comments.filter((comment) => String(comment.item) === item.id).length;
      item.reviewCount = totals.count;
      item.ratingSum = totals.sum;
      item.ratingAvg = totals.count > 0 ? totals.sum / totals.count : 0;
      /*
       * Plausible view counts, derived rather than random.
       *
       * Real views come from people opening the page, which a seed cannot
       * produce — but leaving every launch on zero makes the demo look broken
       * in the one place the number is meant to signal interest. Deriving it
       * from votes and comments keeps the seed deterministic, like everything
       * else in this file, and keeps the ordering believable: the launches
       * people voted for are the launches people looked at. The ratio is the
       * rough shape of a real board — most readers never vote.
       */
      item.viewCount =
        item.voteCount * 17 + item.commentCount * 11 + (item.slug.length % 7) * 23 + 9;

      /*
       * Roughly a third of launches publish a revenue figure, and one of those
       * is pre-revenue — which is the state most worth having in the fixture,
       * because "Pre-revenue" and "no figure at all" render differently and
       * only a seed that contains both will ever show the difference.
       */
      const bucket = item.slug.length % 6;
      if (bucket < 2) {
        item.revenue.disclosed = true;
        item.revenue.currency = 'USD';
        item.revenue.monthlyMinor = bucket === 0 ? 0 : (item.voteCount * 37 + 120) * 100;
        item.revenue.profitable = item.revenue.monthlyMinor > 0 && item.voteCount % 2 === 0;
        item.revenue.reportedAt = addDays(new Date(), -(item.slug.length % 40));
      }
      await item.save();

      /*
       * The same total, spread across the last thirty days.
       *
       * A lifetime figure with no daily rows behind it draws a maker dashboard
       * that is all zeroes next to a large number, which looks like a bug
       * rather than like a seed. Only a share of the total lands in the window
       * — the rest is "before the chart starts", which is what a real launch
       * older than a month looks like.
       *
       * Weighted towards the recent end and jittered off the slug, so the
       * lines have a shape and no two launches have the same one, while the
       * whole thing stays as deterministic as the rest of this file.
       */
      const weights = Array.from({ length: DAILY_WINDOW }, (_, index) => {
        const jitter = ((item.slug.charCodeAt(index % item.slug.length) + index * 7) % 11) + 2;
        return jitter * (1 + index / DAILY_WINDOW);
      });
      const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
      const inWindow = Math.round(item.viewCount * 0.4);

      for (const [index, weight] of weights.entries()) {
        const views = Math.round((weight / weightTotal) * inWindow);
        if (views > 0) {
          dailyViews.push({
            item: item._id,
            dateKey: toDateKey(addDays(startOfToday, index - (DAILY_WINDOW - 1))),
            views,
          });
        }
      }
    }),
  );

  await ItemViewDaily.insertMany(dailyViews);
  console.log(`[seed] wrote ${dailyViews.length} daily view buckets`);

  /*
   * A few notifications for the first maker, so the bell has something in it.
   *
   * Seeded from events that really happened in this dataset — their own
   * launches, their own comment counts — rather than from invented text, so
   * clicking one lands somewhere real instead of on a 404.
   */
  const bellOwner = items[0].submittedBy;
  const ninetyDays = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await Notification.insertMany(
    items.slice(0, 4).map((item, index) => ({
      user: bellOwner,
      kind:
        index === 0 ? 'account.verified' : index === 1 ? 'launch.milestone' : 'comment.received',
      title:
        index === 0
          ? 'Your account is verified'
          : index === 1
            ? `${item.name} passed 10 votes`
            : `Someone commented on ${item.name}`,
      body:
        index === 0
          ? 'The mark now appears beside your name wherever your account shows up on Deck.'
          : 'Have a look at where the traffic is coming from.',
      link: index === 0 ? '/settings' : `/item/${item.slug}`,
      readAt: index > 1 ? new Date() : null,
      createdAt: addDays(new Date(), -index),
      expiresAt: ninetyDays,
    })),
  );
  console.log('[seed] wrote 4 notifications for the first maker');

  console.log(`[seed] stocking ${seedMerch.length} merch products`);
  const merch = await MerchProduct.create(
    seedMerch.map((product) => ({
      name: product.name,
      slug: slugify(product.name),
      tagline: product.tagline,
      description: product.description,
      category: product.category,
      // Whole units in the fixture, integer minor units in the database.
      priceMinor: Math.round(product.price * 100),
      variants: product.variants,
      featured: product.featured ?? false,
      active: true,
      /* Deck's own catalogue: no seller to split payment to, and no review
         queue to sit in. Anything a user lists arrives 'pending' instead. */
      seller: null,
      status: 'approved',
    })),
  );

  const todayCount = await Item.countDocuments({ launchDateKey: toDateKey(now) });

  console.log('\n[seed] done');
  console.log(`  users:   ${users.length}`);
  console.log(`  items:   ${items.length} (${todayCount} launching today)`);
  console.log(`  votes:   ${votes.length}`);
  console.log(`  comments:${comments.length}`);
  console.log(`  merch:   ${merch.length} products`);
  console.log('\n  Sign in with any seeded account, e.g. ada@deck.dev / deck1234\n');

  await disconnectDatabase();
}

seed().catch(async (error) => {
  console.error('[seed] failed:', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
