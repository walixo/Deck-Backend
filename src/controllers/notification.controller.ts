import type { Request, Response } from 'express';
import { Notification } from '../models/Notification';
import { toPublicUser } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type { ListNotificationsQuery } from '../validators/notification.validators';

const ACTOR_FIELDS = 'name username avatarUrl verified';

/**
 * The panel's contents, plus the number the badge shows.
 *
 * Both in one response because the client needs both at the same moment and
 * always has — splitting them would double the polling traffic to answer one
 * question. The count is of *all* unread, not of the page returned: a badge
 * that says 15 when there are 40 is worse than no badge.
 */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  const { limit, before } = req.query as unknown as ListNotificationsQuery;
  const user = req.user!._id;

  /* Keyset pagination on createdAt rather than skip/limit. The list is
     append-at-the-front by nature, so an offset shifts under the reader the
     moment anything arrives — page two would repeat a row from page one. */
  const filter = before ? { user, createdAt: { $lt: new Date(before) } } : { user };

  const [rows, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit).populate('actor', ACTOR_FIELDS),
    Notification.countDocuments({ user, readAt: null }),
  ]);

  res.json({
    success: true,
    data: rows.map((row) => ({
      id: row._id.toString(),
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      read: row.readAt !== null,
      createdAt: row.createdAt,
      actor:
        row.actor && typeof row.actor === 'object' && 'username' in row.actor
          ? toPublicUser(row.actor as never)
          : undefined,
    })),
    meta: {
      unread,
      /* Whether asking again would return anything, so the client does not
         have to make an empty request to find out it is at the end. */
      hasMore: rows.length === limit,
    },
  });
}

/**
 * Marks everything read.
 *
 * One call, not one per row. Opening the panel is the act that means "I have
 * seen these", and firing fifteen requests to say so would be absurd — and
 * would leave the badge briefly wrong while they landed.
 */
export async function markAllRead(req: Request, res: Response): Promise<void> {
  const result = await Notification.updateMany(
    { user: req.user!._id, readAt: null },
    { $set: { readAt: new Date() } },
  );

  res.json({ success: true, data: { marked: result.modifiedCount } });
}

/** Marks one read — used when a single notification is opened. */
export async function markRead(req: Request, res: Response): Promise<void> {
  const notification = await Notification.findOneAndUpdate(
    /* Scoped to the caller, so an id from somebody else's panel matches
       nothing rather than marking their notification read. */
    { _id: req.params.id, user: req.user!._id },
    { $set: { readAt: new Date() } },
    { new: true },
  );

  if (!notification) throw ApiError.notFound('That notification no longer exists');

  res.json({ success: true, data: { id: notification._id.toString(), read: true } });
}
