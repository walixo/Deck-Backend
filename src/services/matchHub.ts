import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { env } from '../config/env';
import { MatchCall, type MatchEndReason } from '../models/MatchCall';
import type { MatchGender } from '../models/MatchProfile';
import { ApiError } from '../utils/ApiError';

/**
 * Match, live: who is online, who is waiting, who is talking to whom.
 *
 * Every person with Match open holds one server-sent-events stream; everything
 * Deck tells them travels down it, and everything they tell Deck is an
 * ordinary POST. Men wait in one line and women in the other. Whenever someone
 * joins a line, the hub pairs the longest-waiting man with the longest-waiting
 * woman who can hear each other — not blocked either way, not just matched.
 *
 * The voices never pass through here. The hub introduces the two browsers by
 * relaying their WebRTC offer, answer and network candidates, then keeps the
 * clock: two minutes from the moment both say they can hear each other, after
 * which it ends the call for both. Only a call that ran out its time opens a
 * share window, and LagosLife usernames are revealed only if both press share.
 *
 * Like the multiplayer hub, this lives in one process's memory: Deck runs one
 * instance. A person whose stream drops has a short grace to reconnect before
 * they leave the line or the call.
 */

export type MatchState = 'idle' | 'waiting' | 'calling';

interface Person {
  userId: string;
  gender: MatchGender;
  handle: string;
  blocked: Set<string>;
  lines: Set<Response>;
  state: MatchState;
  waitingSince: number;
  callId: string | null;
  goneTimer: NodeJS.Timeout | null;
}

interface Call {
  id: string;
  male: string;
  female: string;
  /** Who makes the WebRTC offer; the other answers. */
  caller: string;
  matchedAt: number;
  startedAt: number | null;
  endsAt: number | null;
  connected: Set<string>;
  state: 'connecting' | 'live' | 'ended';
  endReason: MatchEndReason | null;
  shareUntil: number;
  shares: Map<string, string>;
  revealed: boolean;
  timer: NodeJS.Timeout | null;
}

const CALL_MS = env.matchCallSeconds * 1000;
const SHARE_MS = env.matchShareSeconds * 1000;
/** Long enough for two phones on mobile data to find each other. */
const CONNECT_MS = 25_000;
/** A stream that drops may come back this quickly, as phones switch networks. */
const GRACE_MS = 10_000;
/** The same two people are not matched again within this long. */
const REMATCH_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 15_000;

const people = new Map<string, Person>();
const queues: Record<MatchGender, string[]> = { male: [], female: [] };
const calls = new Map<string, Call>();
const recent = new Map<string, number>();

const pairKey = (a: string, b: string) => [a, b].sort().join(':');

/* ------------------------------------------------------------ writing --- */

function write(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function tell(userId: string, event: string, data: unknown): void {
  for (const res of people.get(userId)?.lines ?? []) write(res, event, data);
}

export function counts() {
  let male = 0;
  let female = 0;
  for (const person of people.values()) {
    if (person.gender === 'male') male += 1;
    else female += 1;
  }
  return { total: male + female, male, female };
}

/* Online counts change often; everyone hears at most every 1.5s. */
let onlineTimer: NodeJS.Timeout | null = null;
function announceOnline(): void {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = null;
    const now = counts();
    for (const person of people.values()) for (const res of person.lines) write(res, 'online', now);
  }, 1500);
}

function announceQueue(): void {
  for (const gender of ['male', 'female'] as const) {
    const other = gender === 'male' ? 'female' : 'male';
    queues[gender].forEach((userId, index) =>
      tell(userId, 'queue', {
        position: index + 1,
        waiting: { [gender]: queues[gender].length, [other]: queues[other].length },
      }),
    );
  }
}

/** What a person's screen should show right now — sent on every (re)connect. */
function snapshot(person: Person) {
  const call = person.callId ? calls.get(person.callId) : undefined;
  return {
    online: counts(),
    state: person.state,
    position: person.state === 'waiting' ? queues[person.gender].indexOf(person.userId) + 1 : null,
    call:
      call && call.state !== 'ended'
        ? {
            callId: call.id,
            caller: call.caller === person.userId,
            startedAt: call.startedAt,
            endsAt: call.endsAt,
          }
        : null,
    serverNow: Date.now(),
  };
}

/* ------------------------------------------------------------- people --- */

export interface Presence {
  userId: string;
  gender: MatchGender;
  handle: string;
  blocked: string[];
}

