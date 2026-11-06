import type { Request, Response } from 'express';
import { env } from '../config/env';
import { MatchBrandOrder, MatchBrandProduct, type IMatchBrandOrder } from '../models/MatchMoney';
import { audit } from '../services/audit';
import { bachsConfigured, createCheckout, getCheckout } from '../services/bachs';
import {
  applyVerifiedBrandOrder,
  brandReference,
  faceValues,
  fulfil,
  markPaid,
  priceMinor,
  syncCatalogue,
} from '../services/brandCards';
import { addCredit, MATCH_CURRENCY } from '../services/matchWallet';
import { balance, reloadlyConfigured } from '../services/reloadly';
import { ApiError } from '../utils/ApiError';
import type { MatchBrandBuyInput, MatchBrandProductInput } from '../validators/match.validators';

/**
 * Other brands' gift cards in Match (Chowdeck, Jumia…), through Reloadly.
 * Buyers see the brands staff switched on, priced in naira; staff sync the
 * catalogue, choose brands and markup, and settle anything stuck.
 */

const payments = () => bachsConfigured() || !env.isProduction;

/** An order as its buyer sees it: the code only once it is in. */
function orderView(order: IMatchBrandOrder) {
  return {
    reference: order.reference,
    brand: order.brand,
    productName: order.productName,
    logoUrl: order.logoUrl,
    faceValue: order.faceValue,
    faceCurrency: order.faceCurrency,
    priceMinor: order.priceMinor,
    toName: order.toName,
    status: order.status,
    code: order.status === 'fulfilled' ? order.code : null,
    redeemInstruction: order.redeemInstruction,
    test: order.mode === 'test',
    createdAt: order.createdAt,
  };
}

/** The brands on sale, with their amounts and naira prices, and this person's orders. */
export async function listBrandCards(req: Request, res: Response): Promise<void> {
  const available = reloadlyConfigured() && payments();
  const [products, orders] = await Promise.all([
    available ? MatchBrandProduct.find({ enabled: true }).sort({ brand: 1 }) : [],
    MatchBrandOrder.find({ buyer: req.user!._id, status: { $nin: ['pending', 'failed'] } })
      .select('+code')
      .sort({ createdAt: -1 })
      .limit(20),
  ]);
  res.json({
    success: true,
    data: {
      available,
      products: products
        .map((product) => ({
          productId: product.productId,
          brand: product.brand,
          name: product.name,
          logoUrl: product.logoUrl,
          currency: product.recipientCurrency,
          redeemInstruction: product.redeemInstruction,
          amounts: faceValues(product)
            .map((face) => ({ face, priceMinor: priceMinor(product, face) }))
            .filter(
              (amount): amount is { face: number; priceMinor: number } =>
                amount.priceMinor !== null,
            ),
        }))
        .filter((product) => product.amounts.length > 0),
      orders: orders.map(orderView),
    },
  });
}

/** Starts buying a brand card: a Bachs checkout back to Match, or instant in test mode. */
export async function buyBrandCard(req: Request, res: Response): Promise<void> {
  if (!reloadlyConfigured() || !payments()) {
    throw ApiError.badRequest('Brand gift cards are not available right now');
  }
  const input = req.body as MatchBrandBuyInput;
  const product = await MatchBrandProduct.findOne({ productId: input.productId, enabled: true });
  if (!product) throw ApiError.badRequest('That gift card is not on sale');
  const price = faceValues(product).includes(input.faceValue)
    ? priceMinor(product, input.faceValue)
    : null;
  if (!price) throw ApiError.badRequest('Choose one of the amounts shown');
  const reference = brandReference();
  const base = {
    reference,
    buyer: req.user!._id,
    productId: product.productId,
    brand: product.brand,
    productName: product.name,
    logoUrl: product.logoUrl,
    faceValue: input.faceValue,
    faceCurrency: product.recipientCurrency,
    priceMinor: price,
    currency: MATCH_CURRENCY,
    toName: input.toName,
    redeemInstruction: product.redeemInstruction,
  };

  if (!bachsConfigured()) {
    /* Outside production with no Bachs: paid at once, then bought from Reloadly's sandbox. */
    const order = await MatchBrandOrder.create({ ...base, mode: 'test' });
    const settled = await markPaid(order, new Date());
    const fresh = await MatchBrandOrder.findById(settled._id).select('+code');
    res.status(201).json({ success: true, data: { order: orderView(fresh!) } });
    return;
  }

  const back = `${env.matchUrl}/?brandcard=${encodeURIComponent(reference)}`;
  const checkout = await createCheckout({
    amountMinor: price,
    currency: MATCH_CURRENCY,
    email: req.user!.email,
    name: req.user!.name,
    reference,
    successUrl: back,
    cancelUrl: `${back}&cancelled=1`,
    metadata: { kind: 'match_brand_card' },
  });
  await MatchBrandOrder.create({
    ...base,
    mode: 'live',
    checkoutId: checkout.checkoutId,
    checkoutUrl: checkout.checkoutUrl,
  });
  res.status(201).json({ success: true, data: { checkoutUrl: checkout.checkoutUrl } });
}

