import type { Request, Response } from 'express';
import { env } from '../config/env';
import { OAUTH_PROVIDERS, type OAuthProvider } from '../constants';
import {
  authorizeUrl,
  configuredProviders,
  fetchProfile,
  issueState,
  providerConfigured,
  resolveAccount,
  stateIsValid,
} from '../services/oauth';
import { ApiError } from '../utils/ApiError';
import { signToken } from '../utils/jwt';

/** Ten minutes: long enough to read a consent screen, short enough to matter. */
const STATE_COOKIE = 'deck_oauth_state';
const STATE_COOKIE_MAX_AGE = 10 * 60 * 1000;

function parseProvider(value: string): OAuthProvider {
  const provider = OAUTH_PROVIDERS.find((known) => known === value);
  if (!provider || !providerConfigured(provider)) {
    throw ApiError.notFound('That sign-in method is not available');
  }
  return provider;
}

/*
 * One cookie read, rather than a dependency.
 *
 * `cookie-parser` exists to do this for a whole app; this app sets exactly one
 * cookie, in one flow, and reads it in one place. A package in package.json is
 * a thing to audit and update forever.
 */
function readCookie(req: Request, name: string): string | undefined {
  return (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Where the browser is sent when the flow ends, well or badly. */
function clientOrigin(): string {
  return env.clientOrigins[0] ?? 'http://localhost:5173';
}

/**
 * Which social buttons the sign-in page should offer.
 *
 * Driven by what is actually configured, so a provider whose keys are missing
 * is simply absent rather than being a button that leads to an error page.
 */
export function listAuthProviders(_req: Request, res: Response): void {
  res.json({ success: true, data: { providers: configuredProviders() } });
}

/**
 * Step one: send the browser to the provider.
 *
 * The `state` goes two places — into the URL and into an httpOnly cookie on
 * this origin — and the callback requires them to match. Signing the state
 * proves Deck issued it; the cookie proves it was issued to *this* browser,
 * which is what stops an attacker from completing a flow with their own
 * account in somebody else's session.
 */
export function startOAuth(req: Request, res: Response): void {
  const provider = parseProvider(req.params.provider);
  const state = issueState();

  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.isProduction,
    /* Lax, not Strict: the callback is a top-level navigation arriving from
       github.com or accounts.google.com, and Strict would withhold the cookie
       on exactly that request — the one it exists for. */
    sameSite: 'lax',
    maxAge: STATE_COOKIE_MAX_AGE,
    path: '/api/auth/oauth',
  });

  res.redirect(authorizeUrl(req, provider, state));
}

/**
 * Step two: the provider sends the browser back with a code.
 *
 * Everything here ends in a redirect rather than a JSON body — the client is a
 * browser mid-navigation, not fetch(), so an error object would be rendered as
 * raw text in the address bar. Failures land on the sign-in page with
 * something a person can read.
 *
 * The token goes back in the URL *fragment*. A query string would be sent to
 * the server, written into its access log, and handed to whatever the page
 * links to next as a Referer; a fragment never leaves the browser.
 */
export async function oauthCallback(req: Request, res: Response): Promise<void> {
  const origin = clientOrigin();
  const fail = (message: string): void => {
    res.redirect(`${origin}/login?error=${encodeURIComponent(message)}`);
  };

  res.clearCookie(STATE_COOKIE, { path: '/api/auth/oauth' });

  let provider: OAuthProvider;
  try {
    provider = parseProvider(req.params.provider);
  } catch {
    fail('That sign-in method is not available');
    return;
  }

  /* The user pressed cancel on the consent screen. Not an error worth a
     message — put them back where they were. */
  if (typeof req.query.error === 'string') {
    res.redirect(`${origin}/login`);
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;

  if (!code || !stateIsValid(state) || state !== readCookie(req, STATE_COOKIE)) {
    fail('That sign-in link had expired. Please try again.');
    return;
  }

  try {
    const profile = await fetchProfile(req, provider, code);
    const user = await resolveAccount(provider, profile);
    const token = signToken({ sub: user._id.toString(), username: user.username });

    res.redirect(`${origin}/auth/callback#token=${encodeURIComponent(token)}`);
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : 'We could not complete that sign-in';
    console.error('[oauth] callback failed', error);
    fail(message);
  }
}