/** Opens one person's stream. It stays open until they go away. */
export function attach(presence: Presence, res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let person = people.get(presence.userId);
  if (person) {
    if (person.goneTimer) clearTimeout(person.goneTimer);
    person.goneTimer = null;
  } else {
    person = {
      userId: presence.userId,
      gender: presence.gender,
      handle: presence.handle,
      blocked: new Set(presence.blocked),
      lines: new Set(),
      state: 'idle',
      waitingSince: 0,
      callId: null,
      goneTimer: null,
    };
    people.set(presence.userId, person);
  }
  update(presence);
  person.lines.add(res);
  write(res, 'hello', snapshot(person));
  announceOnline();

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
  res.on('close', () => {
    clearInterval(heartbeat);
    const current = people.get(presence.userId);
    if (!current) return;
    current.lines.delete(res);
    if (current.lines.size === 0 && !current.goneTimer) {
      current.goneTimer = setTimeout(() => depart(presence.userId), GRACE_MS);
    }
  });
}

/** A profile changed — a new username, a new block — and the hub should know. */
export function update(presence: Presence): void {
  const person = people.get(presence.userId);
  if (!person) return;
  person.handle = presence.handle;
  person.blocked = new Set(presence.blocked);
}

/** Gone for good: out of the line, out of any call, off the count. */
function depart(userId: string): void {
  const person = people.get(userId);
  if (!person) return;
  if (person.state === 'waiting') unqueue(person);
  if (person.state === 'calling' && person.callId) {
    const call = calls.get(person.callId);
    if (call) end(call, 'left', userId);
  }
  people.delete(userId);
  announceOnline();
  announceQueue();
}

/** Removes someone from the hub at once and closes their streams — a ban. */
export function kick(userId: string): void {
  const person = people.get(userId);
  if (!person) return;
  tell(userId, 'banned', {});
  for (const res of person.lines) res.end();
  if (person.goneTimer) clearTimeout(person.goneTimer);
  depart(userId);
}

function present(userId: string): Person {
  const person = people.get(userId);
  if (!person || person.lines.size === 0) throw ApiError.conflict('Open Match first');
  return person;
}

/* ------------------------------------------------------------ the line --- */

function unqueue(person: Person): void {
  queues[person.gender] = queues[person.gender].filter((id) => id !== person.userId);
  person.state = 'idle';
}

export function enqueue(userId: string): { position: number } {
  const person = present(userId);
  if (person.state === 'calling') throw ApiError.conflict('You are in a call');
  if (person.state !== 'waiting') {
    person.state = 'waiting';
    person.waitingSince = Date.now();
    queues[person.gender].push(userId);
  }
  pairUp();
  announceQueue();
  const position = queues[person.gender].indexOf(userId) + 1;
  return { position };
}

export function dequeue(userId: string): void {
  const person = people.get(userId);
  if (person?.state === 'waiting') unqueue(person);
  announceQueue();
}

function canMeet(man: Person, woman: Person): boolean {
  if (man.lines.size === 0 || woman.lines.size === 0) return false;
  if (man.blocked.has(woman.userId) || woman.blocked.has(man.userId)) return false;
  const last = recent.get(pairKey(man.userId, woman.userId));
  return !last || Date.now() - last > REMATCH_MS;
}

/** Pairs everyone it can, oldest waiting first on both sides. */
function pairUp(): void {
  for (const manId of [...queues.male]) {
    const man = people.get(manId);
    if (!man || man.state !== 'waiting') continue;
    const womanId = queues.female.find((id) => {
      const woman = people.get(id);
      return woman?.state === 'waiting' && canMeet(man, woman);
    });
    if (womanId) begin(man, people.get(womanId)!);
  }
}

/* ------------------------------------------------------------ the call --- */

function begin(man: Person, woman: Person): void {
  const call: Call = {
    id: `mc_${randomBytes(9).toString('base64url')}`,
    male: man.userId,
    female: woman.userId,
    caller: man.userId,
    matchedAt: Date.now(),
    startedAt: null,
    endsAt: null,
    connected: new Set(),
    state: 'connecting',
    endReason: null,
    shareUntil: 0,
    shares: new Map(),
    revealed: false,
    timer: null,
  };
  calls.set(call.id, call);
  for (const person of [man, woman]) {
    unqueue(person);
    person.state = 'calling';
    person.callId = call.id;
    tell(person.userId, 'matched', { callId: call.id, caller: call.caller === person.userId });
  }
  recent.set(pairKey(man.userId, woman.userId), call.matchedAt);
  call.timer = setTimeout(() => {
    if (call.state === 'connecting') end(call, 'no-connection');
  }, CONNECT_MS);
  void MatchCall.create({
    callId: call.id,
    male: man.userId,
    female: woman.userId,
    matchedAt: new Date(call.matchedAt),
  }).catch(() => undefined);
}

