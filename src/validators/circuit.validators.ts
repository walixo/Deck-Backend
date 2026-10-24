import { z } from 'zod';

/** Inputs to Deck Circuit's attempt endpoints. */

export const movesSchema = z
  .object({
    moves: z
      .string()
      .trim()
      .regex(/^[NESWnesw]{1,32}$/, 'Send 1–32 moves, each one of N, E, S or W')
      .transform((m) => m.toUpperCase()),
  })
  .strict();

export const submitSchema = z
  .object({ answer: z.unknown().refine((a) => a !== undefined, 'Send an answer') })
  .strict();

export type MovesInput = z.infer<typeof movesSchema>;
export type SubmitInput = z.infer<typeof submitSchema>;
