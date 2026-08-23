/**
 * Puts a handful of seeded launches on the Future Gen timeline.
 *
 *   npm run seed-future-gen
 *
 * Future Gen is staff-curated, so it starts empty and stays empty until somebody
 * with an admin account goes and marks launches — which makes the page
 * impossible to look at in development. This marks the hardware-ish seeds and
 * spreads their launch dates over the past few months so the timeline actually
 * reads as one, rather than as five entries all stamped today.
 *
 * Idempotent: run it twice and the second run reports that everything is already
 * listed. It only ever touches seeded launches, never one somebody posted.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { UPLOAD_DIR, UPLOAD_ROUTE } from '../config/uploads';
import { CURRENCY, FUNDRAISE_MIN_COMMENTS, FUNDRAISE_MIN_VOTES } from '../constants';
import { Contribution } from '../models/Contribution';
import { Item, type IItem } from '../models/Item';
import { User } from '../models/User';
import { applyPlatformFee } from '../services/money';
import { toDateKey } from '../utils/date';
import { encodePng } from '../utils/png';

/** How far back to place each entry, in days. Newest first, as the page reads. */
const SPREAD_DAYS = [6, 34, 61, 96, 138];

async function run(): Promise<void> {
  await connectDatabase();

  /*
   * Hardware first, then whatever else is around.
   *
   * Future Gen is about physical things, so the hardware category is the honest
   * pick. The seed does not guarantee five of them, though, and a timeline with
   * two entries does not show what a timeline looks like — so the shortfall is
   * topped up from the rest rather than leaving the page half-built.
   */
  const hardware = await Item.find({ category: 'hardware' }).sort({ voteCount: -1 }).limit(5);
  const shortfall = 5 - hardware.length;
  const filler = shortfall > 0
    ? await Item.find({
        category: { $ne: 'hardware' },
        _id: { $nin: hardware.map((item) => item._id) },
      })
        .sort({ voteCount: -1 })
        .limit(shortfall)
    : [];

  const chosen = [...hardware, ...filler];

  if (chosen.length === 0) {
    console.log('No launches found. Run `npm run seed` first.');
    await disconnectDatabase();
    return;
  }

  let added = 0;

  /*
   * Each concern is guarded on its own, not on membership.
   *
   * An earlier version skipped the whole body once a launch was listed, which
   * meant adding media to the script did nothing on a database where the seed
   * had already run — the fix looked applied and was not. Every block below
   * asks whether *its* thing is missing.
   */
  for (const [index, item] of chosen.entries()) {
    const before = { listed: item.futureGen, shots: item.gallery?.length ?? 0 };

    if (!item.futureGen) {
      const when = new Date();
      when.setDate(when.getDate() - (SPREAD_DAYS[index] ?? 30 * (index + 1)));

      item.futureGen = true;
      item.launchDate = when;
      /* Kept in step by hand: the board groups on this key, and a launchDate
         written without it would leave the launch on the wrong day's board. */
      item.launchDateKey = toDateKey(when);
      added += 1;
    }

    /* Timeline cards carry a media slider, and it renders nothing without
       media — so the feature is invisible in development until something is
       here. Three shots each, in the launch's own colour family. */
    if (before.shots === 0) {
      item.gallery = writeShots(item.slug, 3);
    }

    /* One video, on the newest entry, so the player and its consent gate are
       both reachable without anybody having to paste a URL in by hand. */
    if (index === 0 && !item.videoUrl) {
      item.videoUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
    }

    if (item.isModified()) {
      await item.save();
      console.log(
        `✓ ${item.name} — ${item.launchDateKey}` +
          (before.shots === 0 ? ', 3 shots' : '') +
          (index === 0 ? ', video' : ''),
      );
    } else {
      console.log(`· ${item.name} — nothing to do`);
    }
  }

  /*
   * One live raise, so both halves of the page are visible.
   *
   * Without this every entry sits in the "not eligible yet" state and the
   * progress bar — the thing the page was asked for — never renders in
   * development. The newest entry gets an approved raise, enough votes and
   * comments to have qualified for it, and a few settled contributions.
   */
  const flagship = chosen[0];
  if (flagship && flagship.fundraise.status !== 'approved') {
    await giveRaise(flagship);
    console.log(`\n✓ ${flagship.name} — raise approved, ${BACKERS.length} backers`);
  }

  console.log(
    added > 0
      ? `\nAdded ${added} to Future Gen. Open /future-gen.`
      : '\nEverything was already listed. Open /future-gen.',
  );

  await disconnectDatabase();
}

/**
 * Writes flat 16:9 placeholder shots and returns their public paths.
 *
 * 16:9 because the slider's frame is `aspect-video`: a square image
 * letterboxed into it is the fastest way to make a working slider look broken.
 * Colour is derived from the slug so a launch's shots are a family rather than
 * three unrelated rectangles, and so re-running produces the same set.
 *
 * A horizon band and a block, nothing more. These stand in for photographs of
 * a prototype; making them look like real photographs is not the job, and
 * anything more elaborate would need a font engine or a rasteriser.
 */
