import { env } from '../config/env';

/**
 * Where Match calls find their way: the STUN and TURN servers each browser is
 * given before it calls.
 *
 * Calls connect browser to browser whenever the two networks allow it. Many
 * mobile networks don't — lots of phones share one address — so with
 * Cloudflare's TURN relay configured, those calls pass through Cloudflare
 * instead of failing. The audio stays encrypted end to end; the relay only
 * forwards it and never stores it.
 *
 * Credentials are short-lived and made per person by Cloudflare's API, so the
 * long-lived key never leaves the server. Each person's set is reused for a
 * while to keep calls to that API down.
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Direct-only: public STUN servers that tell each browser its address. */
const DIRECT_ONLY: IceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

/** How long Cloudflare's credentials last; well beyond the longest call. */
const TTL_SECONDS = 2 * 60 * 60;
/** Reused for half that, so a set handed out is always good for an hour. */
const REUSE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

const cache = new Map<string, { servers: IceServer[]; until: number }>();

export const relayConfigured = () =>
  Boolean(env.cloudflareTurn.keyId && env.cloudflareTurn.apiToken);

/* Browsers block port 53, so a TURN address on it only times out. */
const usable = (url: string) => !/:53(\?|$)/.test(url);

function tidy(servers: IceServer[]): IceServer[] {
  return servers
    .map((server) => ({
      ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(usable),
    }))
    .filter((server) => server.urls.length > 0);
}

/**
 * The servers one person's browser should use. Falls back to direct-only if
 * the relay isn't configured or Cloudflare doesn't answer in time, so a slow
 * API can never stop anyone joining the line.
 */
export async function iceServersFor(
  userId: string,
): Promise<{ iceServers: IceServer[]; relay: boolean }> {
  if (!relayConfigured()) return { iceServers: DIRECT_ONLY, relay: false };
  const now = Date.now();
  const kept = cache.get(userId);
  if (kept && kept.until > now) return { iceServers: kept.servers, relay: true };

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.cloudflareTurn.keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.cloudflareTurn.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`Cloudflare answered ${res.status}`);
    const body = (await res.json()) as { iceServers?: IceServer[] };
    const servers = tidy(body.iceServers ?? []);
    if (!servers.some((server) => server.username)) throw new Error('no TURN servers returned');
    if (cache.size > 5000) {
      for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
    }
    cache.set(userId, { servers, until: now + REUSE_MS });
    return { iceServers: servers, relay: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[match] TURN relay unavailable, calls are direct-only: ${(error as Error).message}`,
    );
    return { iceServers: DIRECT_ONLY, relay: false };
  }
}

/** For tests. */
export function resetRelayCache(): void {
  cache.clear();
}
