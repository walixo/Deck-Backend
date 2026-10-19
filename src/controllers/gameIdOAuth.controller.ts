import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { OAuthApp, type IOAuthApp } from '../models/OAuthApp';
import { OAuthCode } from '../models/OAuthCode';
import { OAuthGrant } from '../models/OAuthGrant';
import { ACCESS_TTL_MS, OAuthToken, REFRESH_TTL_MS, type IOAuthToken } from '../models/OAuthToken';
import { User } from '../models/User';
import { hashSecret } from '../services/gameKeys';
import { GAMEID_SCOPES, claimsFor, issuer } from '../services/gameId';
import { gameIdEnabled, jwks, signIdToken } from '../services/gameIdKeys';

/**
 * GameID's public OAuth 2.0 / OpenID Connect endpoints.
 *
 * Called by other developers' servers and apps, from any origin, with no Deck
 * cookie — so they are mounted with an open CORS policy of their own, and they
 * answer in OAuth's own error shape (`{ error, error_description }`, RFC 6749
 * section 5.2) rather than Deck's, because every OAuth library expects it.
 */

const API_BASE = '/api/gameid/oauth';

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });
}

/* ------------------------------------------------------------ discovery --- */

export function discovery(_req: Request, res: Response): void {
  const iss = issuer();
  res.set('Cache-Control', 'public, max-age=3600').json({
    issuer: iss,
    authorization_endpoint: `${iss}/gameid/authorize`,
    token_endpoint: `${iss}${API_BASE}/token`,
    userinfo_endpoint: `${iss}${API_BASE}/userinfo`,
    revocation_endpoint: `${iss}${API_BASE}/revoke`,
    jwks_uri: `${iss}${API_BASE}/jwks.json`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: Object.keys(GAMEID_SCOPES),
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'gameid', 'preferred_username', 'name', 'picture'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    authorization_response_iss_parameter_supported: true,
  });
}

export function publicKeys(_req: Request, res: Response): void {
  if (!gameIdEnabled()) {
    oauthError(res, 503, 'temporarily_unavailable', 'GameID is not configured on this server');
    return;
  }
  res.set('Cache-Control', 'public, max-age=3600').json(jwks());
}

/* ------------------------------------------------------- client auth --- */

/**
 * Identifies the calling app: HTTP Basic (`client_secret_basic`), the body
 * (`client_secret_post`), or a bare `client_id` for public apps (`none`).
 * Secrets are compared as hashes in constant time.
 */
async function authenticateClient(req: Request): Promise<IOAuthApp | null> {
  let clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
  let secret = typeof req.body?.client_secret === 'string' ? req.body.client_secret : '';

  const header = req.header('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    if (split > 0) {
      clientId = decodeURIComponent(decoded.slice(0, split));
      secret = decodeURIComponent(decoded.slice(split + 1));
    }
  }
  if (!clientId) return null;

  const app = await OAuthApp.findOne({ clientId, status: 'active' }).select('+clientSecretHash');
  if (!app) return null;

  if (app.type === 'confidential') {
    if (!secret || !app.clientSecretHash) return null;
    const given = Buffer.from(hashSecret(secret));
    const stored = Buffer.from(app.clientSecretHash);
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return null;
  } else if (secret) {
    /* A public app has no secret; sending one means something is misconfigured. */
    return null;
  }
  return app;
}

/* ----------------------------------------------------------- issuing --- */

const random = () => crypto.randomBytes(32).toString('base64url');

async function issueTokens(
  app: IOAuthApp,
  userId: IOAuthToken['user'],
  scopes: string[],
  family: string,
  codeId: IOAuthToken['code'],
  extra: { nonce?: string | null; authTime?: Date },
) {
  const user = await User.findById(userId);
  if (!user) return null;

  const accessToken = `gat_${random()}`;
  const refreshToken = `grt_${random()}`;
  const now = Date.now();

  await OAuthToken.create({
    accessHash: hashSecret(accessToken),
    refreshHash: hashSecret(refreshToken),
    app: app._id,
    user: user._id,
    scopes,
    family,
    code: codeId,
    accessExpiresAt: new Date(now + ACCESS_TTL_MS),
    refreshExpiresAt: new Date(now + REFRESH_TTL_MS),
  });

  const idToken = signIdToken(
    {
      iss: issuer(),
      aud: app.clientId,
      ...claimsFor(user, app.clientId, scopes),
      ...(extra.authTime ? { auth_time: Math.floor(extra.authTime.getTime() / 1000) } : {}),
      ...(extra.nonce ? { nonce: extra.nonce } : {}),
    },
    ACCESS_TTL_MS / 1000,
  );

  await OAuthGrant.updateOne({ user: user._id, app: app._id }, { $set: { lastUsedAt: new Date() } });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refreshToken,
    id_token: idToken,
    scope: scopes.join(' '),
  };
}

