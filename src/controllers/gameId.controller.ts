import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { CODE_TTL_MS, OAuthCode } from '../models/OAuthCode';
import { OAuthApp, type IOAuthApp } from '../models/OAuthApp';
import { OAuthGrant } from '../models/OAuthGrant';
import { OAuthToken } from '../models/OAuthToken';
import { User } from '../models/User';
import { gameIdEnabled } from '../services/gameIdKeys';
import { hashSecret } from '../services/gameKeys';
import {
  GAMEID_SCOPES,
  HANDLE_COOLDOWN_MS,
  ensureGameId,
  handleProblem,
  issuer,
  parseScopes,
  redirectUriProblem,
  toGameIdResponse,
  type GameIdScope,
} from '../services/gameId';
import { ApiError } from '../utils/ApiError';
import type {
  AuthorizeDecision,
  AuthorizeQuery,
  CreateAppInput,
  UpdateAppInput,
  UpdateGameIdInput,
} from '../validators/gameId.validators';
import { revokeFamily } from './gameIdOAuth.controller';

/**
 * GameID's Deck-side endpoints: a player's own identity, the consent step of
 * the OAuth flow, the apps a player has connected, and the apps a developer
 * has registered. All of these run with the player's Deck session.
 */

/* ---------------------------------------------------------- identity --- */

export async function getMyGameId(req: Request, res: Response): Promise<void> {
  const user = await ensureGameId(req.user!);
  res.json({ success: true, data: toGameIdResponse(user) });
}

/**
 * Changes a handle — at most once every 30 days. Apps that keyed on the
 * permanent code are unaffected; apps that only show the handle pick up the
 * new one the next time the player signs in.
 */
export async function updateMyGameId(req: Request, res: Response): Promise<void> {
  const { handle } = req.body as UpdateGameIdInput;
  const user = await ensureGameId(req.user!);
  if (user.gameId!.handle === handle) {
    res.json({ success: true, data: toGameIdResponse(user) });
    return;
  }

  const problem = handleProblem(handle);
  if (problem) throw ApiError.badRequest(problem);

  const changed = user.gameId!.handleChangedAt;
  if (changed && Date.now() - changed.getTime() < HANDLE_COOLDOWN_MS) {
    const next = new Date(changed.getTime() + HANDLE_COOLDOWN_MS);
    throw ApiError.badRequest(
      `You can change your handle again on ${next.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`,
    );
  }

  try {
    const updated = await User.findByIdAndUpdate(
      user._id,
      { $set: { 'gameId.handle': handle, 'gameId.handleChangedAt': new Date() } },
      { new: true },
    );
    res.json({ success: true, data: toGameIdResponse(updated!) });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw ApiError.conflict('That handle is taken');
    throw error;
  }
}

/* ------------------------------------------------------ authorization --- */

interface AuthorizeProblem {
  error: string;
  description: string;
  /** Null when the client or redirect URI is untrusted: show it, never redirect. */
  redirectTo: string | null;
}

function withParams(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Checks an authorization request, in the order the spec requires: an unknown
 * client or an unregistered redirect URI is never redirected to (that would
 * make GameID an open redirector, and hand errors to a stranger); everything
 * after that is reported back to the app at its own registered address.
 */
async function checkRequest(
  query: AuthorizeQuery,
): Promise<{ app: IOAuthApp; scopes: GameIdScope[] } | AuthorizeProblem> {
  const app = query.client_id ? await OAuthApp.findOne({ clientId: query.client_id }) : null;
  if (!app || app.status !== 'active') {
    return { error: 'invalid_client', description: 'This app is not registered with GameID, or has been switched off.', redirectTo: null };
  }
  if (!app.redirectUris.includes(query.redirect_uri)) {
    return { error: 'invalid_redirect_uri', description: 'This app asked to send you somewhere it has not registered. Nothing was shared.', redirectTo: null };
  }

  const fail = (error: string, description: string): AuthorizeProblem => ({
    error,
    description,
    redirectTo: withParams(query.redirect_uri, { error, error_description: description, state: query.state, iss: issuer() }),
  });

  if (query.response_type !== 'code') {
    return fail('unsupported_response_type', 'GameID only supports response_type=code');
  }
  const scopes = parseScopes(query.scope);
  if (!scopes) {
    return fail('invalid_scope', `Scopes must include openid and may add: ${Object.keys(GAMEID_SCOPES).join(', ')}`);
  }
  if (query.code_challenge) {
    if (query.code_challenge_method !== 'S256') {
      return fail('invalid_request', 'Only code_challenge_method=S256 is supported');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)) {
      return fail('invalid_request', 'code_challenge must be a base64url SHA-256 digest');
    }
  } else if (app.type === 'public') {
    return fail('invalid_request', 'Public apps must use PKCE (code_challenge with S256)');
  }

  return { app, scopes };
}

