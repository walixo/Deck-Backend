import { z } from 'zod';
import { env } from '../config/env';
import { GAME_GENRES, GAME_ORIENTATIONS } from '../models/Game';
import { imageField, urlField } from './fields';

/**
 * Where a game may never be served from.
 *
 * The player gives a reviewed game its own origin inside the frame
 * (`allow-same-origin`) so it can keep saves in its own storage. That is safe
 * only while the game's origin is *not* Deck's — a frame that shares the
 * page's origin can reach up and remove its own sandbox.
 *
 * So two rules. Deck's public domain and every subdomain of it are refused
 * outright, since nobody outside Deck should be serving from there. And the
 * exact origins Deck runs on — whatever CLIENT_ORIGIN and PUBLIC_API_URL say —
 * are refused too. Exact origin, not hostname: in development Deck runs on
 * `localhost:3000`, and a developer's own build on `localhost:5174` is a
 * different origin and perfectly safe to frame.
 */
const DECK_DOMAIN = 'onedeck.africa';

function deckOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const origin of [...env.clientOrigins, env.publicApiUrl]) {
    try {
      if (origin) origins.add(new URL(origin).origin);
    } catch {
      /* A malformed origin in config is not this validator's problem. */
    }
  }
  return origins;
}

function isDeckHost(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hostname === DECK_DOMAIN || url.hostname.endsWith(`.${DECK_DOMAIN}`)) return true;
    return deckOrigins().has(url.origin);
  } catch {
    return false;
  }
}

/**
 * A game's public address: https, and not on Deck.
 *
 * https because Deck is served over https, so an http game would be blocked as
 * mixed content and the play button would do nothing.
 */
export const playUrlField = urlField
  .refine((value) => value.startsWith('https://'), 'The game has to be served over https')
  .refine((value) => !isDeckHost(value), 'Games are hosted on your own domain, not on Deck');

/**
 * Where a developer's test build is. https anywhere, or plain http on their
 * own machine — browsers count `localhost` as secure, so Deck's player can
 * frame a local dev server.
 */
export const testUrlField = urlField
  .refine(
    (value) =>
      value.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value),
    'Use https, or http://localhost for a build on your own machine',
  )
  .refine((value) => !isDeckHost(value), 'Test builds cannot be hosted on Deck either');

/**
 * What somebody may submit to the arcade.
 *
 * Notably absent: `kind`, `component`, `embeddable`, `featured` and `status`.
 * Every one of those is a decision Deck makes, not the submitter — accepting
 * `embeddable` from the client would let anyone put their own JavaScript inside
 * a Deck-chromed frame, and accepting `status` would let them approve
 * themselves. They are not "ignored if sent"; they are not in the schema, so
 * `.strict()` rejects the whole request if they appear, which surfaces the
 * attempt instead of silently dropping it.
 */
export const submitGameSchema = z
  .object({
    title: z.string().trim().min(2, 'Give the game a name').max(80),
    tagline: z
      .string()
      .trim()
      .min(10, 'One line on what it is')
      .max(140, 'Keep the tagline to a line'),
    description: z
      .string()
      .trim()
      .min(40, 'Tell people how it plays — a few sentences at least')
      .max(4000),
    genre: z.enum(GAME_GENRES),
    coverUrl: imageField.or(z.literal('')).optional(),
    /*
     * https only.
     *
     * Deck is served over https, so an http game would be blocked as mixed
     * content and the play button would do nothing — better to refuse it at
     * submission with a reason than to approve a listing that cannot work.
     */
    playUrl: playUrlField,
    orientation: z.enum(GAME_ORIENTATIONS).default('landscape'),
    /* Whether it talks to Deck through the SDK. Not a trust decision — it only
       decides whether the player offers the bridge. */
    sdk: z.boolean().default(false),
    studio: z.string().trim().max(60).optional(),
  })
  .strict();

/* No defaults on an edit: a field left out must stay as it is, not reset. */
export const updateGameSchema = submitGameSchema
  .extend({
    orientation: z.enum(GAME_ORIENTATIONS),
    sdk: z.boolean(),
  })
  .partial();

/** Staff's verdict. The note is required on a rejection and pointless otherwise. */
export const reviewGameSchema = z
  .object({
    status: z.enum(['approved', 'rejected']),
    reviewNote: z.string().trim().max(600).optional(),
    /* Both staff-only, and both deliberately separate from approval: a game can
       be good enough to list without being trusted enough to frame. */
    embeddable: z.boolean().optional(),
    featured: z.boolean().optional(),
  })
  .refine((input) => input.status !== 'rejected' || Boolean(input.reviewNote?.trim()), {
    message: 'Say why, so they can fix it and come back',
    path: ['reviewNote'],
  });

export const listGamesSchema = z.object({
  genre: z.enum(GAME_GENRES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

export type SubmitGameInput = z.infer<typeof submitGameSchema>;
export type UpdateGameInput = z.infer<typeof updateGameSchema>;
export type ReviewGameInput = z.infer<typeof reviewGameSchema>;
export type ListGamesQuery = z.infer<typeof listGamesSchema>;
