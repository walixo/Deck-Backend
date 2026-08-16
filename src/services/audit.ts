import type { Request } from 'express';
import type mongoose from 'mongoose';
import type { AuditAction, AuditTarget } from '../constants';
import { AuditEvent } from '../models/AuditEvent';

export interface AuditInput {
  action: AuditAction;
  targetType: AuditTarget;
  /** ObjectId for most things; a reference string for orders and payouts. */
  targetId: mongoose.Types.ObjectId | string;
  /** How the target should read in a year, once names have changed. */
  targetLabel: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Writes an audit entry.
 *
 * **This never throws.** The action being logged has usually already happened —
 * a role is changed, a parcel is marked posted, a bank transfer has left. If
 * the log write fails, failing the request would roll back the API's view of
 * something the real world already did, which is strictly worse than a gap in
 * the log. So a failure is swallowed and shouted about instead.
 *
 * The one place that reasoning would not hold is an action whose only record is
 * the audit entry. Deck has none: every audited action also writes its own row
 * (a role on the user, a status on the order, a Payout document), so the entry
 * is corroboration rather than the sole evidence.
 *
 * Awaited by callers so a slow write cannot outlive the request and log against
 * a closed connection, but its result is deliberately not their problem.
 */
export async function audit(req: Request | null, input: AuditInput): Promise<void> {
  try {
    const actor = req?.user;

    await AuditEvent.create({
      action: input.action,
      actor: actor?._id ?? null,
      /* Copied, not joined: the entry has to survive the account being deleted. */
      actorName: actor?.name ?? 'Command line',
      actorEmail: actor?.email,
      targetType: input.targetType,
      targetId: input.targetId.toString(),
      targetLabel: input.targetLabel,
      summary: input.summary,
      before: input.before,
      after: input.after,
      ip: req?.ip,
    });
  } catch (error) {
    /* Loud, because a silent gap in an audit trail is the worst outcome here —
       it looks identical to nothing having happened. */
    // eslint-disable-next-line no-console
    console.error('[audit] FAILED TO RECORD', input.action, input.targetId, error);
  }
}
