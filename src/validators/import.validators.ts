import { z } from 'zod';
import { PRICING_MODELS } from '../constants';
import { LISTING_REQUEST_KINDS } from '../models/ListingRequest';
import { imageField, urlField } from './fields';

/*
 * Imports are entered by staff and by the CSV loader, never by the public, so
 * these are looser than `createItemSchema` in one place on purpose: the
 * description floor is lower. A founder's own one-line "about" is often the
 * most accurate description there is, and padding it to forty characters to
 * satisfy a rule written for makers would put words in their mouth.
 */

const countryField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use a two-letter country code, like NG or KE');

const linkSchema = z.object({
  label: z.string().trim().min(1).max(30),
  url: urlField,
});

export const candidateFounderSchema = z.object({
  name: z.string().trim().min(2, 'Founder needs a name').max(60),
  headline: z.string().trim().max(100).optional(),
  /* Attach to an existing founder record rather than creating a second one
     for the same person. */
  founderId: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  links: z.array(linkSchema).max(5).default([]),
});

export const candidateSchema = z.object({
  name: z.string().trim().min(2, 'Give it a name').max(70),
  tagline: z.string().trim().min(6, 'A tagline needs at least 6 characters').max(120),
  description: z.string().trim().min(10, 'Say at least a sentence about it').max(4000),
  websiteUrl: urlField,
  category: z.string().trim().toLowerCase().min(2).max(40),
  country: countryField.or(z.literal('')).optional(),
  tags: z.array(z.string().trim().toLowerCase().min(2).max(24)).max(6).default([]),
  pricing: z.enum(PRICING_MODELS).default('free'),
  logoUrl: imageField.or(z.literal('')).optional(),
  /* Checked per request, not with `.max(new Date(...))` — that would fix the
     limit at the moment the server started and reject yesterday's launches a
     week into uptime. */
  launchedAt: z.coerce
    .date()
    .refine((date) => date.getTime() <= Date.now() + 86_400_000, 'That date is in the future')
    .optional(),
  founders: z.array(candidateFounderSchema).max(8).default([]),
  /* At least one: a listing whose facts came from nowhere cannot be checked
     when somebody disputes it. */
  sourceUrls: z.array(urlField).min(1, 'Say where this came from').max(6),
  notes: z.string().trim().max(1000).optional(),
});

export const updateCandidateSchema = candidateSchema.partial();

export const rejectCandidateSchema = z.object({
  reason: z.string().trim().min(4, 'Say why').max(400),
});

export const listingRequestSchema = z.object({
  kind: z.enum(LISTING_REQUEST_KINDS),
  name: z.string().trim().min(2, 'Tell us your name').max(60),
  email: z.string().trim().toLowerCase().email('We need an email to reply to'),
  relationship: z.string().trim().max(80).optional(),
  message: z.string().trim().max(1000).optional(),
});

export const resolveListingRequestSchema = z.object({
  outcome: z.enum(['resolved', 'dismissed']),
  note: z.string().trim().max(400).optional(),
});

export type CandidateInput = z.infer<typeof candidateSchema>;
export type UpdateCandidateInput = z.infer<typeof updateCandidateSchema>;
export type RejectCandidateInput = z.infer<typeof rejectCandidateSchema>;
export type ListingRequestInput = z.infer<typeof listingRequestSchema>;
export type ResolveListingRequestInput = z.infer<typeof resolveListingRequestSchema>;
