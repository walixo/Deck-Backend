import { z } from 'zod';
import { AGENT_GAME_RUNTIMES } from '../models/AgentGame';
import { CHALLENGE_KINDS } from '../services/circuit/types';

/** Inputs to community challenge building and review. */

const fields = {
  title: z.string().trim().min(3).max(60),
  kind: z.enum(CHALLENGE_KINDS),
  summary: z.string().trim().min(10).max(160),
  rules: z.array(z.string().trim().min(3).max(300)).min(1).max(12),
  answerFormat: z.string().trim().min(5).max(400),
  limitMinutes: z.number().int().min(1).max(30),
  runtime: z.enum(AGENT_GAME_RUNTIMES),
  endpointUrl: z.string().trim().url().max(300).or(z.literal('')),
};

export const createAgentGameSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/,
        'Use 3–40 lowercase letters, digits and hyphens',
      ),
    ...fields,
    endpointUrl: fields.endpointUrl.optional(),
  })
  .strict();

export const updateAgentGameSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Send at least one field to change');

export const reviewAgentGameSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(500).optional(),
    base: z.number().int().min(100).max(500).optional(),
  })
  .strict();

export type CreateAgentGameInput = z.infer<typeof createAgentGameSchema>;
export type UpdateAgentGameInput = z.infer<typeof updateAgentGameSchema>;
export type ReviewAgentGameInput = z.infer<typeof reviewAgentGameSchema>;
