import type { NextFunction, Request, Response } from 'express';
import { Game, type GameKeyMode, type IGame } from '../models/Game';
import { GameProduct } from '../models/GameProduct';
import { GamePurchase } from '../models/GamePurchase';
import { GameSession } from '../models/GameSession';
import { User } from '../models/User';
import { hashSecret, modeOfKey } from '../services/gameKeys';
import { ApiError } from '../utils/ApiError';
import type { PlayerPurchasesQuery } from '../validators/gamePlatform.validators';
import { toProductResponse, toPurchaseResponse } from './gamePlatform.controller';

/**
 * The Deck Games server API, `/api/games/v1`.
 *
 * Called by a developer's own server, never by a browser: it authenticates
 * with a secret API key, and a key in client-side code is a key anyone can
 * read. Everything here is scoped to the one game that key belongs to, and to
 * the key's mode — a test key sees test players and test purchases only, so a
 * developer's staging server can never touch live data by accident.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      game?: IGame;
      gameMode?: GameKeyMode;
    }
  }
}

/**
 * Resolves `Authorization: Bearer dk_…` to a game and a mode.
 *
 * One generic 401 for every way a key can be wrong — missing, malformed,
 * unknown, rotated — so the response never tells a guesser which part of the
 * guess was right.
 */
export async function requireGameKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const mode = modeOfKey(key);
  if (!mode) throw new ApiError(401, 'Send a valid Deck Games API key as a Bearer token');

  const game = await Game.findOne({ [`keys.${mode}.hash`]: hashSecret(key) });
  if (!game) throw new ApiError(401, 'Send a valid Deck Games API key as a Bearer token');

  req.game = game;
  req.gameMode = mode;
  next();
}

/** Ping. Tells a developer which game and mode their key is for. */
export async function whoAmI(req: Request, res: Response): Promise<void> {
  const game = req.game!;
  res.json({
    success: true,
    data: { game: game.slug, title: game.title, mode: req.gameMode, status: game.status },
  });
}

/**
 * Trades a session token from the browser for the player behind it.
 *
 * This is the call that makes a game's server able to trust anything: the
 * token came through the player's browser, but only Deck can say whose it is.
 * A token for a different game, or from the other mode, is refused the same
 * as a forged one.
 */
export async function verifySession(req: Request, res: Response): Promise<void> {
  const { token } = req.body as { token: string };
  const session = await GameSession.findOne({ tokenHash: hashSecret(token) });

  const valid =
    session &&
    session.game.equals(req.game!._id) &&
    session.mode === req.gameMode &&
    session.expiresAt.getTime() > Date.now();
  if (!valid) throw new ApiError(401, 'That session token is not valid for this game');

  const user = await User.findById(session.user).select('name');
  res.json({
    success: true,
    data: {
      playerId: session.playerId,
      displayName: user?.name ?? 'Player',
      mode: session.mode,
      expiresAt: session.expiresAt,
    },
  });
}

export async function listGameProducts(req: Request, res: Response): Promise<void> {
  const products = await GameProduct.find({ game: req.game!._id }).sort({ priceMinor: 1 });
  res.json({ success: true, data: products.map(toProductResponse) });
}

async function findScopedPurchase(req: Request) {
  const purchase = await GamePurchase.findOne({
    reference: req.params.reference.toUpperCase(),
    game: req.game!._id,
    mode: req.gameMode,
  });
  if (!purchase) throw ApiError.notFound('No such purchase for this game and mode');
  return purchase;
}

export async function getGamePurchase(req: Request, res: Response): Promise<void> {
  const purchase = await findScopedPurchase(req);
  res.json({ success: true, data: toPurchaseResponse(purchase) });
}

/**
 * Marks a purchase as handed over.
 *
 * Idempotent: delivering twice returns the first delivery's time, so a
 * developer whose server retries after a timeout cannot double-credit a
 * player by reading this response.
 */
export async function deliverGamePurchase(req: Request, res: Response): Promise<void> {
  const purchase = await findScopedPurchase(req);
  if (purchase.status !== 'paid') {
    throw ApiError.conflict(`This purchase is ${purchase.status}, not paid — do not deliver it`);
  }

  if (!purchase.deliveredAt) {
    await GamePurchase.updateOne(
      { _id: purchase._id, deliveredAt: null },
      { $set: { deliveredAt: new Date() } },
    );
  }

  const updated = await GamePurchase.findById(purchase._id);
  res.json({ success: true, data: toPurchaseResponse(updated ?? purchase) });
}

/**
 * A player's purchases in this game. `?undelivered=true` with `status=paid`
 * is the catch-up query: everything paid for that has not been handed over —
 * what a server that missed webhooks should credit on the player's next visit.
 */
export async function listPlayerPurchases(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as PlayerPurchasesQuery;
  const filter: Record<string, unknown> = {
    game: req.game!._id,
    mode: req.gameMode,
    playerId: req.params.playerId,
  };
  if (query.status) filter.status = query.status;
  if (query.undelivered) filter.deliveredAt = null;

  const purchases = await GamePurchase.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({ success: true, data: purchases.map(toPurchaseResponse) });
}
