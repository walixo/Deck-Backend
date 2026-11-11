import type { Request, Response } from 'express';
import type mongoose from 'mongoose';
import { env } from '../config/env';
import { CardRedemption, GiftCard } from '../models/GiftCard';
import { VaultIssuer, VaultProduct, type IVaultIssuer } from '../models/VaultIssuer';
import { VaultOrder } from '../models/VaultOrder';
import {
  VaultLedgerEntry,
  VaultPartner,
  VaultTopup,
  type IVaultPartner,
  type VaultMode,
} from '../models/VaultPartner';
import { ApiError } from '../utils/ApiError';
import { uniqueSlug } from '../utils/slug';
import { createCheckout, checkoutReturnUrls, bachsConfigured } from '../services/bachs';
import {
  discountFor,
  expiryDaysFor,
  grantTestBalance,
  issuerSummary,
  partnerBalanceMinor,
  redeemCard,
  revealCard,
} from '../services/vault';
import {
  mintApiKey,
  mintFulfilSecret,
  mintWebhookSecret,
  topupReference,
} from '../services/vaultKeys';
import type {
  consoleRedeemSchema,
  createIssuerSchema,
  createPartnerSchema,
  createProductSchema,
  mintKeySchema,
  reviewIssuerSchema,
  topupSchema,
  updateIssuerSchema,
  updatePartnerSchema,
} from '../validators/vault.validators';
import type { z } from 'zod';

/**
 * The Vault dashboard — everything a signed-in person does on
 * vault.onedeck.africa, as opposed to what their server does over the API.
 *
 * One account can be both an issuer and a distributor, and plenty will be:
 * a company that sells its own cards and resells other people's is the normal
 * case, not an edge one. So these are two independent records hanging off the
 * same user rather than a single "vault account" with a type.
 */

const toMinor = (major: number): number => Math.round(major * 100);

/* ------------------------------------------------------------------ issuer */

const issuerView = (issuer: IVaultIssuer) => ({
  id: issuer._id.toString(),
  slug: issuer.slug,
  name: issuer.name,
  tagline: issuer.tagline,
  description: issuer.description,
  logoUrl: issuer.logoUrl,
  terms: issuer.terms,
  supportEmail: issuer.supportEmail,
  website: issuer.website,
  currency: issuer.currency,
  status: issuer.status,
  reviewNote: issuer.reviewNote,
  fulfilment: issuer.fulfilment,
  fulfilUrl: issuer.fulfilUrl,
  discountPercent: issuer.discountPercent,
  defaultExpiryDays: issuer.defaultExpiryDays,
  keys: {
    test: issuer.keys?.test ? { hint: issuer.keys.test.hint, createdAt: issuer.keys.test.createdAt } : null,
    live: issuer.keys?.live ? { hint: issuer.keys.live.hint, createdAt: issuer.keys.live.createdAt } : null,
  },
  createdAt: issuer.createdAt,
});

async function myIssuerOrFail(req: Request): Promise<IVaultIssuer> {
  const issuer = await VaultIssuer.findOne({ owner: req.user!._id });
  if (!issuer) throw ApiError.notFound('You have not set up a card programme yet');
  return issuer;
}

export async function getMyIssuer(req: Request, res: Response): Promise<void> {
  const issuer = await VaultIssuer.findOne({ owner: req.user!._id });
  res.json({ success: true, data: issuer ? issuerView(issuer) : null });
}

export async function createIssuer(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof createIssuerSchema>;

  if (await VaultIssuer.exists({ owner: req.user!._id })) {
    throw ApiError.conflict('You already have a card programme');
  }

  const slug = await uniqueSlug(input.name, async (candidate) =>
    Boolean(await VaultIssuer.exists({ slug: candidate })),
  );

  const issuer = await VaultIssuer.create({
    ...input,
    owner: req.user!._id,
    slug,
    /* Minted now rather than on first use: an issuer who flips to merchant
       fulfilment should find the secret already waiting, not have to
       remember a second step before anything works. */
    fulfilSecret: mintFulfilSecret(),
  });

  res.status(201).json({ success: true, data: issuerView(issuer) });
}

export async function updateIssuer(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof updateIssuerSchema>;
  const issuer = await myIssuerOrFail(req);

  Object.assign(issuer, input);
  if (input.fulfilUrl === '') issuer.fulfilUrl = null;

  /*
   * Changing anything material puts a live programme back in review.
   *
   * These are the fields a distributor priced against or a buyer read before
   * paying. Letting a live issuer quietly halve their discount, or repoint
   * fulfilment at a new endpoint, would make the review meaningless.
   */
  const material: (keyof typeof input)[] = ['discountPercent', 'fulfilment', 'fulfilUrl', 'terms'];
  if (issuer.status === 'live' && material.some((field) => input[field] !== undefined)) {
    issuer.status = 'pending';
    issuer.reviewNote = 'Back in review: pricing or fulfilment changed';
  }

  await issuer.save();
  res.json({ success: true, data: issuerView(issuer) });
}

