import { z } from 'zod';
import { TOPIC_SECTIONS } from '../models/Topic';

/**
 * Minimums with a reason behind each number.
 *
 * A title under 8 characters ("help", "bug?") tells nobody anything and is the
 * single biggest predictor of a thread nobody answers. A body under 20 is
 * usually the title again. Neither is a quality bar — plenty of terrible posts
 * clear both — they just stop the ones that are certainly not questions yet.
 */
export const createTopicSchema = z.object({
  title: z
    .string()
    .trim()
    .min(8, 'Give it a title people can answer — at least 8 characters')
    .max(140, 'Keep the title under 140 characters'),
  body: z
    .string()
    .trim()
    .min(20, 'Say a bit more — at least 20 characters')
    .max(8000),
  section: z.enum(TOPIC_SECTIONS),
});

export const updateTopicSchema = createTopicSchema.partial();

export const createReplySchema = z.object({
  body: z.string().trim().min(2, 'Say something').max(8000),
});

/**
 * Pinning and locking, with a required note.
 *
 * Both change what other people are allowed to do with a thread, so both are
 * audited, and an audit entry that only says a flag flipped explains nothing a
 * month later.
 */
export const moderateTopicSchema = z
  .object({
    pinned: z.boolean().optional(),
    locked: z.boolean().optional(),
    note: z.string().trim().min(4, 'Say why').max(200),
  })
  .refine((value) => value.pinned !== undefined || value.locked !== undefined, {
    message: 'Nothing to change',
  });

export const listTopicsSchema = z.object({
  section: z.enum(TOPIC_SECTIONS).optional(),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CreateTopicInput = z.infer<typeof createTopicSchema>;
export type UpdateTopicInput = z.infer<typeof updateTopicSchema>;
export type CreateReplyInput = z.infer<typeof createReplySchema>;
export type ModerateTopicInput = z.infer<typeof moderateTopicSchema>;
export type ListTopicsQuery = z.infer<typeof listTopicsSchema>;
