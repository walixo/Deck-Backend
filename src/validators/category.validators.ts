import { z } from 'zod';
import { CATEGORY_ICONS } from '../constants';

const ICON_KEYS = Object.keys(CATEGORY_ICONS) as [string, ...string[]];

export const createCategorySchema = z.object({
  label: z.string().trim().min(2, 'Give the category a name').max(40),
  /* Optional: derived from the label when absent, which is the usual path. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(40)
    .regex(/^[a-z0-9-]*$/, 'Slugs use lowercase letters, numbers and hyphens')
    .optional(),
  icon: z.enum(ICON_KEYS, { message: 'Pick an icon from the set' }),
  blurb: z.string().trim().max(160).optional(),
  order: z.coerce.number().int().min(0).max(999).default(100),
});

/**
 * The slug is absent here on purpose — it is the key every launch stores and
 * every filter URL carries, so it cannot be edited. See updateCategory.
 */
export const updateCategorySchema = z.object({
  label: z.string().trim().min(2).max(40).optional(),
  icon: z.enum(ICON_KEYS).optional(),
  blurb: z.string().trim().max(160).optional(),
  order: z.coerce.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

export type CategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
