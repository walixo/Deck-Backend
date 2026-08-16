import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { CURRENCY } from '../constants';
import { Payout } from '../models/Payout';
import { User } from '../models/User';
import { audit } from '../services/audit';
import { balanceFor, outstandingBalances } from '../services/ledger';
import { toPayoutResponse, toPublicUser } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type { RecordPayoutInput } from '../validators/payout.validators';

function payoutReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  return `PAY-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

/** The disbursement run: everyone Deck owes, with who they are attached. */
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
      };
    }),
    meta: {
      currency: CURRENCY,
      totalOwedMinor: rows.reduce((total, row) => total + row.owedMinor, 0),
      sellers: rows.length,
    },
  });
}

/**
 * Records a disbursement Deck has made.
 *
 * The transfer itself happens outside Deck — this writes down that it did. The
 * balance is refused rather than clamped when the amount exceeds what is owed,
 * because a payout larger than the debt is almost always a typo, and a ledger
 * that quietly accepts one is a ledger that stops meaning anything.
 */
export async function recordPayout(req: Request, res: Response): Promise<void> {
  const input = req.body as RecordPayoutInput;

  const seller = await User.findById(input.sellerId);
  if (!seller) throw ApiError.notFound('We could not find that seller');

  const balance = await balanceFor(seller._id);
  const amountMinor = Math.round(input.amount * 100);

  if (amountMinor > balance.owedMinor) {
    throw ApiError.badRequest(
      `That is more than ${seller.name} is owed. The outstanding balance is ${
        balance.owedMinor / 100
      } ${CURRENCY}.`,
    );
  }

  const payout = await Payout.create({
    reference: payoutReference(),
    seller: seller._id,
    amountMinor,
    currency: CURRENCY,
    destination: input.destination || undefined,
    note: input.note || undefined,
    paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
    recordedBy: req.user!._id,
  });

  const after = await balanceFor(seller._id);

  await audit(req, {
    action: 'payout.recorded',
    targetType: 'payout',
    targetId: payout.reference,
    targetLabel: `${payout.reference} to ${seller.name}`,
    summary: `Recorded a ${CURRENCY} ${(amountMinor / 100).toLocaleString()} payout to ${seller.name}`,
    before: { owedMinor: balance.owedMinor },
    after: {
      amountMinor,
      owedMinor: after.owedMinor,
      destination: payout.destination,
    },
  });

  res.status(201).json({
    success: true,
    data: { ...toPayoutResponse(payout), remainingOwedMinor: after.owedMinor },
  });
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
