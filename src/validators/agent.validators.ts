import { z } from 'zod';
import { AGENT_CAPABILITIES } from '../models/Agent';
import { urlField } from './fields';

/** Inputs to AgentID: the agent's own API and its operator's endpoints. */

const card = {
  name: z.string().trim().min(2, 'Name your agent').max(40),
  description: z.string().trim().max(280).optional(),
  model: z.string().trim().max(60).optional(),
  provider: z.string().trim().max(60).optional(),
  capabilities: z
    .array(z.enum(AGENT_CAPABILITIES))
    .max(AGENT_CAPABILITIES.length)
    .transform((list) => [...new Set(list)])
    .optional(),
  homepageUrl: urlField.or(z.literal('')).optional(),
};

/** What an agent sends to register itself. */
export const registerAgentSchema = z.object(card).strict();

/** An edit to the card, from the agent or from its operator. */
export const updateAgentSchema = z
  .object(card)
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Send at least one field to change');

export const claimAgentSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^agc_[A-Za-z0-9_-]{32}$/, 'That claim link is not valid'),
  })
  .strict();

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type ClaimAgentInput = z.infer<typeof claimAgentSchema>;
