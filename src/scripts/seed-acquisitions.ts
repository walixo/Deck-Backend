/**
 * Puts a few launches on the acquisitions board, with offers against them.
 *
 *   npm run seed-acquisitions
 *
 * The board is staff-curated so it starts empty, and empty is exactly the state
 * where none of its design is visible — the asking-price band, the offer count,
 * the sold ledger and the seller's view of bids all need real rows.
 *
 * Idempotent per launch: a launch that already has a listing is left alone.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { ACQUISITION_FEE_PERCENT, CURRENCY } from '../constants';
import { Acquisition, Bid, type AcquisitionAsset } from '../models/Acquisition';
import { Item } from '../models/Item';
import { User } from '../models/User';

interface Seed {
  /** Naira, whole units. */
  asking: number;
  negotiable: boolean;
  reason: string;
  assets: AcquisitionAsset[];
  monthlyRevenue: number;
  monthlyCost: number;
  activeUsers: number;
  notes?: string;
  /** [amount in naira, pitch] */
  offers: [number, string][];
  /** Index into `offers` of the one that was accepted, if any. */
  accepted?: number;
}

const SEEDS: Seed[] = [
  {
    asking: 8_500_000,
    negotiable: true,
    reason:
      'I built this to scratch my own itch and it found about 400 people with the same itch.\n' +
      'It is profitable and it runs itself, but I have taken a full-time role and I am not going to give it the attention it needs to grow. Rather than let it rot I would like somebody to take it who actually wants to push it.\n' +
      'Everything transfers. I will stay on for a month to hand over properly.',
    assets: ['source', 'domain', 'users', 'revenue', 'brand', 'support'],
    monthlyRevenue: 640_000,
    monthlyCost: 85_000,
    activeUsers: 412,
    notes: 'Node and Postgres on Render. One cron, one worker. No third-party lock-in.',
    offers: [
      [
        7_200_000,
        'I run two small SaaS products in the same space and have the support load covered already. Offering under the ask because I would be taking on the migration, but I can close in a week.',
      ],
      [
        8_500_000,
        'Full ask. I have been a customer for a year and I have a list of things I would fix in the first month. Funds are ready.',
      ],
    ],
  },
  {
    asking: 2_200_000,
    negotiable: false,
    reason:
      'Pre-revenue but the hard part is done — the parser handles every edge case I could find over eighteen months, and there is a real test suite behind it.\n' +
      'I am moving to hardware and this deserves an owner who ships. Firm on the price; it is already below what the code cost me to write.',
    assets: ['source', 'domain', 'brand'],
    monthlyRevenue: 0,
    monthlyCost: 12_000,
    activeUsers: 90,
    offers: [],
  },
  {
    asking: 14_000_000,
    negotiable: true,
    reason:
      'Three years old, steady revenue, low churn. I am selling because I have started something else and I would rather do one thing properly than two things badly.\n' +
      'Books are open to a serious buyer. Happy to do an earn-out if that suits you better than a lump sum.',
    assets: ['source', 'domain', 'users', 'revenue', 'brand', 'socials', 'contracts', 'support'],
    monthlyRevenue: 1_150_000,
    monthlyCost: 210_000,
    activeUsers: 1_840,
    offers: [
      [13_000_000, 'Serious buyer, funds in place. Would want two months of handover rather than one.'],
    ],
    accepted: 0,
  },
];

async function run(): Promise<void> {
  await connectDatabase();

  /* Launches that are not already listed and not on Future Gen — a prototype
     being sold out from under a fundraise is a confusing fixture. */
  const candidates = await Item.find({ futureGen: { $ne: true } })
    .sort({ voteCount: -1 })
    .limit(20);

  const people = await User.find().limit(8);
  if (candidates.length === 0 || people.length === 0) {
    console.log('No launches or users found. Run `npm run seed` first.');
    await disconnectDatabase();
    return;
  }

  let added = 0;

  for (const seed of SEEDS) {
    const item = candidates.find(
      (candidate) => !usedIds.has(candidate._id.toString()),
    );
    if (!item) break;
    usedIds.add(item._id.toString());

    if (await Acquisition.exists({ item: item._id })) {
      console.log(`· ${item.name} — already listed`);
      continue;
    }

    const listing = await Acquisition.create({
      item: item._id,
      slug: item.slug,
      seller: item.submittedBy,
      status: 'approved',
      askingMinor: seed.asking * 100,
      currency: CURRENCY,
      negotiable: seed.negotiable,
      reason: seed.reason,
      assets: seed.assets,
      monthlyRevenueMinor: seed.monthlyRevenue * 100,
      monthlyCostMinor: seed.monthlyCost * 100,
      activeUsers: seed.activeUsers,
      notes: seed.notes,
      appliedAt: new Date(),
      reviewedAt: new Date(),
      reviewNote: 'Seeded listing',
    });

    /* Bidders must not be the seller — the API refuses that, and a fixture the
       API would reject describes a state the product cannot reach. */
    const bidders = people.filter(
      (person) => person._id.toString() !== item.submittedBy.toString(),
    );

    let highest = 0;

    for (const [index, [naira, message]] of seed.offers.entries()) {
      const bidder = bidders[index % bidders.length];
      if (!bidder) break;

      const amountMinor = naira * 100;
      const accepted = seed.accepted === index;

      await Bid.create({
        acquisition: listing._id,
        bidder: bidder._id,
        amountMinor,
        currency: CURRENCY,
        message,
        status: accepted ? 'accepted' : 'active',
      });

      if (!accepted) highest = Math.max(highest, amountMinor);

      if (accepted) {
        const feeMinor = Math.round((amountMinor * ACQUISITION_FEE_PERCENT) / 100);
        listing.status = 'sold';
        listing.soldAt = new Date();
        listing.soldMinor = amountMinor;
        listing.soldFeeMinor = feeMinor;
        listing.soldTo = bidder._id;
      }
    }

    listing.bidCount = seed.accepted === undefined ? seed.offers.length : 0;
    listing.highestBidMinor = highest;
    await listing.save();

    added += 1;
    console.log(
      `✓ ${item.name} — ${seed.asking.toLocaleString()} ${CURRENCY}` +
        `, ${seed.offers.length} offer(s)` +
        (listing.status === 'sold' ? ', SOLD' : ''),
    );
  }

  console.log(
    added > 0 ? `\nListed ${added}. Open /acquisitions.` : '\nEverything was already listed.',
  );

  await disconnectDatabase();
}

/** Tracks which launches this run has already consumed. */
const usedIds = new Set<string>();

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
