import crypto from 'node:crypto';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Bachs — Deck's payment provider.
 *
 * The same two rules the Paystack integration lived by, unchanged:
 *
 *  1. The secret key never leaves the server. The browser is only ever handed
 *     a hosted `checkout_url` to go to.
 *  2. Nothing is marked paid because the browser came back from checkout. The
 *     customer controls that redirect. Payment is confirmed by asking Bachs
 *     (`getCheckout`) or by a signature-verified webhook — and Bachs's own docs
 *     name the webhook as the source of truth for fulfilment.
 *
 * Every field name and value below is taken from docs.bachs.io, not inferred.
 * Where the docs are silent, the code says so and does not guess: notably the
 * full checkout-session `status` enum is undocumented, so a session counts as
 * paid only on the two values the `checkout.completed` event documents —
 * `status: "completed"` with `payment_status: "paid"`.
 *
 * Units are the one real difference from Paystack. Deck stores every amount as
 * integer minor units; Bachs speaks decimal strings in the major unit
 * ("20000.00"). Conversion happens at this boundary and nowhere else — see
 * `toDecimal` and `toMinor`.
 */

/* ----------------------------------------------------------------- money --- */

/**
 * Minor units to the decimal string Bachs expects. Integer arithmetic only:
 * `(250000 / 100).toFixed(2)` is fine here, but the habit of never routing
 * money through float division is worth keeping where it costs nothing.
 */
