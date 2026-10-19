import { Router } from 'express';
import {
  discovery,
  publicKeys,
  revoke,
  token,
  userinfo,
} from '../controllers/gameIdOAuth.controller';
import { rateLimit } from '../middleware/rateLimit';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * GameID's public OAuth / OpenID Connect endpoints, `/api/gameid/oauth`.
 * Open CORS (set in app.ts, ahead of Deck's own), no cookies, OAuth-shaped
 * errors. The consent page itself is a frontend route: `/gameid/authorize`.
 */
const router = Router();

/* Token guessing and code replay are cheap to attempt; make them slow. */
const tokenLimiter = rateLimit({ windowMs: 60_000, max: 60, message: 'Too many token requests' });

router.get('/.well-known/openid-configuration', discovery);
router.get('/jwks.json', publicKeys);
router.post('/token', tokenLimiter, asyncHandler(token));
router.get('/userinfo', asyncHandler(userinfo));
router.post('/userinfo', asyncHandler(userinfo));
router.post('/revoke', tokenLimiter, asyncHandler(revoke));

export default router;
