import type { Request, Response } from 'express';
import { env } from '../config/env';
import { MatchGiftCard } from '../models/MatchMoney';
import { audit } from '../services/audit';
import {
  giftCardCode,
  giftCardLabel,
  giftCardProduct,
  giftCardReference,
  MATCH_CURRENCY,
  MATCH_GIFT_CARD_MONTHS,
} from '../services/matchWallet';
import { ApiError } from '../utils/ApiError';
import type { MatchGiftCardIssueInput } from '../validators/match.validators';

/**
 * Staff's side of Match gift cards: what has sold and is still unclaimed,
 * free batches for sponsors and giveaways, and cancelling a card.
 */

const redeemLink = (code: string) => `${env.matchUrl}/?redeem=${encodeURIComponent(code)}`;

/** Sales, what is still out there to be claimed, the batches, and recent cards. */
export async function listMatchGiftCards(_req: Request, res: Response): Promise<void> {
  const now = new Date();
  const [sold, open, redeemed, batches, recent] = await Promise.all([
    MatchGiftCard.aggregate<{ _id: null; minor: number; count: number }>([
      { $match: { mode: 'live', status: { $in: ['active', 'redeemed'] } } },
      { $group: { _id: null, minor: { $sum: '$priceMinor' }, count: { $sum: 1 } } },
    ]),
    MatchGiftCard.aggregate<{ _id: string; minor: number; count: number }>([
      { $match: { status: 'active', expiresAt: { $gt: now } } },
      { $group: { _id: '$kind', minor: { $sum: '$valueMinor' }, count: { $sum: 1 } } },
    ]),
    MatchGiftCard.countDocuments({ status: 'redeemed' }),
    MatchGiftCard.aggregate<{
      _id: string;
      product: string;
      count: number;
      redeemed: number;
      createdAt: Date;
    }>([
      { $match: { mode: 'issued' } },
      {
        $group: {
          _id: '$batch',
          product: { $first: '$product' },
          count: { $sum: 1 },
          redeemed: { $sum: { $cond: [{ $eq: ['$status', 'redeemed'] }, 1, 0] } },
          createdAt: { $min: '$createdAt' },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: 20 },
    ]),
    MatchGiftCard.find({ status: { $in: ['active', 'redeemed', 'void'] } })
      .sort({ createdAt: -1 })
      .limit(40)
      .populate<{ buyer: { name: string; email: string } | null }>('buyer', 'name email')
      .populate<{ redeemedBy: { name: string } | null }>('redeemedBy', 'name'),
  ]);
  const unclaimed = Object.fromEntries(open.map((row) => [row._id, row]));
  res.json({
    success: true,
    data: {
      soldMinor: sold[0]?.minor ?? 0,
      sold: sold[0]?.count ?? 0,
      redeemed,
      /* Credit still owed on live cards, and Match+ cards not yet claimed. */
      unclaimedCreditMinor: unclaimed.credit?.minor ?? 0,
      unclaimedCredit: unclaimed.credit?.count ?? 0,
      unclaimedPlus: unclaimed.plus?.count ?? 0,
      batches: batches.map((batch) => ({
        batch: batch._id,
        label: giftCardLabel(giftCardProduct(batch.product)!),
        count: batch.count,
        redeemed: batch.redeemed,
        createdAt: batch.createdAt,
      })),
      cards: recent.map((card) => ({
        reference: card.reference,
        label: giftCardLabel(card),
        status: card.status,
        mode: card.mode,
        priceMinor: card.priceMinor,
        buyer: card.buyer ? `${card.buyer.name} · ${card.buyer.email}` : card.batch,
        redeemedBy: card.redeemedBy?.name ?? null,
        redeemedAt: card.redeemedAt,
        expiresAt: card.expiresAt,
        createdAt: card.createdAt,
      })),
    },
  });
}

/** Free cards, made live at once, for a sponsor or a giveaway. Returns the codes. */
export async function issueMatchGiftCards(req: Request, res: Response): Promise<void> {
  const { product: id, count, batch } = req.body as MatchGiftCardIssueInput;
  const product = giftCardProduct(id)!;
  if (await MatchGiftCard.exists({ mode: 'issued', batch })) {
    throw ApiError.badRequest('A batch with that name already exists — give this one its own');
  }
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + MATCH_GIFT_CARD_MONTHS);
  const cards = await MatchGiftCard.insertMany(
    Array.from({ length: count }, () => ({
      reference: giftCardReference(),
      code: giftCardCode(),
      product: product.id,
      kind: product.kind,
      valueMinor: product.valueMinor,
      plusDays: product.plusDays,
      priceMinor: 0,
      currency: MATCH_CURRENCY,
      status: 'active',
      mode: 'issued',
      batch,
      paidAt: now,
      expiresAt,
    })),
  );
  await audit(req, {
    action: 'match.giftcards.issued',
    targetType: 'match_gift_card',
    targetId: cards[0]._id,
    targetLabel: batch,
    summary: `Issued ${count} Match gift card${count === 1 ? '' : 's'} (${giftCardLabel(product)}) for “${batch}”`,
    after: { product: product.id, count, batch },
  });
  res.status(201).json({
    success: true,
    data: { batch, codes: cards.map((card) => ({ code: card.code, link: redeemLink(card.code) })) },
  });
}

/** A batch's codes again, for the spreadsheet. */
export async function matchGiftCardBatch(req: Request, res: Response): Promise<void> {
  const batch = String(req.query.batch ?? '');
  const cards = await MatchGiftCard.find({ mode: 'issued', batch })
    .select('+code')
    .sort({ createdAt: 1 });
  if (cards.length === 0) throw ApiError.notFound('No such batch');
  res.json({
    success: true,
    data: {
      batch,
      codes: cards.map((card) => ({
        code: card.code,
        link: redeemLink(card.code),
        status: card.status,
      })),
    },
  });
}

/** Cancels a card that has not been claimed. */
export async function voidMatchGiftCard(req: Request, res: Response): Promise<void> {
  const card = await MatchGiftCard.findOneAndUpdate(
    { reference: String(req.params.reference), status: 'active' },
    { status: 'void' },
    { new: true },
  );
  if (!card) throw ApiError.badRequest('Only an unclaimed, live card can be cancelled');
  await audit(req, {
    action: 'match.giftcard.voided',
    targetType: 'match_gift_card',
    targetId: card._id,
    targetLabel: card.reference,
    summary: `Cancelled Match gift card ${card.reference} (${giftCardLabel(card)})`,
  });
  res.json({ success: true, data: { reference: card.reference, status: card.status } });
}
