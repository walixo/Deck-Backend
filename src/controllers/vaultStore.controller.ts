import type { Request, Response } from 'express';
import { env } from '../config/env';
import { VaultIssuer, VaultProduct } from '../models/VaultIssuer';
import { VaultOrder } from '../models/VaultOrder';
import { ApiError } from '../utils/ApiError';
import { bachsConfigured, checkoutReturnUrls, createCheckout } from '../services/bachs';
import { assertDenomination, discountFor, expiryDaysFor, priceOrder } from '../services/vault';
import { orderReference } from '../services/vaultKeys';
import type { buyCardSchema } from '../validators/vault.validators';
import type { z } from 'zod';

/**
 * The public face of Vault: the shop at vault.onedeck.africa where a person
 * buys a card for themselves or sends one to someone else.
 *
 * Consumers pay face value. The distributor discount is a wholesale rate for
 * businesses buying in volume and committing to a balance; passing it to a
 * walk-up buyer would undercut every distributor on the platform using the
 * issuer's own margin, which is a fast way to have no distributors.
 */

/** Every live issuer and their active cards. */
export async function browse(_req: Request, res: Response): Promise<void> {
  const issuers = await VaultIssuer.find({ status: 'live' }).sort({ name: 1 });
  const products = await VaultProduct.find({
    issuer: { $in: issuers.map((issuer) => issuer._id) },
    status: 'active',
  });

  res.json({
    success: true,
    data: issuers.map((issuer) => ({
      slug: issuer.slug,
      name: issuer.name,
      tagline: issuer.tagline,
      logoUrl: issuer.logoUrl,
      currency: issuer.currency,
      products: products
        .filter((product) => product.issuer.equals(issuer._id))
        .map((product) => ({
          slug: product.slug,
          name: product.name,
          artworkUrl: product.artworkUrl,
          denominationType: product.denominationType,
          denominationsMinor: product.denominationsMinor,
          minMinor: product.minMinor,
          maxMinor: product.maxMinor,
        })),
    })),
  });
}

/** One issuer's shop page. */
export async function getStorefront(req: Request, res: Response): Promise<void> {
  const issuer = await VaultIssuer.findOne({ slug: req.params.slug.toLowerCase(), status: 'live' });
  if (!issuer) throw ApiError.notFound('No shop at that address');

  const products = await VaultProduct.find({ issuer: issuer._id, status: 'active' });

  res.json({
    success: true,
    data: {
      slug: issuer.slug,
      name: issuer.name,
      tagline: issuer.tagline,
      description: issuer.description,
      logoUrl: issuer.logoUrl,
      terms: issuer.terms,
      supportEmail: issuer.supportEmail,
      website: issuer.website,
      currency: issuer.currency,
      products: products.map((product) => ({
        slug: product.slug,
        name: product.name,
        artworkUrl: product.artworkUrl,
        redeemInstructions: product.redeemInstructions,
        denominationType: product.denominationType,
        denominationsMinor: product.denominationsMinor,
        minMinor: product.minMinor,
        maxMinor: product.maxMinor,
        expiryDays: expiryDaysFor(issuer, product),
        /* Shown so a business browsing the shop can see there is a wholesale
           rate worth signing up for, without being charged it here. */
        distributorDiscountPercent: discountFor(issuer, product),
      })),
    },
  });
}

/**
 * Starts a purchase.
 *
 * Nothing is minted here. The order is written `pending` and the cards appear
 * only when Bachs confirms the payment — see `applyVerifiedVaultOrder`. An
 * abandoned checkout therefore costs a row and no value.
 */
export async function buy(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof buyCardSchema>;

  if (!bachsConfigured()) {
    throw new ApiError(503, 'Card payments are not configured on this deployment');
  }

  const issuer = await VaultIssuer.findOne({ slug: req.params.slug.toLowerCase(), status: 'live' });
  if (!issuer) throw ApiError.notFound('No shop at that address');

  const product = await VaultProduct.findOne({
    issuer: issuer._id,
    slug: input.product.toLowerCase(),
    status: 'active',
  });
  if (!product) throw ApiError.notFound('That card is not on sale');

  const unitFaceMinor = Math.round(input.amount * 100);
  assertDenomination(product, unitFaceMinor);

  /* Face value — no distributor discount. Deck's fee still comes out of the
     charge through the one function that knows the rounding rule. */
  const pricing = priceOrder(0, 1, unitFaceMinor);

  const reference = orderReference();
  const { successUrl, cancelUrl } = checkoutReturnUrls(reference);

  const checkout = await createCheckout({
    amountMinor: pricing.chargedMinor,
    currency: issuer.currency,
    email: req.user!.email,
    name: req.user!.name,
    reference,
    successUrl,
    cancelUrl,
    metadata: { kind: 'vault_card', issuer: issuer.slug, product: product.slug },
  });

  const order = await VaultOrder.create({
    reference,
    mode: 'live',
    buyerKind: 'consumer',
    user: req.user!._id,
    issuer: issuer._id,
    product: product._id,
    quantity: 1,
    unitFaceMinor,
    currency: issuer.currency,
    status: 'pending',
    paymentReference: checkout.checkoutId,
    recipientName: input.recipientName ?? '',
    recipientEmail: input.recipientEmail ?? '',
    giftMessage: input.giftMessage ?? '',
    ...pricing,
  });

  res.status(201).json({
    success: true,
    data: {
      reference: order.reference,
      chargedMinor: order.chargedMinor,
      currency: order.currency,
      checkoutUrl: checkout.checkoutUrl,
    },
  });
}

/** Where a buyer lands after paying — safe to poll while the webhook lands. */
export async function getMyOrder(req: Request, res: Response): Promise<void> {
  const order = await VaultOrder.findOne({
    reference: req.params.reference.toUpperCase(),
    user: req.user!._id,
  });
  if (!order) throw ApiError.notFound('No order with that reference');

  res.json({
    success: true,
    data: {
      reference: order.reference,
      status: order.status,
      failureReason: order.failureReason || undefined,
      unitFaceMinor: order.unitFaceMinor,
      chargedMinor: order.chargedMinor,
      currency: order.currency,
      recipientName: order.recipientName,
      createdAt: order.createdAt,
    },
  });
}

/** Headline numbers for the Vault landing page. */
export async function getVaultStats(_req: Request, res: Response): Promise<void> {
  const [issuers, products, orders] = await Promise.all([
    VaultIssuer.countDocuments({ status: 'live' }),
    VaultProduct.countDocuments({ status: 'active' }),
    VaultOrder.countDocuments({ status: 'fulfilled', mode: 'live' }),
  ]);

  res.json({ success: true, data: { issuers, products, orders, currency: env.currency } });
}
