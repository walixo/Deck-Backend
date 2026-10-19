import crypto, { type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

/**
 * The key GameID signs ID tokens with, and the public half apps verify with.
 *
 * RS256, so apps verify with a public key from the JWKS endpoint and never
 * hold anything that could mint a token. The private key comes from
 * GAMEID_PRIVATE_KEY. Without it, development generates a throwaway key at
 * boot — fine for building against, but every restart invalidates tokens
 * signed before it — and production switches GameID off (its endpoints say
 * so) rather than take the whole API down with it.
 */

let cached: { privateKey: KeyObject; publicKey: KeyObject; kid: string } | null = null;

function load() {
  if (cached) return cached;

  let privateKey: KeyObject;
  if (env.gameId.privateKey) {
    privateKey = crypto.createPrivateKey(env.gameId.privateKey);
  } else {
    if (env.isProduction) {
      throw new Error('GAMEID_PRIVATE_KEY is not set — GameID cannot sign ID tokens');
    }
    // eslint-disable-next-line no-console
    console.warn('[gameid] no GAMEID_PRIVATE_KEY — using a throwaway key for this process');
    privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  }

  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  /* RFC 7638 thumbprint: stable for a key, different for the next one, so a
     rotation can publish both and apps pick by `kid`. */
  const thumbprint = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  const kid = crypto.createHash('sha256').update(thumbprint).digest('base64url').slice(0, 16);

  cached = { privateKey, publicKey, kid };
  return cached;
}

export function jwks() {
  const { publicKey, kid } = load();
  return { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] };
}

export function signIdToken(claims: Record<string, unknown>, expiresInSeconds: number): string {
  const { privateKey, kid } = load();
  return jwt.sign(claims, privateKey, { algorithm: 'RS256', keyid: kid, expiresIn: expiresInSeconds });
}

/** Whether GameID can sign tokens on this server. */
export function gameIdEnabled(): boolean {
  try {
    load();
    return true;
  } catch {
    return false;
  }
}

/**
 * Checked at boot, so a malformed key is reported in the deploy log rather
 * than at the first sign-in. A missing or broken key disables GameID only.
 */
export function assertSigningKey(): void {
  try {
    load();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[gameid] disabled: ${(error as Error).message}`);
  }
}
