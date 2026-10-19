import { z } from 'zod';
import { OAUTH_APP_TYPES } from '../models/OAuthApp';
import { imageField, urlField } from './fields';

/** Inputs to GameID's Deck-side endpoints. OAuth endpoints parse their own. */

export const updateGameIdSchema = z
  .object({ handle: z.string().trim().toLowerCase().min(3).max(24) })
  .strict();

const optionalUrl = urlField.or(z.literal('')).optional();

export const createAppSchema = z
  .object({
    name: z.string().trim().min(2, 'Name your app').max(60),
    description: z.string().trim().max(240).optional(),
    logoUrl: imageField.or(z.literal('')).optional(),
    homepageUrl: optionalUrl,
    privacyUrl: optionalUrl,
    type: z.enum(OAUTH_APP_TYPES),
    redirectUris: z.array(z.string().trim().min(1).max(500)).min(1, 'Add at least one redirect URI').max(10),
  })
  .strict();

export const updateAppSchema = createAppSchema
  .omit({ type: true })
  .partial()
  .extend({ status: z.enum(['active', 'disabled']).optional() })
  .strict();

/** The authorize request, as the consent page relays it. */
export const authorizeQuerySchema = z.object({
  client_id: z.string().trim().max(100).default(''),
  redirect_uri: z.string().trim().max(500).default(''),
  response_type: z.string().trim().max(40).default(''),
  scope: z.string().trim().max(200).default(''),
  state: z.string().max(500).optional(),
  code_challenge: z.string().trim().max(128).optional(),
  code_challenge_method: z.string().trim().max(10).optional(),
  nonce: z.string().max(200).optional(),
  prompt: z.string().trim().max(40).optional(),
});

export const authorizeDecisionSchema = authorizeQuerySchema.extend({
  decision: z.enum(['allow', 'deny']),
});

export type UpdateGameIdInput = z.infer<typeof updateGameIdSchema>;
export type CreateAppInput = z.infer<typeof createAppSchema>;
export type UpdateAppInput = z.infer<typeof updateAppSchema>;
export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;
export type AuthorizeDecision = z.infer<typeof authorizeDecisionSchema>;