/** Ends a whole refresh chain — on replay, or when a player disconnects. */
export async function revokeFamily(family: string): Promise<void> {
  await OAuthToken.updateMany({ family, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/* ------------------------------------------------------------- token --- */

export async function token(req: Request, res: Response): Promise<void> {
  if (!gameIdEnabled()) {
    oauthError(res, 503, 'temporarily_unavailable', 'GameID is not configured on this server');
    return;
  }
  const grantType = req.body?.grant_type;
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
    return;
  }

  const app = await authenticateClient(req);
  if (!app) {
    res.set('WWW-Authenticate', 'Basic realm="GameID"');
    oauthError(res, 401, 'invalid_client', 'Unknown client, or wrong or missing credentials');
    return;
  }

  if (grantType === 'authorization_code') {
    await exchangeCode(req, res, app);
  } else {
    await refresh(req, res, app);
  }
}

async function exchangeCode(req: Request, res: Response, app: IOAuthApp): Promise<void> {
  const code = typeof req.body.code === 'string' ? req.body.code : '';
  const redirectUri = typeof req.body.redirect_uri === 'string' ? req.body.redirect_uri : '';
  const verifier = typeof req.body.code_verifier === 'string' ? req.body.code_verifier : '';

  const record = code ? await OAuthCode.findOne({ codeHash: hashSecret(code) }) : null;
  if (!record || !record.app.equals(app._id)) {
    oauthError(res, 400, 'invalid_grant', 'That code is not valid for this app');
    return;
  }

  /* A second use means a copy of the code escaped. Undo the first. */
  if (record.usedAt) {
    const issued = await OAuthToken.find({ code: record._id }).select('family');
    await Promise.all([...new Set(issued.map((t) => t.family))].map(revokeFamily));
    oauthError(res, 400, 'invalid_grant', 'That code has already been used');
    return;
  }
  if (record.expiresAt.getTime() < Date.now()) {
    oauthError(res, 400, 'invalid_grant', 'That code has expired');
    return;
  }
  if (record.redirectUri !== redirectUri) {
    oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the one used to get the code');
    return;
  }
  if (record.codeChallenge) {
    if (!verifier || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
      oauthError(res, 400, 'invalid_grant', 'code_verifier is missing or malformed');
      return;
    }
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== record.codeChallenge) {
      oauthError(res, 400, 'invalid_grant', 'code_verifier does not match the code challenge');
      return;
    }
  }

  /* Claim the code atomically: of two racing exchanges, exactly one wins. */
  const claimed = await OAuthCode.findOneAndUpdate(
    { _id: record._id, usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  if (!claimed) {
    oauthError(res, 400, 'invalid_grant', 'That code has already been used');
    return;
  }

  const tokens = await issueTokens(app, record.user, record.scopes, crypto.randomUUID(), record._id, {
    nonce: record.nonce,
    authTime: record.authTime,
  });
  if (!tokens) {
    oauthError(res, 400, 'invalid_grant', 'That account no longer exists');
    return;
  }
  res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').json(tokens);
}

async function refresh(req: Request, res: Response, app: IOAuthApp): Promise<void> {
  const refreshToken = typeof req.body.refresh_token === 'string' ? req.body.refresh_token : '';
  const record = refreshToken
    ? await OAuthToken.findOne({ refreshHash: hashSecret(refreshToken) })
    : null;

  if (!record || !record.app.equals(app._id) || record.revokedAt) {
    oauthError(res, 400, 'invalid_grant', 'That refresh token is not valid');
    return;
  }
  /* Rotated already: somebody is replaying an old token. End the family. */
  if (record.rotatedAt) {
    await revokeFamily(record.family);
    oauthError(res, 400, 'invalid_grant', 'That refresh token has already been used');
    return;
  }
  if (record.refreshExpiresAt.getTime() < Date.now()) {
    oauthError(res, 400, 'invalid_grant', 'That refresh token has expired');
    return;
  }

  /* An app may narrow its scopes on refresh, never widen them. */
  let scopes = record.scopes;
  if (typeof req.body.scope === 'string' && req.body.scope.trim()) {
    const asked = req.body.scope.split(/\s+/).filter(Boolean);
    if (!asked.every((scope: string) => record.scopes.includes(scope))) {
      oauthError(res, 400, 'invalid_scope', 'A refresh cannot add scopes that were not granted');
      return;
    }
    scopes = asked;
  }

  const rotated = await OAuthToken.findOneAndUpdate(
    { _id: record._id, rotatedAt: null, revokedAt: null },
    { $set: { rotatedAt: new Date() } },
  );
  if (!rotated) {
    await revokeFamily(record.family);
    oauthError(res, 400, 'invalid_grant', 'That refresh token has already been used');
    return;
  }

  const tokens = await issueTokens(app, record.user, scopes, record.family, record.code, {});
  if (!tokens) {
    oauthError(res, 400, 'invalid_grant', 'That account no longer exists');
    return;
  }
  res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').json(tokens);
}

/* ---------------------------------------------------------- userinfo --- */

export async function userinfo(req: Request, res: Response): Promise<void> {
  const header = req.header('authorization') ?? '';
  const accessToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const record = accessToken ? await OAuthToken.findOne({ accessHash: hashSecret(accessToken) }) : null;

  const valid = record && !record.revokedAt && record.accessExpiresAt.getTime() > Date.now();
  if (!valid) {
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    oauthError(res, 401, 'invalid_token', 'The access token is missing, expired or revoked');
    return;
  }

  const [app, user] = await Promise.all([
    OAuthApp.findOne({ _id: record.app, status: 'active' }),
    User.findById(record.user),
  ]);
  if (!app || !user) {
    oauthError(res, 401, 'invalid_token', 'The access token is no longer valid');
    return;
  }

  res.set('Cache-Control', 'no-store').json(claimsFor(user, app.clientId, record.scopes));
}

/* ------------------------------------------------------------ revoke --- */

/**
 * RFC 7009. Always 200 for a well-formed request, whether or not the token
 * existed — the answer must not tell a caller which tokens are real.
 */
export async function revoke(req: Request, res: Response): Promise<void> {
  const app = await authenticateClient(req);
  if (!app) {
    oauthError(res, 401, 'invalid_client', 'Unknown client, or wrong or missing credentials');
    return;
  }

  const given = typeof req.body?.token === 'string' ? req.body.token : '';
  if (given) {
    const hash = hashSecret(given);
    const record = await OAuthToken.findOne({
      app: app._id,
      $or: [{ accessHash: hash }, { refreshHash: hash }],
    });
    if (record) await revokeFamily(record.family);
  }
  res.status(200).set('Cache-Control', 'no-store').end();
}
