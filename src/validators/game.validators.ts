import { z } from 'zod';
import { GAME_GENRES } from '../models/Game';
import { imageField, urlField } from './fields';

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
    playUrl: urlField.refine(
      (value) => value.startsWith('https://'),
      'The game has to be served over https',
    ),
  })
  .strict();

export const updateGameSchema = submitGameSchema.partial();

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
  .refine(
    (input) => input.status !== 'rejected' || Boolean(input.reviewNote?.trim()),
    { message: 'Say why, so they can fix it and come back', path: ['reviewNote'] },
  );

export const listGamesSchema = z.object({
  genre: z.enum(GAME_GENRES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

export type SubmitGameInput = z.infer<typeof submitGameSchema>;
export type UpdateGameInput = z.infer<typeof updateGameSchema>;
export type ReviewGameInput = z.infer<typeof reviewGameSchema>;
export type ListGamesQuery = z.infer<typeof listGamesSchema>;
