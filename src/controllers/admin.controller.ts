import type { Request, Response } from 'express';
import type { FilterQuery } from 'mongoose';
import { env } from '../config/env';
import { CURRENCY, PLATFORM_FEE_PERCENT } from '../constants';
import { AdCampaign } from '../models/AdCampaign';
import { AuditEvent } from '../models/AuditEvent';
import { Comment } from '../models/Comment';
import { Contribution } from '../models/Contribution';
import { Item } from '../models/Item';
import { MerchProduct } from '../models/MerchProduct';
import { Order } from '../models/Order';
import { User, type IUser } from '../models/User';
import { audit } from '../services/audit';
import { EARNING_ORDER_STATUSES, outstandingBalances } from '../services/ledger';
import { toOrderResponse, toPublicUser } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type {
  ListAuditQuery,
  ListUsersQuery,
  UpdateRoleInput,
  VerifyUserInput,
  UpdateOrderStatusInput,
} from '../validators/admin.validators';

/**
 * Everything on the dashboard that needs a number.
 *
 * Every figure here is something an admin can act on — a queue to work through,
 * a debt to settle, a parcel to post. Vanity counts are relegated to the bottom
 * block, because a dashboard that leads with "1,204 users" trains people to
 * stop reading it.
 */
export async function getOverview(_req: Request, res: Response): Promise<void> {
  const [
    pendingListings,
    pendingAds,
    liveListings,
    awaitingFulfilment,
    owedRows,
    users,
    admins,
    launches,
    openRaises,
    contributions,
    comments,
    grossRows,
  ] = await Promise.all([
    MerchProduct.countDocuments({ status: 'pending', seller: { $ne: null } }),
    AdCampaign.countDocuments({ status: 'pending_review' }),
    MerchProduct.countDocuments({ status: 'approved', active: true }),
    Order.countDocuments({ status: 'paid' }),
    outstandingBalances(),
    User.countDocuments(),
    User.countDocuments({ role: 'admin' }),
    Item.countDocuments(),
    Item.countDocuments({ 'fundraise.enabled': true, 'fundraise.closedAt': null }),
    Contribution.countDocuments({ status: 'paid' }),
    Comment.countDocuments(),
    Order.aggregate<{ gross: number; fee: number; orders: number }>([
      { $match: { status: { $in: [...EARNING_ORDER_STATUSES] } } },
      {
        $group: {
          _id: null,
          gross: { $sum: '$totalMinor' },
          fee: { $sum: '$platformFeeMinor' },
          orders: { $sum: 1 },
        },
      },
    ]),
  ]);

  const gross = grossRows[0] ?? { gross: 0, fee: 0, orders: 0 };

  res.json({
    success: true,
    data: {
      currency: CURRENCY,
      feePercent: PLATFORM_FEE_PERCENT,
      /* The work queues — anything with a number above zero wants attention. */
      queues: {
        pendingListings,
        pendingAds,
        awaitingFulfilment,
        sellersOwed: owedRows.length,
        totalOwedMinor: owedRows.reduce((total, row) => total + row.owedMinor, 0),
      },
      money: {
        grossMinor: gross.gross,
        platformFeeMinor: gross.fee,
        paidOrders: gross.orders,
        contributions,
      },
      catalogue: { liveListings, launches, openRaises, comments },
      people: { users, admins },
    },
  });
}

/* --------------------------------------------------------------- people --- */

export async function listUsers(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListUsersQuery;
  const filter: FilterQuery<IUser> = {};

  if (query.role) filter.role = query.role;
  if (query.search) {
    const pattern = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: pattern }, { username: pattern }, { email: pattern }];
  }

  const skip = (query.page - 1) * query.limit;
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
  ]);

  res.json({
    success: true,
    data: users.map((user) => ({
      ...toPublicUser(user),
      email: user.email,
      role: user.role,
    })),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + users.length < total,
    },
  });
}

