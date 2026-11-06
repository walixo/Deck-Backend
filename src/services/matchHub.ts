import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { env } from '../config/env';
import { MatchCall, type MatchEndReason } from '../models/MatchCall';
import {
  MatchDay,
  MatchProfile,
  type IMatchProfile,
  type MatchBilling,
  type MatchGender,
  type MatchHandles,
} from '../models/MatchProfile';
import { ApiError } from '../utils/ApiError';
import { hoursAt, lateAt, matchDay } from './matchHours';
import { tonight } from './matchNights';
import { isPlus, MATCH_PRICES, NotEnoughCredit, refund, spend } from './matchWallet';
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
  /** The country they chose, or empty. Matching prefers the same one. */
  country: string;
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
  /** The one free extra minute: added by either person's tap. */
  freeAdded: boolean;
  /** Whoever pressed "Keep talking", and what they have paid for. */
  payers: Map<string, Payer>;
  timer: NodeJS.Timeout | null;
}

/**
 * Someone paying to keep a call going once its free time is up. Time is
 * bought ahead in small blocks — ten seconds at a time per-second, a minute
 * at a time per-minute — and the next block is bought just before the last
 * runs out, so the call never stops while their credit lasts.
 */
interface Payer {
  mode: MatchBilling;
  /** Match+: the time is free. */
  plus: boolean;
  /** Bought time runs to here. Never before the free time ends. */
  paidUntil: number;
  spentMinor: number;
  /** Stopped paying, or ran out: no more blocks are bought. */
  stopped: boolean;
  /* What the last block cost and when it started, for a per-second refund. */
  block: { from: number; ms: number; minor: number } | null;
  renew: NodeJS.Timeout | null;
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
/** The free extra minute: as long as the first, so tests can shorten both. */
const EXTRA_MS = CALL_MS;
/** Paid time is bought this far ahead, per billing mode. */
const BLOCK_MS: Record<MatchBilling, number> = { second: 10_000, minute: 60_000 };
/** The next block is bought this long before the current one runs out. */
const RENEW_EARLY_MS = 2_500;

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
            time: timeView(call, person.userId),
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
  country: string;
  blocked: string[];
}

/** What the hub needs to know about someone, from their profile. */
export const presenceOf = (profile: IMatchProfile): Presence => ({
  userId: String(profile.user),
  gender: profile.gender,
  plus: isPlus(profile),
  verified: Boolean(profile.verifiedAt),
  country: profile.country ?? '',
  blocked: profile.blocked.map(String),
});

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
      country: presence.country,
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
  person.country = presence.country;
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

/**
 * Pairs everyone it can, oldest waiting first on both sides — someone in the
 * same country first, when one is waiting, and otherwise whoever is.
 */
