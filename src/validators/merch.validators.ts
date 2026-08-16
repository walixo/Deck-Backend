import { z } from 'zod';
import {
  MAX_LINES_PER_ORDER,
  MAX_QUANTITY_PER_LINE,
  MERCH_CATEGORIES,
  MERCH_SORT_OPTIONS,
} from '../constants';

const imageField = z
  .string()
  .trim()
  .regex(
    /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|gif|webp|avif)$/,
    'Images must be uploaded through Deck or given as a full URL',
  )
  .or(z.string().trim().url('Please enter a full URL, including https://'));

const variantSchema = z.object({
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .min(3, 'A SKU needs at least 3 characters')
    .max(32)
    .regex(/^[A-Z0-9-]+$/, 'SKUs use letters, numbers and hyphens only'),
  size: z.string().trim().max(16).optional(),
  colour: z.string().trim().max(24).optional(),
  stock: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const createMerchSchema = z.object({
  name: z.string().trim().min(2, 'Give the product a name').max(80),
  tagline: z.string().trim().min(6, 'Add a short tagline').max(140),
  description: z.string().trim().min(20, 'Describe the product').max(4000),
  category: z.enum(MERCH_CATEGORIES),
  // Priced in whole currency units at the edge, stored as minor units inside.
  // Generous ceiling: the unit is whole currency units, so NGN figures are large.
  price: z.coerce
    .number()
    .min(0, 'Price cannot be negative')
    .max(10_000_000, 'That price looks wrong'),
  images: z.array(imageField).max(6).default([]),
  variants: z.array(variantSchema).min(1, 'Add at least one variant').max(24),
  /* Staff-only in practice — the controller ignores it from anyone else. */
  featured: z.boolean().default(false),
  active: z.boolean().default(true),
});

export const updateMerchSchema = createMerchSchema.partial();

export const listMerchSchema = z.object({
  category: z.enum(MERCH_CATEGORIES).optional(),
  sort: z.enum(MERCH_SORT_OPTIONS).default('featured'),
  search: z.string().trim().max(80).optional(),
  /** Filter to one maker's shelf. */
  seller: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{24}$/i, 'That is not a valid seller')
    .optional(),
  /** 'deck' for Deck's own goods, 'makers' for everything the community lists. */
  source: z.enum(['all', 'deck', 'makers']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
});

export const rejectMerchSchema = z.object({
  reason: z.string().trim().min(4, 'Tell them why').max(400),
});

/**
 * The checkout payload carries SKUs and quantities only — deliberately no
 * prices. Totals are recomputed from the database, so a tampered cart cannot
 * buy a hoodie for a penny.
 */
export const createOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().trim().toUpperCase().min(3).max(32),
        quantity: z.coerce.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
      }),
    )
    .min(1, 'Your cart is empty')
    .max(MAX_LINES_PER_ORDER),
  email: z.string().trim().toLowerCase().email('That email does not look right'),
  shippingAddress: z.object({
    fullName: z.string().trim().min(2, 'Who is this going to?').max(80),
    line1: z.string().trim().min(3, 'Add a street address').max(120),
    line2: z.string().trim().max(120).optional().or(z.literal('')),
    city: z.string().trim().min(2, 'Add a city').max(80),
    postcode: z.string().trim().min(2, 'Add a postcode').max(20),
    country: z.string().trim().min(2, 'Add a country').max(60),
  }),
});

export type CreateMerchInput = z.infer<typeof createMerchSchema>;
export type UpdateMerchInput = z.infer<typeof updateMerchSchema>;
export type ListMerchQuery = z.infer<typeof listMerchSchema>;
export type RejectMerchInput = z.infer<typeof rejectMerchSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
