import { z } from 'zod';
import { MATCH_REPORT_REASONS } from '../models/MatchCall';
import { MATCH_GENDERS } from '../models/MatchProfile';

/** A LagosLife username, typed with or without its @, stored without. Empty clears it. */
const lagosLifeField = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, ''))
  .refine(
    (value) => value === '' || /^[A-Za-z0-9._]{2,30}$/.test(value),
    'Usernames are 2–30 letters, numbers, dots or underscores',
  );

export const createMatchProfileSchema = z
  .object({
    gender: z.enum(MATCH_GENDERS),
    lagosLife: lagosLifeField.optional(),
    adult: z.literal(true, { errorMap: () => ({ message: 'Match is for people 18 and over' }) }),
  })
  .strict();

export const updateMatchProfileSchema = z
  .object({
    lagosLife: lagosLifeField,
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

export type CreateMatchProfileInput = z.infer<typeof createMatchProfileSchema>;
export type UpdateMatchProfileInput = z.infer<typeof updateMatchProfileSchema>;
export type MatchSignalInput = z.infer<typeof matchSignalSchema>;
export type MatchReportInput = z.infer<typeof matchReportSchema>;
export type MatchPushInput = z.infer<typeof matchPushSchema>;
export type MatchSectionRequestInput = z.infer<typeof matchSectionRequestSchema>;
export type MatchSectionInput = z.infer<typeof matchSectionSchema>;
export type MatchPauseInput = z.infer<typeof matchPauseSchema>;
