import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { env } from '../config/env';
import { MatchCall, type MatchEndReason } from '../models/MatchCall';
import { MatchDay, type MatchGender, type MatchHandles } from '../models/MatchProfile';
import { ApiError } from '../utils/ApiError';
import { hoursAt, lateAt, matchDay } from './matchHours';
import { tonight } from './matchNights';
import { pushPublicKey } from './vapid';

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
 * share window, and X and Instagram usernames are revealed only if both press share.
 *
 * Match keeps evening hours (see `matchHours.ts`): nobody joins a line while
 * it is closed, the lines empty at closing time, and calls already running
 * finish. Until enough people are online, everyone sees "busy" or "quiet"
 * rather than a small number (`publicView`); staff see the real figures.
 *
 * Like the multiplayer hub, this lives in one process's memory: Deck runs one
 * instance. A person whose stream drops has a short grace to reconnect before
 * they leave the line or the call.
 */

export type MatchState = 'idle' | 'waiting' | 'calling';

interface Person {
  userId: string;
  gender: MatchGender;
  /** A Match+ member: may join the line in the late window. */
  plus: boolean;
  /** Has the Verified badge, which the person they talk to sees. */
  verified: boolean;
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
  shares: Map<string, MatchHandles>;
  revealed: boolean;
  /** Who pressed +1 minute this round. Both pressing adds a minute. */
  extendVotes: Set<string>;
  /** Minutes added so far. The first is free; later ones are paid for. */
  extensions: number;
  /** Both pressed and the server is charging for it; no new votes meanwhile. */
  settling: boolean;
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
/** Two people can talk this many times in all; after that they are not matched again. */
export const MAX_CALLS_TOGETHER = 5;
const HEARTBEAT_MS = 15_000;
const EXTRA_MS = 60_000;

const people = new Map<string, Person>();
const queues: Record<MatchGender, string[]> = { male: [], female: [] };
const calls = new Map<string, Call>();
const recent = new Map<string, number>();
/* How many times each pair has actually talked — calls that connected, not
   ones that failed to. Loaded from the call history at start-up. */
const talked = new Map<string, number>();

const pairKey = (a: string, b: string) => [a, b].sort().join(':');

/* ------------------------------------------------------------ writing --- */

function write(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Tells someone something outside a call — a gift arriving, a new balance. */
export function notify(userId: string, event: string, data: unknown): void {
  tell(userId, event, data);
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

/* What browsers need to subscribe to pings; null when pings are not set up. */
const pushKey = pushPublicKey();

/**
 * What everyone may see: the hours, whether anyone is on each side, and the
 * real numbers only once there are enough of them to encourage rather than
 * put off.
 */
export function publicView() {
  const now = counts();
  return {
    hours: hoursAt(),
    late: lateAt(),
    tonight: tonight(),
    live: now.total >= env.matchCountsFrom ? now : null,
    available: { male: now.male > 0, female: now.female > 0 },
    pushKey,
  };
}

/* The busiest moment of each evening, for staff. Written at most every 10s. */
let peakTimer: NodeJS.Timeout | null = null;
function notePeak(): void {
  if (peakTimer) return;
  peakTimer = setTimeout(() => {
    peakTimer = null;
    const now = counts();
    void MatchDay.updateOne(
      { day: matchDay() },
      { $max: { peakOnline: now.total, peakMale: now.male, peakFemale: now.female } },
      { upsert: true },
    ).catch(() => undefined);
  }, 10_000);
}

/* Someone arrived: a listener (the pinger) may tell people who are away. */
let arrivalListener: ((gender: MatchGender) => void) | null = null;
export function onArrival(listener: (gender: MatchGender) => void): void {
  arrivalListener = listener;
}
function arrived(gender: MatchGender): void {
  if (hoursAt().open) arrivalListener?.(gender);
}

export function isOnline(userId: string): boolean {
  return Boolean(people.get(userId)?.lines.size);
}

/* Online counts change often; everyone hears at most every 1.5s. */
let onlineTimer: NodeJS.Timeout | null = null;
function announceOnline(): void {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = null;
    const view = publicView();
    for (const person of people.values())
      for (const res of person.lines) write(res, 'online', view);
  }, 1500);
}

function announceQueue(): void {
  for (const gender of ['male', 'female'] as const) {
    const other = gender === 'male' ? 'female' : 'male';
    queues[gender].forEach((userId, index) =>
      tell(userId, 'queue', { position: index + 1, otherWaiting: queues[other].length > 0 }),
    );
  }
}

/** What a person's screen should show right now — sent on every (re)connect. */
function snapshot(person: Person) {
  const call = person.callId ? calls.get(person.callId) : undefined;
  return {
    online: publicView(),
    state: person.state,
    position: person.state === 'waiting' ? queues[person.gender].indexOf(person.userId) + 1 : null,
    call:
      call && call.state !== 'ended'
        ? {
            callId: call.id,
            caller: call.caller === person.userId,
            startedAt: call.startedAt,
            endsAt: call.endsAt,
            extensions: call.extensions,
            them: { verified: Boolean(people.get(partnerOf(call, person.userId))?.verified) },
          }
        : null,
    serverNow: Date.now(),
  };
}

/* ------------------------------------------------------------- people --- */

export interface Presence {
  userId: string;
  gender: MatchGender;
  plus: boolean;
  verified: boolean;
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
      plus: presence.plus,
      verified: presence.verified,
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
  const fresh = person.lines.size === 0;
  person.lines.add(res);
  write(res, 'hello', snapshot(person));
  announceOnline();
  notePeak();
  if (fresh) arrived(person.gender);

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

/** A profile changed — a new block, Match+, a badge — and the hub should know. */
export function update(presence: Presence): void {
  const person = people.get(presence.userId);
  if (!person) return;
  person.plus = presence.plus;
  person.verified = presence.verified;
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

/**
 * Takes someone out at once, quietly — out of any line or call, streams
 * closed. Their page reconnects by itself and comes back as they are now
 * (after staff switch their section, say).
 */
export function reset(userId: string): void {
  const person = people.get(userId);
  if (!person) return;
  if (person.goneTimer) clearTimeout(person.goneTimer);
  const lines = [...person.lines];
  depart(userId);
  for (const res of lines) res.end();
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
  if (!hoursAt().open && !(person.plus && lateAt().open)) {
    const hour = env.matchHours.open % 12 || 12;
    const opens = `${hour}${env.matchHours.open < 12 ? 'am' : 'pm'}`;
    throw ApiError.conflict(
      lateAt().open
        ? `Match is closed — it opens at ${opens}. Match+ members talk until midnight.`
        : `Match is closed — it opens at ${opens}`,
    );
  }
  if (person.state !== 'waiting') {
    person.state = 'waiting';
    person.waitingSince = Date.now();
    queues[person.gender].push(userId);
    arrived(person.gender);
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
  const pair = pairKey(man.userId, woman.userId);
  if ((talked.get(pair) ?? 0) >= MAX_CALLS_TOGETHER) return false;
  const last = recent.get(pair);
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
    extendVotes: new Set(),
    extensions: 0,
    settling: false,
    timer: null,
  };
  calls.set(call.id, call);
  const waits = {
    male: call.matchedAt - man.waitingSince,
    female: call.matchedAt - woman.waitingSince,
  };
  for (const person of [man, woman]) {
    unqueue(person);
    person.state = 'calling';
    person.callId = call.id;
    const partner = person === man ? woman : man;
    tell(person.userId, 'matched', {
      callId: call.id,
      caller: call.caller === person.userId,
      them: { verified: partner.verified },
    });
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
    maleWaitMs: waits.male,
    femaleWaitMs: waits.female,
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
  const pair = pairKey(call.male, call.female);
  talked.set(pair, (talked.get(pair) ?? 0) + 1);
  call.endsAt = call.startedAt + CALL_MS;
  call.timer = setTimeout(() => end(call, 'time'), CALL_MS);
  for (const id of [call.male, call.female]) {
    tell(id, 'started', {
      callId,
      startedAt: call.startedAt,
      endsAt: call.endsAt,
      serverNow: Date.now(),
    });
  }
  void MatchCall.updateOne({ callId }, { startedAt: new Date(call.startedAt) }).catch(
    () => undefined,
  );
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
  void MatchCall.updateOne(
    { callId: call.id },
    { endedAt: new Date(), endReason: reason, endedBy: by ?? null },
  ).catch(() => undefined);
  /* Kept a little past the share window, then forgotten. */
  setTimeout(() => calls.delete(call.id), SHARE_MS + 10_000);
  announceOnline();
}

/**
 * Presses +1 minute. Each side hears who has pressed, so the other can say
 * yes too. When both have, the round is `agreed`: the caller charges for it
 * (the first minute is free) and then grants or refuses it. Nobody can vote
 * again while that is being settled.
 */
export function voteMinute(
  userId: string,
  callId: string,
): { agreed: false } | { agreed: true; round: number; male: string; female: string } {
  const call = inCall(userId, callId);
  if (call.state !== 'live') throw ApiError.conflict('No more time to add');
  if (call.settling) throw ApiError.conflict('Adding a minute…');
  call.extendVotes.add(userId);
  for (const id of [call.male, call.female]) {
    tell(id, 'extend', {
      callId,
      mine: call.extendVotes.has(id),
      theirs: call.extendVotes.has(partnerOf(call, id)),
      round: call.extensions,
    });
  }
  if (call.extendVotes.size < 2) return { agreed: false };
  call.settling = true;
  return { agreed: true, round: call.extensions, male: call.male, female: call.female };
}

/** Minutes added to this call so far: the next one is free only if none were. */
export function minutesAdded(userId: string, callId: string): number {
  return inCall(userId, callId).extensions;
}

/** Adds the agreed minute. False if the call ended while it was paid for. */
export function grantMinute(callId: string): boolean {
  const call = calls.get(callId);
  if (!call) return false;
  call.settling = false;
  call.extendVotes.clear();
  if (call.state !== 'live') return false;
  call.extensions += 1;
  call.endsAt = (call.endsAt ?? Date.now()) + EXTRA_MS;
  if (call.timer) clearTimeout(call.timer);
  call.timer = setTimeout(() => end(call, 'time'), call.endsAt - Date.now());
  for (const id of [call.male, call.female]) {
    tell(id, 'extended', {
      callId,
      endsAt: call.endsAt,
      serverNow: Date.now(),
      extensions: call.extensions,
    });
  }
  void MatchCall.updateOne({ callId }, { extended: true, extensions: call.extensions }).catch(
    () => undefined,
  );
  return true;
}

/** The agreed minute could not be paid for: the votes reset, with a reason. */
export function refuseMinute(callId: string, short: string): void {
  const call = calls.get(callId);
  if (!call) return;
  call.settling = false;
  call.extendVotes.clear();
  for (const id of [call.male, call.female]) {
    tell(id, 'extend', {
      callId,
      mine: false,
      theirs: false,
      round: call.extensions,
      refused: id === short ? 'you' : 'them',
    });
  }
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
export function share(
  userId: string,
  callId: string,
  handles: MatchHandles,
): { revealed: boolean } {
  const call = inCall(userId, callId);
  if (call.endReason !== 'time')
    throw ApiError.conflict('You can share once your two minutes are up');
  if (Date.now() > call.shareUntil) throw ApiError.conflict('The time to share has passed');
  if (!handles.x && !handles.instagram) {
    throw ApiError.badRequest('Add your X or Instagram username first');
  }
  call.shares.set(userId, handles);
  if (call.shares.size === 2 && !call.revealed) {
    call.revealed = true;
    for (const id of [call.male, call.female]) {
      tell(id, 'revealed', { callId, handles: call.shares.get(partnerOf(call, id)) });
    }
  }
  return { revealed: call.revealed };
}

/*
 * Opening and closing time. At closing the lines empty — anyone mid-call
 * finishes their call — and everyone hears the new hours.
 */
let wasOpen = hoursAt().open;
let wasLate = lateAt().open;
setInterval(() => {
  const open = hoursAt().open;
  const late = lateAt().open;
  if (open === wasOpen && late === wasLate) return;
  wasOpen = open;
  wasLate = late;
  if (!open) {
    /* At closing, Match+ members may stay in line for the late window. */
    for (const gender of ['male', 'female'] as const) {
      queues[gender] = queues[gender].filter((userId) => {
        const person = people.get(userId);
        if (late && person?.plus) return true;
        if (person) person.state = 'idle';
        tell(userId, 'closed', {});
        return false;
      });
    }
  }
  const view = publicView();
  for (const person of people.values()) for (const res of person.lines) write(res, 'online', view);
}, 15_000).unref();

/**
 * Counts every pair's connected calls from the history, so the limit on
 * talking to the same person survives a restart. Called once at start-up.
 */
export async function loadTalkedCounts(): Promise<void> {
  const pairs = await MatchCall.aggregate<{
    _id: { male: unknown; female: unknown };
    count: number;
  }>([
    { $match: { startedAt: { $ne: null } } },
    { $group: { _id: { male: '$male', female: '$female' }, count: { $sum: 1 } } },
  ]);
  for (const pair of pairs) {
    talked.set(pairKey(String(pair._id.male), String(pair._id.female)), pair.count);
  }
}

/** For tests: the hub back to empty. */
export function resetMatchHub(): void {
  for (const call of calls.values()) if (call.timer) clearTimeout(call.timer);
  people.clear();
  calls.clear();
  recent.clear();
  talked.clear();
  queues.male = [];
  queues.female = [];
}
