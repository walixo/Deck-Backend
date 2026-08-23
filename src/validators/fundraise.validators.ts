import { z } from 'zod';
import { MAX_CONTRIBUTION_MINOR, MIN_CONTRIBUTION_MINOR } from '../constants';

/**
 * Turning a raise on requires a target; turning it off does not.
 *
 * The target is a goal, not a condition — Deck is keep-what-you-raise, so
 * missing it costs the launcher nothing. It exists so the progress bar has
 * something to measure against.
 */
/**
 * The application form.
 *
 * Four questions, all required. A fundraise puts Deck's name behind somebody
 * asking strangers for money, so a reviewer needs enough to make a decision —
 * an application that can be submitted blank is a queue of blanks.
 */
export const applyFundraiseSchema = z.object({
  purpose: z.string().trim().min(40, 'Tell us what the money is for').max(600),
  useOfFunds: z.string().trim().min(40, 'Break down roughly how it will be spent').max(600),
  timeline: z.string().trim().min(4, 'Roughly when will it be spent?').max(200),
  contact: z.string().trim().min(4, 'How can we reach you about this?').max(160),
  target: z.coerce.number().min(1, 'Set a target').max(10_000_000, 'That target looks wrong'),
});

/** Staff decision. A note is required on rejection so the maker learns why. */
export const reviewFundraiseSchema = z
  .object({
    approve: z.boolean(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((value) => value.approve || (value.note?.length ?? 0) >= 4, {
    message: 'Say why it was turned down',
    path: ['note'],
  });

/**
 * The launcher's remaining controls, once approved.
 *
 * `enabled` is gone: whether a raise exists is Deck's decision, not the
 * maker's. What is left is pausing one they already have, and editing the
 * pitch and target — which is why this no longer needs a refine on `enabled`.
 */
export const updateFundraiseSchema = z
  .object({
    /* Whole currency units at the edge, minor units inside — same as prices. */
    target: z.coerce.number().min(0).max(10_000_000, 'That target looks wrong').optional(),
    pitch: z.string().trim().max(600).optional().or(z.literal('')),
    closed: z.boolean().optional(),
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
export type ApplyFundraiseInput = z.infer<typeof applyFundraiseSchema>;
export type ReviewFundraiseInput = z.infer<typeof reviewFundraiseSchema>;
export type CreateContributionInput = z.infer<typeof createContributionSchema>;
