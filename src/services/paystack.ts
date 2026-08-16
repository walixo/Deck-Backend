import crypto from 'node:crypto';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

const PAYSTACK_BASE = 'https://api.paystack.co';

/**
 * Paystack integration.
 *
 * Two rules govern everything here:
 *
 *  1. The secret key never leaves the server. The browser is only ever handed
 *     the `authorization_url` to redirect to.
 *  2. An order is never marked paid on the strength of the browser coming back
 *     from the checkout. The customer controls that redirect, so payment is
 *     only ever confirmed by asking Paystack directly (`verifyTransaction`) or
 *     by a signature-verified webhook.
 *
 * Every charge settles into Deck's own account. What Deck then owes a seller is
 * tracked in the ledger and paid out separately — see `payout.controller.ts`.
 *
 * Amounts are integer minor units — kobo for NGN, cents for USD — which is
 * exactly how prices are already stored, so nothing is converted or rounded.
 */

export const paystackConfigured = (): boolean => Boolean(env.paystackSecretKey);

interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

async function paystackRequest<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  if (!env.paystackSecretKey) {
    throw ApiError.badRequest('Card payments are not configured on this server');
  }

  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${env.paystackSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      // Do not let a hanging provider hold a checkout request open forever.
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(502, 'We could not reach the payment provider. Please try again.');
  }

  const payload = (await response.json().catch(() => null)) as PaystackEnvelope<T> | null;

  if (!response.ok || !payload?.status) {
    // Paystack's message is safe to surface — it is written for end users.
    throw new ApiError(502, payload?.message ?? 'The payment provider rejected that request');
  }

  return payload.data;
}

/** Starts a transaction and returns the URL to send the customer to. */
export async function initializeTransaction(options: {
  email: string;
  amountMinor: number;
  reference: string;
  currency: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}): Promise<InitializeResult> {
  const data = await paystackRequest<{
    authorization_url: string;
    access_code: string;
    reference: string;
  }>('/transaction/initialize', {
    method: 'POST',
    body: {
      email: options.email,
      amount: options.amountMinor,
      reference: options.reference,
      currency: options.currency,
      callback_url: options.callbackUrl,
      metadata: options.metadata,
    },
  });

  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference,
  };
}

export interface VerifiedTransaction {
  status: string;
  amountMinor: number;
  currency: string;
  paidAt: string | null;
  channel: string | null;
}

/** Asks Paystack what actually happened. This is the only source of truth. */
export async function verifyTransaction(reference: string): Promise<VerifiedTransaction> {
  const data = await paystackRequest<{
    status: string;
    amount: number;
    currency: string;
    paid_at: string | null;
    channel: string | null;
  }>(`/transaction/verify/${encodeURIComponent(reference)}`);

  return {
    status: data.status,
    amountMinor: data.amount,
    currency: data.currency,
    paidAt: data.paid_at,
    channel: data.channel,
  };
}

/**
 * Validates a webhook came from Paystack: HMAC SHA-512 of the *raw* body keyed
 * with the secret. Re-serialising the parsed JSON would change the bytes and
 * break the comparison, which is why the webhook route keeps the raw buffer.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !env.paystackSecretKey) return false;

  const expected = crypto.createHmac('sha512', env.paystackSecretKey).update(rawBody).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws on length mismatch, so guard before comparing.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