function publicApp(app: IOAuthApp) {
  return {
    clientId: app.clientId,
    name: app.name,
    description: app.description,
    logoUrl: app.logoUrl,
    homepageUrl: app.homepageUrl,
    privacyUrl: app.privacyUrl,
    redirectHost: '',
  };
}

/**
 * What the consent page needs to draw itself: the app, what it is asking
 * for, and whether this player has already agreed to exactly that.
 */
export async function getAuthorizeInfo(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as AuthorizeQuery;
  const checked = await checkRequest(query);
  if ('error' in checked) {
    res.json({ success: true, data: { ok: false, ...checked } });
    return;
  }

  const { app, scopes } = checked;
  let granted = false;
  let gameId = null;
  if (req.user) {
    const user = await ensureGameId(req.user);
    gameId = toGameIdResponse(user);
    const grant = await OAuthGrant.findOne({ user: user._id, app: app._id });
    granted = Boolean(grant && scopes.every((scope) => grant.scopes.includes(scope)));
  }

  let redirectHost = '';
  try {
    redirectHost = new URL(query.redirect_uri).host || new URL(query.redirect_uri).protocol;
  } catch {
    /* Already validated above; unreachable in practice. */
  }

  res.json({
    success: true,
    data: {
      ok: true,
      app: { ...publicApp(app), redirectHost },
      scopes: scopes.map((scope) => ({ scope, description: GAMEID_SCOPES[scope] })),
      granted,
      gameId,
    },
  });
}

/**
 * The player's answer. Allowing records the grant and mints a one-time code
 * bound to everything that was asked; denying tells the app so. Either way
 * the browser is sent back to the app's registered address — and only there.
 */
