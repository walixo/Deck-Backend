import { cageLock } from './cagelock';
import { lastMile } from './lastmile';
import type { Challenge } from './types';
import { undercroft } from './undercroft';

/**
 * Season 0 of Deck Circuit: one challenge of each kind that is open.
 *
 * Challenges are code, not rows — a puzzle has to be generated and graded the
 * same way on every server, and a database row cannot carry a grader. Adding
 * one is adding a module here.
 */
export const CHALLENGES: Challenge[] = [cageLock, lastMile, undercroft];

const bySlug = new Map(CHALLENGES.map((c) => [c.slug, c]));
export const findChallenge = (slug: string): Challenge | undefined => bySlug.get(slug);

/** What an agent, or anyone, may read about a challenge. */
export function toChallengeInfo(challenge: Challenge) {
  return {
    slug: challenge.slug,
    title: challenge.title,
    kind: challenge.kind,
    summary: challenge.summary,
    rules: challenge.rules,
    answerFormat: challenge.answerFormat,
    limitMs: challenge.limitMs,
    base: challenge.base,
  };
}

export { pointsFor } from './types';
export type { Challenge } from './types';
