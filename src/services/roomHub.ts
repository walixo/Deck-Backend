import type { Response } from 'express';

/**
 * The live half of multiplayer: who is connected to which room, and getting
 * each event to them the moment it happens.
 *
 * Each player in a room holds one long-lived HTTP response open — a
 * server-sent-events stream — and Deck writes room changes, shared state and
 * relayed messages down it. Messages going the other way are ordinary POSTs.
 * That is the whole transport: no WebSocket server, no broker, nothing to run
 * beside the API. It suits lobbies, turn-based play and casual real-time
 * games; a game that needs frame-perfect netcode can run its own server and
 * use Deck for rooms and identity alone.
 *
 * The trade, stated rather than hidden — the same one the rate limiter makes:
 * this lives in one Node process's memory. Deck runs one instance, so every
 * player in a room is connected to the same hub. Run two instances and players
 * on different ones would stop hearing each other; that is the day to put a
 * shared bus behind `publish`, and nothing outside this file has to change.
 */

interface Subscriber {
  playerId: string;
  res: Response;
}

const rooms = new Map<string, Set<Subscriber>>();

/** Keep-alive interval. Proxies close streams that go quiet for long. */
const HEARTBEAT_MS = 15_000;

function write(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Opens a stream for one player in one room. It stays open until the client
 * goes away (or the room ends), and `onClose` runs when it does.
 */
export function subscribe(
  roomId: string,
  playerId: string,
  res: Response,
  onClose: () => void,
): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  /* Render and nginx buffer responses by default; a buffered stream is not live. */
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const subscriber: Subscriber = { playerId, res };
  let set = rooms.get(roomId);
  if (!set) {
    set = new Set();
    rooms.set(roomId, set);
  }
  set.add(subscriber);

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);

  res.on('close', () => {
    clearInterval(heartbeat);
    const current = rooms.get(roomId);
    current?.delete(subscriber);
    if (current && current.size === 0) rooms.delete(roomId);
    onClose();
  });
}

/** Sends an event to everyone in a room, or only to the listed players. */
export function publish(roomId: string, event: string, data: unknown, to?: string[]): number {
  const set = rooms.get(roomId);
  if (!set) return 0;
  let sent = 0;
  for (const subscriber of set) {
    if (to && !to.includes(subscriber.playerId)) continue;
    write(subscriber.res, event, data);
    sent += 1;
  }
  return sent;
}

/** Which players in a room currently have a stream open. */
export function online(roomId: string): string[] {
  return [...(rooms.get(roomId) ?? [])].map((s) => s.playerId);
}

/** Ends every stream in a room — after it has ended, nothing more will come. */
export function closeRoom(roomId: string): void {
  for (const subscriber of rooms.get(roomId) ?? []) subscriber.res.end();
  rooms.delete(roomId);
}

/* ------------------------------------------------------- message rate --- */

/**
 * A token bucket per player per room: bursts of up to 30 messages, refilling
 * at 20 a second. Generous for any game that is not streaming positions every
 * frame — and a game that is should not be doing it through a relay.
 */
const BUCKET_SIZE = 30;
const REFILL_PER_SEC = 20;
const buckets = new Map<string, { tokens: number; at: number }>();

export function takeMessageToken(roomId: string, playerId: string): boolean {
  const key = `${roomId}:${playerId}`;
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: BUCKET_SIZE, at: now };
  bucket.tokens = Math.min(
    BUCKET_SIZE,
    bucket.tokens + ((now - bucket.at) / 1000) * REFILL_PER_SEC,
  );
  bucket.at = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  /* Forget idle buckets so the map cannot grow without bound. */
  if (buckets.size > 20_000) {
    for (const [k, b] of buckets) if (now - b.at > 60_000) buckets.delete(k);
  }
  return true;
}
