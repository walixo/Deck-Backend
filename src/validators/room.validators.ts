import { z } from 'zod';
import { ROOM_VISIBILITIES } from '../models/GameRoom';

/** Inputs to multiplayer rooms: the player's endpoints and the server API. */

const mode = z.enum(['test', 'live']);
/* Sandbox seats; the controller checks it is test mode and the developer. */
const seat = z.coerce.number().int().min(0).max(15).optional();

/** Any JSON at all — the game decides what it means. Size is checked separately. */
const json = z.unknown();

/** Who a message goes to: everyone else, everyone, the host, or one player. */
const target = z
  .union([z.enum(['others', 'all', 'host']), z.string().regex(/^[pt]_[a-z0-9]{8,40}$/)])
  .default('others');

export const createRoomSchema = z
  .object({ mode: mode.optional(), visibility: z.enum(ROOM_VISIBILITIES).default('private'), seat })
  .strict();

export const joinRoomSchema = z
  .object({
    mode: mode.optional(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[23456789A-HJ-NP-Z]{6}$/, 'Room codes are six letters and numbers'),
    seat,
  })
  .strict();

export const quickMatchSchema = z.object({ mode: mode.optional(), seat }).strict();

export const seatOnlySchema = z.object({ seat }).strict();

export const readySchema = z.object({ ready: z.boolean(), seat }).strict();

export const roomMessageSchema = z.object({ to: target, data: json, seat }).strict();

export const roomStateSchema = z.object({ state: json, seat }).strict();

export const seatQuerySchema = z.object({ seat });

/* ------------------------------------------------- the server API --- */

export const serverMessageSchema = z.object({ to: target, data: json }).strict();

export const serverStateSchema = z.object({ state: json }).strict();

export const endRoomSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            playerId: z.string().regex(/^[pt]_[a-z0-9]{8,40}$/),
            rank: z.number().int().min(1).max(100),
            score: z.number().int().min(0).max(1_000_000_000).optional(),
          })
          .strict(),
      )
      .max(16)
      .default([]),
  })
  .strict();

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;
export type QuickMatchInput = z.infer<typeof quickMatchSchema>;
export type ReadyInput = z.infer<typeof readySchema>;
export type RoomMessageInput = z.infer<typeof roomMessageSchema>;
export type RoomStateInput = z.infer<typeof roomStateSchema>;
export type ServerMessageInput = z.infer<typeof serverMessageSchema>;
export type ServerStateInput = z.infer<typeof serverStateSchema>;
export type EndRoomInput = z.infer<typeof endRoomSchema>;
