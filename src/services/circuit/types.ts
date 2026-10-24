/**
 * The contract every Deck Circuit challenge keeps.
 *
 * A challenge is pure code: given a seed it builds the same puzzle every
 * time, and given a puzzle and an answer it grades without trusting anything
 * the agent says about itself. The secret half of a puzzle — a maze's map, a
 * reference cost — never leaves the server.
 */

export const CHALLENGE_KINDS = ['solve', 'optimise', 'explore'] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export interface Generated {
  /** What the agent is given. */
  puzzle: Record<string, unknown>;
  /** What only the grader sees. */
  secret: Record<string, unknown>;
  /** Explore challenges only: where play starts. */
  state?: Record<string, unknown>;
}

export interface Graded {
  /** 0 for a wrong or invalid answer; up to 1 for the best. */
  quality: number;
  /** One line on why, safe to show the agent. */
  detail: string;
  /** Figures worth keeping with the result (cost, steps…). */
  stats?: Record<string, number>;
}

export interface StepResult {
  state: Record<string, unknown>;
  /** What the agent sees after the moves. */
  observation: Record<string, unknown>;
  /** Set when the run is over — escaped, or out of steps. */
  finished?: Graded;
}

export interface Challenge {
  slug: string;
  title: string;
  kind: ChallengeKind;
  /** One line for lists. */
  summary: string;
  /** The rules, in full, as the agent will read them. */
  rules: string[];
  /** The shape of `answer` (solve, optimise) or of a move (explore). */
  answerFormat: string;
  /** Hard limit from start to finish. */
  limitMs: number;
  /** Points for a perfect answer submitted at the very end of the limit. */
  base: number;
  /* Built-in challenges answer at once; community ones may answer over the
     network or from a sandbox, so every call may be awaited. */
  generate(seed: number): Generated | Promise<Generated>;
  /** Solve and optimise: grade a submitted answer. */
  grade?(generated: Generated, answer: unknown): Graded | Promise<Graded>;
  /** Explore: apply moves to the running state. */
  step?(
    secret: Record<string, unknown>,
    state: Record<string, unknown>,
    moves: string,
    puzzle?: Record<string, unknown>,
  ): StepResult | Promise<StepResult>;
  /** Explore: what the agent sees right now, without moving. */
  observe?(
    secret: Record<string, unknown>,
    state: Record<string, unknown>,
    puzzle?: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Community challenges only: who made it. */
  author?: { handle: string } | null;
}

/**
 * The published formula: speed only separates answers of equal quality, and
 * a wrong answer is worth nothing however fast.
 */
export function pointsFor(challenge: Challenge, quality: number, timeMs: number): number {
  const speed = 1 + 0.5 * (1 - Math.min(1, timeMs / challenge.limitMs));
  return Math.round(challenge.base * quality * speed);
}

/** sfc32: small, fast, and the same in every runtime for a given seed. */
export function seeded(seed: number): () => number {
  let a = 0x9e3779b9,
    b = 0x243f6a88,
    c = 0xb7e15162,
    d = seed >>> 0;
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

export const randInt = (rand: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rand() * (hi - lo + 1));

export function shuffle<T>(rand: () => number, list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
