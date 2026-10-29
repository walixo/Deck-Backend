import { z } from 'zod';
import { MATCH_REPORT_REASONS } from '../models/MatchCall';
import { MATCH_GIFTS } from '../models/MatchMoney';
import { MATCH_GENDERS } from '../models/MatchProfile';

/**
 * A username typed with or without its @, or pasted as a profile link; stored
 * bare. Empty clears it.
 */
const handleField = (site: RegExp, pattern: RegExp, message: string) =>
  z
    .string()
    .trim()
    .transform((value) =>
      value
        .replace(site, '')
        .replace(/^@/, '')
        .replace(/[/?#].*$/, ''),
    )
    .refine((value) => value === '' || pattern.test(value), message);

const xField = handleField(
  /^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i,
  /^[A-Za-z0-9_]{1,15}$/,
  'X usernames are up to 15 letters, numbers or underscores',
);
const instagramField = handleField(
  /^(https?:\/\/)?(www\.)?instagram\.com\//i,
  /^[A-Za-z0-9._]{1,30}$/,
  'Instagram usernames are up to 30 letters, numbers, dots or underscores',
);

export const createMatchProfileSchema = z
  .object({
    gender: z.enum(MATCH_GENDERS),
    x: xField.optional(),
    instagram: instagramField.optional(),
    adult: z.literal(true, { errorMap: () => ({ message: 'Match is for people 18 and over' }) }),
  })
  .strict();

export const updateMatchProfileSchema = z
  .object({
    x: xField.optional(),
    instagram: instagramField.optional(),
    /* Accepted so a client may resend its whole form; a different value is refused. */
    gender: z.enum(MATCH_GENDERS).optional(),
  })
  .strict();

export const matchSignalSchema = z.object({ data: z.record(z.unknown()) }).strict();

export const matchReportSchema = z
  .object({
    reason: z.enum(MATCH_REPORT_REASONS),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const matchPushSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(1000)
      .refine((value) => value.startsWith('https://'), 'Push endpoints use https'),
    keys: z
      .object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) })
      .strict(),
    expirationTime: z.number().nullable().optional(),
  })
  .strict();

export const matchSectionRequestSchema = z
  .object({ note: z.string().trim().max(300).optional() })
  .strict();

export const matchSectionSchema = z.object({ gender: z.enum(MATCH_GENDERS) }).strict();

export const matchPauseSchema = z.object({ days: z.number().int().min(1).max(365) }).strict();

export const matchTopupSchema = z.object({ amountMinor: z.number().int().positive() }).strict();

export const matchGiftSchema = z.object({ gift: z.enum(MATCH_GIFTS) }).strict();

const giftCardProducts = ['credit-1000', 'credit-2000', 'credit-5000', 'plus-30'] as const;
const shortText = (max: number) => z.string().trim().max(max).optional().default('');

/** Buying a gift card: what it holds, and an optional note for the card. */
export const matchGiftCardSchema = z
  .object({
    product: z.enum(giftCardProducts),
    toName: shortText(40),
    fromName: shortText(40),
    message: shortText(140),
  })
  .strict();

export const matchRedeemSchema = z
  .object({ code: z.string().trim().min(4, 'Enter the gift card code').max(32) })
  .strict();

/** Staff issuing free cards for a sponsor or a giveaway. */
export const matchGiftCardIssueSchema = z
  .object({
    product: z.enum(giftCardProducts),
    count: z.number().int().min(1).max(500),
    batch: z.string().trim().min(1, 'Say what these are for').max(80),
  })
  .strict();

/** A selfie as a data URL; the screen shrinks it to a few hundred kilobytes. */
export const matchVerificationSchema = z
  .object({ photo: z.string().max(900_000, 'That photo is too large') })
  .strict();

const lagosDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date like 2026-11-06');

/** Staff: one evening's sponsor and/or theme. Either may be null to clear it. */
export const matchNightSchema = z
  .object({
    day: lagosDay,
    sponsor: z
      .object({
        name: z.string().trim().min(1).max(60),
        line: z.string().trim().max(140).default(''),
        url: z
          .string()
          .trim()
          .max(300)
          .refine((value) => value === '' || /^https:\/\//.test(value), 'Links start with https://')
          .default(''),
      })
      .strict()
      .nullable(),
    theme: z
      .object({
        title: z.string().trim().min(1).max(60),
        blurb: z.string().trim().max(200).default(''),
        entryMinor: z.number().int().min(0).max(10_000_00),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((night) => night.sponsor || night.theme, 'Add a sponsor, a theme, or both');

export const matchVerificationDecisionSchema = z
  .object({
    note: z.string().trim().max(300).optional(),
    /* Looks under 18: declined, refunded, and kept off Match. */
    underage: z.boolean().optional(),
  })
  .strict();

export type CreateMatchProfileInput = z.infer<typeof createMatchProfileSchema>;
export type UpdateMatchProfileInput = z.infer<typeof updateMatchProfileSchema>;
export type MatchSignalInput = z.infer<typeof matchSignalSchema>;
export type MatchReportInput = z.infer<typeof matchReportSchema>;
export type MatchPushInput = z.infer<typeof matchPushSchema>;
export type MatchSectionRequestInput = z.infer<typeof matchSectionRequestSchema>;
export type MatchSectionInput = z.infer<typeof matchSectionSchema>;
export type MatchPauseInput = z.infer<typeof matchPauseSchema>;
export type MatchTopupInput = z.infer<typeof matchTopupSchema>;
export type MatchGiftInput = z.infer<typeof matchGiftSchema>;
export type MatchGiftCardInput = z.infer<typeof matchGiftCardSchema>;
export type MatchRedeemInput = z.infer<typeof matchRedeemSchema>;
export type MatchGiftCardIssueInput = z.infer<typeof matchGiftCardIssueSchema>;
export type MatchVerificationInput = z.infer<typeof matchVerificationSchema>;
export type MatchNightInput = z.infer<typeof matchNightSchema>;
export type MatchVerificationDecisionInput = z.infer<typeof matchVerificationDecisionSchema>;
