import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  CURRENCY,
  FREE_SHIPPING_THRESHOLD_MINOR,
  MAX_QUANTITY_PER_LINE,
  SHIPPING_FLAT_MINOR,
} from '../constants';
import { MerchProduct } from '../models/MerchProduct';
import { Order, type IOrderLine, type IOrderShare } from '../models/Order';
import { env } from '../config/env';
import { allocate, applyPlatformFee } from '../services/money';
import { initializeTransaction, paystackConfigured } from '../services/paystack';
import { toOrderResponse } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type { CreateOrderInput } from '../validators/merch.validators';

/** Short, unambiguous reference. No 0/O/1/I, so it survives being read aloud. */
function orderReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  const body = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return `DECK-${body}`;
}

/** Stands in for "Deck itself" when grouping an order's lines by who sold them. */
const DECK = 'deck';

export function shippingFor(subtotalMinor: number): number {
  return subtotalMinor >= FREE_SHIPPING_THRESHOLD_MINOR ? 0 : SHIPPING_FLAT_MINOR;
}

/**
 * Places an order.
 *
 * The client sends SKUs and quantities — never prices. Every line is priced from
 * the database, stock is checked and decremented, and the totals are computed
 * here. A tampered cart can therefore change *what* is ordered but never what
 * it costs.
 *
 * Once stock is reserved the order is created `awaiting_payment` and a Paystack
 * transaction is opened for it, using the order reference as the transaction
 * reference. The response carries an `authorizationUrl` for the browser to
 * redirect to. The order only becomes `paid` when Paystack itself confirms the
 * charge — see `payment.controller.ts`.
 *
 * With no PAYSTACK_SECRET_KEY set the shop still works end to end; orders just
 * stay `awaiting_payment` with no redirect.
 */
