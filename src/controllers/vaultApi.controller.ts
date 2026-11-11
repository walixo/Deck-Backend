import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { GiftCard } from '../models/GiftCard';
import { VaultIssuer, VaultProduct, type IVaultIssuer } from '../models/VaultIssuer';
import { VaultOrder } from '../models/VaultOrder';
import { VaultPartner, type IVaultPartner, type VaultMode } from '../models/VaultPartner';
import { ApiError } from '../utils/ApiError';
import {
  discountFor,
  expiryDaysFor,
  partnerBalanceMinor,
  placePartnerOrder,
  redeemCard,
  revealCard,
} from '../services/vault';
import { notifyPartner } from '../services/vaultFulfil';
import { hashSecret, normaliseCode, readKey } from '../services/vaultKeys';
import type {
  apiBalanceSchema,
  apiOrderSchema,
  apiRedeemSchema,
} from '../validators/vault.validators';
import type { z } from 'zod';

/**
 * The Vault server API — `/api/vault/v1`.
 *
 * Two audiences, one router, told apart by the prefix on the key they send.
 * A `vlt_` key belongs to a distributor and can buy cards; a `vli_` key
 * belongs to a merchant and can look one up or redeem it. Neither can do the
 * other's work, which is checked per route rather than assumed.
 *
 * Everything here answers in minor units. A decimal amount is the single most
 * common source of money bugs across client languages, and an integer number
 * of kobo cannot be rounded wrong by somebody's float.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      vaultPartner?: IVaultPartner;
      vaultIssuer?: IVaultIssuer;
      vaultMode?: VaultMode;
    }
  }
}

const UNAUTHORISED = 'Send a valid Vault API key as a Bearer token';

/** Resolves `Authorization: Bearer vlt_…` or `vli_…` to an account and mode. */
export async function requireVaultKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const claim = readKey(key);
  if (!claim) throw new ApiError(401, UNAUTHORISED);

  const hash = hashSecret(key);

  if (claim.audience === 'partner') {
    const partner = await VaultPartner.findOne({ [`keys.${claim.mode}.hash`]: hash }).select(
      '+webhookSecret',
    );
    if (!partner) throw new ApiError(401, UNAUTHORISED);
    if (partner.status === 'suspended') throw ApiError.forbidden('This account is suspended');
    req.vaultPartner = partner;
  } else {
    const issuer = await VaultIssuer.findOne({ [`keys.${claim.mode}.hash`]: hash });
    if (!issuer) throw new ApiError(401, UNAUTHORISED);
    req.vaultIssuer = issuer;
  }

  req.vaultMode = claim.mode;
  next();
}

/** Guards a route to one side of the product. */
export function requirePartner(req: Request): IVaultPartner {
  if (!req.vaultPartner) {
    throw ApiError.forbidden('This endpoint needs a distributor key (vlt_…)');
  }
  return req.vaultPartner;
}

export function requireIssuer(req: Request): IVaultIssuer {
  if (!req.vaultIssuer) {
    throw ApiError.forbidden('This endpoint needs an issuer key (vli_…)');
  }
  return req.vaultIssuer;
}

/* -------------------------------------------------------------------- ping */

/** Tells a caller which account and mode their key is for. */
export async function whoAmI(req: Request, res: Response): Promise<void> {
  const mode = req.vaultMode!;

  if (req.vaultPartner) {
    const partner = req.vaultPartner;
    res.json({
      success: true,
      data: {
        audience: 'partner',
        id: partner.slug,
        name: partner.name,
        mode,
        status: partner.status,
        balanceMinor: await partnerBalanceMinor(partner._id, mode),
      },
    });
    return;
  }

  const issuer = requireIssuer(req);
  res.json({
    success: true,
    data: {
      audience: 'issuer',
      id: issuer.slug,
      name: issuer.name,
      mode,
      status: issuer.status,
      fulfilment: issuer.fulfilment,
    },
  });
}

/* --------------------------------------------------------------- catalogue */

/**
 * Every card on sale, with the price a distributor actually pays.
 *
 * The discount is resolved here rather than left for the caller to work out
 * from two fields, because a partner computing it themselves is a partner who
 * will eventually compute it differently from Vault and dispute an invoice.
 */
