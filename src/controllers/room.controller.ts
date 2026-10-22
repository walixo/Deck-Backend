import type { Request, Response } from 'express';
import { GameRoom, ROOM_STATE_MAX_BYTES, type IGameRoom } from '../models/GameRoom';
import type { IGame } from '../models/Game';
import { publish, subscribe, takeMessageToken } from '../services/roomHub';
import {
  activeUntil,
  assertMember,
  broadcastRoom,
  endRoom,
  findRoom,
  mintRoomCode,
  mintRoomId,
  roomWebhook,
  seatFor,
  toRoomResponse,
  type Seat,
} from '../services/rooms';
import { ApiError } from '../utils/ApiError';
import type {
  CreateRoomInput,
  JoinRoomInput,
  QuickMatchInput,
  ReadyInput,
  RoomMessageInput,
  RoomStateInput,
} from '../validators/room.validators';
import { findGame, resolveMode } from './gamePlatform.controller';

/**
 * Multiplayer rooms, from the player's side.
 *
 * Called by the Deck page hosting the game — the same host that relays the
 * SDK's purchases — on behalf of the signed-in player. The game frame never
 * holds a Deck credential; it asks the host, and the host asks here.
 */

/** The most a single relayed message may weigh, as JSON. */
const MESSAGE_MAX_BYTES = 4 * 1024;

async function multiplayerGame(req: Request): Promise<IGame> {
  const game = await findGame(String(req.params.slug));
  if (game.kind !== 'external' || !game.sdk) {
    throw ApiError.badRequest('This game does not use the Deck Games SDK');
  }
  if (!game.multiplayer?.enabled) {
    throw ApiError.badRequest('Multiplayer is not switched on for this game');
  }
  return game;
}

/** The game, the mode, and who is acting — resolved once per request. */
async function context(req: Request, requestedMode?: 'test' | 'live', seat?: number) {
  const game = await multiplayerGame(req);
  const mode = resolveMode(req, game, requestedMode);
  const me = await seatFor(req, game, mode, seat);
  return { game, mode, me };
}

/** A room this caller is in, in the mode they are acting in. */
async function myRoom(req: Request, seat?: number) {
  const game = await multiplayerGame(req);
  const room = await findRoom(String(req.params.roomId), game);
  const mode = resolveMode(req, game, room.mode);
  const me = await seatFor(req, game, mode, seat);
  assertMember(room, me.playerId);
  return { game, room, me };
}

function asPlayer(me: Seat, userId: IGameRoom['players'][number]['user']) {
  return {
    playerId: me.playerId,
    user: userId,
    seat: me.seat,
    displayName: me.displayName,
    ready: false,
    joinedAt: new Date(),
  };
}