function pairUp(): void {
  for (const manId of [...queues.male]) {
    const man = people.get(manId);
    if (!man || man.state !== 'waiting') continue;
    const open = queues.female.filter((id) => {
      const woman = people.get(id);
      return woman?.state === 'waiting' && canMeet(man, woman);
    });
    const near = man.country
      ? open.find((id) => people.get(id)?.country === man.country)
      : undefined;
    const womanId = near ?? open[0];
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
    freeAdded: false,
    payers: new Map(),
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
  /* Anyone who pressed Keep talking while connecting starts counting now. */
  for (const [id, payer] of call.payers) {
    payer.paidUntil = Math.max(payer.paidUntil, freeEnd(call));
    scheduleRenewal(call, id);
  }
  retime(call);
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
  settlePayers(call, Date.now());
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

/* ------------------------------------------------------------- time --- */

/** When the free time ends: one minute, plus the free extra one if added. */
const freeEnd = (call: Call) =>
  (call.startedAt ?? Date.now()) + CALL_MS + (call.freeAdded ? EXTRA_MS : 0);

/** One side's view of the clock: free or paid, and who is paying. */
function timeView(call: Call, userId: string) {
  const mine = call.payers.get(userId);
  const theirs = call.payers.get(partnerOf(call, userId));
  return {
    freeAdded: call.freeAdded,
    freeEndsAt: call.startedAt ? freeEnd(call) : null,
    paying: {
      you: Boolean(mine && !mine.stopped),
      them: Boolean(theirs && !theirs.stopped),
    },
    mode: mine?.mode ?? null,
    spentMinor: mine?.spentMinor ?? 0,
  };
}

/**
 * Moves the end of the call to the later of the free time and whatever has
 * been paid for, and tells both sides. `note` says what just happened, for
 * the person it happened to and the other one.
 */
function retime(call: Call, note?: { kind: string; by: string }): void {
  if (call.state !== 'live' || !call.startedAt) {
    for (const id of [call.male, call.female]) {
      tell(id, 'time', {
        callId: call.id,
        endsAt: call.endsAt,
        time: timeView(call, id),
        serverNow: Date.now(),
      });
    }
    return;
  }
  const paid = Math.max(0, ...[...call.payers.values()].map((payer) => payer.paidUntil));
  call.endsAt = Math.max(freeEnd(call), paid);
  if (call.timer) clearTimeout(call.timer);
  call.timer = setTimeout(() => end(call, 'time'), Math.max(0, call.endsAt - Date.now()));
  for (const id of [call.male, call.female]) {
    tell(id, 'time', {
      callId: call.id,
      endsAt: call.endsAt,
      time: timeView(call, id),
      note: note ? { kind: note.kind, by: note.by === id ? 'you' : 'them' } : null,
      serverNow: Date.now(),
    });
  }
}

/**
 * The one free extra minute, for both, on either person's tap. A second tap,
 * from either side, has nothing more to give: after it, time is paid for.
 */
export function addFreeMinute(userId: string, callId: string): void {
  const call = inCall(userId, callId);
  if (call.state === 'ended') throw ApiError.conflict('The call has ended');
  if (call.freeAdded)
    throw ApiError.conflict('The free minute is already added — keep talking to go on');
  call.freeAdded = true;
  /* Anyone already paying starts after the new free minute instead. */
  for (const payer of call.payers.values()) payer.paidUntil += EXTRA_MS;
  retime(call, { kind: 'free', by: userId });
  void MatchCall.updateOne({ callId }, { extended: true, extensions: 1 }).catch(() => undefined);
}

const blockPrice = (payer: Pick<Payer, 'mode' | 'plus'>) =>
  payer.plus
    ? 0
    : payer.mode === 'second'
      ? (BLOCK_MS.second / 1000) * MATCH_PRICES.second
      : MATCH_PRICES.minute;

/**
 * Buys the next block of time for one payer. False if they couldn't pay;
 * they then stop, and the call runs on only as long as someone else pays.
 */
async function buyBlock(call: Call, userId: string): Promise<boolean> {
  const payer = call.payers.get(userId);
  if (!payer || payer.stopped || call.state === 'ended') return false;
  const ms = BLOCK_MS[payer.plus ? 'minute' : payer.mode];
  const minor = blockPrice(payer);
  try {
    await spend(
      userId,
      minor,
      'minute',
      call.id,
      payer.plus
        ? 'Extra time · Match+'
        : `Extra time · ${payer.mode === 'second' ? 'per second' : 'per minute'}`,
    );
  } catch {
    payer.stopped = true;
    return false;
  }
  /* The call may have ended while the charge went through. */
  if ((call.state as Call['state']) === 'ended') {
    if (minor > 0) await refund(userId, minor, call.id, 'Call ended first');
    return false;
  }
  const from = Math.max(payer.paidUntil, freeEnd(call), Date.now());
  payer.paidUntil = from + ms;
  payer.spentMinor += minor;
  payer.block = { from, ms, minor };
  return true;
}

function scheduleRenewal(call: Call, userId: string): void {
  const payer = call.payers.get(userId);
  if (!payer || payer.stopped || call.state !== 'live') return;
  if (payer.renew) clearTimeout(payer.renew);
  payer.renew = setTimeout(
    () => {
      void buyBlock(call, userId).then((ok) => {
        if (ok) scheduleRenewal(call, userId);
        retime(call, ok ? undefined : { kind: 'out-of-credit', by: userId });
      });
    },
    Math.max(0, payer.paidUntil - Date.now() - RENEW_EARLY_MS),
  );
}

/**
 * "Keep talking": this person pays to carry the call on past its free time,
 * for both of them. Their first block is bought now, so a tap with no credit
 * is refused straight away instead of when the free time runs out.
 */
export async function keepTalking(
  userId: string,
  callId: string,
  mode: MatchBilling,
  plus: boolean,
): Promise<void> {
  const call = inCall(userId, callId);
  if (call.state === 'ended') throw ApiError.conflict('The call has ended');
  const existing = call.payers.get(userId);
  if (existing && !existing.stopped) return;
  const payer: Payer = existing ?? {
    mode,
    plus,
    paidUntil: 0,
    spentMinor: 0,
    stopped: false,
    block: null,
    renew: null,
  };
  payer.stopped = false;
  call.payers.set(userId, payer);
  const minor = blockPrice(payer);
  try {
    if (!(await buyBlock(call, userId))) throw new Error('declined');
  } catch {
    payer.stopped = true;
    retime(call);
    const profile = await MatchProfile.findOne({ user: userId }).select('creditMinor');
    throw new NotEnoughCredit(minor, profile?.creditMinor ?? 0, userId);
  }
  if (call.state === 'live') scheduleRenewal(call, userId);
  retime(call, { kind: 'paying', by: userId });
}

/** Stops paying. Per second, the unused seconds come back; a minute is kept. */
export async function stopPaying(userId: string, callId: string): Promise<void> {
  const call = inCall(userId, callId);
  const payer = call.payers.get(userId);
  if (!payer || payer.stopped) return;
  payer.stopped = true;
  if (payer.renew) clearTimeout(payer.renew);
  const back = unusedMinor(payer, call, Date.now());
  if (back > 0) {
    payer.spentMinor -= back;
    payer.paidUntil = Math.max(Date.now(), freeEnd(call));
    await refund(userId, back, call.id, 'Extra time not used');
  }
  retime(call, { kind: 'stopped', by: userId });
}

/** What a per-second payer bought but won't use, from `at`: whole seconds only. */
function unusedMinor(payer: Payer, call: Call, at: number): number {
  if (payer.plus || payer.mode !== 'second' || !payer.block) return 0;
  const usedFrom = Math.max(at, freeEnd(call));
  const unusedMs = Math.max(0, payer.paidUntil - usedFrom);
  const seconds = Math.floor(Math.min(unusedMs, payer.block.ms) / 1000);
  return Math.min(payer.block.minor, seconds * MATCH_PRICES.second);
}

/** At the end: stop every renewal and hand back unused per-second time. */
function settlePayers(call: Call, at: number): void {
  for (const [id, payer] of call.payers) {
    if (payer.renew) clearTimeout(payer.renew);
    const back = unusedMinor(payer, call, at);
    payer.stopped = true;
    if (back > 0) {
      payer.spentMinor -= back;
      void refund(id, back, call.id, 'Extra time not used').catch(() => undefined);
    }
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