export async function submitIssuer(req: Request, res: Response): Promise<void> {
  const issuer = await myIssuerOrFail(req);
  if (issuer.status === 'live') throw ApiError.badRequest('This programme is already live');

  if (!(await VaultProduct.exists({ issuer: issuer._id, status: 'active' }))) {
    throw ApiError.badRequest('Add at least one card before submitting for review');
  }

  issuer.status = 'pending';
  issuer.reviewNote = '';
  await issuer.save();

  res.json({ success: true, data: issuerView(issuer) });
}

/** Mints an issuer key. The plaintext is in this response and nowhere else. */
export async function mintIssuerKey(req: Request, res: Response): Promise<void> {
  const { mode } = req.body as z.infer<typeof mintKeySchema>;
  const issuer = await myIssuerOrFail(req);

  if (mode === 'live' && issuer.status !== 'live') {
    throw ApiError.badRequest('A live key needs an approved programme');
  }

  const minted = mintApiKey('issuer', mode);
  issuer.keys[mode] = { hash: minted.hash, hint: minted.hint, createdAt: new Date() };
  await issuer.save();

  res.status(201).json({ success: true, data: { mode, key: minted.key, hint: minted.hint } });
}

/** Shows (or rotates) the secret Vault signs fulfilment calls with. */
export async function getFulfilSecret(req: Request, res: Response): Promise<void> {
  const issuer = await VaultIssuer.findOne({ owner: req.user!._id }).select('+fulfilSecret');
  if (!issuer) throw ApiError.notFound('You have not set up a card programme yet');

  if (req.method === 'POST' || !issuer.fulfilSecret) {
    issuer.fulfilSecret = mintFulfilSecret();
    await issuer.save();
  }

  res.json({ success: true, data: { secret: issuer.fulfilSecret } });
}

/* ---------------------------------------------------------------- products */

export async function listMyProducts(req: Request, res: Response): Promise<void> {
  const issuer = await myIssuerOrFail(req);
  const products = await VaultProduct.find({ issuer: issuer._id }).sort({ createdAt: 1 });

  res.json({
    success: true,
    data: products.map((product) => ({
      id: product._id.toString(),
      slug: product.slug,
      name: product.name,
      artworkUrl: product.artworkUrl,
      redeemInstructions: product.redeemInstructions,
      denominationType: product.denominationType,
      denominationsMinor: product.denominationsMinor,
      minMinor: product.minMinor,
      maxMinor: product.maxMinor,
      discountPercent: product.discountPercent,
      effectiveDiscountPercent: discountFor(issuer, product),
      expiryDays: product.expiryDays,
      effectiveExpiryDays: expiryDaysFor(issuer, product),
      status: product.status,
      currency: product.currency,
    })),
  });
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof createProductSchema>;
  const issuer = await myIssuerOrFail(req);

  const slug = await uniqueSlug(input.name, async (candidate) =>
    Boolean(await VaultProduct.exists({ issuer: issuer._id, slug: candidate })),
  );

  const product = await VaultProduct.create({
    issuer: issuer._id,
    slug,
    name: input.name,
    artworkUrl: input.artworkUrl,
    redeemInstructions: input.redeemInstructions,
    denominationType: input.denominationType,
    denominationsMinor: input.denominations.map(toMinor),
    minMinor: input.min ? toMinor(input.min) : 0,
    maxMinor: input.max ? toMinor(input.max) : 0,
    discountPercent: input.discountPercent ?? null,
    expiryDays: input.expiryDays ?? null,
    status: input.status ?? 'active',
    currency: issuer.currency,
  });

  res.status(201).json({ success: true, data: { id: product._id.toString(), slug: product.slug } });
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof createProductSchema>;
  const issuer = await myIssuerOrFail(req);

  const product = await VaultProduct.findOne({ _id: req.params.id, issuer: issuer._id });
  if (!product) throw ApiError.notFound('No such card');

  product.name = input.name;
  product.artworkUrl = input.artworkUrl ?? '';
  product.redeemInstructions = input.redeemInstructions ?? '';
  product.denominationType = input.denominationType;
  product.denominationsMinor = input.denominations.map(toMinor);
  product.minMinor = input.min ? toMinor(input.min) : 0;
  product.maxMinor = input.max ? toMinor(input.max) : 0;
  product.discountPercent = input.discountPercent ?? null;
  product.expiryDays = input.expiryDays ?? null;
  if (input.status) product.status = input.status;

  await product.save();
  res.json({ success: true, data: { id: product._id.toString(), slug: product.slug } });
}

