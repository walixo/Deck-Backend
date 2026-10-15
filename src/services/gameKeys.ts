import crypto from 'node:crypto';
import type { GameKeyMode } from '../models/Game';

/**
 * Secrets the games platform mints: developer API keys, webhook signing
 * secrets, and the short-lived session tokens handed to games in the browser.
 *
 * Every one is random from the OS, and every one Deck needs only to *check* is
 * stored as a SHA-256 hash. A plain hash rather than bcrypt is right here and
 * wrong for passwords: these are 32 random bytes, not something a person
 * chose, so there is nothing to brute-force — and a key is checked on every
 * server call, where bcrypt's deliberate slowness would be a tax on each one.
 */

const random = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');

export const hashSecret = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/** `dk_test_…` / `dk_live_…`. The prefix says which mode a key works in. */
export function mintApiKey(mode: GameKeyMode): { key: string; hash: string; hint: string } {
  const key = `dk_${mode}_${random(32)}`;
  return { key, hash: hashSecret(key), hint: key.slice(-4) };
}

/** Which mode a key claims to be, from its prefix — or null if it is not one. */
export function modeOfKey(key: string): GameKeyMode | null {
  if (key.startsWith('dk_test_')) return 'test';
  if (key.startsWith('dk_live_')) return 'live';
  return null;
}

/** The secret Deck signs webhooks with. Stored as-is: Deck needs it to sign. */
export const mintWebhookSecret = (): string => `whsec_${random(32)}`;

export const mintSessionToken = (): string => `gs_${random(32)}`;

/** `p_…` for live players, `t_…` for test. Random, never derived from a user. */
export const mintPlayerId = (mode: GameKeyMode): string =>
  `${mode === 'live' ? 'p' : 't'}_${crypto.randomBytes(10).toString('hex')}`;

/** Same alphabet as order references: no 0/O/1/I, safe to read aloud. */
export function purchaseReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(8);
  return `GP-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}
