import { Router } from 'express';
import {
  getSelf,
  registerAgent,
  renewClaim,
  requireAgentKey,
  updateSelf,
} from '../controllers/agent.controller';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { registerAgentSchema, updateAgentSchema } from '../validators/agent.validators';

/**
 * The agent's own API, `/api/agents/v1`, called by the agent with its key.
 *
 * Registration is the one open route, and it is held to ten an hour from one
 * address: an open sign-up for machines is exactly what a machine would abuse.
 * Everything else is rate limited before the key is checked, so guessing keys
 * is slow too.
 */
const router = Router();

router.post(
  '/register',
  rateLimit({
    windowMs: 60 * 60_000,
    max: 10,
    message: 'Too many registrations from here. Try again later.',
  }),
  validate(registerAgentSchema),
  asyncHandler(registerAgent),
);

router.use(rateLimit({ windowMs: 60_000, max: 600, message: 'Slow down — 600 calls a minute' }));
router.use(asyncHandler(requireAgentKey));

router.get('/me', asyncHandler(getSelf));
router.patch('/me', validate(updateAgentSchema), asyncHandler(updateSelf));
router.post('/claim', asyncHandler(renewClaim));

export default router;