/**
 * Takes a card off sale.
 *
 * Paused, never deleted. Cards already in people's hands point at this row for
 * their redeem instructions and their name, and an order from last month has
 * to stay readable. Removing it would orphan both.
 */
export async function pauseProduct(req: Request, res: Response): Promise<void> {
  const issuer = await myIssuerOrFail(req);
  const product = await VaultProduct.findOneAndUpdate(
    { _id: req.params.id, issuer: issuer._id },
    { status: 'paused' },
    { new: true },
  );
  if (!product) throw ApiError.notFound('No such card');
  res.json({ success: true, data: { id: product._id.toString(), status: product.status } });
}

/* ----------------------------------------------------------- issuer money */

export async function getIssuerSummary(req: Request, res: Response): Promise<void> {
  const issuer = await myIssuerOrFail(req);
  res.json({
    success: true,
    data: { ...(await issuerSummary(issuer._id)), currency: issuer.currency },
  });
}

export async function listIssuerOrders(req: Request, res: Response): Promise<void> {
  const issuer = await myIssuerOrFail(req);
  const mode = (req.query.mode as VaultMode) ?? 'live';

  const orders = await VaultOrder.find({ issuer: issuer._id, mode })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate<{ partner: IVaultPartner }>('partner', 'name slug');

  res.json({
    success: true,
    data: orders.map((order) => ({
      reference: order.reference,
      status: order.status,
      buyerKind: order.buyerKind,
      buyer: (order.partner as unknown as IVaultPartner)?.name ?? 'Direct purchase',
      quantity: order.quantity,
      faceTotalMinor: order.faceTotalMinor,
      discountMinor: order.discountMinor,
      issuerNetMinor: order.issuerNetMinor,
      currency: order.currency,
      createdAt: order.createdAt,
    })),
  });
}

export async function listIssuerRedemptions(req: Request, res: Response): Promise<void> {
  const issuer = await myIssuerOrFail(req);
  const redemptions = await CardRedemption.find({ issuer: issuer._id })
    .sort({ createdAt: -1 })
    .limit(100);

  res.json({
    success: true,
    data: redemptions.map((entry) => ({
      reference: entry.reference,
      amountMinor: entry.amountMinor,
      balanceAfterMinor: entry.balanceAfterMinor,
      source: entry.source,
      mode: entry.mode,
      note: entry.note,
      createdAt: entry.createdAt,
    })),
  });
}

/** Redeeming from the dashboard, for a merchant without a till integration. */
export async function consoleRedeem(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof consoleRedeemSchema>;
  const issuer = await myIssuerOrFail(req);

  const result = await redeemCard({
    code: input.code,
    pin: input.pin,
    amountMinor: input.amount ? toMinor(input.amount) : undefined,
    mode: (req.query.mode as VaultMode) ?? 'live',
    issuer: issuer._id,
    source: 'issuer_console',
    actor: req.user!._id,
    note: input.note,
  });

  res.json({
    success: true,
    data: {
      reference: result.reference,
      redeemedMinor: result.redeemedMinor,
      balanceMinor: result.balanceMinor,
      status: result.card.status,
      currency: result.card.currency,
    },
  });
}

/* ----------------------------------------------------------------- partner */

const partnerView = (partner: IVaultPartner) => ({
  id: partner._id.toString(),
  slug: partner.slug,
  name: partner.name,
  website: partner.website,
  logoUrl: partner.logoUrl,
  status: partner.status,
  webhookUrl: partner.webhookUrl,
  keys: {
    test: partner.keys?.test ? { hint: partner.keys.test.hint, createdAt: partner.keys.test.createdAt } : null,
    live: partner.keys?.live ? { hint: partner.keys.live.hint, createdAt: partner.keys.live.createdAt } : null,
  },
  createdAt: partner.createdAt,
});

async function myPartnerOrFail(req: Request): Promise<IVaultPartner> {
  const partner = await VaultPartner.findOne({ owner: req.user!._id });
  if (!partner) throw ApiError.notFound('You have not set up a distributor account yet');
  return partner;
}

