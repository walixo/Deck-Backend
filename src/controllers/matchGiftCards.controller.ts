import type { Request, Response } from 'express';
import { env } from '../config/env';
import { MatchGiftCard, type IMatchGiftCard } from '../models/MatchMoney';
import { MatchProfile } from '../models/MatchProfile';
import { bachsConfigured, createCheckout, getCheckout } from '../services/bachs';
import * as hub from '../services/matchHub';
import {
  activateGiftCard,
  applyVerifiedGiftCard,
  giftCardCode,
  giftCardLabel,
  giftCardProduct,
  giftCardReference,
  isPlus,
  MATCH_CURRENCY,
  MATCH_GIFT_CARD_MONTHS,
  MATCH_GIFT_CARDS,
  redeemGiftCard as redeem,
} from '../services/matchWallet';
import { ApiError } from '../utils/ApiError';
import type { MatchGiftCardInput, MatchRedeemInput } from '../validators/match.validators';

/**
 * Match gift cards: bought for someone else through the same Bachs checkout
 * as a top-up, and claimed with a one-time code.
 *
 * Buying needs only a Deck account. Redeeming needs Match set up, because
 * that is where the credit or Match+ goes.
 */

/** The link a card is shared with: it opens Match ready to redeem. */
const redeemLink = (code: string) => `${env.matchUrl}/?redeem=${encodeURIComponent(code)}`;

/** A card as its buyer sees it; the code only once it is paid for. */
export function giftCardView(card: IMatchGiftCard) {
  const live = card.status === 'active' || card.status === 'redeemed';
  return {
    reference: card.reference,
    product: card.product,
    kind: card.kind,
    label: giftCardLabel(card),
    valueMinor: card.valueMinor,
    plusDays: card.plusDays,
    priceMinor: card.priceMinor,
    status: card.status,
    toName: card.toName,
    fromName: card.fromName,
    message: card.message,
    code: live ? card.code : null,
    link: live ? redeemLink(card.code) : null,
    expiresAt: card.expiresAt,
    redeemedAt: card.redeemedAt,
    test: card.mode === 'test',
    createdAt: card.createdAt,
  };
}

/** What cards cost, and the cards this person has bought. */
export async function listGiftCards(req: Request, res: Response): Promise<void> {
  const mine = await MatchGiftCard.find({ buyer: req.user!._id, status: { $ne: 'failed' } })
    .select('+code')
    .sort({ createdAt: -1 })
    .limit(20);
  res.json({
    success: true,
    data: {
      products: MATCH_GIFT_CARDS.map((card) => ({ ...card, label: giftCardLabel(card) })),
      months: MATCH_GIFT_CARD_MONTHS,
      payments: bachsConfigured() || !env.isProduction,
      /* Unpaid checkouts someone walked away from are not worth listing. */
      cards: mine.filter((card) => card.status !== 'pending').map(giftCardView),
    },
  });
}

/**
 * Starts buying a card: a hosted checkout that comes back to Match. Where
 * Bachs is not configured outside production the card is made live at once
 * and marked as a test.
 */
export async function buyGiftCard(req: Request, res: Response): Promise<void> {
  const input = req.body as MatchGiftCardInput;
  const product = giftCardProduct(input.product);
  if (!product) throw ApiError.badRequest('Choose a gift card');
  const reference = giftCardReference();
  const base = {
    reference,
    code: giftCardCode(),
    product: product.id,
    kind: product.kind,
    valueMinor: product.valueMinor,
    plusDays: product.plusDays,
    priceMinor: product.priceMinor,
    currency: MATCH_CURRENCY,
    buyer: req.user!._id,
    toName: input.toName,
    fromName: input.fromName,
    message: input.message,
  };

  if (!bachsConfigured()) {
    if (env.isProduction) throw ApiError.badRequest('Payments are not available right now');
    const card = await activateGiftCard(await MatchGiftCard.create({ ...base, mode: 'test' }), {
      paidAt: new Date(),
    });
    const withCode = await MatchGiftCard.findById(card._id).select('+code');
    res.status(201).json({ success: true, data: { card: giftCardView(withCode!) } });
    return;
  }

  const back = `${env.matchUrl}/?giftcard=${encodeURIComponent(reference)}`;
  const checkout = await createCheckout({
    amountMinor: product.priceMinor,
    currency: MATCH_CURRENCY,
    email: req.user!.email,
    name: req.user!.name,
    reference,
    successUrl: back,
    cancelUrl: `${back}&cancelled=1`,
    metadata: { kind: 'match_gift_card' },
  });
  await MatchGiftCard.create({
    ...base,
    mode: 'live',
    checkoutId: checkout.checkoutId,
    checkoutUrl: checkout.checkoutUrl,
  });
  res.status(201).json({ success: true, data: { checkoutUrl: checkout.checkoutUrl } });
}

/** Back from checkout: asks Bachs, makes the card live if paid, and shows it. */
export async function verifyGiftCard(req: Request, res: Response): Promise<void> {
  const card = await MatchGiftCard.findOne({
    reference: String(req.params.reference).toUpperCase(),
  }).select('+code');
  if (!card || !card.buyer?.equals(req.user!._id)) throw ApiError.notFound('No such gift card');
  if (card.status === 'pending' && card.checkoutId) {
    await applyVerifiedGiftCard(card, await getCheckout(card.checkoutId));
  }
  const fresh = await MatchGiftCard.findById(card._id).select('+code');
  res.json({ success: true, data: { card: giftCardView(fresh!) } });
}

/** Claims a card: credit into the wallet, or Match+ days onto the profile. */
export async function redeemGiftCard(req: Request, res: Response): Promise<void> {
  const { code } = req.body as MatchRedeemInput;
  const result = await redeem(code, req.user!._id);
  if (result.plusUntil) {
    const profile = await MatchProfile.findOne({ user: req.user!._id });
    if (profile) {
      hub.update({
        userId: String(profile.user),
        gender: profile.gender,
        plus: isPlus(profile),
        verified: Boolean(profile.verifiedAt),
        blocked: profile.blocked.map(String),
      });
    }
  }
  res.json({
    success: true,
    data: {
      label: giftCardLabel(result.card),
      kind: result.card.kind,
      fromName: result.card.fromName,
      message: result.card.message,
      creditMinor: result.creditMinor,
      plusUntil: result.plusUntil,
    },
  });
}
