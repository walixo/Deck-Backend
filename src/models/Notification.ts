import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { NOTIFICATION_KINDS, type NotificationKind } from '../constants';

/**
 * One thing that happened, addressed to one person.
 *
 * The text is written at the moment the event occurs and stored, rather than
 * being reassembled from live data when the panel is opened. A notification is
 * a record of something that happened at a time — "Ada reviewed Pocket Lathe"
 * stays true even after the launch is renamed, the review is edited, or Ada
 * deletes her account. Resolving it lazily would quietly rewrite history, and
 * would also mean four populates to draw a list of fifteen rows.
 *
 * The cost is that renames do not propagate, which is the correct trade: the
 * panel is a log, not a view.
 */
export interface INotification extends Document {
  _id: mongoose.Types.ObjectId;
  /** Who is being told. */
  user: mongoose.Types.ObjectId;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Where clicking it goes. Always an in-app path. */
  link: string;
  /** Who caused it, when that is a person. Absent for staff and system events. */
  actor?: mongoose.Types.ObjectId;
  readAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, trim: true, maxlength: 240 },
    link: { type: String, required: true, trim: true, maxlength: 300 },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    readAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

/* The panel's only query: this person's notifications, newest first. */
notificationSchema.index({ user: 1, createdAt: -1 });

/*
 * The badge's query, which runs far more often than the panel's — every poll,
 * for every signed-in reader. Partial rather than plain, so the index contains
 * only unread rows: it stays small no matter how much history accumulates, and
 * counting is a scan of exactly the documents being counted.
 */
notificationSchema.index({ user: 1, createdAt: -1 }, { partialFilterExpression: { readAt: null } });

/*
 * Ninety days, then gone.
 *
 * Nobody scrolls back three months through a notification list, and the
 * alternative is a collection that grows forever at the rate of everything
 * that ever happens on the site. The underlying events are not lost — the
 * comment, the order and the audit entry all still exist.
 */
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Notification: Model<INotification> =
  mongoose.models.Notification ?? mongoose.model<INotification>('Notification', notificationSchema);
