import { z } from 'zod';
import { env } from '../config/env';
import { GAME_ORIENTATIONS, MULTIPLAYER_MAX, MULTIPLAYER_MIN } from '../models/Game';
import { PRODUCT_TYPES } from '../models/GameProduct';
import { testUrlField } from './game.validators';
import { urlField } from './fields';

/**
 * Inputs to the Deck Games platform: the player's bridge calls and the
 * developer's settings.
 *
 * Amounts arrive in major units (naira) and are converted once, in the
 * controller, the same as every other form on Deck. Product prices are never
 * accepted from a player — only from the developer, here.
 */

const mode = z.enum(['test', 'live']);

export const sessionSchema = z
  .object({
    mode: mode.optional(),
    /* A sandbox seat (test mode, developer only) — see services/rooms. */
    seat: z.number().int().min(0).max(15).optional(),
  })
  .strict();

export const purchaseSchema = z
  .object({
    productId: z.string().trim().toLowerCase().min(2).max(48),
    mode: mode.optional(),
  })
  .strict();

export const modeQuerySchema = z.object({ mode: mode.optional() });

export const developerSettingsSchema = z
  .object({
    orientation: z.enum(GAME_ORIENTATIONS),
    sdk: z.boolean(),
    studio: z.string().trim().max(60),
    testUrl: testUrlField.nullable(),
    /* https and public, checked again (with DNS) in the controller. */
    webhookUrl: urlField
      .refine(
        (value) => value.startsWith('https://') || env.allowPrivateWebhooks,
        'Webhook URLs must use https',
      )
      .nullable(),
    multiplayer: z
      .object({
        enabled: z.boolean(),
        minPlayers: z.number().int().min(MULTIPLAYER_MIN).max(MULTIPLAYER_MAX),
        maxPlayers: z.number().int().min(MULTIPLAYER_MIN).max(MULTIPLAYER_MAX),
      })
      .strict()
      .refine((m) => m.minPlayers <= m.maxPlayers, 'The minimum cannot be more than the maximum'),
  })
  .partial()
  .strict();

export const mintKeySchema = z.object({ mode }).strict();

/** Lowercase, digits and `._-` — the string a developer's code already uses. */
const productIdField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9._-]{1,47}$/,
    'Use 2–48 lowercase letters, digits, dots, dashes or underscores',
  );

/** ₦100 floor: below that, payment fees eat the developer's share. */
const priceField = z.coerce
  .number()
  .min(100, 'The lowest price is ₦100')
  .max(500_000, 'The highest price is ₦500,000');

export const createProductSchema = z
  .object({
    productId: productIdField,
    name: z.string().trim().min(2, 'Name it').max(60),
    description: z.string().trim().max(240).optional(),
    price: priceField,
    type: z.enum(PRODUCT_TYPES).default('one_off'),
  })
  .strict();

export const updateProductSchema = z
  .object({
    /* Renames it — allowed only until its first live sale (see updateProduct). */
    productId: productIdField,
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(240),
    price: priceField,
    type: z.enum(PRODUCT_TYPES),
    active: z.boolean(),
  })
  .partial()
  .strict();

export const salesQuerySchema = z.object({
  mode: mode.default('live'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/* ------------------------------------------------- server API (v1) --- */

export const verifySessionSchema = z.object({ token: z.string().trim().min(10).max(200) }).strict();

export const playerPurchasesQuerySchema = z.object({
  status: z.enum(['pending', 'paid', 'failed']).optional(),
  undelivered: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

export type SessionInput = z.infer<typeof sessionSchema>;
export type PurchaseInput = z.infer<typeof purchaseSchema>;
export type DeveloperSettingsInput = z.infer<typeof developerSettingsSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type SalesQuery = z.infer<typeof salesQuerySchema>;
export type PlayerPurchasesQuery = z.infer<typeof playerPurchasesQuerySchema>;
