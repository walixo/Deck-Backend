import { z } from 'zod';

export const createCommentSchema = z.object({
  body: z
    .string()
    .trim()
    .min(2, 'Write at least a couple of words')
    .max(2000, 'Keep it under 2000 characters'),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  parent: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Invalid parent comment')
    .optional(),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
