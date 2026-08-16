import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { AUDIT_ACTIONS, AUDIT_TARGETS, type AuditAction, type AuditTarget } from '../constants';

/**
 * One privileged thing somebody did.
 *
 * Three properties make this an audit trail rather than a table of rows:
 *
 *  1. **Append-only.** The hooks below refuse every update and delete at the
 *     schema layer, so no future handler — and no careless script reaching for
 *     `updateMany` — can quietly rewrite history. A log that can be edited
 *     proves nothing, and the moment it is editable it stops being evidence.
 *
 *  2. **Self-contained.** Names are copied in, not joined. Normally that is a
 *     smell; here it is the point. An entry has to still make sense in a year,
 *     after the admin has left and the product has been renamed — "Ada Okonkwo
 *     approved Jonas's Field Cap" survives that, two dangling ObjectIds do not.
 *
 *  3. **Snapshotted.** `before` and `after` hold what actually changed, so a
 *     disputed action can be reconstructed without trusting the summary text.
 */
export interface IAuditEvent extends Document {
  _id: mongoose.Types.ObjectId;
  action: AuditAction;
  /** Null when the actor was a command-line script rather than a signed-in user. */
  actor: mongoose.Types.ObjectId | null;
  actorName: string;
  actorEmail?: string;
  targetType: AuditTarget;
  /** ObjectId for most things, a reference string for orders and payouts. */
  targetId: string;
  targetLabel: string;
  /** One line, already phrased for reading. */
  summary: string;
  before?: unknown;
  after?: unknown;
  /** Where the request came from, when there was one. */
  ip?: string;
  createdAt: Date;
}

const auditEventSchema = new Schema<IAuditEvent>(
  {
    action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorName: { type: String, required: true, trim: true, maxlength: 120 },
    actorEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
    targetType: { type: String, enum: AUDIT_TARGETS, required: true },
    targetId: { type: String, required: true, trim: true, index: true },
    targetLabel: { type: String, required: true, trim: true, maxlength: 200 },
    summary: { type: String, required: true, trim: true, maxlength: 400 },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    ip: { type: String, trim: true, maxlength: 64 },
  },
  {
    // No updatedAt: nothing here is ever updated, so the field would be a lie.
    timestamps: { createdAt: true, updatedAt: false },
  },
);

/** The log reads newest-first, usually filtered by who or what. */
auditEventSchema.index({ createdAt: -1 });
auditEventSchema.index({ actor: 1, createdAt: -1 });
auditEventSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

/*
 * Immutability, enforced where it cannot be forgotten.
 *
 * Putting this on the schema rather than trusting every future caller means an
 * accidental `AuditEvent.updateMany(...)` throws instead of silently rewriting
 * the record of what happened. Retention pruning, if it is ever wanted, should
 * be a deliberate out-of-band job — not something the app can reach.
 */
const REFUSE = function refuse(this: unknown, next: (error?: Error) => void) {
  next(new Error('The audit trail is append-only: entries cannot be changed or removed'));
};

for (const hook of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  auditEventSchema.pre(hook, REFUSE);
}

/** Blocks `document.save()` on anything already written. */
auditEventSchema.pre('save', function guard(next) {
  if (!this.isNew) {
    next(new Error('The audit trail is append-only: entries cannot be changed'));
    return;
  }
  next();
});

export const AuditEvent: Model<IAuditEvent> =
  mongoose.models.AuditEvent ?? mongoose.model<IAuditEvent>('AuditEvent', auditEventSchema);
