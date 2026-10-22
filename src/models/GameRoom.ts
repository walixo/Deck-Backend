import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A multiplayer room: a handful of players in one game, together.
 *
 * Deck keeps the parts every multiplayer game needs and nobody wants to build
 * twice — who is in the room, who is hosting, whether it has started, a join
 * code to share, and a small piece of shared state — and relays messages
 * between the players live (see `services/roomHub.ts`). The game itself decides
 * what the messages mean.
 *
 * Players are recorded by their per-game player id, never their Deck account:
 * the same privacy rule as everywhere else on the platform. The user id is
 * kept alongside, server-side only, so Deck can tell whether a request comes
 * from someone actually in the room.
 *
 * Rooms are short-lived. An idle room expires after two hours; an ended room is
 * kept a day so its result can still be read, then cleared.
 */

export const ROOM_STATUSES = ['open', 'playing', 'ended'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ROOM_VISIBILITIES = ['private', 'public'] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

/** How long a room lives without any activity. */
export const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
/** How long an ended room is kept for its result. */
export const ROOM_ENDED_KEEP_MS = 24 * 60 * 60 * 1000;
/** The most shared state a room may hold, as serialised JSON. */
export const ROOM_STATE_MAX_BYTES = 16 * 1024;

export interface RoomPlayer {
  playerId: string;
  /** Server-side only: who this seat belongs to on Deck. */
  user: mongoose.Types.ObjectId;
  /** Test mode only: which of the developer's sandbox seats this is. */
  seat: number;
  displayName: string;
  ready: boolean;
  joinedAt: Date;
}

export interface RoomResult {
  playerId: string;
  rank: number;
  score: number | null;
}

export interface IGameRoom extends Document {
  _id: mongoose.Types.ObjectId;
  /** `rm_…`. What the SDK and the server API address a room by. */
  roomId: string;
  game: mongoose.Types.ObjectId;
  mode: 'test' | 'live';
  /** Six characters to share. */
  code: string;
  /**
   * The code while the room can still be joined or played; null once it ends.
   * The unique index is on this, so a code is reserved only while it is live
   * and can be handed out again afterwards.
   */
  activeCode: string | null;
  visibility: RoomVisibility;
  status: RoomStatus;
  hostPlayerId: string;
  minPlayers: number;
  maxPlayers: number;
  players: RoomPlayer[];
  /** Shared state the host or the game's server sets. Opaque to Deck. */
  state: unknown;
  results: RoomResult[];
  startedAt: Date | null;
  endedAt: Date | null;
  /** When the room is cleared away. Pushed forward by activity. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const playerSchema = new Schema<RoomPlayer>(
  {
    playerId: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    seat: { type: Number, default: 0 },
    displayName: { type: String, required: true },
    ready: { type: Boolean, default: false },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const resultSchema = new Schema<RoomResult>(
  {
    playerId: { type: String, required: true },
    rank: { type: Number, required: true },
    score: { type: Number, default: null },
  },
  { _id: false },
);

const roomSchema = new Schema<IGameRoom>(
  {
    roomId: { type: String, required: true, unique: true },
    game: { type: Schema.Types.ObjectId, ref: 'Game', required: true },
    mode: { type: String, enum: ['test', 'live'], required: true },
    code: { type: String, required: true },
    activeCode: { type: String, default: null },
    visibility: { type: String, enum: ROOM_VISIBILITIES, default: 'private' },
    status: { type: String, enum: ROOM_STATUSES, default: 'open' },
    hostPlayerId: { type: String, required: true },
    minPlayers: { type: Number, required: true },
    maxPlayers: { type: Number, required: true },
    players: { type: [playerSchema], default: [] },
    state: { type: Schema.Types.Mixed, default: null },
    results: { type: [resultSchema], default: [] },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false },
);

roomSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
/* A join code is unique among live rooms only (see `activeCode`). */
roomSchema.index(
  { activeCode: 1 },
  { unique: true, partialFilterExpression: { activeCode: { $type: 'string' } } },
);
/* Quick match: open public rooms for one game and mode, oldest first. */
roomSchema.index({ game: 1, mode: 1, visibility: 1, status: 1, createdAt: 1 });

export const GameRoom: Model<IGameRoom> =
  mongoose.models.GameRoom ?? mongoose.model<IGameRoom>('GameRoom', roomSchema);
