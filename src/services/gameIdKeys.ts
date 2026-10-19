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

/**
 * Turns whatever was pasted into GAMEID_PRIVATE_KEY back into a clean PEM.
 *
 * A key survives a trip through a dashboard textarea in many shapes: newlines
 * escaped as `\n`, newlines flattened into spaces, Windows line endings,
 * wrapping quotes — or npm's own `> package@1.0.0 script` banner lines, if the
 * generator was run without `-s` and piped to the clipboard. OpenSSL rejects
 * all of those with an opaque DECODER error. So rather than parse what was
 * given, find the BEGIN/END block, take only the base64 between them, and
 * rebuild the PEM the way OpenSSL expects: 64-character lines.
 */
export function normalisePem(raw: string): string {
  const text = raw.replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\r/g, '');
  const match = text.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  /* The base64 alone, its BEGIN/END lines lost in the copy: a PKCS#8 key is
     the only thing our generator makes, so read it as one. */
  const bare = text.replace(/[\s"']/g, '');
  if (!match && /^[A-Za-z0-9+/]{600,}={0,2}$/.test(bare)) {
    return `-----BEGIN PRIVATE KEY-----\n${(bare.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
  }
  if (!match) {
    throw new Error(
      'GAMEID_PRIVATE_KEY has no "-----BEGIN … PRIVATE KEY-----" block. Regenerate it with `node scripts/gameid-key.mjs | pbcopy` and paste again',
    );
  }
  const [, label, body] = match;
  const base64 = body.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!base64) throw new Error('GAMEID_PRIVATE_KEY has an empty key block');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function load() {
  if (cached) return cached;

  let privateKey: KeyObject;
  if (env.gameId.privateKey) {
    try {
      privateKey = crypto.createPrivateKey(normalisePem(env.gameId.privateKey));
    } catch (error) {
      /* Never echo the value — only what is wrong with it. */
      const reason = (error as Error).message.startsWith('GAMEID_PRIVATE_KEY')
        ? (error as Error).message
        : `GAMEID_PRIVATE_KEY is not a readable RSA private key (${(error as { code?: string }).code ?? 'unreadable'}). Regenerate it with \`node scripts/gameid-key.mjs | pbcopy\` and paste again`;
      /* OpenSSL's own error carries a code, never the key material. */
      throw new Error(reason, { cause: error });
    }
    if (privateKey.asymmetricKeyType !== 'rsa') {
      throw new Error('GAMEID_PRIVATE_KEY must be an RSA key — ID tokens are signed RS256');
    }
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
