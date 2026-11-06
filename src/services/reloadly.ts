import { env } from '../config/env';

/**
 * Reloadly's gift card API: the wholesaler that holds the deals with brands
 * like Chowdeck and Jumia, so Match can sell their cards.
 *
 * Everything that talks to Reloadly is here, so if an endpoint differs from
 * what is written below, it is fixed in one place. What is confirmed from
 * Reloadly's own pages: the token request, the sandbox host, listing a
 * country's products and placing an order, and that a Nigerian account pays in
 * NGN. The live host, the redeem-code and transaction paths and the Accept
 * header follow Reloadly's standard API shape — check them against the
 * sandbox before switching to live.
 *
 * Orders cost real wallet money and are not idempotent: an order whose
 * outcome is unknown must be looked up by its `customIdentifier` before it is
 * ever tried again.
 */

export interface ReloadlyProduct {
  productId: number;
  productName: string;
  global: boolean;
  senderFee: number;
  discountPercentage: number;
  denominationType: 'FIXED' | 'RANGE';
  recipientCurrencyCode: string;
  senderCurrencyCode: string;
  minRecipientDenomination: number | null;
  maxRecipientDenomination: number | null;
  minSenderDenomination: number | null;
  maxSenderDenomination: number | null;
  fixedRecipientDenominations: number[];
  fixedSenderDenominations: number[];
  fixedRecipientToSenderDenominationsMap: Record<string, number> | null;
  logoUrls: string[];
  brand: { brandId: number; brandName: string };
  country: { isoName: string; name: string; flagUrl?: string };
  redeemInstruction?: { concise?: string; verbose?: string };
}

export interface ReloadlyOrder {
  transactionId: number;
  amount: number;
  discount: number;
  currencyCode: string;
  fee: number;
  customIdentifier: string;
  status: string;
  transactionCreatedTime?: string;
}

export interface ReloadlyCard {
  cardNumber?: string | null;
  pinCode?: string | null;
  redemptionUrl?: string | null;
}

export class ReloadlyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** True when we can't tell whether the request took effect (timeouts, 5xx). */
    public readonly unknownOutcome = false,
  ) {
    super(message);
  }
}

export const reloadlyConfigured = () => Boolean(env.reloadly.clientId && env.reloadly.clientSecret);

const host = () =>
  env.reloadly.apiUrl ||
  (env.reloadly.environment === 'live'
    ? 'https://giftcards.reloadly.com'
    : 'https://giftcards-sandbox.reloadly.com');
/* The token's audience is the gift card host for that environment. */
const audience = () =>
  env.reloadly.environment === 'live'
    ? 'https://giftcards.reloadly.com'
    : 'https://giftcards-sandbox.reloadly.com';

let token: { value: string; until: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.until > Date.now()) return token.value;
  const res = await fetch(env.reloadly.authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.reloadly.clientId,
      client_secret: env.reloadly.clientSecret,
      grant_type: 'client_credentials',
      audience: audience(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ReloadlyError(`Reloadly sign-in failed (${res.status})`, res.status);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  /* Renewed an hour early; test tokens last a day, live ones sixty. */
  token = { value: body.access_token, until: Date.now() + (body.expires_in - 3600) * 1000 };
  return token.value;
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${host()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        Accept: 'application/com.reloadly.giftcards-v1+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new ReloadlyError(
      `Reloadly did not answer: ${(error as Error).message}`,
      0,
      method === 'POST',
    );
  }
  if (res.status === 401) token = null;
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { message?: string; errorCode?: string };
    throw new ReloadlyError(
      `Reloadly: ${detail.message ?? res.statusText} (${detail.errorCode ?? res.status})`,
      res.status,
      method === 'POST' && res.status >= 500,
    );
  }
  return (await res.json()) as T;
}

/** Every gift card product on sale in a country. */
export const listProducts = (countryCode: string) =>
  api<ReloadlyProduct[]>('GET', `/countries/${encodeURIComponent(countryCode)}/products`);

/**
 * Buys one card. `unitPrice` is in the product's recipient currency (the
 * denomination the buyer chose); Reloadly charges the wallet in its own.
 */
export const placeOrder = (input: {
  productId: number;
  countryCode: string;
  unitPrice: number;
  customIdentifier: string;
  senderName: string;
  recipientEmail?: string;
}) => api<ReloadlyOrder>('POST', '/orders', { ...input, quantity: 1 });

/** An order looked up by our own reference: how to settle an unknown outcome. */
export async function findOrder(customIdentifier: string): Promise<ReloadlyOrder | null> {
  const page = await api<{ content?: ReloadlyOrder[] }>(
    'GET',
    `/reports/transactions?customIdentifier=${encodeURIComponent(customIdentifier)}&size=1`,
  );
  return page.content?.find((order) => order.customIdentifier === customIdentifier) ?? null;
}

/** The card(s) a successful order issued: number, PIN and/or redemption link. */
export const redeemCodes = (transactionId: number) =>
  api<ReloadlyCard[]>('GET', `/orders/transactions/${transactionId}/cards`);

/** What is left in the Reloadly wallet. */
export const balance = () =>
  api<{ balance: number; currencyCode: string }>('GET', '/accounts/balance');

/** For tests. */
export function resetReloadlyToken(): void {
  token = null;
}
