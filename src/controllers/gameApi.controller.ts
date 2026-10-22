import type { NextFunction, Request, Response } from 'express';
import { Game, type GameKeyMode, type IGame } from '../models/Game';
import { GameProduct } from '../models/GameProduct';
import { GamePurchase } from '../models/GamePurchase';
import { GameSession } from '../models/GameSession';
import { GameRoom, ROOM_STATE_MAX_BYTES, type IGameRoom } from '../models/GameRoom';
import { Score } from '../models/Score';
import { User } from '../models/User';
import { hashSecret, modeOfKey } from '../services/gameKeys';
import { publish } from '../services/roomHub';
import { activeUntil, endRoom, toRoomResponse } from '../services/rooms';
import { ApiError } from '../utils/ApiError';
import type { PlayerPurchasesQuery } from '../validators/gamePlatform.validators';
import type {
  EndRoomInput,
  ServerMessageInput,
  ServerStateInput,
} from '../validators/room.validators';
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

/* ------------------------------------------------------------- rooms --- */

/** A room of this game, in this key's mode — or 404, whichever it is not. */
async function apiRoom(req: Request): Promise<IGameRoom> {
  const room = await GameRoom.findOne({
    roomId: String(req.params.roomId),
    game: req.game!._id,
    mode: req.gameMode,
  });
  if (!room) throw ApiError.notFound('No room with that id for this key');
  return room;
}

/**
 * A room as Deck sees it: who is in it, who hosts, its status and state.
 *
 * The call that lets a game's own server trust a room — check a player is
 * really in it before letting them act, whatever their browser claims.
 */
export async function getApiRoom(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: toRoomResponse(await apiRoom(req)) });
}

/** Authoritative shared state from the game's server, sent to every player. */
export async function setApiRoomState(req: Request, res: Response): Promise<void> {
  const { state } = req.body as ServerStateInput;
  const room = await apiRoom(req);
  if (room.status === 'ended') throw ApiError.conflict('This room has ended');
  if (JSON.stringify(state ?? null).length > ROOM_STATE_MAX_BYTES) {
    throw ApiError.badRequest('Room state is limited to 16 KB');
  }
  room.state = state ?? null;
  room.markModified('state');
  room.expiresAt = activeUntil();
  await room.save();
  publish(room.roomId, 'state', { state: room.state, from: 'server' });
  res.json({ success: true, data: toRoomResponse(room) });
}

/** A message from the game's server, to everyone or to one player. */
export async function sendApiRoomMessage(req: Request, res: Response): Promise<void> {
  const { to, data } = req.body as ServerMessageInput;
  const room = await apiRoom(req);
  if (room.status === 'ended') throw ApiError.conflict('This room has ended');
  if (JSON.stringify(data ?? null).length > 4 * 1024) {
    throw ApiError.badRequest('Messages are limited to 4 KB');
  }
  const everyone = room.players.map((p) => p.playerId);
  let recipients: string[] = everyone;
  if (to === 'host') recipients = [room.hostPlayerId];
  else if (to !== 'all' && to !== 'others') {
    if (!everyone.includes(to)) throw ApiError.badRequest('That player is not in this room');
    recipients = [to];
  }
  const delivered = publish(
    room.roomId,
    'message',
    { from: 'server', data: data ?? null, at: Date.now() },
    recipients,
  );
  res.json({ success: true, data: { delivered } });
}

/**
 * Ends a room with its results.
 *
 * The only way ranked results enter Deck: from the game's server, not from a
 * browser. In live mode, any result with a score also goes on the game's
 * leaderboard, kept as the player's best — the same rule as a submitted score,
 * but from a source that can be trusted.
 */
export async function endApiRoom(req: Request, res: Response): Promise<void> {
  const { results } = req.body as EndRoomInput;
  const room = await apiRoom(req);
  if (room.status === 'ended') throw ApiError.conflict('This room has already ended');

  const byPlayer = new Map(room.players.map((p) => [p.playerId, p]));
  for (const result of results) {
    if (!byPlayer.has(result.playerId)) {
      throw ApiError.badRequest(`${result.playerId} is not in this room`);
    }
  }

  const ended = await endRoom(
    room,
    results.map((r) => ({ playerId: r.playerId, rank: r.rank, score: r.score ?? null })),
  );

  if (room.mode === 'live') {
    await Promise.all(
      results
        .filter((r) => r.score !== undefined)
        .map(async (r) => {
          const user = byPlayer.get(r.playerId)!.user;
          const existing = await Score.findOne({ game: room.game, user }).select('score');
          const improved = !existing || r.score! > existing.score;
          await Score.updateOne(
            { game: room.game, user },
            {
              $max: { score: r.score! },
              ...(improved ? { $set: { achievedAt: new Date() } } : {}),
              $setOnInsert: { game: room.game, user },
            },
            { upsert: true },
          );
        }),
    );
  }

  res.json({ success: true, data: toRoomResponse(ended) });
}
