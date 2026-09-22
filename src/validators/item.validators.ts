import { z } from 'zod';
import { imageField, urlField } from './fields';
import { PRICING_MODELS, SORT_OPTIONS } from '../constants';

/* Shared with the profile validator — see validators/fields. */

export const createItemSchema = z.object({
  name: z.string().trim().min(2, 'Give your launch a name').max(70),
  tagline: z
    .string()
    .trim()
    .min(10, 'A tagline needs at least 10 characters')
    .max(120, 'Keep the tagline under 120 characters'),
  description: z
    .string()
    .trim()
    .min(40, 'Tell people a bit more — at least 40 characters')
    .max(4000),
  /* Shape only — whether this slug exists is checked against the Category
     collection in the controller, because Zod runs before any database call. */
  category: z.string().trim().toLowerCase().min(2).max(40),
  pricing: z.enum(PRICING_MODELS).default('free'),
  websiteUrl: urlField,
  repoUrl: urlField.or(z.literal('')).optional(),
  logoUrl: imageField.or(z.literal('')).optional(),
  coverUrl: imageField.or(z.literal('')).optional(),
  /* The wall panel's colour. Empty string is a real value here — it means
     "go back to sampling my logo" — so it has to survive validation rather
     than be rejected as a malformed hex. */
  wallColour: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Pick a colour as a six-digit hex, like #b8a9fa')
    .or(z.literal(''))
    .optional(),
  /* Only YouTube and Vimeo. An arbitrary URL in an iframe is somebody else's
     page rendered inside Deck's origin, which is not a feature. */
  videoUrl: urlField
    .refine(
      (value) => /^https:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//.test(value),
      'Video links must be YouTube or Vimeo',
    )
    .or(z.literal(''))
    .optional(),
  gallery: z.array(imageField).max(6).default([]),
  tags: z.array(z.string().trim().toLowerCase().min(2).max(24)).max(6).default([]),
  makers: z.array(z.string().trim().min(2).max(60)).max(8).default([]),
  launchDate: z.coerce.date().optional(),
});

/**
 * Editing a launch cannot move it between boards.
 *
 * `launchDate` decides `launchDateKey`, which is what the daily board groups on
 * and what the board-finish badges aggregate over. Left editable, a maker could
 * PATCH a launch that had already collected votes onto a different day — taking
 * its votes with it, rewriting who topped that board, and leaving no record
 * anywhere, because `updateItem` only audits admins editing other people's
 * launches.
 *
 * Rescheduling is a real need, so it still exists — as `PATCH
 * /api/admin/items/:id/schedule`, which is staff-only and writes an audit entry.
 */
export const updateItemSchema = createItemSchema
  .omit({ launchDate: true })
  .partial()
  .extend({
    /* Attached to the revision this edit creates, not to the launch. Optional:
       most edits are self-evident from the diff, and forcing a message on a
       typo fix would only teach people to type "." */
    note: z.string().trim().max(200).optional(),
  });

/**
 * Shipping a new version of an existing product.
 *
 * Takes a whole launch body rather than a patch, because that is what it
 * creates: a new launch, on today's board, starting from zero votes. The client
 * prefills the form from the current version, but every field is genuinely open
 * — including name and category, which ordinary edits freeze once votes exist.
 * Changing what the product *is* is precisely what a release is for.
 */
export const releaseItemSchema = createItemSchema.omit({ launchDate: true }).extend({
  version: z
    .string()
    .trim()
    .min(1, 'Give this version a label, like 2.0')
    .max(24, 'Keep the version label short'),
  /** Optional "what is new" line, shown on the version strip. */
  changelog: z.string().trim().max(400).optional(),
});

/** Admin-only reschedule. Separate from the edit body so it cannot arrive by accident. */
export const rescheduleItemSchema = z.object({
  launchDate: z.coerce.date(),
  reason: z.string().trim().min(4, 'Say why this is being moved').max(200),
});

/**
 * Putting a launch on Future Gen, or taking it off.
 *
 * A note is required in both directions. Future Gen entries can run fundraises
 * aimed at people who are backing the showcase as much as the product, so both
 * "we let this in" and "we took this down" are decisions somebody may have to
 * account for later — and an audit entry that only says a flag flipped explains
 * nothing.
 */
export const setFutureGenSchema = z.object({
  futureGen: z.boolean(),
  note: z.string().trim().min(4, 'Say why').max(200),
});

export const listItemsSchema = z.object({
  category: z.string().trim().toLowerCase().min(2).max(40).optional(),
  sort: z.enum(SORT_OPTIONS).default('trending'),
  search: z.string().trim().max(80).optional(),
  pricing: z.enum(PRICING_MODELS).optional(),
  tag: z.string().trim().toLowerCase().max(24).optional(),
  featured: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /* The Future Gen showcase reads the same endpoint with this set. */
  futureGen: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /*
   * A board day, a month, or a year — matched as a prefix of `launchDateKey`.
   *
   * One parameter rather than three because the archive rail cascades through
   * exactly those levels, and `2026`, `2026-08` and `2026-08-15` are the same
   * question asked at three depths. Anchored and length-checked so it can only
   * ever be a prefix, never a pattern.
   */
  on: z
    .string()
    .trim()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'Dates look like 2026, 2026-08 or 2026-08-15')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type RescheduleItemInput = z.infer<typeof rescheduleItemSchema>;
export type SetFutureGenInput = z.infer<typeof setFutureGenSchema>;
export type ReleaseItemInput = z.infer<typeof releaseItemSchema>;
export type ListItemsQuery = z.infer<typeof listItemsSchema>;

/**
 * A maker updating what their product earns.
 *
 * Separate from `updateItemSchema` because it is a different kind of change,
 * governed by a different rule: the pitch freezes when the edit window shuts,
 * and a monthly figure that could never be updated after four hours would be
 * wrong for the rest of the launch's life.
 *
 * `disclosed: false` clears the figure entirely — publishing a number has to
 * be reversible, or nobody sensible publishes one.
 */
export const updateRevenueSchema = z
  .object({
    disclosed: z.boolean(),
    /* Whole units in, minor units stored — the client sends 2500, not 250000.
       Capped at a hundred million a month, which is not a real ceiling so much
       as a typo catcher. */
    monthly: z.coerce.number().min(0).max(100_000_000).optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like USD')
      .optional(),
    /* A claim the maker makes, not a sum Deck does. See the model. */
    profitable: z.boolean().optional(),
  })
  .refine((value) => !value.disclosed || value.monthly !== undefined, {
    message: 'Give a monthly figure, or zero if the product is pre-revenue',
    path: ['monthly'],
  });

export type UpdateRevenueInput = z.infer<typeof updateRevenueSchema>;
