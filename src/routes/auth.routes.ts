import { Router } from 'express';
import {
  changePassword,
  login,
  me,
  register,
  updateProfile,
} from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '../validators/auth.validators';

const router = Router();

router.post('/register', validate(registerSchema), asyncHandler(register));
router.post('/login', validate(loginSchema), asyncHandler(login));
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
  asyncHandler(requireAuth),
  validate(changePasswordSchema),
  asyncHandler(changePassword),
);

export default router;