export async function getMyPartner(req: Request, res: Response): Promise<void> {
  const partner = await VaultPartner.findOne({ owner: req.user!._id });
  if (!partner) {
    res.json({ success: true, data: null });
    return;
  }

  res.json({
    success: true,
    data: {
      ...partnerView(partner),
      balances: {
        test: await partnerBalanceMinor(partner._id, 'test'),
        live: await partnerBalanceMinor(partner._id, 'live'),
      },
      currency: env.currency,
    },
  });
}

export async function createPartner(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof createPartnerSchema>;

  if (await VaultPartner.exists({ owner: req.user!._id })) {
    throw ApiError.conflict('You already have a distributor account');
  }

  const slug = await uniqueSlug(input.name, async (candidate) =>
    Boolean(await VaultPartner.exists({ slug: candidate })),
  );

  const partner = await VaultPartner.create({
    ...input,
    owner: req.user!._id,
    slug,
    webhookSecret: mintWebhookSecret(),
  });

  /* Sandbox money immediately, so the first test order can happen in the same
     session as signup rather than after a conversation about billing. */
  await grantTestBalance(partner);

  res.status(201).json({ success: true, data: partnerView(partner) });
}

export async function updatePartner(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof updatePartnerSchema>;
  const partner = await myPartnerOrFail(req);

  Object.assign(partner, input);
  if (input.webhookUrl === '') partner.webhookUrl = null;

  await partner.save();
  res.json({ success: true, data: partnerView(partner) });
}

export async function mintPartnerKey(req: Request, res: Response): Promise<void> {
  const { mode } = req.body as z.infer<typeof mintKeySchema>;
  const partner = await myPartnerOrFail(req);

  if (mode === 'live' && partner.status !== 'live') {
    throw ApiError.badRequest('A live key needs an approved distributor account');
  }

  const minted = mintApiKey('partner', mode);
  partner.keys[mode] = { hash: minted.hash, hint: minted.hint, createdAt: new Date() };
  await partner.save();

  res.status(201).json({ success: true, data: { mode, key: minted.key, hint: minted.hint } });
}

export async function getWebhookSecret(req: Request, res: Response): Promise<void> {
  const partner = await VaultPartner.findOne({ owner: req.user!._id }).select('+webhookSecret');
  if (!partner) throw ApiError.notFound('You have not set up a distributor account yet');

  if (req.method === 'POST' || !partner.webhookSecret) {
    partner.webhookSecret = mintWebhookSecret();
    await partner.save();
  }

  res.json({ success: true, data: { secret: partner.webhookSecret } });
}

export async function listLedger(req: Request, res: Response): Promise<void> {
  const partner = await myPartnerOrFail(req);
  const mode = (req.query.mode as VaultMode) ?? 'live';

  const entries = await VaultLedgerEntry.find({ partner: partner._id, mode })
    .sort({ createdAt: -1 })
    .limit(100);

  res.json({
    success: true,
    data: {
      balanceMinor: await partnerBalanceMinor(partner._id, mode),
      currency: env.currency,
      entries: entries.map((entry) => ({
        kind: entry.kind,
        amountMinor: entry.amountMinor,
        reference: entry.reference,
        note: entry.note,
        createdAt: entry.createdAt,
      })),
    },
  });
}

/**
 * Adds to a balance.
 *
 * Test money is granted outright — it is not real, and making someone go
 * through a checkout for play money would be theatre. Live money goes through
 * Bachs like every other payment on Deck, and the balance only moves when the
 * webhook confirms it.
 */
export async function topUp(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof topupSchema>;
  const partner = await myPartnerOrFail(req);
  const amountMinor = toMinor(input.amount);

  if (input.mode === 'test') {
    await VaultLedgerEntry.create({
      partner: partner._id,
      mode: 'test',
      kind: 'topup',
      amountMinor,
      reference: topupReference(),
      note: 'Sandbox top-up',
    });
    res.json({
      success: true,
      data: { mode: 'test', balanceMinor: await partnerBalanceMinor(partner._id, 'test') },
    });
    return;
  }

  if (!bachsConfigured()) {
    throw new ApiError(503, 'Card payments are not configured on this deployment');
  }

  const reference = topupReference();
  const { successUrl, cancelUrl } = checkoutReturnUrls(reference);
  const checkout = await createCheckout({
    amountMinor,
    currency: env.currency,
    email: req.user!.email,
    name: req.user!.name,
    reference,
    successUrl,
    cancelUrl,
    metadata: { kind: 'vault_topup', partner: partner.slug },
  });

  await VaultTopup.create({
    partner: partner._id,
    user: req.user!._id,
    mode: 'live',
    amountMinor,
    reference,
    checkoutId: checkout.checkoutId,
  });

  res.status(201).json({
    success: true,
    data: { mode: 'live', reference, checkoutUrl: checkout.checkoutUrl },
  });
}

