import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../config/env';
import type { OAuthProvider } from '../constants';
import { User, type IUser } from '../models/User';
import { ApiError } from '../utils/ApiError';

/** What every provider is boiled down to before Deck looks at it. */
export interface ProviderProfile {
  /** The provider's immutable id. Not the email, and not the handle. */
  providerId: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  /** A suggested username. Sanitised and made unique before use. */
  handle: string;
  avatarUrl?: string;
}

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** Extra parameters this provider wants on the authorize URL. */
  authorizeExtras?: Record<string, string>;
  profile(accessToken: string): Promise<ProviderProfile>;
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      /* GitHub rejects requests with no user agent outright. */
      'User-Agent': 'Deck',
    },
  });

  if (!response.ok) {
    throw ApiError.badRequest(`The provider refused to describe the account (${response.status})`);
  }

  return (await response.json()) as T;
}

const PROVIDERS: Record<OAuthProvider, ProviderSpec> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    /* `user:email` is needed on top of `read:user` because GitHub does not put
       a private email on the profile — and most developers keep theirs private,
       so without it almost every sign-in would arrive with no address at all. */
    scope: 'read:user user:email',
    async profile(accessToken) {
      const account = await getJson<{
        id: number;
        login: string;
        name: string | null;
        avatar_url?: string;
      }>('https://api.github.com/user', accessToken);

      /*
       * The address comes from /user/emails, not from the profile.
       *
       * The profile's `email` field is whatever the user set as public, which
       * is frequently null and is never marked as verified. This endpoint
       * returns every address with its verification state, and the primary
       * verified one is the only thing worth binding an account to.
       */
      const emails = await getJson<{ email: string; primary: boolean; verified: boolean }[]>(
        'https://api.github.com/user/emails',
        accessToken,
      );
      const best =
        emails.find((row) => row.primary && row.verified) ?? emails.find((row) => row.verified);

      return {
        providerId: String(account.id),
        email: best?.email.toLowerCase() ?? null,
        emailVerified: Boolean(best),
        name: account.name?.trim() || account.login,
        handle: account.login,
        avatarUrl: account.avatar_url,
      };
    },
  },

  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    /* Without these two, a signed-in Google user is bounced straight back
       through the flow with no chance to pick which account they want. */
    authorizeExtras: { response_type: 'code', prompt: 'select_account' },
    async profile(accessToken) {
      const account = await getJson<{
        sub: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      }>('https://openidconnect.googleapis.com/v1/userinfo', accessToken);

      return {
        providerId: account.sub,
        email: account.email?.toLowerCase() ?? null,
        emailVerified: Boolean(account.email_verified),
        name: account.name?.trim() || account.email?.split('@')[0] || 'Maker',
        handle: account.email?.split('@')[0] ?? `user${account.sub.slice(-6)}`,
        avatarUrl: account.picture,
      };
    },
  },
};

export function providerConfigured(provider: OAuthProvider): boolean {
  return env.oauth[provider] !== null;
}

export function configuredProviders(): OAuthProvider[] {
  return (Object.keys(PROVIDERS) as OAuthProvider[]).filter(providerConfigured);
}

/**
 * This server's own address, as the provider will see it.
 *
 * Has to match what is registered with GitHub and Google exactly, so it comes
 * from configuration rather than from the request: behind a proxy the Host
 * header is whatever the proxy chose to send, and guessing wrong produces a
 * `redirect_uri_mismatch` that says nothing about which value was wrong.
 */
function apiOrigin(req: Request): string {
  if (env.publicApiUrl) return env.publicApiUrl;
  if (env.isProduction) {
    throw ApiError.badRequest('Sign-in is misconfigured: PUBLIC_API_URL is not set');
  }
  return `${req.protocol}://${req.get('host')}`;
}

export function redirectUri(req: Request, provider: OAuthProvider): string {
  return `${apiOrigin(req)}/api/auth/oauth/${provider}/callback`;
}

/* ----------------------------------------------------------------- state --- */

/**
 * The `state` parameter, signed so the callback can tell its own from a forgery.
 *
 * Signing alone does not stop login CSRF — an attacker can start a real flow
 * and get a real state — so the controller also plants the same value in a
 * short-lived cookie and requires the two to agree. Signing is what makes the
 * cookie check cheap: no store, nothing to expire server-side.
 */
