import { z } from 'zod';
import { CATEGORIES, PRICING_MODELS, SORT_OPTIONS } from '../constants';

const urlField = z.string().trim().url('Please enter a full URL, including https://');

/**
 * Image fields accept either an absolute URL or a path handed back by
 * `POST /api/uploads`. The `/uploads/<uuid>.<ext>` shape is matched strictly —
 * a loose "starts with /" check would let a client store an arbitrary path.
 */
const uploadedPath = z
  .string()
  .trim()
  .regex(
    /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|gif|webp|avif)$/,
    'Images must be uploaded through Deck or given as a full URL',
  );

const imageField = uploadedPath.or(urlField);

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
  category: z.enum(CATEGORIES),
  pricing: z.enum(PRICING_MODELS).default('free'),
  websiteUrl: urlField,
  repoUrl: urlField.or(z.literal('')).optional(),
  logoUrl: imageField.or(z.literal('')).optional(),
  coverUrl: imageField.or(z.literal('')).optional(),
  gallery: z.array(imageField).max(6).default([]),
  tags: z.array(z.string().trim().toLowerCase().min(2).max(24)).max(6).default([]),
  makers: z.array(z.string().trim().min(2).max(60)).max(8).default([]),
  launchDate: z.coerce.date().optional(),
});

export const updateItemSchema = createItemSchema.partial();

export const listItemsSchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  sort: z.enum(SORT_OPTIONS).default('trending'),
  search: z.string().trim().max(80).optional(),
  pricing: z.enum(PRICING_MODELS).optional(),
  tag: z.string().trim().toLowerCase().max(24).optional(),
  featured: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ListItemsQuery = z.infer<typeof listItemsSchema>;
