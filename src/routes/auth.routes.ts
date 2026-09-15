import { Router } from 'express';
import {
  changePassword,
  login,
  me,
  register,
  updateProfile,
} from '../controllers/auth.controller';
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
