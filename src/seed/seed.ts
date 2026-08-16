/* eslint-disable no-console */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { Comment } from '../models/Comment';
import { Item } from '../models/Item';
import { AdCampaign } from '../models/AdCampaign';
import { AuditEvent } from '../models/AuditEvent';
import { Contribution } from '../models/Contribution';
import { MerchProduct } from '../models/MerchProduct';
import { Payout } from '../models/Payout';
import { Order } from '../models/Order';
import { User } from '../models/User';
import { Vote } from '../models/Vote';
import { addDays, toDateKey } from '../utils/date';
import { slugify } from '../utils/slug';
import { seedComments, seedItems, seedUsers } from './data';
import { seedMerch } from './merch.data';

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
  await Promise.all(
    items.map(async (item) => {
      const totals = ratingTotals.get(item.id) ?? { count: 0, sum: 0 };
      item.commentCount = comments.filter((comment) => String(comment.item) === item.id).length;
      item.reviewCount = totals.count;
      item.ratingSum = totals.sum;
      item.ratingAvg = totals.count > 0 ? totals.sum / totals.count : 0;
      await item.save();
    }),
  );

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
