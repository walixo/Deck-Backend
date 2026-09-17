import { Router } from 'express';
import {
  changePassword,
  login,
  me,
  register,
  updateProfile,
} from '../controllers/auth.controller';
import { listAuthProviders, oauthCallback, startOAuth } from '../controllers/oauth.controller';
import { requireAuth } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '../validators/auth.validators';

const router = Router();

/* Limiter before the validator, so a flood of malformed bodies is turned away
   for the same cost as a flood of well-formed ones. */
router.post('/register', authLimiter, validate(registerSchema), asyncHandler(register));
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(login));

/*
 * Social sign-in.
 *
 * Public and unvalidated by the usual middleware because the caller is a
 * browser following a redirect, not the client talking to an API: there is no
 * JSON body to check, and the only untrusted inputs — `code` and `state` — are
 * handled in the controller, where a bad one has to become a redirect rather
 * than a 400.
 *
 * Not behind `authLimiter`. The expensive thing an attacker could repeat here
 * is a token exchange against GitHub, which fails without a valid one-time
 * code, and rate-limiting the callback by IP would throttle everyone behind a
 * shared address out of signing in at all.
 */
router.get('/providers', listAuthProviders);
router.get('/oauth/:provider/start', startOAuth);
router.get('/oauth/:provider/callback', asyncHandler(oauthCallback));
router.get('/me', asyncHandler(requireAuth), asyncHandler(me));
router.patch(
  '/me',
  asyncHandler(requireAuth),
  validate(updateProfileSchema),
  asyncHandler(updateProfile),
);

/* Separate from PATCH /me on purpose: a password change needs the current
   password, reissues a token, and should never be something a profile-form
   submission can do by accident. */
router.post(
  '/me/password',
  /* Limited too, though it sits behind auth: the handler checks the *current*
     password, which makes it a credential oracle for anyone holding a stolen
     token and wanting the password itself. */
  authLimiter,
  asyncHandler(requireAuth),
  validate(changePasswordSchema),
  asyncHandler(changePassword),
);

export default router;