/**
 * Promotes a user to staff, or takes it away.
 *
 * Two guards, both about not painting yourself into a corner:
 *
 *  - You cannot demote yourself. It is the single easiest way to lock every
 *    admin function behind a door nobody can open, and it is always a misclick
 *    rather than an intention.
 *  - The last admin cannot be demoted by anyone. Same reason, one step out.
 *
 * Recovering from either would mean editing the database by hand, so the cheap
 * check here is worth more than the flexibility it costs.
 */
export async function updateUserRole(req: Request, res: Response): Promise<void> {
  const { role } = req.body as UpdateRoleInput;
  const actor = req.user!;

  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('We could not find that account');

  if (user.role === role) {
    res.json({
      success: true,
      data: { ...toPublicUser(user), email: user.email, role: user.role },
    });
    return;
  }

  if (role === 'user') {
    if (user._id.toString() === actor._id.toString()) {
      throw ApiError.badRequest('You cannot remove your own staff access');
    }

    const admins = await User.countDocuments({ role: 'admin' });
    if (admins <= 1) {
      throw ApiError.badRequest('Deck needs at least one admin — promote someone else first');
    }
  }

  const previous = user.role;
  user.role = role;
  await user.save();

  await audit(req, {
    action: role === 'admin' ? 'role.granted' : 'role.revoked',
    targetType: 'user',
    targetId: user._id,
    targetLabel: `${user.name} (@${user.username})`,
    summary:
      role === 'admin'
        ? `Made ${user.name} a Deck admin`
        : `Removed staff access from ${user.name}`,
    before: { role: previous },
    after: { role },
  });

  res.json({
    success: true,
    data: { ...toPublicUser(user), email: user.email, role: user.role },
  });
}

/* --------------------------------------------------------------- orders --- */

export async function listAllOrders(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { status?: string; page: number; limit: number };
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;

  const skip = (query.page - 1) * query.limit;
  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate('user', 'username name avatarUrl')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit),
  ]);

  res.json({
    success: true,
    data: orders.map((order) => ({
      ...toOrderResponse(order),
      buyer: order.user && 'username' in order.user ? toPublicUser(order.user as never) : null,
      sellerCount: order.sellerShares.length,
      platformFeeMinor: order.platformFeeMinor,
    })),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + orders.length < total,
    },
  });
}

/**
 * Moves an order along: paid → shipped → delivered.
 *
 * Only forwards, and only one of those two steps. Anything that would unwind a
 * charge — cancelling something already paid for — is deliberately not here: it
 * implies a refund, which has to happen at the payment provider and would leave
 * the ledger claiming a seller earned money that went back to the buyer. Until
 * refunds exist as a real flow, an admin cannot half-do one by accident.
 */
const NEXT_STATUS: Record<string, string[]> = {
  paid: ['shipped'],
  shipped: ['delivered'],
};

export async function updateOrderStatus(req: Request, res: Response): Promise<void> {
  const { status } = req.body as UpdateOrderStatusInput;

  const order = await Order.findOne({ reference: req.params.reference.toUpperCase() });
  if (!order) throw ApiError.notFound('We could not find that order');

  const allowed = NEXT_STATUS[order.status] ?? [];
  if (!allowed.includes(status)) {
    throw ApiError.badRequest(
      allowed.length === 0
        ? `An order that is ${order.status.replace('_', ' ')} cannot be moved from here`
        : `That order can only go to ${allowed.join(' or ')} next`,
    );
  }

  const previous = order.status;
  order.status = status;
  await order.save();

  await audit(req, {
    action: status === 'shipped' ? 'order.shipped' : 'order.delivered',
    targetType: 'order',
    targetId: order.reference,
    targetLabel: `Order ${order.reference}`,
    summary: `Marked order ${order.reference} ${status}`,
    before: { status: previous },
    after: { status },
  });

  res.json({ success: true, data: toOrderResponse(order) });
}

/* ---------------------------------------------------------------- audit --- */

/**
 * The audit trail, newest first.
 *
 * Read-only by construction: there is no route to change or remove an entry,
 * and the model refuses both anyway. Filterable by who and by what, because the
 * two questions an audit log actually gets asked are "what did this person do?"
 * and "who touched this thing?".
 */
