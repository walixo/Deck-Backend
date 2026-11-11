import crypto from 'node:crypto';
import { env } from '../config/env';
import type { SecretField } from '../models/GiftCard';
import type { VaultMode } from '../models/VaultPartner';

/**
 * Every secret Vault mints or has to keep: card codes, PINs, partner API keys
 * and webhook signing keys.
 *
 * Two different jobs live here and they use different tools on purpose.
 *
 * **Checked but never shown** — API keys, webhook signatures. A SHA-256 hash is
 * enough and is the right choice: these are 32 random bytes rather than
 * something a person chose, so there is nothing to brute-force, and a key is
 * verified on every call where bcrypt's deliberate slowness would be a tax on
 * each one. This is the same reasoning as `services/gameKeys.ts`.
 *
 * **Shown back to their owner** — card codes and PINs. A hash cannot do this,
 * so they are additionally encrypted with AES-256-GCM. See `models/GiftCard.ts`
 * for why a card code is not a password.
 */

const random = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');

export const hashSecret = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/* ------------------------------------------------------------- partner keys */

/**
 * `vlt_…` buys cards, `vli_…` redeems them.
 *
 * The two sides of Vault do opposite things to value, so their credentials are
 * told apart by prefix rather than by which collection happens to match. A key
 * that has to be looked for in two places is a key that can be accepted by the
 * wrong one.
 */
export type KeyAudience = 'partner' | 'issuer';

const PREFIX: Record<KeyAudience, string> = { partner: 'vlt', issuer: 'vli' };

export function mintApiKey(
  audience: KeyAudience,
  mode: VaultMode,
): { key: string; hash: string; hint: string } {
  const key = `${PREFIX[audience]}_${mode}_${random(32)}`;
  return { key, hash: hashSecret(key), hint: key.slice(-4) };
}

/** What a key claims to be, from its prefix — or null if it is not one of ours. */
export function readKey(key: string): { audience: KeyAudience; mode: VaultMode } | null {
  for (const audience of ['partner', 'issuer'] as const) {
    for (const mode of ['test', 'live'] as const) {
      if (key.startsWith(`${PREFIX[audience]}_${mode}_`)) return { audience, mode };
    }
  }
  return null;
}

/** Signing keys Vault keeps in the clear, because Vault needs to sign with them. */
export const mintWebhookSecret = (): string => `whsec_${random(32)}`;
export const mintFulfilSecret = (): string => `vfs_${random(32)}`;

/* ---------------------------------------------------------- card encryption */

const ALGORITHM = 'aes-256-gcm';

/**
 * The encryption key, derived once from `VAULT_SECRET`.
 *
 * scrypt rather than using the secret's bytes directly, so a short or
 * low-entropy secret in someone's `.env` still produces a full-strength key.
 * The salt is fixed and public: a random one would mean the same secret
 * derived a different key on every boot, and nothing already encrypted could
 * be read back. Key separation, not password storage, is the job here.
 */
let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!env.vault.secret) {
    throw new Error('VAULT_SECRET is not set — Vault cannot issue or read card codes');
  }
  cachedKey = crypto.scryptSync(env.vault.secret, 'deck-vault-cards-v1', 32);
  return cachedKey;
}

/**
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * Versioned so the format can change without guessing at what old rows are,
 * and authenticated so a tampered ciphertext fails loudly at `decrypt` rather
 * than returning plausible rubbish that gets printed on a card.
 */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptSecret(packed: string): string {
  const [version, iv, tag, body] = packed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) {
    throw new Error('That stored secret is not in a format this version can read');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/** Packs a plaintext secret into the three forms a card stores it in. */
export function sealSecret(plain: string): SecretField {
  return { hash: hashSecret(plain), cipher: encryptSecret(plain), last4: plain.slice(-4) };
}

/* -------------------------------------------------------------- card codes */

/*
 * No 0/O/1/I/L/U. The first four because they are the pairs people mistype
 * when reading a code off a screen or hearing it down a phone; U because it
 * is the one letter that turns otherwise innocent random strings into words
 * somebody has to apologise for.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomFrom(alphabet: string, length: number): string {
  /*
   * Rejection sampling, not `% alphabet.length`.
   *
   * 256 is not a multiple of 30, so the modulo of a uniform byte favours the
   * first 16 letters by a few percent. It would still look random in a
   * listing, and it would still quietly shrink the keyspace of a bearer
   * instrument. Drawing again on the ragged tail costs nothing and removes the
   * bias entirely.
   */
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * `VLT-XXXX-XXXX-XXXX` — 12 characters from a 30-letter alphabet, so roughly
 * 59 bits. Grouped in fours because that is how people read a code aloud and
 * type it into a form.
 */
export function mintCardCode(): string {
  const body = randomFrom(CODE_ALPHABET, 12);
  return `VLT-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** A four-digit PIN. Digits only: it gets typed on a card terminal. */
export const mintCardPin = (): string => randomFrom('0123456789', 4);

/**
 * Normalises what someone typed into what was issued.
 *
 * People paste codes with the dashes, without them, in lower case, and with a
 * space the mail client inserted. All of those are the same card, and failing
 * the lookup on any of them is a support ticket.
 */
export function normaliseCode(input: string): string {
  const bare = input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^VLT/, '');
  return `VLT-${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8, 12)}`;
}

/* -------------------------------------------------------------- references */

const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Same alphabet as Deck's order references, so they read as one family. */
function reference(prefix: string, length = 8): string {
  const bytes = crypto.randomBytes(length);
  return `${prefix}-${Array.from(bytes, (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join('')}`;
}

export const orderReference = (): string => reference('VLT');
export const redemptionReference = (): string => reference('VRD');
export const topupReference = (): string => reference('VTP');