export function issueState(): string {
  const nonce = randomBytes(16).toString('base64url');
  const issued = Date.now().toString(36);
  const payload = `${nonce}.${issued}`;
  return `${payload}.${createHmac('sha256', env.jwtSecret).update(payload).digest('base64url')}`;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export function stateIsValid(state: string | undefined): boolean {
  if (!state) return false;

  const parts = state.split('.');
  if (parts.length !== 3) return false;

  const [nonce, issued, signature] = parts;
  const expected = createHmac('sha256', env.jwtSecret)
    .update(`${nonce}.${issued}`)
    .digest('base64url');

  /* Constant time, so the comparison cannot be used to guess a signature one
     character at a time. Lengths must match first — timingSafeEqual throws. */
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false;

  const age = Date.now() - parseInt(issued, 36);
  return age >= 0 && age < STATE_TTL_MS;
}

/* ------------------------------------------------------------- the flow --- */

export function authorizeUrl(req: Request, provider: OAuthProvider, state: string): string {
  const config = env.oauth[provider];
  if (!config) throw ApiError.notFound('That sign-in method is not available');

  const spec = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(req, provider),
    scope: spec.scope,
    state,
    ...spec.authorizeExtras,
  });

  return `${spec.authorizeUrl}?${params.toString()}`;
}

/** Trades the one-time code for an access token. */
async function exchangeCode(req: Request, provider: OAuthProvider, code: string): Promise<string> {
  const config = env.oauth[provider];
  if (!config) throw ApiError.notFound('That sign-in method is not available');

  const response = await fetch(PROVIDERS[provider].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri(req, provider),
      grant_type: 'authorization_code',
    }).toString(),
  });

  const body = (await response.json()) as { access_token?: string; error_description?: string };

  /* GitHub answers 200 with an `error` body when the code is stale, so the
     status is not enough to go on — the presence of a token is. */
  if (!response.ok || !body.access_token) {
    throw ApiError.badRequest(
      body.error_description ?? 'That sign-in attempt could not be completed',
    );
  }

  return body.access_token;
}

export async function fetchProfile(
  req: Request,
  provider: OAuthProvider,
  code: string,
): Promise<ProviderProfile> {
  return PROVIDERS[provider].profile(await exchangeCode(req, provider, code));
}

/* ----------------------------------------------------------- the account --- */

/** Turns a provider handle into something the username rules will accept. */
async function availableUsername(suggested: string): Promise<string> {
  const base = suggested
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24)
    .padEnd(3, '0');

  /* Suffixes rather than random strings, so the second "ada" becomes "ada2"
     and not "ada_f3c1" — a handle somebody has to live with and type. */
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}${suffix + 1}`;
    if (!(await User.exists({ username: candidate }))) return candidate;
  }

  return `${base}${randomBytes(3).toString('hex')}`;
}

/**
 * Finds, links, or creates the account behind a provider profile.
 *
 * Three paths, in this order:
 *
 *  1. The provider id is already linked — sign that account in. This is every
 *     returning user, and it works even if they changed their email at the
 *     provider afterwards, which is the reason the id is what gets stored.
 *  2. A Deck account already has this *verified* email — link the provider to
 *     it. Someone who signed up with a password and later clicks "Continue
 *     with GitHub" expects to land in their own account, not a duplicate.
 *  3. Nobody has it — create an account.
 *
 * Every path insists on a verified email. An unverified one is a claim, not a
 * fact, and treating it as a fact is how account takeover works: register a
 * provider account with somebody else's address, sign in, inherit their
 * launches. Refusing is a worse sign-up experience for a handful of people and
 * the only safe answer.
 */
export async function resolveAccount(
  provider: OAuthProvider,
  profile: ProviderProfile,
): Promise<IUser> {
  const linked = await User.findOne({
    identities: { $elemMatch: { provider, providerId: profile.providerId } },
  });
  if (linked) return linked;

  if (!profile.email || !profile.emailVerified) {
    throw ApiError.badRequest(
      `Your ${provider} account has no verified email address. Verify one there, then try again.`,
    );
  }

  const existing = await User.findOne({ email: profile.email });
  if (existing) {
    existing.identities.push({
      provider,
      providerId: profile.providerId,
      linkedAt: new Date(),
    });
    await existing.save();
    return existing;
  }

  return User.create({
    name: profile.name.slice(0, 60),
    username: await availableUsername(profile.handle),
    email: profile.email,
    /* No password. The account can add one later through the normal reset
       path; until then `comparePassword` refuses every attempt. */
    avatarUrl: profile.avatarUrl,
    identities: [{ provider, providerId: profile.providerId, linkedAt: new Date() }],
  });
}
