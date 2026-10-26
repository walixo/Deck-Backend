import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { CURRENCY } from '../constants';
import { Game, type GameKeyMode, type IGame } from '../models/Game';
import { GamePlayer } from '../models/GamePlayer';
import { GameProduct, type IGameProduct } from '../models/GameProduct';
import { GamePurchase, type IGamePurchase } from '../models/GamePurchase';
import { GameSession, SESSION_TTL_MS } from '../models/GameSession';
import type { IUser } from '../models/User';
import { bachsConfigured, checkoutReturnUrls, createCheckout } from '../services/bachs';
import {
  hashSecret,
  mintApiKey,
  mintPlayerId,
  mintSessionToken,
  mintWebhookSecret,
  purchaseReference,
} from '../services/gameKeys';
import { assertDeliverable, deliverPurchase, post } from '../services/gameWebhooks';
import { seatFor } from '../services/rooms';
import { applyGameFee } from '../services/money';
import { formatMinor, notify } from '../services/notify';
import { toGameResponse } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type {
  CreateProductInput,
  DeveloperSettingsInput,
  PurchaseInput,
  SalesQuery,
  SessionInput,
  UpdateProductInput,
} from '../validators/gamePlatform.validators';

/**
 * The Deck Games platform: what a game in the player can ask Deck for, and
 * what its developer can configure.
 *
 * Two kinds of caller reach this file, both signed in to Deck:
 *
 *  - **The player host** — Deck's own page wrapped around the game frame. It
 *    relays the SDK's requests (a session, a purchase) on the player's behalf.
 *    The game itself never holds a Deck credential.
 *  - **The developer** — managing keys, products and webhooks for a game they
 *    own. Staff can do everything a developer can.
 *
 * The developer's *server* talks to `gameApi.controller.ts` instead, with an
 * API key and no Deck account at all.
 */

const AUTHOR_FIELDS = 'name username avatarUrl headline verified';

/* ------------------------------------------------------------ helpers --- */

export async function findGame(slug: string, withSecret = false): Promise<IGame> {
  const query = Game.findOne({ slug });
  if (withSecret) query.select('+webhookSecret');
  const game = await query;
  if (!game) throw ApiError.notFound('We could not find that game');
  return game;
}

export function canDevelop(user: IUser | undefined, game: IGame): boolean {
  if (!user) return false;
  return user.role === 'admin' || Boolean(game.author?.equals(user._id));
}

function assertDeveloper(req: Request, game: IGame): void {
  if (!canDevelop(req.user, game)) throw ApiError.forbidden('That is not your game');
}

/**
 * Which environment a request runs in.
 *
 * Test is for the developer (and staff) only, and is the only mode available
 * before review — so a developer can build against a game nobody else can
 * see. Live is for everyone, and only once the game is approved.
 */
export function resolveMode(req: Request, game: IGame, requested?: GameKeyMode): GameKeyMode {
  const developer = canDevelop(req.user, game);
  const mode: GameKeyMode = requested ?? (game.status === 'approved' ? 'live' : 'test');

  if (mode === 'test' && !developer) {
    throw ApiError.forbidden('Test mode is for the game’s developer');
  }
  if (mode === 'live' && game.status !== 'approved') {
    if (!developer) throw ApiError.notFound('We could not find that game');
    throw ApiError.badRequest('This game is not live yet — use test mode until it is approved');
  }
  return mode;
}

/**
 * This user's id in this game, minted on first use.
 *
 * Two tabs asking at the same moment can both miss the lookup; the unique
 * index lets exactly one insert win and the other reads what it wrote.
 */
export async function playerIdFor(game: IGame, user: IUser, mode: GameKeyMode): Promise<string> {
  const existing = await GamePlayer.findOne({ game: game._id, user: user._id, mode });
  if (existing) return existing.playerId;

  try {
    const created = await GamePlayer.create({
      game: game._id,
      user: user._id,
      mode,
      playerId: mintPlayerId(mode),
    });
    return created.playerId;
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const raced = await GamePlayer.findOne({ game: game._id, user: user._id, mode });
    if (!raced) throw error;
    return raced.playerId;
  }
}