/** Back from checkout: settles the payment, nudges Reloadly, and shows the order. */
export async function verifyBrandCard(req: Request, res: Response): Promise<void> {
  const order = await MatchBrandOrder.findOne({
    reference: String(req.params.reference).toUpperCase(),
  });
  if (!order || !order.buyer.equals(req.user!._id)) throw ApiError.notFound('No such gift card');
  if (order.status === 'pending' && order.checkoutId) {
    await applyVerifiedBrandOrder(order, await getCheckout(order.checkoutId));
  } else if (order.status === 'paid' || order.status === 'stuck') {
    await fulfil(order._id);
  }
  const fresh = await MatchBrandOrder.findById(order._id).select('+code');
  res.json({ success: true, data: { order: orderView(fresh!) } });
}

/* --------------------------------------------------------------- staff --- */

/** Every synced product, recent orders, and the Reloadly wallet. */
export async function adminBrandCards(_req: Request, res: Response): Promise<void> {
  const [products, orders] = await Promise.all([
    MatchBrandProduct.find().sort({ enabled: -1, brand: 1 }).limit(500),
    MatchBrandOrder.find({ status: { $ne: 'pending' } })
      .sort({ createdAt: -1 })
      .limit(40)
      .populate<{ buyer: { name: string; email: string } | null }>('buyer', 'name email'),
  ]);
  let wallet: { balance: number; currencyCode: string } | null = null;
  if (reloadlyConfigured()) wallet = await balance().catch(() => null);
  res.json({
    success: true,
    data: {
      configured: reloadlyConfigured(),
      environment: env.reloadly.environment,
      wallet,
      products: products.map((product) => ({
        productId: product.productId,
        brand: product.brand,
        name: product.name,
        logoUrl: product.logoUrl,
        currency: product.recipientCurrency,
        sellable: product.senderCurrency === MATCH_CURRENCY,
        discountPct: product.discountPct,
        enabled: product.enabled,
        markupPct: product.markupPct,
        amounts: faceValues(product).map((face) => ({
          face,
          priceMinor: priceMinor(product, face),
        })),
        syncedAt: product.syncedAt,
      })),
      orders: orders.map((order) => ({
        reference: order.reference,
        brand: order.brand,
        faceValue: order.faceValue,
        faceCurrency: order.faceCurrency,
        priceMinor: order.priceMinor,
        costAmount: order.costAmount,
        costCurrency: order.costCurrency,
        status: order.status,
        problem: order.problem,
        attempts: order.attempts,
        mode: order.mode,
        buyer: order.buyer ? `${order.buyer.name} · ${order.buyer.email}` : '',
        createdAt: order.createdAt,
      })),
    },
  });
}

export async function syncBrandCards(req: Request, res: Response): Promise<void> {
  if (!reloadlyConfigured()) throw ApiError.badRequest('Add the Reloadly keys first');
  const count = await syncCatalogue();
  await audit(req, {
    action: 'match.brandcards.synced',
    targetType: 'match_brand_card',
    targetId: 'catalogue',
    targetLabel: env.reloadly.country,
    summary: `Synced ${count} gift card products for ${env.reloadly.country} from Reloadly`,
  });
  res.json({ success: true, data: { products: count } });
}

/** Puts a brand on sale or takes it off, or changes its markup. */
export async function updateBrandProduct(req: Request, res: Response): Promise<void> {
  const input = req.body as MatchBrandProductInput;
  const product = await MatchBrandProduct.findOneAndUpdate(
    { productId: Number(req.params.productId) },
    { $set: input },
    { new: true },
  );
  if (!product) throw ApiError.notFound('No such product');
  await audit(req, {
    action: 'match.brandcard.product',
    targetType: 'match_brand_card',
    targetId: String(product.productId),
    targetLabel: product.name,
    summary: `${product.name}: ${product.enabled ? 'on sale' : 'off sale'}, ${product.markupPct}% markup`,
    after: input,
  });
  res.json({
    success: true,
    data: { productId: product.productId, enabled: product.enabled, markupPct: product.markupPct },
  });
}

/** Tries a stuck order again — it checks Reloadly first, so a card is never bought twice. */
export async function retryBrandOrder(req: Request, res: Response): Promise<void> {
  const order = await MatchBrandOrder.findOne({ reference: String(req.params.reference) });
  if (!order || !['paid', 'stuck'].includes(order.status))
    throw ApiError.badRequest('Only a paid, unfilled order can be retried');
  await MatchBrandOrder.updateOne({ _id: order._id }, { lockedUntil: null });
  const after = await fulfil(order._id);
  await audit(req, {
    action: 'match.brandcard.retried',
    targetType: 'match_brand_card',
    targetId: order._id,
    targetLabel: order.reference,
    summary: `Retried ${order.brand} card ${order.reference}: ${after?.status ?? 'unknown'}`,
  });
  res.json({ success: true, data: { status: after?.status, problem: after?.problem ?? '' } });
}

/** Gives a stuck order's money back as Match credit, and closes it. */
export async function refundBrandOrder(req: Request, res: Response): Promise<void> {
  const order = await MatchBrandOrder.findOneAndUpdate(
    { reference: String(req.params.reference), status: 'stuck', reloadlyTransactionId: null },
    { status: 'refunded', lockedUntil: null },
    { new: true },
  );
  if (!order) throw ApiError.badRequest('Only a stuck order Reloadly never filled can be refunded');
  await addCredit(
    order.buyer,
    order.priceMinor,
    'refund',
    order.reference,
    `${order.brand} gift card — refunded`,
    'paid',
  );
  await audit(req, {
    action: 'match.brandcard.refunded',
    targetType: 'match_brand_card',
    targetId: order._id,
    targetLabel: order.reference,
    summary: `Refunded ${order.brand} card ${order.reference} as Match credit`,
  });
  res.json({ success: true, data: { status: order.status } });
}