/** Creates a room with a fresh code, retrying on the rare collision. */
async function createRoomFor(
  game: IGame,
  mode: 'test' | 'live',
  me: Seat,
  req: Request,
  visibility: 'private' | 'public',
): Promise<IGameRoom> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = mintRoomCode();
    try {
      return await GameRoom.create({
        roomId: mintRoomId(),
        game: game._id,
        mode,
        code,
        activeCode: code,
        visibility,
        hostPlayerId: me.playerId,
        minPlayers: game.multiplayer.minPlayers,
        maxPlayers: game.multiplayer.maxPlayers,
        players: [asPlayer(me, req.user!._id)],
        expiresAt: activeUntil(),
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  throw new ApiError(503, 'Could not make a room just now — try again');
}

/**
 * Adds a player to a room atomically: only while it is open, not full, and
 * they are not in it already — all in one conditional update, so two people
 * taking the last seat at once cannot both get it.
 */
async function joinAtomically(
  filter: Record<string, unknown>,
  me: Seat,
  req: Request,
  maxPlayers: number,
) {
  return GameRoom.findOneAndUpdate(
    {
      ...filter,
      status: 'open',
      [`players.${maxPlayers - 1}`]: { $exists: false },
      'players.playerId': { $ne: me.playerId },
    },
    { $push: { players: asPlayer(me, req.user!._id) }, $set: { expiresAt: activeUntil() } },
    { new: true },
  );
}

/* ----------------------------------------------------------- endpoints --- */

/** Makes a room and puts the caller in it as host. */
export async function createRoom(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateRoomInput;
  const { game, mode, me } = await context(req, input.mode, input.seat);
  const room = await createRoomFor(game, mode, me, req, input.visibility);
  res.status(201).json({ success: true, data: toRoomResponse(room) });
}

/** Joins a room by its six-character code. */
export async function joinRoom(req: Request, res: Response): Promise<void> {
  const input = req.body as JoinRoomInput;
  const { game, mode, me } = await context(req, input.mode, input.seat);

  const room = await GameRoom.findOne({ activeCode: input.code, game: game._id, mode });
  if (!room) throw ApiError.notFound('No open room has that code');
  if (room.players.some((p) => p.playerId === me.playerId)) {
    res.json({ success: true, data: toRoomResponse(room) });
    return;
  }
  if (room.status !== 'open') throw ApiError.conflict('That game has already started');

  const joined = await joinAtomically({ _id: room._id }, me, req, room.maxPlayers);
  if (!joined) throw ApiError.conflict('That room is full');
  broadcastRoom(joined);
  res.json({ success: true, data: toRoomResponse(joined) });
}

/**
 * Puts the caller in the oldest open public room with a free seat, or makes a
 * new public room if there is none.
 */
export async function quickMatch(req: Request, res: Response): Promise<void> {
  const input = req.body as QuickMatchInput;
  const { game, mode, me } = await context(req, input.mode, input.seat);

  const already = await GameRoom.findOne({
    game: game._id,
    mode,
    status: { $in: ['open', 'playing'] },
    'players.playerId': me.playerId,
  });
  if (already) {
    res.json({ success: true, data: toRoomResponse(already) });
    return;
  }

  const candidates = await GameRoom.find({
    game: game._id,
    mode,
    visibility: 'public',
    status: 'open',
  })
    .sort({ createdAt: 1 })
    .limit(5)
    .select('_id maxPlayers');
  for (const candidate of candidates) {
    const joined = await joinAtomically({ _id: candidate._id }, me, req, candidate.maxPlayers);
    if (joined) {
      broadcastRoom(joined);
      res.json({ success: true, data: toRoomResponse(joined) });
      return;
    }
  }

  const room = await createRoomFor(game, mode, me, req, 'public');
  res.status(201).json({ success: true, data: toRoomResponse(room) });
}

export async function getRoom(req: Request, res: Response): Promise<void> {
  const { room } = await myRoom(req, req.query.seat as unknown as number | undefined);
  res.json({ success: true, data: toRoomResponse(room) });
}

/**
 * The live stream for one player in one room: the room as it is now, then
 * every change, state update and message addressed to them, as they happen.
 */
export async function streamRoom(req: Request, res: Response): Promise<void> {
  const { room, me } = await myRoom(req, req.query.seat as unknown as number | undefined);
  if (room.status === 'ended') throw ApiError.conflict('This room has ended');

  subscribe(room.roomId, me.playerId, res, () => {
    /* Tell the others this player dropped, from fresh data. */
    void GameRoom.findOne({ roomId: room.roomId }).then((current) => {
      if (current && current.status !== 'ended') broadcastRoom(current);
    });
  });
  /* The room as it stands, to this player, and their arrival to everyone. */
  publish(room.roomId, 'room', toRoomResponse(room));
}

export async function setReady(req: Request, res: Response): Promise<void> {
  const input = req.body as ReadyInput;
  const { room, me } = await myRoom(req, input.seat);
  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, 'players.playerId': me.playerId },
    { $set: { 'players.$.ready': input.ready, expiresAt: activeUntil() } },
    { new: true },
  );
  broadcastRoom(updated!);
  res.json({ success: true, data: toRoomResponse(updated!) });
}

