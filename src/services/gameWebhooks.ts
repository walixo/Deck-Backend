import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../config/env';
import { Game } from '../models/Game';
import { GamePurchase, MAX_WEBHOOK_ATTEMPTS, type IGamePurchase } from '../models/GamePurchase';

/**
 * Events Deck sends to a developer's server.
 *
 * Signed the way Bachs signs the events it sends Deck — `X-Deck-Signature:
 * t={unix},v1={hex}` over `"{t}.{raw body}"` — partly because it is a sound
 * scheme and partly because a developer who has verified one will recognise
 * the other.
 *
 * Delivery is at-least-once. Every event carries a stable `id`; a developer
 * who has seen one should acknowledge it and do nothing. A non-2xx answer is
 * retried on a widening schedule, then given up on — and the purchase is
 * still readable through the server API, so a developer whose server was down
 * for a day can catch up by polling.
 */

const TIMEOUT_MS = 8_000;

/* After attempt n (1-based), wait this long before attempt n+1. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];

export function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/**
 * Whether an address is somewhere Deck's server must never be sent.
 *
 * The webhook URL is typed by a stranger and fetched by Deck's server, which
 * sits inside a hosting provider's network. Without this, `https://10.0.0.5/`
 * or a hostname that resolves to it would let anyone make Deck call internal
 * services on their behalf (SSRF). Every resolved address is checked, not just
 * the first, because a name can resolve to several.
 */
function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80')
  );
}

/** Throws with a reason a developer can act on if Deck will not call this URL. */
export async function assertDeliverable(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That is not a valid URL');
  }
  if (parsed.username || parsed.password) throw new Error('Leave credentials out of the URL');
  if (env.allowPrivateWebhooks && ['http:', 'https:'].includes(parsed.protocol)) return;
  if (parsed.protocol !== 'https:') throw new Error('Webhook URLs must use https');

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error(`${host} does not resolve`);
  if (addresses.some(isPrivateAddress)) {
    throw new Error('Webhook URLs must point at a public address');
  }
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string;
}

/** One POST. Never follows redirects — a redirect could lead anywhere. */
export async function post(
  url: string,
  secret: string,
  type: string,
  payload: object,
): Promise<DeliveryResult> {
  try {
    await assertDeliverable(url);
  } catch (error) {
    return { ok: false, status: null, error: (error as Error).message };
  }

  const body = JSON.stringify(payload);
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DeckGames-Webhooks/1',
        'X-Deck-Event': type,
        'X-Deck-Signature': sign(secret, body),
      },
      body,
    });
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, error: ok ? '' : `Answered ${response.status}` };
  } catch (error) {
    const message =
      (error as Error).name === 'TimeoutError'
        ? `No answer within ${TIMEOUT_MS / 1000}s`
        : (error as Error).message;
    return { ok: false, status: null, error: message };
  }
}

/** The body of `purchase.paid`. Minor units, like every amount Deck sends. */
export function purchasePayload(purchase: IGamePurchase, gameSlug: string) {
  return {
    id: `evt_${purchase.reference}_paid`,
    type: 'purchase.paid',
    created_at: new Date().toISOString(),
    mode: purchase.mode,
    game: gameSlug,
    data: {
      reference: purchase.reference,
      productId: purchase.productId,
      productName: purchase.productName,
      productType: purchase.productType,
      playerId: purchase.playerId,
      priceMinor: purchase.priceMinor,
      developerShareMinor: purchase.developerShareMinor,
      currency: purchase.currency,
      paidAt: purchase.paidAt,
    },
  };
}

/**
 * Attempts one delivery of a paid purchase and records the outcome on it.
 *
 * Safe to call more than once: each call is one attempt, and the developer
 * dedupes on the event id. A game with no webhook URL is marked `none` — the
 * developer has chosen to poll.
 */
export async function deliverPurchase(purchaseId: IGamePurchase['_id']): Promise<void> {
  const purchase = await GamePurchase.findById(purchaseId);
  if (!purchase || purchase.status !== 'paid') return;

  const game = await Game.findById(purchase.game).select('+webhookSecret slug webhookUrl');
  if (!game?.webhookUrl || !game.webhookSecret) {
    purchase.webhook.state = 'none';
    purchase.webhook.nextAttemptAt = null;
    await purchase.save();
    return;
  }

  const result = await post(
    game.webhookUrl,
    game.webhookSecret,
    'purchase.paid',
    purchasePayload(purchase, game.slug),
  );

  const attempts = purchase.webhook.attempts + 1;
  purchase.webhook.attempts = attempts;
  purchase.webhook.lastAttemptAt = new Date();
  purchase.webhook.lastStatus = result.status;
  purchase.webhook.lastError = result.error.slice(0, 300);

  if (result.ok) {
    purchase.webhook.state = 'delivered';
    purchase.webhook.nextAttemptAt = null;
  } else if (attempts >= MAX_WEBHOOK_ATTEMPTS) {
    purchase.webhook.state = 'failed';
    purchase.webhook.nextAttemptAt = null;
  } else {
    purchase.webhook.state = 'pending';
    purchase.webhook.nextAttemptAt = new Date(Date.now() + BACKOFF_MS[attempts - 1]);
  }
  await purchase.save();
}

/** The scheduler's job: every delivery that is due another try. */
export async function retryGameWebhooks(now = new Date()): Promise<{ attempted: number }> {
  const due = await GamePurchase.find({
    'webhook.state': 'pending',
    'webhook.nextAttemptAt': { $lte: now },
  })
    .select('_id')
    .limit(50);

  for (const purchase of due) await deliverPurchase(purchase._id);
  return { attempted: due.length };
}