function inCall(userId: string, callId: string): Call {
  const call = calls.get(callId);
  if (!call || (call.male !== userId && call.female !== userId)) {
    throw ApiError.notFound('That call is not yours');
  }
  return call;
}

const partnerOf = (call: Call, userId: string) => (call.male === userId ? call.female : call.male);

/** Passes WebRTC set-up — an offer, an answer, a network candidate — across. */
export function relay(userId: string, callId: string, data: unknown): void {
  const call = inCall(userId, callId);
  if (call.state === 'ended') throw ApiError.conflict('This call has ended');
  tell(partnerOf(call, userId), 'signal', { callId, data });
}

/** One side can hear the other. When both can, the two minutes start. */
export function connected(userId: string, callId: string): void {
  const call = inCall(userId, callId);
  if (call.state !== 'connecting') return;
  call.connected.add(userId);
  if (call.connected.size < 2) return;

  if (call.timer) clearTimeout(call.timer);
  call.state = 'live';
  call.startedAt = Date.now();
  call.endsAt = call.startedAt + CALL_MS;
  call.timer = setTimeout(() => end(call, 'time'), CALL_MS);
  for (const id of [call.male, call.female]) {
    tell(id, 'started', { callId, startedAt: call.startedAt, endsAt: call.endsAt, serverNow: Date.now() });
  }
  void MatchCall.updateOne({ callId }, { startedAt: new Date(call.startedAt) }).catch(() => undefined);
}

function end(call: Call, reason: MatchEndReason, by?: string): void {
  if (call.state === 'ended') return;
  if (call.timer) clearTimeout(call.timer);
  call.state = 'ended';
  call.endReason = reason;
  call.shareUntil = reason === 'time' ? Date.now() + SHARE_MS : 0;
  for (const id of [call.male, call.female]) {
    const person = people.get(id);
    if (person && person.callId === call.id) {
      person.state = 'idle';
      person.callId = null;
    }
    tell(id, 'ended', {
      callId: call.id,
      reason,
      by: by ? (by === id ? 'you' : 'them') : null,
      canShare: reason === 'time',
      shareUntil: call.shareUntil,
      serverNow: Date.now(),
    });
  }
  void MatchCall.updateOne({ callId: call.id }, { endedAt: new Date(), endReason: reason }).catch(
    () => undefined,
  );
  /* Kept a little past the share window, then forgotten. */
  setTimeout(() => calls.delete(call.id), SHARE_MS + 10_000);
  announceOnline();
}

export function leave(userId: string, callId: string, reason: MatchEndReason = 'left'): void {
  end(inCall(userId, callId), reason, userId);
}

/** The other person in a call, for reports. */
export function partner(userId: string, callId: string): string {
  return partnerOf(inCall(userId, callId), userId);
}

/**
 * Presses share. Nothing is revealed until both have; then each hears the
 * other's username. Open only after a call that ran its full two minutes.
 */
export function share(userId: string, callId: string, handle: string): { revealed: boolean } {
  const call = inCall(userId, callId);
  if (call.endReason !== 'time') throw ApiError.conflict('You can share once your two minutes are up');
  if (Date.now() > call.shareUntil) throw ApiError.conflict('The time to share has passed');
  if (!handle) throw ApiError.badRequest('Add your LagosLife username first');
  call.shares.set(userId, handle);
  if (call.shares.size === 2 && !call.revealed) {
    call.revealed = true;
    for (const id of [call.male, call.female]) {
      tell(id, 'revealed', { callId, handle: call.shares.get(partnerOf(call, id)) });
    }
  }
  return { revealed: call.revealed };
}

/** For tests: the hub back to empty. */
export function resetMatchHub(): void {
  for (const call of calls.values()) if (call.timer) clearTimeout(call.timer);
  people.clear();
  calls.clear();
  recent.clear();
  queues.male = [];
  queues.female = [];
}