export function toProductResponse(product: IGameProduct) {
  return {
    productId: product.productId,
    name: product.name,
    description: product.description,
    priceMinor: product.priceMinor,
    currency: product.currency,
    type: product.type,
    active: product.active,
  };
}

/** What a player — or the developer's server — may know about a purchase. */
export function toPurchaseResponse(purchase: IGamePurchase) {
  return {
    reference: purchase.reference,
    status: purchase.status,
    mode: purchase.mode,
    productId: purchase.productId,
    productName: purchase.productName,
    productType: purchase.productType,
    playerId: purchase.playerId,
    priceMinor: purchase.priceMinor,
    currency: purchase.currency,
    paidAt: purchase.paidAt,
    deliveredAt: purchase.deliveredAt,
    createdAt: purchase.createdAt,
  };
}

/** The developer's view adds the money and the webhook's state. */
function toSaleResponse(purchase: IGamePurchase) {
  return {
    ...toPurchaseResponse(purchase),
    developerShareMinor: purchase.developerShareMinor,
    platformFeeMinor: purchase.platformFeeMinor,
    webhook: {
      state: purchase.webhook.state,
      attempts: purchase.webhook.attempts,
      lastStatus: purchase.webhook.lastStatus,
      lastError: purchase.webhook.lastError,
      lastAttemptAt: purchase.webhook.lastAttemptAt,
    },
  };
}

/**
 * Settles a purchase as paid and starts webhook delivery.
 *
 * Called from the payment webhook and the return page for live purchases, and
 * directly for test ones. Idempotent on `pending`, like every other settle.
 */
export async function markGamePurchasePaid(
  purchase: IGamePurchase,
  paid: { paidAt?: string | Date | null; chargeId?: string | null },
): Promise<IGamePurchase> {
  if (purchase.status !== 'pending') return purchase;

  purchase.status = 'paid';
  purchase.paidAt = paid.paidAt ? new Date(paid.paidAt) : new Date();
  if (paid.chargeId) purchase.chargeId = paid.chargeId;
  purchase.webhook.state = 'pending';
  purchase.webhook.nextAttemptAt = new Date();
  await purchase.save();

  /* Fire and forget: a slow developer server must not hold up the player's
     confirmation. A failed first attempt is picked up by the retry job. */
  void deliverPurchase(purchase._id).catch(() => undefined);

  /* Real money only — a developer testing their own store does not need
     telling about it. */
  if (purchase.mode === 'live') {
    const game = await Game.findById(purchase.game).select('slug title');
    if (game) {
      void notify({
        user: purchase.developer,
        kind: 'game.sale',
        title: `${formatMinor(purchase.developerShareMinor, purchase.currency)} from ${purchase.productName}`,
        body: `A player bought ${purchase.productName} in ${game.title}.`,
        link: `/games/developers/${game.slug}`,
      });
    }
  }
  return purchase;
}

/* ------------------------------------------------- the player's side --- */

/**
 * What a game sells. Public for a live game; developer-only before review,
 * like the game itself.
 */
export async function listProducts(req: Request, res: Response): Promise<void> {
  const game = await findGame(req.params.slug);
  if (game.status !== 'approved' && !canDevelop(req.user, game)) {
    throw ApiError.notFound('We could not find that game');
  }

  const products = await GameProduct.find({ game: game._id, active: true }).sort({
    priceMinor: 1,
  });
  res.json({ success: true, data: products.map(toProductResponse) });
}

/**
 * A fresh session token for the game in the player's frame.
 *
 * The host fetches this when the SDK asks and hands it straight to the game;
 * the game's server then trades it for a player id through the server API.
 * The response also carries the player id directly — the game may use it at
 * once for display — but a game that grants anything should only trust the
 * one its own server got back from Deck.
 */
