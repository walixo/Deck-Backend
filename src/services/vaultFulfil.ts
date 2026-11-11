import crypto from 'node:crypto';
import { env } from '../config/env';
import type { IVaultIssuer } from '../models/VaultIssuer';
import type { IVaultPartner, VaultMode } from '../models/VaultPartner';
import { ApiError } from '../utils/ApiError';

/**
 * Vault's outbound calls: asking a merchant to mint a card, and telling a
 * partner that their order is ready.
 *
 * Both are signed the same way, so anyone integrating either side learns one
 * verification routine. The signature covers a timestamp as well as the body,
 * because a signature over the body alone is replayable forever — an attacker
 * who captures one valid request can send it again tomorrow and it still
 * verifies.
 */

const SIGNATURE_VERSION = 'v1';

/**
 * `t=<unix seconds>,v1=<hex hmac>` over `<t>.<body>`.
 *
 * Deliberately Stripe's shape. It is the one most developers have already
 * written a verifier for, and a familiar format is a format people actually
 * check instead of skipping.
 */
export function signPayload(secret: string, body: string, at = new Date()): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},${SIGNATURE_VERSION}=${digest}`;
}

export interface MintRequest {
  orderReference: string;
  idempotencyKey: string;
  productSlug: string;
  amountMinor: number;
  currency: string;
  mode: VaultMode;
  expiresAt: Date | null;
}

export interface MintResponse {
  code: string;
  pin?: string | null;
  externalId?: string | null;
}

/**
 * Asks an issuer's own system to mint one card.
 *
 * This is the `merchant` fulfilment path: the merchant generates the code so
 * the card is native to their wallet or POS, and Vault only brokers the sale.
 *
 * There are no retries here, and that is deliberate. Minting is not safely
 * repeatable from Vault's side — a timeout may mean the merchant created a
 * card and the response was lost, so a blind retry risks issuing two cards and
 * charging for one. Vault sends an idempotency key and leaves the decision to
 * the merchant: if they honour it, a retry is free and they should return the
 * same card; if they do not, the order fails, the buyer is refunded, and
 * nobody has issued value twice. Failing closed is the only safe default when
 * the thing being created is money.
 */
export async function mintCardAtMerchant(
  issuer: IVaultIssuer,
  request: MintRequest,
): Promise<MintResponse> {
  if (!issuer.fulfilUrl) {
    throw ApiError.badRequest(`${issuer.name} has no fulfilment endpoint configured`);
  }
  if (!issuer.fulfilSecret) {
    throw ApiError.badRequest(
      `${issuer.name} has no fulfilment secret — regenerate it in the Vault dashboard`,
    );
  }

  const body = JSON.stringify({
    event: 'card.mint',
    orderReference: request.orderReference,
    product: request.productSlug,
    amountMinor: request.amountMinor,
    currency: request.currency,
    mode: request.mode,
    expiresAt: request.expiresAt?.toISOString() ?? null,
  });

  /* An abort rather than an open-ended wait: a merchant endpoint that hangs
     would otherwise hold the partner's HTTP request open with it. */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.vault.fulfilTimeoutMs);

  let response: Response;
  try {
    response = await fetch(issuer.fulfilUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-vault-signature': signPayload(issuer.fulfilSecret, body),
        'x-vault-idempotency-key': request.idempotencyKey,
        'user-agent': 'Deck-Vault/1.0',
      },
      body,
    });
  } catch (error) {
    const reason = (error as Error).name === 'AbortError' ? 'did not answer in time' : 'could not be reached';
    throw new ApiError(502, `${issuer.name}'s card service ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ApiError(502, `${issuer.name}'s card service answered ${response.status}`);
  }

  let payload: MintResponse;
  try {
    payload = (await response.json()) as MintResponse;
  } catch {
    throw new ApiError(502, `${issuer.name}'s card service did not return JSON`);
  }

  if (!payload?.code || typeof payload.code !== 'string') {
    throw new ApiError(502, `${issuer.name}'s card service did not return a code`);
  }

  return {
    code: payload.code.trim(),
    pin: typeof payload.pin === 'string' ? payload.pin.trim() : null,
    externalId: typeof payload.externalId === 'string' ? payload.externalId : null,
  };
}

/* --------------------------------------------------------------- webhooks */

/**
 * Tells a partner something happened, if they asked to be told.
 *
 * Fire-and-forget on purpose: a partner's webhook endpoint being slow or down
 * must never fail the API call that triggered it, because by that point the
 * cards exist and the money has moved. The order is already readable over the
 * API, so a missed webhook costs a poll rather than a sale.
 */
export async function notifyPartner(
  partner: IVaultPartner,
  mode: VaultMode,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!partner.webhookUrl || !partner.webhookSecret) return;

  const body = JSON.stringify({ event, mode, data, sentAt: new Date().toISOString() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.vault.fulfilTimeoutMs);

  try {
    await fetch(partner.webhookUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-vault-signature': signPayload(partner.webhookSecret, body),
        'user-agent': 'Deck-Vault/1.0',
      },
      body,
    });
  } catch {
    /* Swallowed by design — see above. */
  } finally {
    clearTimeout(timer);
  }
}
