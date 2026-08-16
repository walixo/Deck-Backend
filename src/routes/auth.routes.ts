import { Router } from 'express';
import { login, me, register, updateProfile } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { loginSchema, registerSchema, updateProfileSchema } from '../validators/auth.validators';

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

export default router;