export async function decideAuthorize(req: Request, res: Response): Promise<void> {
  if (!gameIdEnabled()) throw new ApiError(503, 'GameID sign-in is not available right now');
  const input = req.body as AuthorizeDecision;
  const checked = await checkRequest(input);
  if ('error' in checked) {
    if (!checked.redirectTo) throw ApiError.badRequest(checked.description);
    res.json({ success: true, data: { redirectTo: checked.redirectTo } });
    return;
  }

  const { app, scopes } = checked;
  if (input.decision === 'deny') {
    res.json({
      success: true,
      data: {
        redirectTo: withParams(input.redirect_uri, {
          error: 'access_denied',
          error_description: 'The player declined',
          state: input.state,
          iss: issuer(),
        }),
      },
    });
    return;
  }

  const user = await ensureGameId(req.user!);
  await OAuthGrant.updateOne(
    { user: user._id, app: app._id },
    { $addToSet: { scopes: { $each: scopes } }, $set: { lastUsedAt: new Date() } },
    { upsert: true },
  );

  const code = `gac_${crypto.randomBytes(32).toString('base64url')}`;
  await OAuthCode.create({
    codeHash: hashSecret(code),
    app: app._id,
    user: user._id,
    redirectUri: input.redirect_uri,
    scopes,
    codeChallenge: input.code_challenge ?? null,
    nonce: input.nonce ?? null,
    authTime: new Date(),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  res.json({
    success: true,
    data: { redirectTo: withParams(input.redirect_uri, { code, state: input.state, iss: issuer() }) },
  });
}

/* -------------------------------------------------------- connections --- */

/** Every app this player has signed in to with GameID. */
export async function listConnections(req: Request, res: Response): Promise<void> {
  const grants = await OAuthGrant.find({ user: req.user!._id }).sort({ lastUsedAt: -1 }).populate('app');
  res.json({
    success: true,
    data: grants
      .filter((grant) => grant.app)
      .map((grant) => {
        const app = grant.app as unknown as IOAuthApp;
        return {
          app: publicApp(app),
          scopes: grant.scopes,
          connectedAt: grant.createdAt,
          lastUsedAt: grant.lastUsedAt,
        };
      }),
  });
}

/** Disconnects an app: forgets the consent and signs it out everywhere. */
export async function revokeConnection(req: Request, res: Response): Promise<void> {
  const app = await OAuthApp.findOne({ clientId: req.params.clientId });
  if (!app) throw ApiError.notFound('We could not find that app');

  await OAuthGrant.deleteOne({ user: req.user!._id, app: app._id });
  const tokens = await OAuthToken.find({ user: req.user!._id, app: app._id, revokedAt: null }).select('family');
  await Promise.all([...new Set(tokens.map((t) => t.family))].map(revokeFamily));

  res.json({ success: true, data: { disconnected: true } });
}

/* --------------------------------------------------- developer apps --- */

function toAppResponse(app: IOAuthApp) {
  return {
    ...publicApp(app),
    type: app.type,
    redirectUris: app.redirectUris,
    status: app.status,
    secretHint: app.clientSecretHint,
    createdAt: app.createdAt,
  };
}

function checkRedirects(uris: string[], type: IOAuthApp['type']): void {
  for (const uri of uris) {
    const problem = redirectUriProblem(uri, type);
    if (problem) throw ApiError.badRequest(problem);
  }
}

const mintSecret = () => `gsk_${crypto.randomBytes(32).toString('base64url')}`;

async function findOwnApp(req: Request): Promise<IOAuthApp> {
  const app = await OAuthApp.findOne({ clientId: req.params.clientId });
  const user = req.user!;
  if (!app || (!app.owner.equals(user._id) && user.role !== 'admin')) {
    throw ApiError.notFound('We could not find that app');
  }
  return app;
}

export async function listMyApps(req: Request, res: Response): Promise<void> {
  const apps = await OAuthApp.find({ owner: req.user!._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: apps.map(toAppResponse) });
}

export async function getMyApp(req: Request, res: Response): Promise<void> {
  const app = await findOwnApp(req);
  const [players, activeTokens] = await Promise.all([
    OAuthGrant.countDocuments({ app: app._id }),
    OAuthToken.countDocuments({ app: app._id, revokedAt: null, refreshExpiresAt: { $gt: new Date() }, rotatedAt: null }),
  ]);
  res.json({ success: true, data: { ...toAppResponse(app), stats: { players, activeSessions: activeTokens } } });
}

/**
 * Registers an app. A confidential app's secret is returned in this response
 * and never again.
 */
export async function createApp(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateAppInput;
  checkRedirects(input.redirectUris, input.type);

  const secret = input.type === 'confidential' ? mintSecret() : null;
  const app = await OAuthApp.create({
    owner: req.user!._id,
    name: input.name,
    description: input.description ?? '',
    logoUrl: input.logoUrl ?? '',
    homepageUrl: input.homepageUrl ?? '',
    privacyUrl: input.privacyUrl ?? '',
    type: input.type,
    clientId: `gid_${crypto.randomBytes(12).toString('base64url')}`,
    clientSecretHash: secret ? hashSecret(secret) : null,
    clientSecretHint: secret ? secret.slice(-4) : null,
    redirectUris: [...new Set(input.redirectUris)],
  });

  res.status(201).json({ success: true, data: { ...toAppResponse(app), clientSecret: secret } });
}

export async function updateMyApp(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateAppInput;
  const app = await findOwnApp(req);

  if (input.redirectUris) {
    checkRedirects(input.redirectUris, app.type);
    app.redirectUris = [...new Set(input.redirectUris)];
  }
  if (input.name !== undefined) app.name = input.name;
  if (input.description !== undefined) app.description = input.description;
  if (input.logoUrl !== undefined) app.logoUrl = input.logoUrl;
  if (input.homepageUrl !== undefined) app.homepageUrl = input.homepageUrl;
  if (input.privacyUrl !== undefined) app.privacyUrl = input.privacyUrl;
  if (input.status !== undefined) app.status = input.status;
  await app.save();

  res.json({ success: true, data: toAppResponse(app) });
}

/** Replaces a confidential app's secret. The old one stops working at once. */
export async function rotateAppSecret(req: Request, res: Response): Promise<void> {
  const app = await findOwnApp(req);
  if (app.type !== 'confidential') throw ApiError.badRequest('Public apps have no secret');

  const secret = mintSecret();
  await OAuthApp.updateOne(
    { _id: app._id },
    { $set: { clientSecretHash: hashSecret(secret), clientSecretHint: secret.slice(-4) } },
  );
  res.status(201).json({ success: true, data: { clientSecret: secret, secretHint: secret.slice(-4) } });
}