export async function createOrder(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateOrderInput;
  const user = req.user!;

  /*
   * Collapse duplicate SKUs, then re-check the cap against the merged total.
   * Zod enforces the limit per line, which on its own is bypassable by sending
   * the same SKU twice — ten plus ten would arrive as two valid lines.
   */
  const wanted = new Map<string, number>();
  for (const line of input.lines) {
    wanted.set(line.sku, (wanted.get(line.sku) ?? 0) + line.quantity);
  }

  for (const [sku, quantity] of wanted) {
    if (quantity > MAX_QUANTITY_PER_LINE) {
      throw ApiError.badRequest(`You can order at most ${MAX_QUANTITY_PER_LINE} of ${sku}`);
    }
  }

  const skus = [...wanted.keys()];
  const products = await MerchProduct.find({
    'variants.sku': { $in: skus },
    status: 'approved',
    active: true,
  });

  const lines: IOrderLine[] = [];
  let subtotalMinor = 0;

  for (const sku of skus) {
    const quantity = wanted.get(sku)!;
    const product = products.find((candidate) =>
      candidate.variants.some((variant) => variant.sku === sku),
    );
    if (!product) throw ApiError.badRequest(`"${sku}" is no longer available`);

    const variant = product.variants.find((candidate) => candidate.sku === sku)!;
    if (variant.stock < quantity) {
      throw ApiError.conflict(
        variant.stock === 0
          ? `${product.name} (${variant.size ?? variant.sku}) just sold out`
          : `Only ${variant.stock} left of ${product.name} (${variant.size ?? variant.sku})`,
      );
    }

    subtotalMinor += product.priceMinor * quantity;

    lines.push({
      product: product._id,
      sku,
      name: product.name,
      size: variant.size,
      colour: variant.colour,
      unitPriceMinor: product.priceMinor,
      quantity,
      image: product.images[0],
      seller: product.seller,
    });
  }

  const shippingMinor = shippingFor(subtotalMinor);

  /*
   * Work out what Deck owes each seller.
   *
   * Every kobo of this charge lands in Deck's own account; these rows are the
   * debt that creates. They are computed once, here, and frozen — the ledger
   * reads them back rather than recalculating, so a later change to the fee
   * percentage cannot silently rewrite what someone earned last month.
   *
   * Shipping goes to whoever posts the parcel, allocated in proportion to the
   * value each party contributed. Deck's own goods take a share too, which
   * simply stays with Deck. Using `allocate` rather than rounding each share
   * separately guarantees the parts sum to exactly what the buyer paid.
   */
  const parties = [...new Set(lines.map((line) => line.seller?.toString() ?? DECK))];
  const goodsByParty = new Map<string, number>(parties.map((party) => [party, 0]));
  for (const line of lines) {
    const key = line.seller?.toString() ?? DECK;
    goodsByParty.set(key, goodsByParty.get(key)! + line.unitPriceMinor * line.quantity);
  }

  const shippingByParty = allocate(
    shippingMinor,
    parties.map((party) => goodsByParty.get(party)!),
  );

  const sellerShares: IOrderShare[] = [];
  for (const [index, party] of parties.entries()) {
    if (party === DECK) continue;

    const goodsMinor = goodsByParty.get(party)!;
    /* The fee applies to goods only. Shipping is a pass-through cost, and
       commission on postage would mean Deck earning from the courier. */
    const { feeMinor } = applyPlatformFee(goodsMinor);
    const shipping = shippingByParty[index];

    sellerShares.push({
      seller: new mongoose.Types.ObjectId(party),
      goodsMinor,
      platformFeeMinor: feeMinor,
      shippingMinor: shipping,
      netMinor: goodsMinor - feeMinor + shipping,
    });
  }

  const platformFeeMinor = sellerShares.reduce((total, share) => total + share.platformFeeMinor, 0);

  /*
   * Reserve stock with a conditional update per line: the filter re-checks
   * availability, so two people buying the last tee at once cannot both win.
   * If any line loses the race, the ones already taken are handed back.
   */
  const reserved: { sku: string; quantity: number }[] = [];
  let createdOrderId: string | null = null;
  try {
    for (const line of lines) {
      const result = await MerchProduct.updateOne(
        {
          _id: line.product,
          variants: { $elemMatch: { sku: line.sku, stock: { $gte: line.quantity } } },
        },
        { $inc: { 'variants.$.stock': -line.quantity } },
      );
      if (result.modifiedCount !== 1) {
        throw ApiError.conflict(`${line.name} sold out while you were checking out`);
      }
      reserved.push({ sku: line.sku, quantity: line.quantity });
    }

    const reference = orderReference();
    const order = await Order.create({
      reference,
      user: user._id,
      email: input.email,
      lines,
      subtotalMinor,
      shippingMinor,
      totalMinor: subtotalMinor + shippingMinor,
      platformFeeMinor,
      sellerShares,
      currency: CURRENCY,
      status: 'awaiting_payment',
      shippingAddress: {
        ...input.shippingAddress,
        line2: input.shippingAddress.line2 || undefined,
      },
    });

    createdOrderId = order.id;

    if (paystackConfigured()) {
      const transaction = await initializeTransaction({
        email: input.email,
        amountMinor: order.totalMinor,
        reference,
        currency: order.currency,
        callbackUrl: `${env.paystackCallbackUrl}?reference=${reference}`,
        metadata: { orderId: order.id, deckReference: reference, kind: 'order' },
      });

      order.payment = {
        provider: 'paystack',
        reference: transaction.reference,
        authorizationUrl: transaction.authorizationUrl,
      };
      await order.save();
    }

    res.status(201).json({
      success: true,
      data: {
        ...toOrderResponse(order),
        // Present only when card payments are configured.
        authorizationUrl: order.payment?.authorizationUrl ?? null,
      },
    });
  } catch (error) {
    /*
     * Unwind everything this request created. Releasing stock is not enough on
     * its own: if the order row survived a failed payment hand-off it would sit
     * in the customer's history as an unpayable `awaiting_payment` order, since
     * there is no authorization URL to return to.
     */
    await Promise.all([
      ...reserved.map((entry) =>
        MerchProduct.updateOne(
          { 'variants.sku': entry.sku },
          { $inc: { 'variants.$.stock': entry.quantity } },
        ),
      ),
      createdOrderId ? Order.deleteOne({ _id: createdOrderId }) : Promise.resolve(),
    ]);
    throw error;
  }
}

export async function listMyOrders(req: Request, res: Response): Promise<void> {
  const orders = await Order.find({ user: req.user!._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ success: true, data: orders.map(toOrderResponse) });
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const order = await Order.findOne({ reference: req.params.reference.toUpperCase() });
  if (!order) throw ApiError.notFound('We could not find that order');

  const user = req.user!;
  if (order.user.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('That order belongs to someone else');
  }

  res.json({ success: true, data: toOrderResponse(order) });
}

/** Quote shipping for a cart before checkout, so the UI never guesses. */
export async function quoteShipping(req: Request, res: Response): Promise<void> {
  const subtotal = Math.max(0, Number(req.query.subtotalMinor ?? 0) || 0);
  res.json({
    success: true,
    data: {
      subtotalMinor: subtotal,
      shippingMinor: shippingFor(subtotal),
      freeShippingThresholdMinor: FREE_SHIPPING_THRESHOLD_MINOR,
      currency: CURRENCY,
    },
  });
}