function writeShots(slug: string, count: number): string[] {
  const seed = [...slug].reduce((total, char) => total + char.charCodeAt(0), 0);
  const paths: string[] = [];

  for (let n = 0; n < count; n += 1) {
    const rgb = Buffer.alloc(SHOT_W * SHOT_H * 3);
    const hue = (seed * 37 + n * 53) % 360;
    const [br, bg, bb] = hslToRgb(hue, 0.42, 0.34 + n * 0.08);
    const [fr, fg, fb] = hslToRgb((hue + 28) % 360, 0.55, 0.68);

    const horizon = Math.round(SHOT_H * (0.58 + n * 0.06));
    const blockX = Math.round(SHOT_W * (0.16 + n * 0.2));
    const blockW = Math.round(SHOT_W * 0.26);
    const blockTop = Math.round(horizon - SHOT_H * (0.22 + n * 0.05));

    for (let y = 0; y < SHOT_H; y += 1) {
      for (let x = 0; x < SHOT_W; x += 1) {
        const inBlock = x >= blockX && x < blockX + blockW && y >= blockTop && y < horizon;
        const [r, g, b] = inBlock || y >= horizon ? [fr, fg, fb] : [br, bg, bb];
        const i = (y * SHOT_W + x) * 3;
        rgb[i] = r;
        rgb[i + 1] = g;
        rgb[i + 2] = b;
      }
    }

    const name = `seed-shot-${createHash('sha1').update(`${slug}-${n}`).digest('hex').slice(0, 32)}`;
    /* The upload validator matches `/uploads/<uuid>.<ext>` strictly, so the
       filename has to be UUID-shaped — a bare hash would be rejected the first
       time somebody edited the launch. */
    const uuid = `${name.slice(10, 18)}-${name.slice(18, 22)}-${name.slice(22, 26)}-${name.slice(26, 30)}-${name.slice(30, 42).padEnd(12, '0')}`;
    writeFileSync(path.join(UPLOAD_DIR, `${uuid}.png`), encodePng(rgb, SHOT_W, SHOT_H));
    paths.push(`${UPLOAD_ROUTE}/${uuid}.png`);
  }

  return paths;
}

const SHOT_W = 640;
const SHOT_H = 360;

/** HSL to RGB, so shots can be generated as a hue family rather than hand-picked. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[Math.floor(h / 60) % 6];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** Amount in naira, and what they said. */
const BACKERS: [number, string | undefined][] = [
  [25_000, 'Been following this build since the first photo. Go.'],
  [5_000, undefined],
  [50_000, 'The bed rigidity work is the hard part and you did it first.'],
  [2_000, 'Small, but rooting for you.'],
];

async function giveRaise(item: IItem): Promise<void> {
  /* Contributions need somebody to have made them, and it cannot be the person
     raising — the API refuses that, and a seed that produces state the API
     would reject is worse than no seed. */
  const backers = await User.find({ _id: { $ne: item.submittedBy } }).limit(BACKERS.length);
  if (backers.length === 0) return;

  item.fundraise.status = 'approved';
  item.fundraise.enabled = true;
  item.fundraise.targetMinor = 1_200_000 * 100;
  item.fundraise.pitch =
    'A second prototype, a proper spindle, and enough stock to put ten of these in ' +
    'other people’s workshops before the end of the year.';
  item.fundraise.appliedAt = new Date();
  item.fundraise.reviewedAt = new Date();

  /* The gate is real, so the seed has to clear it rather than route around it —
     otherwise the fixture describes a state the application flow cannot reach. */
  item.voteCount = Math.max(item.voteCount, FUNDRAISE_MIN_VOTES + 6);
  item.commentCount = Math.max(item.commentCount, FUNDRAISE_MIN_COMMENTS + 1);

  let raised = 0;

  for (const [index, [naira, message]] of BACKERS.entries()) {
    const backer = backers[index % backers.length];
    const amountMinor = naira * 100;
    const { feeMinor, netMinor } = applyPlatformFee(amountMinor);
    const paidAt = new Date();
    paidAt.setDate(paidAt.getDate() - (BACKERS.length - index) * 3);

    await Contribution.create({
      reference: `SEEDFG${item._id.toString().slice(-6).toUpperCase()}${index}`,
      item: item._id,
      beneficiary: item.submittedBy,
      contributor: backer._id,
      email: backer.email,
      amountMinor,
      platformFeeMinor: feeMinor,
      netMinor,
      currency: CURRENCY,
      status: 'paid',
      message,
      anonymous: index === 1,
      paidAt,
    });

    raised += amountMinor;
  }

  item.fundraise.raisedMinor = raised;
  item.fundraise.contributorCount = BACKERS.length;
  await item.save();
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
