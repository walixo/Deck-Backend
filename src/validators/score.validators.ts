import { z } from 'zod';
import { MAX_SCORE } from '../models/Score';

/**
 * A submitted score.
 *
 * Integer only — the games all floor before submitting, and a float here would
 * mean two players on "1200" sorting by a decimal nobody can see.
 */
export const submitScoreSchema = z.object({
  score: z
    .number()
    .int('Scores are whole numbers')
    .min(0, 'A score cannot be negative')
    .max(MAX_SCORE, 'That is not a real score'),
});

export type SubmitScoreInput = z.infer<typeof submitScoreSchema>;