export async function listAuditEvents(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListAuditQuery;
  const filter: Record<string, unknown> = {};

  if (query.action) filter.action = query.action;
  if (query.actor) filter.actor = query.actor;
  if (query.targetId) filter.targetId = query.targetId;

  const skip = (query.page - 1) * query.limit;
  const [total, events] = await Promise.all([
    AuditEvent.countDocuments(filter),
    AuditEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
  ]);

  res.json({
    success: true,
    data: events.map((event) => ({
      id: event._id.toString(),
      action: event.action,
      actorId: event.actor ? event.actor.toString() : null,
      actorName: event.actorName,
      actorEmail: event.actorEmail,
      targetType: event.targetType,
      targetId: event.targetId,
      targetLabel: event.targetLabel,
      summary: event.summary,
      before: event.before,
      after: event.after,
      ip: event.ip,
      createdAt: event.createdAt,
    })),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + events.length < total,
    },
  });
}

/**
 * Grants or removes a verification mark. Staff only, always recorded.
 *
 * The mark is a public claim Deck makes on somebody's behalf — that the account
 * is who it says it is — so both directions carry a mandatory reason into the
 * audit trail. Removing one matters more than granting it: people will have
 * relied on the mark, and "why did this disappear" needs an answer that is not
 * somebody's memory.
 */
export async function setUserVerified(req: Request, res: Response): Promise<void> {
  const { verified, reason } = req.body as VerifyUserInput;

  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('We could not find that account');

  if (user.verified === verified) {
    res.json({ success: true, data: { ...toPublicUser(user), role: user.role } });
    return;
  }

  user.verified = verified;
  user.verifiedAt = verified ? new Date() : null;
  await user.save();

  await audit(req, {
    action: verified ? 'user.verified' : 'user.unverified',
    targetType: 'user',
    targetId: user._id,
    targetLabel: user.name,
    summary: verified
      ? `Verified @${user.username} — ${reason}`
      : `Removed verification from @${user.username} — ${reason}`,
    before: { verified: !verified },
    after: { verified, reason },
  });

  res.json({ success: true, data: { ...toPublicUser(user), role: user.role } });
}

/**
 * What address this server thinks its callers have, and whether TRUST_PROXY
 * agrees with reality.
 *
 * This exists because the answer is unknowable from outside. `req.ip` is
 * derived from `X-Forwarded-For` and the configured hop count, and getting the
 * count wrong does not raise anything — it quietly hands back the address of
 * the nearest proxy instead of the visitor's, and everything downstream keeps
 * working while being wrong:
 *
 *   - the login rate limiter buckets the entire internet into one counter, so
 *     ten failed logins anywhere lock out everyone;
 *   - the view dedupe collapses distinct visitors onto a handful of keys and
 *     undercounts;
 *   - every audit entry records the proxy rather than the actor.
 *
 * The hop count depends on the *route the request took*, not on the host, so
 * it changes the day traffic starts going through a CDN and nobody notices.
 * Hence a live check rather than a note in a README.
 *
 * Staff-only: the chain describes the infrastructure, and the addresses in it
 * are real.
 */
export function getProxyDiagnostics(req: Request, res: Response): void {
  const chain = (req.get('x-forwarded-for') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  /*
   * Each proxy in front appends the address it received the request from, so
   * a fully-proxied chain has exactly one entry per hop — and the number of
   * hops is what `trust proxy` wants. No header at all means nothing is in
   * front, and trusting one hop would then let any caller name its own IP.
   */
  const recommended = chain.length > 0 ? chain.length : false;

  res.json({
    success: true,
    data: {
      configured: env.trustProxy,
      recommended,
      agrees: env.trustProxy === recommended,
      /* What the rest of the app will act on. Compare it against the address
         you are actually calling from — if they differ, the count is wrong. */
      resolvedIp: req.ip,
      /* The other end of the last socket: the proxy nearest this process. */
      socketIp: req.socket.remoteAddress ?? null,
      forwardedFor: chain,
      forwardedHops: chain.length,
      /* Which front door the request came through — a Vercel rewrite and a
         direct call to the API host are different chains, and this says which
         one you just used. */
      host: req.get('host') ?? null,
    },
  });
}