export async function createSession(req: Request, res: Response): Promise<void> {
  const { mode: requested, seat } = req.body as SessionInput;
  const game = await findGame(req.params.slug);
  if (game.kind !== 'external' || !game.sdk) {
    throw ApiError.badRequest('This game does not use the Deck Games SDK');
  }

  const mode = resolveMode(req, game, requested);
  const user = req.user!;
  /* A sandbox seat is its own test player, verifiable like any other. */
  const { playerId, displayName } = await seatFor(req, game, mode, seat);
  const token = mintSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await GameSession.create({
    tokenHash: hashSecret(token),
    game: game._id,
    user: user._id,
    playerId,
    mode,
    expiresAt,
  });

  res.status(201).json({
    success: true,
    data: { token, playerId, displayName, mode, expiresAt },
  });
}

/**
 * Starts a purchase.
 *
 * The price comes from the product row, never from the request. Live: a Bachs
 * checkout opens and the host shows it; the purchase settles when Bachs says
 * so. Test: nothing is charged and it settles at once, webhook and all, so a
 * developer can build the whole flow before review.
 */
export async function createPurchase(req: Request, res: Response): Promise<void> {
  const input = req.body as PurchaseInput;
  const game = await findGame(req.params.slug);
  if (game.kind !== 'external' || !game.sdk || !game.author) {
    throw ApiError.badRequest('This game does not sell anything through Deck');
  }

  const mode = resolveMode(req, game, input.mode);
  const product = await GameProduct.findOne({
    game: game._id,
    productId: input.productId,
    active: true,
  });
  if (!product) throw ApiError.notFound(`This game has no product called "${input.productId}"`);

  if (mode === 'live' && !bachsConfigured()) {
    throw ApiError.badRequest('Payments are not available right now');
  }

  const user = req.user!;
  const playerId = await playerIdFor(game, user, mode);

  /* A one-off is owned forever: buying it twice is a mistake, not a sale. */
  if (product.type === 'one_off') {
    const owned = await GamePurchase.exists({
      game: game._id,
      playerId,
      productId: product.productId,
      status: 'paid',
    });
    if (owned) throw ApiError.conflict('You already own this');
  }

  const { feeMinor, netMinor } = applyGameFee(product.priceMinor);
  const purchase = await GamePurchase.create({
    reference: purchaseReference(),
    game: game._id,
    developer: game.author,
    product: product._id,
    productId: product.productId,
    productName: product.name,
    productType: product.type,
    user: user._id,
    playerId,
    mode,
    email: user.email,
    priceMinor: product.priceMinor,
    currency: product.currency,
    developerShareMinor: netMinor,
    platformFeeMinor: feeMinor,
  });

  if (mode === 'test') {
    await markGamePurchasePaid(purchase, { paidAt: new Date() });
    res.status(201).json({
      success: true,
      data: { ...toPurchaseResponse(purchase), checkoutUrl: null },
    });
    return;
  }

  try {
    const checkout = await createCheckout({
      amountMinor: product.priceMinor,
      currency: product.currency,
      email: user.email,
      name: user.name,
      reference: purchase.reference,
      ...checkoutReturnUrls(purchase.reference),
      metadata: {
        kind: 'game_purchase',
        game: game.slug,
        product: product.productId,
      },
    });
    purchase.checkoutId = checkout.checkoutId;
    await purchase.save();

    res.status(201).json({
      success: true,
      data: { ...toPurchaseResponse(purchase), checkoutUrl: checkout.checkoutUrl },
    });
  } catch (error) {
    /* No checkout means nothing can pay it. Leaving it pending would show the
       player a purchase that can never complete. */
    purchase.status = 'failed';
    await purchase.save();
    throw error;
  }
}

