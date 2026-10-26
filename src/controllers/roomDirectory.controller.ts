import type { Request, Response } from 'express';
import type mongoose from 'mongoose';
import { Game, type IGame } from '../models/Game';
import { GameRoom, type IGameRoom } from '../models/GameRoom';
import { online } from '../services/roomHub';
import { ApiError } from '../utils/ApiError';

/**
 * Rooms, from the arcade's side: the page where players find each other
 * before any game is open.
 *
 * The rooms themselves are made and played inside games (see
 * `room.controller.ts`); this only reads them. It lists live public rooms with
 * a free seat and somebody actually connected, the rooms the caller is already
 * in, and turns a six-character code into the game it belongs to — so a code
 * typed on the Rooms page lands in the right game, which joins on init.
 *
 * Live mode only. Test rooms belong to a developer's sandbox and never appear.
 */

/** The same alphabet `mintRoomCode` draws from: no 0/O, 1/I/L. */
const CODE = /^[23456789A-HJ-NP-Z]{6}$/;

/** Only games a player can actually play together inside Deck. */
const PLAYABLE = {
  status: 'approved',
  kind: 'external',
  sdk: true,
  embeddable: true,
  'multiplayer.enabled': true,
} as const;

const GAME_FIELDS = 'slug title tagline genre coverUrl orientation multiplayer';

function gameCard(game: IGame) {
  return {
    slug: game.slug,
    title: game.title,
    genre: game.genre,
    coverUrl: game.coverUrl,
    orientation: game.orientation,
  };
}

function roomCard(room: IGameRoom, game: IGame) {
  const connected = new Set(online(room.roomId));
  const host = room.players.find((p) => p.playerId === room.hostPlayerId);
  return {
    code: room.code,
    status: room.status,
    visibility: room.visibility,
    seats: room.players.length,
    online: room.players.filter((p) => connected.has(p.playerId)).length,
    minPlayers: room.minPlayers,
    maxPlayers: room.maxPlayers,
    /* First name only: this list is public, and the room has the rest. */
    host: host?.displayName.trim().split(/\s+/)[0] ?? null,
    createdAt: room.createdAt,
    game: gameCard(game),
  };
}

/**
 * Every game that can be played together, with how busy it is, and the public
 * rooms waiting for players. Public: finding a game should not need an account.
 */
export async function listRooms(_req: Request, res: Response): Promise<void> {
  const games = await Game.find(PLAYABLE)
    .select(GAME_FIELDS)
    .sort({ featured: -1, plays: -1 })
    .limit(60);
  const byId = new Map(games.map((game) => [String(game._id), game]));

  const rooms = await GameRoom.find({
    game: { $in: games.map((game) => game._id) },
    mode: 'live',
    status: { $in: ['open', 'playing'] },
  })
    .sort({ createdAt: 1 })
    .limit(400);

  const busy = new Map<string, { open: number; playing: number; playersNow: number }>();
  const waiting: ReturnType<typeof roomCard>[] = [];
  for (const room of rooms) {
    const game = byId.get(String(room.game));
    if (!game) continue;
    const card = roomCard(room, game);
    /* A room nobody is connected to is a tab somebody closed. */
    if (card.online === 0) continue;

    const tally = busy.get(game.slug) ?? { open: 0, playing: 0, playersNow: 0 };
    tally.playersNow += card.online;
    if (room.status === 'playing') tally.playing += 1;
    else if (room.visibility === 'public' && card.seats < card.maxPlayers) {
      tally.open += 1;
      waiting.push(card);
    }
    busy.set(game.slug, tally);
  }

  res.json({
    success: true,
    data: {
      games: games.map((game) => ({
        ...gameCard(game),
        tagline: game.tagline,
        minPlayers: game.multiplayer.minPlayers,
        maxPlayers: game.multiplayer.maxPlayers,
        ...(busy.get(game.slug) ?? { open: 0, playing: 0, playersNow: 0 }),
      })),
      rooms: waiting.slice(0, 48),
    },
  });
}

/** The live rooms the caller has a seat in, so they can get back to them. */
export async function listMyRooms(req: Request, res: Response): Promise<void> {
  const rooms = await GameRoom.find({
    'players.user': req.user!._id,
    mode: 'live',
    status: { $in: ['open', 'playing'] },
  })
    .sort({ updatedAt: -1 })
    .limit(12)
    .populate<{ game: IGame & { _id: mongoose.Types.ObjectId } }>('game', `${GAME_FIELDS} status`);

  res.json({
    success: true,
    data: rooms
      .filter((room) => room.game && room.game.status === 'approved')
      .map((room) => roomCard(room as unknown as IGameRoom, room.game)),
  });
}

/**
 * Which game a code belongs to. Codes are unique across every live room, so a
 * code alone is enough; the answer carries the seats and status so the page
 * can say "full" or "already started" without opening the game first.
 */
export async function findRoomByCode(req: Request, res: Response): Promise<void> {
  const code = String(req.params.code ?? '').toUpperCase();
  if (!CODE.test(code)) throw ApiError.badRequest('Room codes are six letters and numbers');

  const room = await GameRoom.findOne({ activeCode: code, mode: 'live' }).populate<{
    game: IGame & { _id: mongoose.Types.ObjectId };
  }>('game', `${GAME_FIELDS} status`);
  if (!room?.game || room.game.status !== 'approved') {
    throw ApiError.notFound('No open room has that code');
  }
  res.json({ success: true, data: roomCard(room as unknown as IGameRoom, room.game) });
}
