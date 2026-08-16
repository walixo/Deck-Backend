import { z } from 'zod';
import { AD_DURATIONS, AD_PLACEMENTS } from '../constants';

const imageField = z
  .string()
  .trim()
  .regex(
    /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|gif|webp|avif)$/,
    'Images must be uploaded through Deck or given as a full URL',
  )
  .or(z.string().trim().url('Please enter a full URL, including https://'));

/**
 * What an advertiser sends.
 *
 * No price, and no target URL. The price comes from the rate card on the
 * server; the link goes to the launch being promoted. Letting an advertiser
 * name their own destination would turn a paid slot into an open redirect that
 * Deck vouches for — the one thing a trusted placement must never be.
 */
export const createAdSchema = z.object({
  itemSlug: z.string().trim().min(1, 'Which launch is this for?').max(90),
  placement: z.enum(AD_PLACEMENTS),
  days: z.coerce
    .number()
    .int()
    .refine((value) => (AD_DURATIONS as readonly number[]).includes(value), {
      message: `Choose a run of ${AD_DURATIONS.join(', ')} days`,
    }),
  /** Defaults to as soon as it is paid for; a date lets them line up a launch. */
  startAt: z.string().datetime().optional(),

  headline: z.string().trim().min(4, 'Give the ad a headline').max(60),
  body: z.string().trim().min(10, 'Add a line about it').max(140),
  imageUrl: imageField.optional().or(z.literal('')),
  ctaLabel: z.string().trim().min(2).max(24).default('Take a look'),
});

export const rejectAdSchema = z.object({
  reason: z.string().trim().min(4, 'Tell them why').max(400),
});

export type CreateAdInput = z.infer<typeof createAdSchema>;
export type RejectAdInput = z.infer<typeof rejectAdSchema>;