/**
 * One purchase, for the player who made it (polling while checkout is open),
 * the game's developer, or staff. Reads Deck's record only — the return page
 * and the payment webhook are what ask Bachs.
 */
export async function getPurchase(req: Request, res: Response): Promise<void> {
  const purchase = await GamePurchase.findOne({ reference: req.params.reference.toUpperCase() });
  if (!purchase) throw ApiError.notFound('We could not find that purchase');

  const user = req.user!;
  const mine = purchase.user.equals(user._id);
  const developer = purchase.developer.equals(user._id) || user.role === 'admin';
  if (!mine && !developer) throw ApiError.notFound('We could not find that purchase');

  const game = await Game.findById(purchase.game).select('slug title');
  res.json({
    success: true,
    data: {
      ...toPurchaseResponse(purchase),
      game: game?.slug ?? null,
      gameTitle: game?.title ?? '',
    },
  });
}

/** What this player owns in this game — the SDK's `getPurchases()`. */
export async function listEntitlements(req: Request, res: Response): Promise<void> {
  const game = await findGame(req.params.slug);
  const mode = resolveMode(req, game, (req.query.mode as GameKeyMode | undefined) ?? undefined);
  const player = await GamePlayer.findOne({ game: game._id, user: req.user!._id, mode });
  if (!player) {
    res.json({ success: true, data: [] });
    return;
  }

  const purchases = await GamePurchase.find({
    game: game._id,
    playerId: player.playerId,
    status: 'paid',
  }).sort({ paidAt: -1 });
  res.json({ success: true, data: purchases.map(toPurchaseResponse) });
}

/* --------------------------------------------- the developer's side --- */

/** A short summary of a game's sales, for the dashboard header. */
async function salesSummary(gameId: mongoose.Types.ObjectId) {
  const rows = await GamePurchase.aggregate<{
    _id: 'test' | 'live';
    sales: number;
    grossMinor: number;
    developerShareMinor: number;
    undelivered: number;
  }>([
    { $match: { game: gameId, status: 'paid' } },
    {
      $group: {
        _id: '$mode',
        sales: { $sum: 1 },
        grossMinor: { $sum: '$priceMinor' },
        developerShareMinor: { $sum: '$developerShareMinor' },
        undelivered: { $sum: { $cond: [{ $eq: ['$deliveredAt', null] }, 1, 0] } },
      },
    },
  ]);

  const empty = { sales: 0, grossMinor: 0, developerShareMinor: 0, undelivered: 0 };
  const pick = (mode: 'test' | 'live') => {
    const row = rows.find((entry) => entry._id === mode);
    return row ? { ...empty, ...row, _id: undefined } : empty;
  };
  return { live: pick('live'), test: pick('test'), currency: CURRENCY };
}

/** Everything the developer dashboard shows for one game. */
export async function getDeveloperView(req: Request, res: Response): Promise<void> {
  const game = await findGame(req.params.slug, true);
  assertDeveloper(req, game);
  await game.populate('author', AUTHOR_FIELDS);

  const [products, sales] = await Promise.all([
    GameProduct.find({ game: game._id }).sort({ active: -1, priceMinor: 1 }),
    salesSummary(game._id),
  ]);
  const locked = await liveSold(products.map((product) => product._id));

  res.json({
    success: true,
    data: {
      game: toGameResponse(game),
      settings: {
        orientation: game.orientation,
        sdk: game.sdk,
        studio: game.studio,
        testUrl: game.testUrl,
        webhookUrl: game.webhookUrl,
        hasWebhookSecret: Boolean(game.webhookSecret),
        multiplayer: {
          enabled: game.multiplayer?.enabled ?? false,
          minPlayers: game.multiplayer?.minPlayers ?? 2,
          maxPlayers: game.multiplayer?.maxPlayers ?? 4,
        },
        keys: {
          test: game.keys?.test
            ? { hint: game.keys.test.hint, createdAt: game.keys.test.createdAt }
            : null,
          live: game.keys?.live
            ? { hint: game.keys.live.hint, createdAt: game.keys.live.createdAt }
            : null,
        },
      },
      products: products.map((product) => ({
        ...toProductResponse(product),
        idLocked: locked.has(String(product._id)),
      })),
      sales,
      feePercent: env.gameFeePercent,
    },
  });
}

