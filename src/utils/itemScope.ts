import type { IItem } from '../models/Item';
import { ApiError } from './ApiError';

/**
 * The launches that take part in the contest.
 *
 * Deck imports products it found elsewhere so the catalogue is not empty, and
 * those listings are browsable but never compete (see `source` on the Item
 * model). Every query that ranks, awards, or counts the community spreads this
 * in, so the rule lives in one place and a new board cannot forget it:
 *
 *   Item.find({ ...COMPETING, launchDateKey })
 *
 * `$ne` rather than `{ source: 'deck' }` on purpose: launches created before the
 * field existed have no `source` at all, and they are exactly the ones that
 * competed.
 */
export const COMPETING = { source: { $ne: 'imported' as const } };

/** An imported listing nobody has claimed yet — owned by Deck Index, not a person. */
export function isUnclaimedImport(item: Pick<IItem, 'source' | 'claimedAt'>): boolean {
  return item.source === 'imported' && !item.claimedAt;
}

/**
 * Refuses what only a launch's real owner should be able to start.
 *
 * Staff can edit an unclaimed listing — fixing a fact is the point of review —
 * but raising money, selling the product, buying ads for it or shipping a new
 * version are things its founder decides, and the founder is not here yet.
 * Without this, the owner check would let any admin do all of them, because
 * admins pass every owner check.
 */
export function assertClaimed(item: Pick<IItem, 'source' | 'claimedAt'>, action: string): void {
  if (isUnclaimedImport(item)) {
    throw ApiError.badRequest(
      `This listing is waiting for its founder to claim it, so nobody can ${action} yet`,
    );
  }
}
