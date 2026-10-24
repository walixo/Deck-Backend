import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../../../config/env';
import { CAPS, ChallengeError, type Call, type Runner } from './protocol';

/**
 * Hosted challenges: Deck calls the developer's HTTPS endpoint.
 *
 * Every request is a POST of `{ call, …input }`, signed the way Deck signs its
 * purchase webhooks — `X-Deck-Signature: t=…,v1=…`, an HMAC-SHA256 in hex of
 * `"{t}.{raw body}"` with the game's signing secret — so the developer can
 * refuse anything that did not come from Deck.
 *
 * Deck is the one making requests here, so it guards itself: https only,
 * public addresses only (no reaching into Deck's own network), no redirects,
 * a short timeout, and a cap on the reply.
 */

const TIMEOUT_MS: Record<Call, number> = {
  generate: 5000,
  solve: 8000,
  grade: 3000,
  step: 3000,
  observe: 3000,
};

function isPrivate(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivate(v6.slice(7));
  return (
    v6 === '::1' ||
    v6 === '::' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80')
  );
}

/**
 * Throws unless the URL is https and every address it resolves to is public.
 * Outside production, http://localhost is allowed so developers can test
 * against a server on their own machine.
 */
export async function assertCallable(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ChallengeError('The endpoint is not a valid URL');
  }
  const local = !env.isProduction && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (local) return url;
  if (url.protocol !== 'https:') throw new ChallengeError('The endpoint must use https');
  const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length) throw new ChallengeError(`${url.hostname} does not resolve`);
  if (addresses.some(({ address }) => isPrivate(address))) {
    throw new ChallengeError(`${url.hostname} resolves to a private address`);
  }
  return url;
}

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function hostedRunner(endpoint: string, secret: string, slug: string): Runner {
  return {
    async call(call, input) {
      const url = await assertCallable(endpoint);
      const body = JSON.stringify({ call, ...input });
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS[call]),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'DeckCircuit/1',
            'X-Deck-Call': call,
            'X-Deck-Challenge': slug,
            'X-Deck-Signature': sign(secret, body),
          },
          body,
        });
      } catch (error) {
        const timedOut = (error as Error).name === 'TimeoutError';
        throw new ChallengeError(
          timedOut
            ? `${call} took longer than ${TIMEOUT_MS[call] / 1000}s`
            : `${call} could not reach the endpoint`,
        );
      }
      if (!res.ok) throw new ChallengeError(`${call} answered HTTP ${res.status}`);
      const text = await res.text();
      if (Buffer.byteLength(text) > CAPS.reply)
        throw new ChallengeError(`${call} replied with over 512 KB`);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ChallengeError(`${call} did not reply with JSON`);
      }
    },
  };
}