/**
 * The settings a developer may change at any time, including after approval.
 *
 * None of these change what was reviewed: the game's address and its write-up
 * stay frozen once approved (see `updateGame`). Orientation, a test build, a
 * webhook and the studio name are the developer's own plumbing.
 */
export async function updateDeveloperSettings(req: Request, res: Response): Promise<void> {
  const input = req.body as DeveloperSettingsInput;
  const game = await findGame(req.params.slug);
  assertDeveloper(req, game);

  if (input.webhookUrl) {
    try {
      await assertDeliverable(input.webhookUrl);
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
  }

  if (input.orientation !== undefined) game.orientation = input.orientation;
  if (input.sdk !== undefined) game.sdk = input.sdk;
  if (input.studio !== undefined) game.studio = input.studio;
  if (input.testUrl !== undefined) game.testUrl = input.testUrl;
  if (input.webhookUrl !== undefined) game.webhookUrl = input.webhookUrl;
  if (input.multiplayer !== undefined) game.multiplayer = input.multiplayer;
  await game.save();

  res.json({ success: true, data: { updated: Object.keys(input) } });
}

/**
 * Mints an API key, replacing any earlier key of the same mode.
 *
 * Returned once. The old key stops working the moment this returns — rotating
 * is how a leaked key is killed, so a grace period would defeat the point.
 */
export async function mintKey(req: Request, res: Response): Promise<void> {
  const { mode } = req.body as { mode: GameKeyMode };
  const game = await findGame(req.params.slug);
  assertDeveloper(req, game);

  const { key, hash, hint } = mintApiKey(mode);
  await Game.updateOne(
    { _id: game._id },
    { $set: { [`keys.${mode}`]: { hash, hint, createdAt: new Date() } } },
  );

  res.status(201).json({ success: true, data: { mode, key, hint } });
}

/** Mints (or rotates) the webhook signing secret. Returned once. */
export async function mintWebhookSecretFor(req: Request, res: Response): Promise<void> {
  const game = await findGame(req.params.slug);
  assertDeveloper(req, game);

  const secret = mintWebhookSecret();
  await Game.updateOne({ _id: game._id }, { $set: { webhookSecret: secret } });

  res.status(201).json({ success: true, data: { secret } });
}

/** Sends a signed `ping` so a developer can check their endpoint end to end. */
export async function testWebhook(req: Request, res: Response): Promise<void> {
  const game = await findGame(req.params.slug, true);
  assertDeveloper(req, game);
  if (!game.webhookUrl) throw ApiError.badRequest('Add a webhook URL first');
  if (!game.webhookSecret) throw ApiError.badRequest('Create a signing secret first');

  const result = await post(game.webhookUrl, game.webhookSecret, 'ping', {
    id: `evt_ping_${Date.now()}`,
    type: 'ping',
    created_at: new Date().toISOString(),
    mode: 'test',
    game: game.slug,
    data: { message: 'Hello from Deck Games' },
  });

  res.json({ success: true, data: result });
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateProductInput;
  const game = await findGame(req.params.slug);
  assertDeveloper(req, game);

  if (await GameProduct.exists({ game: game._id, productId: input.productId })) {
    throw ApiError.conflict(`There is already a product called "${input.productId}"`);
  }

  const product = await GameProduct.create({
    game: game._id,
    productId: input.productId,
    name: input.name,
    description: input.description ?? '',
    priceMinor: Math.round(input.price * 100),
    currency: CURRENCY,
    type: input.type,
  });

  res.status(201).json({ success: true, data: toProductResponse(product) });
}

/**
 * Edits a product. Purchases already made keep the name and price they were
 * made at — those were copied onto each purchase — so this only changes what
 * the next buyer sees. Products are retired with `active: false`, never
 * deleted, because purchases point at them.
 */
export async function updateProduct(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateProductInput;
  const game = await findGame(req.params.slug);
  assertDeveloper(req, game);

  const product = await GameProduct.findOne({
    game: game._id,
    productId: req.params.productId.toLowerCase(),
  });
  if (!product) throw ApiError.notFound('We could not find that product');

  const renamed = input.productId !== undefined && input.productId !== product.productId;
  if (renamed) {
    if ((await liveSold([product._id])).size) {
      throw ApiError.conflict(
        `Players have bought this as "${product.productId}", so its ID can’t change. Retire it and add a new product instead.`,
      );
    }
    if (await GameProduct.exists({ game: game._id, productId: input.productId })) {
      throw ApiError.conflict(`There is already a product called "${input.productId}"`);
    }
    product.productId = input.productId!;
  }
  if (input.name !== undefined) product.name = input.name;
  if (input.description !== undefined) product.description = input.description;
  if (input.price !== undefined) product.priceMinor = Math.round(input.price * 100);
  if (input.type !== undefined) product.type = input.type;
  if (input.active !== undefined) product.active = input.active;
  await product.save();
  /* Test purchases follow the new name, so the sandbox's ownership still adds up. */
  if (renamed) {
    await GamePurchase.updateMany(
      { product: product._id, mode: 'test' },
      { $set: { productId: product.productId } },
    );
  }

  const locked = await liveSold([product._id]);
  res.json({ success: true, data: { ...toProductResponse(product), idLocked: locked.size > 0 } });
}

/**
 * Products players have bought in live mode, paid or still at checkout.
 *
 * A product's ID is the string a game's code, its server and its webhooks key
 * on, and every purchase keeps a copy of it — "already owns this" checks, the
 * player's purchase list and the developer's grants all match on it. Renaming
 * a product after a real sale would split it in two, so its ID is fixed from
 * then on. Matched by the product itself, not the string, so a rename cannot
 * hide a sale.
 */
async function liveSold(productIds: mongoose.Types.ObjectId[]): Promise<Set<string>> {
  if (!productIds.length) return new Set();
  const sold = await GamePurchase.distinct('product', {
    product: { $in: productIds },
    mode: 'live',
    status: { $in: ['paid', 'pending'] },
  });
  return new Set(sold.map(String));
}

/** A game's purchases, newest first, one mode at a time. */
export async function listSales(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as SalesQuery;
  const game = await findGame(req.params.slug);
  assertDeveloper(req, game);

  const filter = { game: game._id, mode: query.mode };
  const skip = (query.page - 1) * query.limit;
  const [total, purchases] = await Promise.all([
    GamePurchase.countDocuments(filter),
    GamePurchase.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
  ]);

  res.json({
    success: true,
    data: purchases.map(toSaleResponse),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + purchases.length < total,
    },
  });
}

/** Sends a paid purchase's webhook again, now, with a fresh attempt count. */
export async function resendWebhook(req: Request, res: Response): Promise<void> {
  const game = await findGame(req.params.slug);
  assertDeveloper(req, game);

  const purchase = await GamePurchase.findOne({
    game: game._id,
    reference: req.params.reference.toUpperCase(),
  });
  if (!purchase) throw ApiError.notFound('We could not find that purchase');
  if (purchase.status !== 'paid') throw ApiError.badRequest('Only paid purchases send webhooks');

  purchase.webhook.state = 'pending';
  purchase.webhook.attempts = 0;
  purchase.webhook.nextAttemptAt = new Date();
  await purchase.save();
  await deliverPurchase(purchase._id);

  const updated = await GamePurchase.findById(purchase._id);
  res.json({ success: true, data: toSaleResponse(updated ?? purchase) });
}