/* ------------------------------------------------------------------ staff */

/**
 * Every issuer, for review. Pending ones first — they are the queue.
 *
 * `-reviewNote` after the status sort so that within the pending group the
 * ones nobody has looked at yet come before the ones already commented on.
 */
export async function listIssuersForReview(_req: Request, res: Response): Promise<void> {
  const issuers = await VaultIssuer.find().sort({ status: 1, createdAt: -1 }).limit(200);

  const counts = await VaultProduct.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { status: 'active' } },
    { $group: { _id: '$issuer', count: { $sum: 1 } } },
  ]);
  const byIssuer = new Map(counts.map((row) => [row._id.toString(), row.count]));

  res.json({
    success: true,
    data: issuers.map((issuer) => ({
      ...issuerView(issuer),
      activeProducts: byIssuer.get(issuer._id.toString()) ?? 0,
    })),
  });
}

/**
 * Approves, pauses or rejects a card programme.
 *
 * This is the gate on the whole supply side: an issuer is not sellable to
 * distributors until somebody here says so, because a live programme is Deck
 * promising strangers that a merchant will honour a code.
 */
export async function reviewIssuer(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof reviewIssuerSchema>;

  const issuer = await VaultIssuer.findById(req.params.id);
  if (!issuer) throw ApiError.notFound('No such card programme');

  if (input.status === 'live' && !(await VaultProduct.exists({ issuer: issuer._id, status: 'active' }))) {
    throw ApiError.badRequest('That programme has no active cards to sell');
  }

  issuer.status = input.status;
  issuer.reviewNote = input.note ?? '';
  issuer.reviewedBy = req.user!._id;
  issuer.reviewedAt = new Date();
  await issuer.save();

  res.json({ success: true, data: issuerView(issuer) });
}

/** Lets a distributor go live, or stops one. */
export async function reviewPartner(req: Request, res: Response): Promise<void> {
  const { status } = req.body as { status: 'live' | 'suspended' | 'pending' };

  const partner = await VaultPartner.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true, runValidators: true },
  );
  if (!partner) throw ApiError.notFound('No such distributor');

  res.json({ success: true, data: partnerView(partner) });
}

export async function listPartnersForReview(_req: Request, res: Response): Promise<void> {
  const partners = await VaultPartner.find().sort({ status: 1, createdAt: -1 }).limit(200);

  res.json({
    success: true,
    data: await Promise.all(
      partners.map(async (partner) => ({
        ...partnerView(partner),
        balances: {
          test: await partnerBalanceMinor(partner._id, 'test'),
          live: await partnerBalanceMinor(partner._id, 'live'),
        },
      })),
    ),
  });
}

/* ------------------------------------------------------------- my cards */

/**
 * Cards bought on the storefront by the signed-in person.
 *
 * The code is revealed here because this is the buyer's own order — but one
 * card at a time, by id, rather than in the list, so a page that merely shows
 * somebody their purchase history does not put a screenful of live bearer
 * instruments on screen.
 */
export async function listMyCards(req: Request, res: Response): Promise<void> {
  const orders = await VaultOrder.find({ user: req.user!._id, status: 'fulfilled' })
    .sort({ createdAt: -1 })
    .limit(50);

  const cards = await GiftCard.find({ order: { $in: orders.map((order) => order._id) } })
    .sort({ createdAt: -1 })
    .populate<{ issuer: IVaultIssuer }>('issuer', 'name slug logoUrl');

  res.json({
    success: true,
    data: cards.map((card) => ({
      id: card._id.toString(),
      issuer: {
        name: (card.issuer as unknown as IVaultIssuer)?.name,
        slug: (card.issuer as unknown as IVaultIssuer)?.slug,
        logoUrl: (card.issuer as unknown as IVaultIssuer)?.logoUrl,
      },
      last4: card.code.last4,
      faceValueMinor: card.faceValueMinor,
      balanceMinor: card.balanceMinor,
      currency: card.currency,
      status: card.status,
      expiresAt: card.expiresAt,
      recipientName: card.recipientName,
    })),
  });
}

export async function revealMyCard(req: Request, res: Response): Promise<void> {
  const card = await GiftCard.findById(req.params.id);
  if (!card) throw ApiError.notFound('No such card');

  const order = card.order ? await VaultOrder.findById(card.order) : null;
  if (!order?.user?.equals(req.user!._id)) {
    throw ApiError.forbidden('That card is not yours');
  }

  res.json({ success: true, data: await revealCard(card._id) });
}
