/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { Game } from '../models/Game';

/**
 * Puts Deck's own game on the shelf.
 *
 * Sky Run is a component in the frontend bundle, but the arcade lists it from
 * the same collection as everything else, so it needs a row. `component` is the
 * key the frontend maps to a component it already has — never a path, and never
 * anything evaluated.
 *
 * Idempotent by slug, and it updates the copy rather than skipping: the write-up
 * is edited far more often than the game is, and a seed that refuses to touch an
 * existing row means every copy change needs a manual database edit.
 */
/** Deck's own games. `component` is a key the frontend maps to a component it
    already ships — never a path, and never anything evaluated. */
const OURS = [
  {
    slug: 'sky-run',
    title: 'Sky Run',
    tagline: 'Fly the bird from the home page. Dodge everything else.',
    genre: 'arcade',
    component: 'sky-run',
    featured: true,
    description:
      'The bird that drifts across the top of Deck, given something to do. Blocks and ' +
      'invaders come at you from the right and the speed compounds — a warm-up for ten ' +
      'seconds, a real game for ten more, then flat out. Sparkles are points and hearts buy ' +
      'you another mistake.\n\n' +
      'Move the pointer to fly, or use the arrow keys. Your best score is kept on your own ' +
      'device — there is no leaderboard and nothing to sign in to.',
  },
  {
    slug: 'snakejo',
    title: 'Snakejo',
    tagline: 'Snake, on a green screen, exactly as you remember it.',
    genre: 'arcade',
    component: 'snakejo',
    featured: false,
    description:
      'Eat, grow, and do not touch the walls or yourself. Every apple makes the snake a ' +
      'little faster, and it never wraps around the edges — the board getting smaller as ' +
      'you get longer is the whole difficulty curve.\n\n' +
      'It is the only thing on Deck that ignores the site palette on purpose. Snake is a ' +
      'specific object people remember, and the memory is dark pixels on a green backlight, ' +
      'so the board brings its own two colours.\n\n' +
      'Arrow keys, WASD, or swipe on a phone.',
  },
  {
    slug: 'block-drop',
    title: 'Block Drop',
    tagline: 'A small robot, a lot of falling scrap, and gravity in a hurry.',
    genre: 'action',
    component: 'block-drop',
    featured: false,
    description:
      'Sky Run turned ninety degrees. You run along the floor while girders, bolts and ' +
      'canisters come down at you, and the fall speed compounds the same way — within half ' +
      'a minute it is coming down faster than you can read it. Some of it drifts sideways ' +
      'as it falls, so standing in one column and stepping out late does not work.\n\n' +
      'Sparkles are points, hearts are another go. Pointer or the arrow keys; taking a key ' +
      'hands control back from the mouse so the two never fight.',
  },
  {
    slug: 'speed-x',
    title: 'Speed X',
    tagline: 'Five lanes, no brakes, and one life.',
    genre: 'action',
    component: 'speed-x',
    featured: false,
    description:
      'A road that keeps getting faster and traffic that does not. Steer between five lanes ' +
      'and overtake — one touch ends the run, because a car that can be hit three times has ' +
      'nothing at stake.\n\n' +
      'Your score is distance, in metres, and nothing else adds to it. There are no pickups ' +
      'and no combo: the only way to a bigger number is to stay on the road longer while the ' +
      'road speeds up.\n\n' +
      'Pointer to steer freely, or the arrow keys to change lane. Waves of traffic always ' +
      'leave a way through — a wall you cannot pass is not difficulty.',
  },
] as const;

/*
 * Slugs that used to exist and no longer should.
 *
 * The upsert above is keyed by slug, so renaming a game inserts the new one and
 * leaves the old row behind — still approved, still on the shelf, now a second
 * copy of the same game under a dead name. Retiring them explicitly is the only
 * way a rename is actually a rename.
 */
const RETIRED = ['xenzia'];

async function run(): Promise<void> {
  await mongoose.connect(env.mongoUri);
  console.log('[db] connected');

  const gone = await Game.deleteMany({ slug: { $in: RETIRED }, kind: 'builtin' });
  if (gone.deletedCount) console.log(`[games] retired ${gone.deletedCount} renamed entr(y/ies)`);

  for (const game of OURS) {
    const result = await Game.findOneAndUpdate(
      { slug: game.slug },
      {
        $set: {
          title: game.title,
          tagline: game.tagline,
          description: game.description,
          genre: game.genre,
          kind: 'builtin',
          component: game.component,
          playUrl: null,
          status: 'approved',
          featured: game.featured,
          embeddable: false,
          author: null,
        },
        /* Only on insert, so re-running never resets the play counter. */
        $setOnInsert: { plays: 0 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log(`[games] "${result.title}" is on the shelf (${result.plays} plays)`);
  }

  await mongoose.disconnect();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