export function toDecimal(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new Error(`toDecimal expects a non-negative integer, got ${minor}`);
  }
  const whole = Math.floor(minor / 100);
  const fraction = String(minor % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * A Bachs decimal string back to integer minor units, parsed as text so
 * "75000.10" can never become 7500009.999. Anything that is not a plain
 * decimal is refused rather than coerced — this feeds a tamper check.
 */
export function toMinor(decimal: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(decimal.trim());
  if (!match) throw new Error(`Unrecognised amount from the payment provider: ${decimal}`);
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/* ---------------------------------------------------------------- client --- */

export const bachsConfigured = (): boolean => Boolean(env.bachs.secretKey);

/**
 * A failed call to Bachs, carrying what Bachs actually said.
 *
 * Surfaces to the browser as a 502 like any upstream failure, but keeps the
 * provider's status and code for the code that has to decide what to do next.
 * The transfer run is the reason: a 4xx from Bachs (`INSUFFICIENT_BALANCE`, an
 * inactive capability) will fail the same way on every retry and should be
 * marked failed, while a 5xx or a timeout should simply be tried again —
 * treating the two alike either retries forever or gives up on an outage.
 */
export class BachsError extends ApiError {
  constructor(
    message: string,
    /** Bachs's HTTP status, or 0 when Bachs could not be reached at all. */
    public readonly providerStatus: number,
    public readonly code?: string,
  ) {
    super(502, message);
  }

  /** True when retrying the identical request cannot succeed. */
  get permanent(): boolean {
    return this.providerStatus >= 400 && this.providerStatus < 500;
  }
}

/**
 * Sandbox keys go to the sandbox host and live keys to the live one, decided
 * by the key itself — the prefix rule Bachs documents. An explicit override
 * wins, which is what lets the integration be exercised against a local mock.
 */
function baseUrl(): string {
  if (env.bachs.apiUrl) return env.bachs.apiUrl.replace(/\/+$/, '');
  return env.bachs.secretKey.startsWith('sk_sandbox_')
    ? 'https://sandbox-api.bachs.io'
    : 'https://api.bachs.io';
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Sent as `Idempotency-Key`, so a retried call cannot act twice. */
  idempotencyKey?: string;
}

async function bachsRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!bachsConfigured()) {
    throw ApiError.badRequest('Payments are not configured on this server');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.bachs.secretKey}`,
    'Content-Type': 'application/json',
  };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      /* A hanging provider must not hold a checkout request open forever. */
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BachsError('We could not reach the payment provider. Please try again.', 0);
  }

  const payload = (await response.json().catch(() => null)) as
    (T & { message?: string; error?: { message?: string; code?: string } }) | null;

  if (!response.ok || !payload) {
    const message =
      payload?.error?.message ?? payload?.message ?? 'The payment provider rejected that request';
    /* Logged with the code, surfaced without it: the code is for us. */
    // eslint-disable-next-line no-console
    console.error('[bachs]', response.status, path, payload?.error?.code ?? '', message);
    throw new BachsError(message, response.status, payload?.error?.code);
  }

  return payload;
}

/* -------------------------------------------------------------- checkout --- */

/** How long a hosted checkout stays payable. */
export const CHECKOUT_LIFETIME_MINUTES = 60;

export interface CheckoutResult {
  checkoutId: string;
  /** The hosted page to send the customer to. */
  checkoutUrl: string;
}

/**
 * Starts a hosted checkout for a raw amount.
 *
 * `pricing` rather than `product_cart`: Deck's prices live in Deck's database,
 * and mirroring every merch variant, contribution and ad slot into Bachs's
 * product catalogue would create a second price list to keep in sync. The docs
 * allow exactly one pricing source, and a raw amount is one.
 *
 * `reference` is echoed back on both `checkout.completed` and
 * `collection.succeeded`, which is how a webhook finds its order.
 */
export async function createCheckout(options: {
  amountMinor: number;
  currency: string;
  email: string;
  name?: string;
  reference: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}): Promise<CheckoutResult> {
  const data = await bachsRequest<{ checkout_id: string; checkout_url: string }>(
    '/v1/checkout-sessions',
    {
      method: 'POST',
      body: {
        pricing: { currency: options.currency, amount: toDecimal(options.amountMinor) },
        customer: { email: options.email, ...(options.name ? { name: options.name } : {}) },
        success_url: options.successUrl,
        cancel_url: options.cancelUrl,
        reference: options.reference,
        metadata: options.metadata,
        /* Bachs's default, set explicitly: the expiry sweep waits a margin past
           this before it cancels anything, and it should not be resting on a
           default that might move. */
        expires_in_minutes: CHECKOUT_LIFETIME_MINUTES,
      },
    },
  );

  return { checkoutId: data.checkout_id, checkoutUrl: data.checkout_url };
}

/** What a payment provider confirmed, in Deck's own terms and units. */
export interface VerifiedPayment {
  status: 'success' | 'pending' | 'failed';
  amountMinor: number;
  currency: string;
  paidAt: string | null;
  chargeId: string | null;
  /**
   * True only when the checkout is past its own `expires_at` and did not
   * complete — so it can never be paid now. The expiry sweep cancels on this
   * and on nothing weaker. An unrecognised status alone is not enough: the
   * status enum is undocumented, and cancelling a paid order because Bachs used
   * a word this file did not know would be the worst failure available here.
   */
  expired?: boolean;
}

/**
 * Asks Bachs what happened to a checkout. Used when the customer comes back
 * from the hosted page, so the order can update before the webhook lands.
 *
 * Anything other than the documented completed-and-paid pair is reported as
 * pending, never as failed: an undocumented status is not evidence of failure,
 * and the webhook will settle it either way.
 */
export async function getCheckout(checkoutId: string): Promise<VerifiedPayment> {
  const data = await bachsRequest<{
    status?: string;
    payment_status?: string;
    amount?: string;
    currency?: string | null;
    completed_at?: string | null;
    expires_at?: string | null;
    charge?: { id?: string } | null;
  }>(`/v1/checkout-sessions/${encodeURIComponent(checkoutId)}`);

  const paid = data.status === 'completed' && data.payment_status === 'paid';
  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : NaN;
  return {
    status: paid ? 'success' : 'pending',
    amountMinor: data.amount ? toMinor(data.amount) : 0,
    currency: data.currency ?? '',
    paidAt: data.completed_at ?? null,
    chargeId: data.charge?.id ?? null,
    expired: data.status !== 'completed' && Number.isFinite(expiresAt) && expiresAt < Date.now(),
  };
}

/* -------------------------------------------------------------- webhooks --- */

export interface BachsEvent {
  id: string;
  type: string;
  created_at: string;
  /** Present only on Connect events that came from a connected account. */
  account?: string;
  data: Record<string, unknown>;
}

/** Five minutes either side, the tolerance Bachs's own examples use. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verifies a webhook and returns the event, or `null` if it is not genuine.
 *
 * Exactly as documented: HMAC-SHA256 over `"{timestamp}.{raw body}"`, keyed
 * with the endpoint's signing secret, lowercase hex. The V2 header is read
 * because it carries a `v1=` for every currently valid secret — so a secret
 * rotation, during which Bachs signs with both for 24 hours, does not start
 * rejecting deliveries the moment the new secret is configured here.
 *
 * The raw body matters: re-serialising parsed JSON changes the bytes, which is
 * why the route keeps the original buffer.
 */
export function verifyWebhook(
  rawBody: Buffer,
  header: (name: string) => string | undefined,
): BachsEvent | null {
  /*
   * One secret per Bachs endpoint. An endpoint listens to either the
   * platform's own events (payments) or connected accounts' events (sub-account
   * onboarding) — never both — so Deck registers two endpoints at the same URL,
   * each with its own signing secret, and BACHS_WEBHOOK_SECRET holds both,
   * separated by a comma. A delivery is genuine if any of them signed it.
   */
  const secrets = env.bachs.webhookSecret
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (secrets.length === 0) return null;

  const v2 = header('x-bachs-signature-v2');
  let timestamp: string | undefined;
  let signatures: string[] = [];

  if (v2) {
    for (const part of v2.split(',')) {
      const [key, value] = part.trim().split('=');
      if (key === 't') timestamp = value;
      if (key === 'v1' && value) signatures.push(value);
    }
  } else {
    timestamp = header('x-bachs-timestamp');
    const v1 = header('x-bachs-signature');
    if (v1) signatures = [v1];
  }

  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return null;

  /* Replay protection: a captured delivery is worthless five minutes later. */
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > WEBHOOK_TOLERANCE_SECONDS) return null;

  const genuine = secrets.some((secret) => {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    const want = Buffer.from(expected, 'utf8');
    return signatures.some((candidate) => {
      const given = Buffer.from(candidate, 'utf8');
      /* timingSafeEqual throws on a length mismatch, so check first. */
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    });
  });
  if (!genuine) return null;

  try {
    return JSON.parse(rawBody.toString('utf8')) as BachsEvent;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- connect --- */

export interface ConnectedAccount {
  id: string;
  /** Whether the `transfers` capability is active — the one that lets an
      account receive a share. */
  transfersActive: boolean;
  isActive: boolean;
}

function readAccount(data: {
  id: string;
  is_active?: boolean;
  capabilities?: Record<string, { status?: string }>;
}): ConnectedAccount {
  return {
    id: data.id,
    transfersActive: data.capabilities?.transfers?.status === 'active',
    isActive: Boolean(data.is_active),
  };
}

/**
 * Creates a recipient sub-account for a seller, maker or game developer.
 *
 * The `recipient` persona with `transfers` and `payouts` — Deck sends them
 * money and they withdraw it to their bank. They never take card payments
 * themselves; Deck collects everything. `contact_email` is the only required
 * field per the docs. In sandbox the capabilities activate immediately; live,
 * they start restricted until Bachs reviews the account.
 */
export async function createConnectedAccount(options: {
  email: string;
  name: string;
  country?: string;
  /** Deck's own user id, so a retry cannot create a second account. */
  idempotencyKey: string;
}): Promise<ConnectedAccount> {
  const data = await bachsRequest<{
    id: string;
    is_active?: boolean;
    capabilities?: Record<string, { status?: string }>;
  }>('/v1/accounts', {
    method: 'POST',
    idempotencyKey: options.idempotencyKey,
    body: {
      contact_email: options.email,
      display_name: options.name,
      ...(options.country ? { country: options.country } : {}),
      entity_type: 'individual',
      configuration: {
        recipient: {
          capabilities: {
            transfers: { requested: true },
            payouts: { requested: true },
          },
        },
      },
    },
  });

  return readAccount(data);
}

/** Re-reads an account — used to refresh status after onboarding. */
export async function getConnectedAccount(accountId: string): Promise<ConnectedAccount> {
  return readAccount(
    await bachsRequest<{
      id: string;
      is_active?: boolean;
      capabilities?: Record<string, { status?: string }>;
    }>(`/v1/accounts/${encodeURIComponent(accountId)}`),
  );
}

/**
 * A hosted onboarding link: Bachs collects the identity and bank details, so
 * none of it ever passes through Deck. Links expire in about an hour and a new
 * one supersedes the old, so this is called fresh every time rather than the
 * URL being stored.
 */
export async function createOnboardingLink(
  accountId: string,
  options: { refreshUrl: string; returnUrl: string; update?: boolean },
): Promise<{ url: string; expiresAt: string }> {
  const data = await bachsRequest<{ url: string; expires_at: string }>(
    `/v1/accounts/${encodeURIComponent(accountId)}/account-links`,
    {
      method: 'POST',
      body: {
        type: options.update ? 'update' : 'onboarding',
        refresh_url: options.refreshUrl,
        return_url: options.returnUrl,
      },
    },
  );
  return { url: data.url, expiresAt: data.expires_at };
}

/**
 * Sends money from Deck's available balance to a sub-account.
 *
 * A separate transfer, not a destination charge, because of the 14-day hold:
 * the money is collected into Deck's balance at sale time and only moved once
 * the refund window has passed. The idempotency key makes a retried run return
 * the transfer it already made instead of paying twice.
 */
export async function createTransfer(options: {
  destination: string;
  amountMinor: number;
  currency: string;
  transferGroup: string;
  description: string;
  idempotencyKey: string;
}): Promise<{ id: string; status: string }> {
  const data = await bachsRequest<{ id: string; status: string }>('/v1/transfers', {
    method: 'POST',
    idempotencyKey: options.idempotencyKey,
    body: {
      destination: options.destination,
      amount: toDecimal(options.amountMinor),
      currency: options.currency,
      transfer_group: options.transferGroup,
      description: options.description,
    },
  });
  return { id: data.id, status: data.status };
}

/* --------------------------------------------------------------- returns --- */

/**
 * Where the hosted checkout sends the customer back to.
 *
 * Both outcomes return to the same page with the reference attached — the
 * page asks the server what actually happened, so the URL only has to say
 * *which* payment, never *how it went*. A `cancelled` flag on the cancel leg
 * lets the page skip a pointless verify for someone who backed out.
 *
 * Bachs requires these to be public http/https addresses, so a `localhost`
 * return URL may be refused in local development; point PAYMENT_RETURN_URL at
 * the deployed site or a tunnel when testing checkout end to end.
 */
export function checkoutReturnUrls(reference: string): { successUrl: string; cancelUrl: string } {
  const base = env.paymentReturnUrl;
  const join = base.includes('?') ? '&' : '?';
  const withRef = `${base}${join}reference=${encodeURIComponent(reference)}`;
  return { successUrl: withRef, cancelUrl: `${withRef}&cancelled=1` };
}
