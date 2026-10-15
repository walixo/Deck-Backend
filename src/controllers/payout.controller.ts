import type { Request, Response } from 'express';
import { env } from '../config/env';
import { CURRENCY } from '../constants';
import { Payout } from '../models/Payout';
import { User } from '../models/User';
import { audit } from '../services/audit';
import { bachsConfigured } from '../services/bachs';
import { balanceFor, outstandingBalances } from '../services/ledger';
import {
  MIN_TRANSFER_MINOR,
  onboardingLink,
  refreshPayoutAccount,
  runTransfers,
} from '../services/payouts';
import { toPayoutResponse, toPublicUser } from '../serializers';
import { ApiError } from '../utils/ApiError';

/**
 * Everyone Deck owes, and whether each of them can be paid yet.
 *
 * `availableMinor` is what the next transfer run will send; `owedMinor` also
 * counts earnings still inside the hold. The account status is the column
 * staff actually need: owed money sitting against somebody with no active
 * sub-account is money that will not move until that person finishes
 * onboarding, and nobody else can do that step for them.
 */
export async function listOwed(_req: Request, res: Response): Promise<void> {
  const rows = await outstandingBalances();
  const users = await User.find({ _id: { $in: rows.map((row) => row.sellerId) } });
  const byId = new Map(users.map((user) => [user._id.toString(), user]));

  res.json({
    success: true,
    data: rows.map((row) => {
      const user = byId.get(row.sellerId);
      return {
        ...row,
        currency: CURRENCY,
        seller: user ? toPublicUser(user) : null,
        email: user?.email ?? null,
        payoutAccount: !user?.payoutAccount
          ? 'none'
          : user.payoutAccount.transfersActive
            ? 'active'
            : 'pending',
      };
    }),
    meta: {
      currency: CURRENCY,
      totalOwedMinor: rows.reduce((total, row) => total + row.owedMinor, 0),
      totalAvailableMinor: rows.reduce((total, row) => total + row.availableMinor, 0),
      sellers: rows.length,
      holdDays: env.payoutHoldDays,
      minTransferMinor: MIN_TRANSFER_MINOR,
    },
  });
}

/**
 * Runs the transfer job now, instead of waiting for the hourly tick.
 *
 * The same function the scheduler calls, so there is one path for money to
 * leave and it is the one with the safeguards. Manual recording of bank
 * transfers was retired along with manual payouts: a payout row is now only
 * ever written by the transfer run, against a transfer Bachs actually made.
 */
export async function runTransfersNow(req: Request, res: Response): Promise<void> {
  if (!bachsConfigured()) throw ApiError.badRequest('Payments are not configured on this server');

  const result = await runTransfers();

  await audit(req, {
    action: 'payouts.run',
    targetType: 'payout',
    targetId: `run-${Date.now()}`,
    targetLabel: 'Transfer run',
    summary: `Ran transfers by hand: ${result.sent} sent, ${result.retried} retried, ${result.failed} refused, ${result.awaitingAccount} waiting on onboarding`,
    after: { ...result },
  });

  res.json({ success: true, data: result });
}

/** The seller's own record: what they are owed, and what has been sent. */
export async function listMyPayouts(req: Request, res: Response): Promise<void> {
  const [payouts, balance] = await Promise.all([
    Payout.find({ seller: req.user!._id }).sort({ paidAt: -1 }).limit(50),
    balanceFor(req.user!._id),
  ]);

  res.json({
    success: true,
    data: payouts.map(toPayoutResponse),
    meta: { ...balance, currency: CURRENCY },
  });
}

/* --------------------------------------------------- payout account --- */

/**
 * Where Bachs sends someone back to after hosted onboarding. The page asks
 * the server for the account's real status on arrival — reaching this URL
 * proves nothing on its own, which Bachs's own docs are explicit about.
 */
/* Where onboarding may send someone back to: the shop dashboard, or the games
   developer area. A fixed list, never a path from the request — a free-form
   return path would turn this into an open redirect off Deck's domain. */
const RETURN_PATHS = { sell: '/sell', games: '/games/developers' } as const;

function onboardingUrls(from: keyof typeof RETURN_PATHS = 'sell') {
  const origin = (env.clientOrigins[0] ?? '').replace(/\/+$/, '');
  const path = RETURN_PATHS[from];
  return {
    returnUrl: `${origin}${path}?payouts=returned`,
    /* An expired or used link sends them here; the page mints a fresh one. */
    refreshUrl: `${origin}${path}?payouts=refresh`,
  };
}

function toAccountResponse(user: { payoutAccount?: { transfersActive: boolean } | null }) {
  return {
    status: !user.payoutAccount
      ? 'none'
      : user.payoutAccount.transfersActive
        ? 'active'
        : 'pending',
    holdDays: env.payoutHoldDays,
  };
}

/** The caller's sub-account status. Never the account id — they do not need it. */
export async function getMyPayoutAccount(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: toAccountResponse(req.user!) });
}

/**
 * Creates the caller's sub-account if needed and returns a hosted onboarding
 * link. Bachs collects identity and bank details on its own page; nothing of
 * the kind passes through Deck.
 */
export async function startPayoutOnboarding(req: Request, res: Response): Promise<void> {
  if (!bachsConfigured()) throw ApiError.badRequest('Payouts are not configured on this server');
  const from = (req.body as { from?: string } | undefined)?.from === 'games' ? 'games' : 'sell';
  const url = await onboardingLink(req.user!, onboardingUrls(from));
  res.json({ success: true, data: { url } });
}

/** Re-reads the caller's status from Bachs — for the return from onboarding. */
export async function refreshMyPayoutAccount(req: Request, res: Response): Promise<void> {
  if (!bachsConfigured()) {
    res.json({ success: true, data: toAccountResponse(req.user!) });
    return;
  }
  const user = await refreshPayoutAccount(req.user!);
  res.json({ success: true, data: toAccountResponse(user) });
}
