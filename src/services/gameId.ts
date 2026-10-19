import crypto from 'node:crypto';
import { env } from '../config/env';
import { User, type IUser } from '../models/User';

/**
 * GameID's rules: who a player is, what an app may learn, and where a code
 * may be sent.
 */

/** Everything an app can ask for. There is no email scope, by design. */
export const GAMEID_SCOPES = {
  openid: 'Confirm it’s you — an ID unique to this app',
  profile: 'Your GameID — handle, code, display name and avatar',
} as const;
export type GameIdScope = keyof typeof GAMEID_SCOPES;

export function parseScopes(raw: string | undefined): GameIdScope[] | null {
  const requested = (raw ?? '').split(/\s+/).filter(Boolean);
  if (!requested.includes('openid')) return null;
  if (!requested.every((scope) => scope in GAMEID_SCOPES)) return null;
  return [...new Set(requested)] as GameIdScope[];
}

/** The public origin apps see in tokens and discovery. */
export function issuer(): string {
  return env.gameId.issuer || (env.clientOrigins[0] ?? 'http://localhost:5173').replace(/\/+$/, '');
}

/**
 * The subject an app knows a player by: stable for that player in that app,
 * different in every other app, and meaningless without Deck's secret. Two
 * apps comparing subjects cannot tell they share a player — unless the player
 * also gave both of them their GameID, which is the player's choice to make.
 */
export function pairwiseSubject(userId: string, clientId: string): string {
  const secret = env.gameId.subjectSecret || `gameid-sub:${env.jwtSecret}`;
  const digest = crypto.createHmac('sha256', secret).update(`${clientId}:${userId}`).digest('base64url');
  return `gid_${digest.slice(0, 27)}`;
}

/* ------------------------------------------------------------ handles --- */

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.]{2,23}$/;
const RESERVED = new Set(['admin', 'deck', 'gameid', 'support', 'staff', 'official', 'system', 'root', 'null', 'undefined']);
/** A handle may change once every 30 days, so it stays something people can find. */
export const HANDLE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export function handleProblem(handle: string): string | null {
  if (!HANDLE_PATTERN.test(handle)) {
    return 'Use 3–24 lowercase letters, numbers, dots or underscores, starting with a letter or number';
  }
  if (RESERVED.has(handle) || handle.includes('..')) return 'That handle is not available';
  return null;
}

/** `GID-7F3K-9Q2M` — no 0/O/1/I, so it can be read aloud or typed from a screenshot. */
function mintCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return `GID-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * Gives a player their GameID on first use: their Deck username as the handle
 * where it is free and valid, a numbered variant where not, and a fresh code.
 * Unique indexes settle any race between two first uses.
 */
export async function ensureGameId(user: IUser): Promise<IUser> {
  if (user.gameId?.handle) return user;

  const base =
    user.username
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, '')
      .replace(/^[_.]+/, '')
      .slice(0, 20) || 'player';
  const seed = handleProblem(base) ? `player${base}`.slice(0, 20) : base;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const handle = attempt === 0 ? seed : `${seed.slice(0, 19)}${crypto.randomInt(10, 99999)}`;
    if (handleProblem(handle)) continue;
    try {
      const updated = await User.findOneAndUpdate(
        { _id: user._id, 'gameId.handle': { $exists: false } },
        { $set: { gameId: { handle, code: mintCode(), handleChangedAt: null, createdAt: new Date() } } },
        { new: true },
      );
      return updated ?? ((await User.findById(user._id)) as IUser);
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  throw new Error('Could not assign a GameID');
}

export function toGameIdResponse(user: IUser) {
  return {
    handle: user.gameId?.handle ?? null,
    code: user.gameId?.code ?? null,
    displayName: user.name,
    avatarUrl: user.avatarUrl ?? null,
    handleChangedAt: user.gameId?.handleChangedAt ?? null,
    createdAt: user.gameId?.createdAt ?? null,
  };
}

/** The claims an app receives, by scope. Never more. */
export function claimsFor(user: IUser, clientId: string, scopes: string[]) {
  const claims: Record<string, unknown> = { sub: pairwiseSubject(user._id.toString(), clientId) };
  if (scopes.includes('profile') && user.gameId) {
    claims.gameid = user.gameId.code;
    claims.preferred_username = user.gameId.handle;
    claims.name = user.name;
    if (user.avatarUrl) claims.picture = user.avatarUrl;
  }
  return claims;
}

/* ------------------------------------------------------ redirect URIs --- */

/**
 * Where an app may receive codes.
 *
 * https anywhere; http only on the developer's own machine; and, for public
 * (native) apps, a private-use scheme such as `com.studio.game:/callback`
 * (RFC 8252). Never `javascript:`, `data:` or `file:`, and never a fragment —
 * a code in a fragment is a code in the browser history.
 */
export function redirectUriProblem(value: string, appType: 'confidential' | 'public'): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${value} is not a valid URL`;
  }
  if (url.hash) return 'Redirect URIs cannot contain a #fragment';
  if (url.username || url.password) return 'Leave credentials out of redirect URIs';

  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ? null
      : 'Use https, except for localhost while developing';
  }
  if (['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(url.protocol)) {
    return `${url.protocol} URIs are not allowed`;
  }
  if (appType !== 'public') return 'Custom URI schemes are for public (native) apps only';
  /* Reverse-domain, so one app cannot claim another's generic scheme. */
  return url.protocol.slice(0, -1).includes('.')
    ? null
    : 'Custom schemes must be reverse-domain, like com.yourstudio.game:/callback';
}
