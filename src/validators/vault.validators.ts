import { z } from 'zod';
import { DENOMINATION_TYPES, FULFILMENT_MODES, PRODUCT_STATUSES } from '../models/VaultIssuer';
import { imageField, urlField } from './fields';

/**
 * Inputs to Vault.
 *
 * Amounts arrive in **major units** (naira) from Deck's own forms and are
 * converted once in the controller, like every other form on Deck. The partner
 * API is the deliberate exception: it takes minor units, because an integer
 * number of kobo is unambiguous across every client language and a decimal
 * naira amount is exactly the kind of thing that arrives as 9.999999 from
 * somebody's float.
 */

const httpsUrl = urlField.refine((value) => /^https:\/\//i.test(value), {
  message: 'That URL must be https',
});

/* ------------------------------------------------------------------ issuer */

export const createIssuerSchema = z
  .object({
    name: z.string().trim().min(2, 'Give your card programme a name').max(80),
    tagline: z.string().trim().max(140).optional(),
    description: z.string().trim().max(4000).optional(),
    logoUrl: imageField.or(z.literal('')).optional(),
    terms: z.string().trim().max(4000).optional(),
    supportEmail: z.string().trim().toLowerCase().email('That email does not look right').or(z.literal('')).optional(),
    website: urlField.or(z.literal('')).optional(),
    discountPercent: z.number().min(0).max(90).optional(),
    defaultExpiryDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict();

export const updateIssuerSchema = createIssuerSchema
  .extend({
    fulfilment: z.enum(FULFILMENT_MODES).optional(),
    fulfilUrl: httpsUrl.or(z.literal('')).optional(),
  })
  .partial()
  .strict();

/* ----------------------------------------------------------------- product */

export const createProductSchema = z
  .object({
    name: z.string().trim().min(2, 'Give this card a name').max(80),
    artworkUrl: imageField.or(z.literal('')).optional(),
    redeemInstructions: z.string().trim().max(2000).optional(),
    denominationType: z.enum(DENOMINATION_TYPES).default('fixed'),
    /* Major units in, minor units stored — the controller does the one
       conversion. Capped so a typo cannot create a ₦10bn card. */
    denominations: z.array(z.number().positive().max(10_000_000)).max(12).default([]),
    min: z.number().positive().max(10_000_000).optional(),
    max: z.number().positive().max(10_000_000).optional(),
    discountPercent: z.number().min(0).max(90).nullable().optional(),
    expiryDays: z.number().int().min(0).max(3650).nullable().optional(),
    status: z.enum(PRODUCT_STATUSES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.denominationType === 'fixed' && value.denominations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['denominations'],
        message: 'Add at least one amount people can buy',
      });
    }
    if (value.denominationType === 'range') {
      if (!value.min || !value.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['min'],
          message: 'A range card needs a smallest and a largest amount',
        });
      } else if (value.min > value.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['min'],
          message: 'The smallest amount cannot be above the largest',
        });
      }
    }
  });

export const updateProductSchema = createProductSchema;

/* ----------------------------------------------------------------- partner */

export const createPartnerSchema = z
  .object({
    name: z.string().trim().min(2, 'What is your business called?').max(80),
    website: urlField.or(z.literal('')).optional(),
    logoUrl: imageField.or(z.literal('')).optional(),
  })
  .strict();

export const updatePartnerSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    website: urlField.or(z.literal('')).optional(),
    logoUrl: imageField.or(z.literal('')).optional(),
    webhookUrl: httpsUrl.or(z.literal('')).optional(),
  })
  .strict();

export const mintKeySchema = z.object({ mode: z.enum(['test', 'live']) }).strict();

/* ------------------------------------------------------------- partner API */

/**
 * An order placed over the API.
 *
 * `amountMinor` rather than a decimal, and an explicit quantity cap: a partner
 * typo of 100000 instead of 1000 would otherwise mint a hundred thousand
 * bearer instruments before anyone noticed.
 */
export const apiOrderSchema = z
  .object({
    product: z.string().trim().min(1, 'Which card are you buying?'),
    amountMinor: z.number().int().positive('The amount must be a positive whole number'),
    quantity: z.number().int().min(1).max(500).default(1),
    recipientName: z.string().trim().max(80).optional(),
    recipientEmail: z.string().trim().toLowerCase().email().or(z.literal('')).optional(),
    giftMessage: z.string().trim().max(500).optional(),
  })
  .strict();

export const apiRedeemSchema = z
  .object({
    code: z.string().trim().min(4, 'Enter the card code'),
    pin: z.string().trim().max(12).optional(),
    /* Omitted means "spend whatever is left", which is what a till does when
       the card covers the bill. */
    amountMinor: z.number().int().positive().optional(),
  })
  .strict();

export const apiBalanceSchema = z
  .object({
    code: z.string().trim().min(4, 'Enter the card code'),
    pin: z.string().trim().max(12).optional(),
  })
  .strict();

/* ---------------------------------------------------------------- consumer */

export const buyCardSchema = z
  .object({
    product: z.string().trim().min(1),
    /** Major units: this one comes from Deck's own storefront form. */
    amount: z.number().positive().max(10_000_000),
    recipientName: z.string().trim().max(80).optional(),
    recipientEmail: z.string().trim().toLowerCase().email('Where should we send it?').or(z.literal('')).optional(),
    giftMessage: z.string().trim().max(500).optional(),
  })
  .strict();

/* --------------------------------------------------------------- dashboard */

export const consoleRedeemSchema = z
  .object({
    code: z.string().trim().min(4, 'Enter the card code'),
    pin: z.string().trim().max(12).optional(),
    amount: z.number().positive().optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export const topupSchema = z
  .object({
    mode: z.enum(['test', 'live']),
    amount: z.number().positive().max(100_000_000),
  })
  .strict();

export const reviewIssuerSchema = z
  .object({
    status: z.enum(['live', 'paused', 'rejected']),
    note: z.string().trim().max(600).optional(),
  })
  .strict();