/** The host starts the game once enough players are in. */
export async function startRoom(req: Request, res: Response): Promise<void> {
  const { room, me } = await myRoom(req, (req.body as { seat?: number }).seat);
  if (room.hostPlayerId !== me.playerId)
    throw ApiError.forbidden('Only the host can start the game');
  if (room.status !== 'open') throw ApiError.conflict('This game has already started');
  if (room.players.length < room.minPlayers) {
    throw ApiError.badRequest(`This game needs at least ${room.minPlayers} players`);
  }

  const started = await GameRoom.findOneAndUpdate(
    { _id: room._id, status: 'open' },
    { $set: { status: 'playing', startedAt: new Date(), expiresAt: activeUntil() } },
    { new: true },
  );
  if (!started) throw ApiError.conflict('This game has already started');
  publish(started.roomId, 'started', toRoomResponse(started));
  broadcastRoom(started);
  void roomWebhook(started, 'room.started');
  res.json({ success: true, data: toRoomResponse(started) });
}

/** Relays a message to the other players. Not stored — it is live or it is gone. */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const input = req.body as RoomMessageInput;
  const { room, me } = await myRoom(req, input.seat);
  if (room.status === 'ended') throw ApiError.conflict('This room has ended');
  if (JSON.stringify(input.data ?? null).length > MESSAGE_MAX_BYTES) {
    throw ApiError.badRequest('Messages are limited to 4 KB');
  }
  if (!takeMessageToken(room.roomId, me.playerId)) {
    throw new ApiError(429, 'Too many messages — slow down');
  }

  const everyone = room.players.map((p) => p.playerId);
  let to: string[];
  if (input.to === 'all') to = everyone;
  else if (input.to === 'others') to = everyone.filter((id) => id !== me.playerId);
  else if (input.to === 'host') to = [room.hostPlayerId];
  else {
    if (!everyone.includes(input.to)) throw ApiError.badRequest('That player is not in this room');
    to = [input.to];
  }

  const delivered = publish(
    room.roomId,
    'message',
    { from: me.playerId, data: input.data ?? null, at: Date.now() },
    to,
  );
  res.json({ success: true, data: { delivered } });
}

/** The host sets the room's shared state; everyone receives it. */
export async function setState(req: Request, res: Response): Promise<void> {
  const input = req.body as RoomStateInput;
  const { room, me } = await myRoom(req, input.seat);
  if (room.hostPlayerId !== me.playerId)
    throw ApiError.forbidden('Only the host can set the room state');
  if (room.status === 'ended') throw ApiError.conflict('This room has ended');
  if (JSON.stringify(input.state ?? null).length > ROOM_STATE_MAX_BYTES) {
    throw ApiError.badRequest('Room state is limited to 16 KB');
  }

  room.state = input.state ?? null;
  room.markModified('state');
  room.expiresAt = activeUntil();
  await room.save();
  publish(room.roomId, 'state', { state: room.state, from: me.playerId });
  res.json({ success: true, data: toRoomResponse(room) });
}

/**
 * Leaves a room. The host's role passes to whoever joined next; the last
 * player out ends it.
 */
export async function leaveRoom(req: Request, res: Response): Promise<void> {
  const { room, me } = await myRoom(req, (req.body as { seat?: number }).seat);
  room.players = room.players.filter((p) => p.playerId !== me.playerId);

  if (room.players.length === 0) {
    await endRoom(room);
  } else {
    if (room.hostPlayerId === me.playerId) room.hostPlayerId = room.players[0]!.playerId;
    room.expiresAt = activeUntil();
    await room.save();
    broadcastRoom(room);
  }
  res.json({ success: true, data: { left: true } });
}

/**
 * The host ends the room from the game. No results from here: a browser can
 * claim anything, so ranked results only come from the game's server.
 */
export async function endRoomByHost(req: Request, res: Response): Promise<void> {
  const { room, me } = await myRoom(req, (req.body as { seat?: number }).seat);
  if (room.hostPlayerId !== me.playerId) throw ApiError.forbidden('Only the host can end the game');
  const ended = await endRoom(room);
  res.json({ success: true, data: toRoomResponse(ended) });
}