export async function listCatalogue(req: Request, res: Response): Promise<void> {
  requirePartner(req);

  const issuers = await VaultIssuer.find({ status: 'live' }).sort({ name: 1 });
  const products = await VaultProduct.find({
    issuer: { $in: issuers.map((issuer) => issuer._id) },
    status: 'active',
  });

  const byIssuer = new Map(issuers.map((issuer) => [issuer._id.toString(), issuer]));

  res.json({
    success: true,
    data: issuers.map((issuer) => ({
      id: issuer.slug,
      name: issuer.name,
      tagline: issuer.tagline,
      logoUrl: issuer.logoUrl,
      currency: issuer.currency,
      terms: issuer.terms,
      products: products
        .filter((product) => product.issuer.equals(issuer._id))
        .map((product) => {
          const owner = byIssuer.get(product.issuer.toString())!;
          const discountPercent = discountFor(owner, product);
          return {
            id: product.slug,
            name: product.name,
            artworkUrl: product.artworkUrl,
            currency: product.currency,
            denominationType: product.denominationType,
            denominationsMinor: product.denominationsMinor,
            minMinor: product.minMinor,
            maxMinor: product.maxMinor,
            discountPercent,
            expiryDays: expiryDaysFor(owner, product),
            redeemInstructions: product.redeemInstructions,
          };
        }),
    })),
  });
}

/* ------------------------------------------------------------------ orders */

/**
 * Buys cards.
 *
 * The `Idempotency-Key` header is honoured and strongly encouraged: minting
 * costs real money and cannot be undone by retrying, so a caller whose request
 * times out needs a way to ask again without risking a second order. Sending
 * the same key returns the first order rather than creating another.
 */
export async function createOrder(req: Request, res: Response): Promise<void> {
  const partner = requirePartner(req);
  const mode = req.vaultMode!;
  const input = req.body as z.infer<typeof apiOrderSchema>;

  /* `issuer/product`, or just `product` when it is unambiguous. Accepting the
     qualified form means a partner never has to care that two merchants both
     called their card "standard". */
  const [left, right] = input.product.split('/');
  const productSlug = (right ?? left).toLowerCase();
  const issuerSlug = right ? left.toLowerCase() : null;

  const issuer = issuerSlug
    ? await VaultIssuer.findOne({ slug: issuerSlug, status: 'live' }).select('+fulfilSecret')
    : null;
  if (issuerSlug && !issuer) throw ApiError.notFound('No live issuer with that id');

  const products = await VaultProduct.find({
    slug: productSlug,
    status: 'active',
    ...(issuer ? { issuer: issuer._id } : {}),
  });

  if (products.length === 0) throw ApiError.notFound('No card on sale with that id');
  if (products.length > 1) {
    throw ApiError.badRequest(
      'More than one issuer sells a card with that id — qualify it as "issuer/product"',
    );
  }

  const product = products[0];

  /* Re-read by id rather than reusing the one found by slug above: a single
     query means a single inferred type, and `+fulfilSecret` is needed here
     either way for merchant-minted cards. */
  const owner = await VaultIssuer.findById(product.issuer).select('+fulfilSecret');
  if (!owner) throw ApiError.notFound('That card no longer has an issuer');

  const { order, cards } = await placePartnerOrder({
    partner,
    mode,
    issuer: owner,
    product,
    quantity: input.quantity,
    unitFaceMinor: input.amountMinor,
    idempotencyKey: req.header('idempotency-key')?.trim() || null,
    recipientName: input.recipientName,
    recipientEmail: input.recipientEmail,
    giftMessage: input.giftMessage,
  });

  const revealed = await Promise.all(
    cards.map(async (card) => ({
      id: card._id.toString(),
      ...(await revealCard(card._id)),
      faceValueMinor: card.faceValueMinor,
      balanceMinor: card.balanceMinor,
      currency: card.currency,
      expiresAt: card.expiresAt,
    })),
  );

  /* After the response is built, never before it: a partner's webhook endpoint
     being slow must not delay the cards they are waiting on. */
  void notifyPartner(partner, mode, 'order.fulfilled', {
    reference: order.reference,
    status: order.status,
    quantity: order.quantity,
    chargedMinor: order.chargedMinor,
  });

  res.status(201).json({
    success: true,
    data: {
      reference: order.reference,
      status: order.status,
      issuer: owner.slug,
      product: product.slug,
      quantity: order.quantity,
      unitFaceMinor: order.unitFaceMinor,
      faceTotalMinor: order.faceTotalMinor,
      discountMinor: order.discountMinor,
      chargedMinor: order.chargedMinor,
      currency: order.currency,
      balanceMinor: await partnerBalanceMinor(partner._id, mode),
      cards: revealed,
    },
  });
}

