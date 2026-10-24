import { z } from 'zod';

/**
 * The contract a community challenge keeps, whichever runtime it uses.
 *
 * Every call is JSON in, JSON out:
 *   generate { seed }                          → { puzzle, secret, state? }
 *   grade    { puzzle, secret, answer }        → { quality, detail, stats? }
 *   step     { puzzle, secret, state, moves }  → { state, observation, finished? }
 *   observe  { puzzle, secret, state }         → { observation }
 *   solve    { puzzle, secret }                → { answer } or { moves }
 *
 * `solve` is only ever called by Deck's checks, to prove the grader accepts a
 * right answer. Replies are validated and capped here, so a misbehaving
 * challenge fails loudly instead of storing something it should not.
 */

export const CALLS = ['generate', 'grade', 'step', 'observe', 'solve'] as const;
export type Call = (typeof CALLS)[number];

export const CAPS = {
  puzzle: 256 * 1024,
  secret: 64 * 1024,
  state: 64 * 1024,
  observation: 32 * 1024,
  reply: 512 * 1024,
} as const;

const object = z.record(z.unknown());

const graded = z.object({
  quality: z.number().min(0).max(1),
  detail: z.string().max(300).default(''),
  stats: z.record(z.number()).optional(),
});

export const REPLIES = {
  generate: z.object({ puzzle: object, secret: object, state: object.optional() }),
  grade: graded,
  step: z.object({ state: object, observation: object, finished: graded.optional() }),
  observe: z.object({ observation: object }),
  solve: z.object({ answer: z.unknown().optional(), moves: z.string().max(100_000).optional() }),
} as const;

export type Reply<C extends Call> = z.infer<(typeof REPLIES)[C]>;

/** A challenge failed to keep the contract: unreachable, slow, or a bad reply. */
export class ChallengeError extends Error {}

export const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null));

/** Something that can answer a call: a hosted endpoint or a WebAssembly module. */
export interface Runner {
  call(call: Call, input: Record<string, unknown>): Promise<unknown>;
}

/** Validates a reply against the contract and the size caps. */
export function parseReply<C extends Call>(call: C, raw: unknown): Reply<C> {
  const result = REPLIES[call].safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ChallengeError(
      `${call} replied in the wrong shape${issue ? ` (${issue.path.join('.') || 'reply'}: ${issue.message})` : ''}`,
    );
  }
  const reply = result.data as Record<string, unknown>;
  for (const key of ['puzzle', 'secret', 'state', 'observation'] as const) {
    if (reply[key] !== undefined && sizeOf(reply[key]) > CAPS[key]) {
      throw new ChallengeError(`${call} returned a ${key} over ${CAPS[key] / 1024} KB`);
    }
  }
  return result.data as Reply<C>;
}
