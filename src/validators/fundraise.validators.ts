import { z } from 'zod';
import { MAX_CONTRIBUTION_MINOR, MIN_CONTRIBUTION_MINOR } from '../constants';

/**
 * Turning a raise on requires a target; turning it off does not.
 *
 * The target is a goal, not a condition — Deck is keep-what-you-raise, so
 * missing it costs the launcher nothing. It exists so the progress bar has
 * something to measure against.
 */
export const updateFundraiseSchema = z
  .object({
    enabled: z.boolean(),
    /* Whole currency units at the edge, minor units inside — same as prices. */
    target: z.coerce.number().min(0).max(10_000_000, 'That target looks wrong').optional(),
    pitch: z.string().trim().max(600).optional().or(z.literal('')),
    closed: z.boolean().optional(),
  })
  .refine((value) => !value.enabled || (value.target ?? 0) > 0, {
    message: 'Set a target you are raising towards',
    path: ['target'],
  });

const minWhole = Math.floor(MIN_CONTRIBUTION_MINOR / 100);
const maxWhole = Math.floor(MAX_CONTRIBUTION_MINOR / 100);

export const createContributionSchema = z.object({
  amount: z.coerce
    .number()
    .min(minWhole, `The smallest contribution is ${minWhole.toLocaleString()}`)
    .max(maxWhole, 'That is more than we can take in one go'),
  message: z.string().trim().max(280).optional().or(z.literal('')),
  anonymous: z.boolean().default(false),
});

export type UpdateFundraiseInput = z.infer<typeof updateFundraiseSchema>;
export type CreateContributionInput = z.infer<typeof createContributionSchema>;
