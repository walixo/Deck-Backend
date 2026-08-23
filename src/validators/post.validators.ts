import { z } from 'zod';

const imageField = z
  .string()
  .trim()
  .regex(
    /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|gif|webp|avif)$/,
    'Images must be uploaded through Deck',
  )
  .or(z.string().trim().url());

export const createPostSchema = z.object({
  title: z.string().trim().min(4, 'Give the post a title').max(120),
  excerpt: z
    .string()
    .trim()
    .min(20, 'Write a line or two that makes someone want to read it')
    .max(240),
  body: z.string().trim().min(120, 'A post needs more than a paragraph').max(40_000),
  coverUrl: imageField.or(z.literal('')).optional(),
  tags: z.array(z.string().trim().toLowerCase().min(2).max(24)).max(6).default([]),
  status: z.enum(['draft', 'published']).default('draft'),
  /* Optional and allowed to be in the future — a post can be written now and
     go live on Monday. The feed compares it against the clock. */
  publishedAt: z.coerce.date().optional(),
});

export const updatePostSchema = createPostSchema.partial();

export const listPostsSchema = z.object({
  tag: z.string().trim().toLowerCase().max(24).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(24).default(9),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export type ListPostsQuery = z.infer<typeof listPostsSchema>;
