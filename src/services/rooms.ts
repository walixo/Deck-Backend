import crypto from 'node:crypto';
import type { Request } from 'express';
import { canDevelop, playerIdFor } from '../controllers/gamePlatform.controller';
import { Game, type GameKeyMode, type IGame } from '../models/Game';
import { GameRoom, ROOM_ENDED_KEEP_MS, ROOM_IDLE_MS, type IGameRoom } from '../models/GameRoom';
import { ApiError } from '../utils/ApiError';
import { post } from './gameWebhooks';
import { closeRoom, online, publish } from './roomHub';

/**
 * The rules of a room, shared by the player's endpoints and the developer's
 * server API.
 */

/** `rm_` and twelve hex characters. */
export const mintRoomId = (): string => `rm_${crypto.randomBytes(6).toString('hex')}`;

/* No 0/O/1/I: a code is read aloud and typed on a phone. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function mintRoomCode(): string {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export const activeUntil = (): Date => new Date(Date.now() + ROOM_IDLE_MS);

/** The most seats one developer may drive at once in the sandbox. */
export const MAX_SANDBOX_SEATS = 4;

export interface Seat {
  playerId: string;
  displayName: string;
  seat: number;
}

/**
 * Who is acting: the signed-in player, or — in the sandbox — one of their
 * test seats.
 *
 * A developer testing multiplayer needs several players and has one account.
 * In test mode, and only for the game's own developer, a request may name a
 * `seat`: seat 0 is the developer's ordinary test player, and each further
 * seat is a separate test player with its own stable `t_` id, derived from
 * the first so it is the same every time without storing anything. Live mode
 * never accepts a seat — one person is one player.
 */
export async function seatFor(
  req: Request,
  game: IGame,
  mode: GameKeyMode,
  seat?: number,
): Promise<Seat> {
  const user = req.user!;
  const requested = seat ?? 0;
  if (requested > 0) {
    if (mode !== 'test' || !canDevelop(user, game)) {
      throw ApiError.forbidden('Sandbox seats are for the game’s developer, in test mode');
    }
    if (requested >= MAX_SANDBOX_SEATS) {
      throw ApiError.badRequest(`The sandbox has ${MAX_SANDBOX_SEATS} seats`);
    }
  }

  const base = await playerIdFor(game, user, mode);
  if (requested === 0) return { playerId: base, displayName: user.name, seat: 0 };
  const derived = crypto.createHash('sha256').update(`${base}:seat:${requested}`).digest('hex');
  return {
    playerId: `t_${derived.slice(0, 20)}`,
    displayName: `Test player ${requested + 1}`,
    seat: requested,
  };
}

/** What a player — or the game's server — sees of a room. Never a Deck user id. */
export function toRoomResponse(room: IGameRoom) {
  const connected = new Set(online(room.roomId));
  return {
    roomId: room.roomId,
    code: room.code,
    mode: room.mode,
    visibility: room.visibility,
    status: room.status,
    hostPlayerId: room.hostPlayerId,
    minPlayers: room.minPlayers,
    maxPlayers: room.maxPlayers,
    players: room.players.map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      ready: p.ready,
      online: connected.has(p.playerId),
      host: p.playerId === room.hostPlayerId,
    })),
    state: room.state ?? null,
    results: room.results,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
  };
}

/** Tells everyone in the room what it looks like now. */
export function broadcastRoom(room: IGameRoom): void {
  publish(room.roomId, 'room', toRoomResponse(room));
}

/** Loads a room of this game, or 404s. */
export async function findRoom(roomId: string, game: IGame): Promise<IGameRoom> {
  const room = await GameRoom.findOne({ roomId, game: game._id });
  if (!room) throw ApiError.notFound('We could not find that room');
  return room;
}

export function assertMember(room: IGameRoom, playerId: string): void {
  if (!room.players.some((p) => p.playerId === playerId)) {
    throw ApiError.forbidden('You are not in this room');
  }
}

/**
 * Ends a room: no more joining, its code freed, a day's grace to read the
 * result, and every stream told and then closed.
 */
export async function endRoom(
  room: IGameRoom,
  results: IGameRoom['results'] = [],
): Promise<IGameRoom> {
  if (room.status === 'ended') return room;
  room.status = 'ended';
  room.activeCode = null;
  room.endedAt = new Date();
  room.results = results;
  room.expiresAt = new Date(Date.now() + ROOM_ENDED_KEEP_MS);
  await room.save();
  publish(room.roomId, 'ended', toRoomResponse(room));
  broadcastRoom(room);
  /* A moment for the last event to flush before the streams close. */
  setTimeout(() => closeRoom(room.roomId), 250);
  void roomWebhook(room, 'room.ended');
  return room;
}

/**
 * `room.started` and `room.ended`, to the game's webhook if it has one.
 *
 * Best effort and not retried, unlike purchases: these are notices, and the
 * server API is the source of truth (`GET /rooms/:roomId`).
 */
export async function roomWebhook(
  room: IGameRoom,
  type: 'room.started' | 'room.ended',
): Promise<void> {
  const game = await Game.findById(room.game).select('+webhookSecret slug webhookUrl');
  if (!game?.webhookUrl || !game.webhookSecret) return;
  await post(game.webhookUrl, game.webhookSecret, type, {
    /* The same envelope as `purchase.paid`, so one handler can route both. */
    id: `evt_${room.roomId}_${type === 'room.started' ? 'started' : 'ended'}`,
    type,
    created_at: new Date().toISOString(),
    mode: room.mode,
    game: game.slug,
    data: toRoomResponse(room),
  }).catch(() => undefined);
}