/** One order, with its cards. Safe to poll after a timeout. */
export async function getOrder(req: Request, res: Response): Promise<void> {
  const partner = requirePartner(req);

  const order = await VaultOrder.findOne({
    reference: req.params.reference.toUpperCase(),
    partner: partner._id,
  });
  if (!order) throw ApiError.notFound('No order with that reference');

  const cards = await GiftCard.find({ order: order._id });
  const revealed = await Promise.all(
    cards.map(async (card) => ({
      id: card._id.toString(),
      ...(await revealCard(card._id)),
      faceValueMinor: card.faceValueMinor,
      balanceMinor: card.balanceMinor,
      status: card.status,
      currency: card.currency,
      expiresAt: card.expiresAt,
    })),
  );

  res.json({
    success: true,
    data: {
      reference: order.reference,
      status: order.status,
      failureReason: order.failureReason || undefined,
      quantity: order.quantity,
      unitFaceMinor: order.unitFaceMinor,
      faceTotalMinor: order.faceTotalMinor,
      discountMinor: order.discountMinor,
      chargedMinor: order.chargedMinor,
      currency: order.currency,
      createdAt: order.createdAt,
      cards: revealed,
    },
  });
}

export async function listOrders(req: Request, res: Response): Promise<void> {
  const partner = requirePartner(req);
  const mode = req.vaultMode!;
  const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);

  const orders = await VaultOrder.find({ partner: partner._id, mode })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate<{ issuer: IVaultIssuer }>('issuer', 'slug name');

  res.json({
    success: true,
    data: orders.map((order) => ({
      reference: order.reference,
      status: order.status,
      issuer: (order.issuer as unknown as IVaultIssuer)?.slug,
      quantity: order.quantity,
      chargedMinor: order.chargedMinor,
      currency: order.currency,
      createdAt: order.createdAt,
    })),
  });
}

/** The distributor's prepaid balance. */
export async function getBalance(req: Request, res: Response): Promise<void> {
  const partner = requirePartner(req);
  const mode = req.vaultMode!;
  res.json({
    success: true,
    data: {
      mode,
      balanceMinor: await partnerBalanceMinor(partner._id, mode),
      currency: env.currency,
    },
  });
}

/* ----------------------------------------------------------- issuer routes */

/**
 * Looks a card up without spending it — what a till does before it commits.
 *
 * Scoped to the calling issuer's own cards. An issuer who could query any
 * code in Vault would have an oracle for guessing other merchants' cards.
 */
export async function checkCard(req: Request, res: Response): Promise<void> {
  const issuer = requireIssuer(req);
  const mode = req.vaultMode!;
  const input = req.body as z.infer<typeof apiBalanceSchema>;

  const card = await GiftCard.findOne({
    'code.hash': hashSecret(normaliseCode(input.code)),
    issuer: issuer._id,
    mode,
  });
  if (!card) throw ApiError.notFound('No card matches that code');

  /* Expiry is reported from the date rather than only from the stored status,
     so a card that lapsed since its last write reads correctly here. */
  const expired = Boolean(card.expiresAt && card.expiresAt.getTime() < Date.now());

  res.json({
    success: true,
    data: {
      id: card._id.toString(),
      last4: card.code.last4,
      status: expired && card.status === 'active' ? 'expired' : card.status,
      faceValueMinor: card.faceValueMinor,
      balanceMinor: card.balanceMinor,
      currency: card.currency,
      issuedAt: card.issuedAt,
      expiresAt: card.expiresAt,
      requiresPin: Boolean(card.pin),
    },
  });
}

/** Spends part or all of a card. */
export async function redeem(req: Request, res: Response): Promise<void> {
  const issuer = requireIssuer(req);
  const mode = req.vaultMode!;
  const input = req.body as z.infer<typeof apiRedeemSchema>;

  const result = await redeemCard({
    code: input.code,
    pin: input.pin,
    amountMinor: input.amountMinor,
    mode,
    issuer: issuer._id,
    source: 'issuer_api',
  });

  res.json({
    success: true,
    data: {
      reference: result.reference,
      cardId: result.card._id.toString(),
      redeemedMinor: result.redeemedMinor,
      balanceMinor: result.balanceMinor,
      status: result.card.status,
      currency: result.card.currency,
    },
  });
}
