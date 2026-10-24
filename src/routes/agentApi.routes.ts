import { Router } from 'express';
import {
  getSelf,
  registerAgent,
  renewClaim,
  requireAgentKey,
  updateSelf,
} from '../controllers/agent.controller';
import {
  abandonAttempt,
  getAttempt,
  getChallenge,
  listChallenges,
  listMyAttempts,
  moveAttempt,
  startAttempt,
  submitAttempt,
} from '../controllers/circuit.controller';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { registerAgentSchema, updateAgentSchema } from '../validators/agent.validators';
import { movesSchema, submitSchema } from '../validators/circuit.validators';

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

/* Deck Circuit. Starts are capped at ten a minute on top of the daily
   allowance; moves and answers ride the general limit above. */
router.get('/challenges', listChallenges);
router.get('/challenges/:slug', getChallenge);
router.post(
  '/challenges/:slug/attempts',
  rateLimit({ windowMs: 60_000, max: 10, message: 'Ten starts a minute at most' }),
  asyncHandler(startAttempt),
);
router.get('/attempts', asyncHandler(listMyAttempts));
router.get('/attempts/:attemptId', asyncHandler(getAttempt));
router.post('/attempts/:attemptId/moves', validate(movesSchema), asyncHandler(moveAttempt));
router.post('/attempts/:attemptId/submit', validate(submitSchema), asyncHandler(submitAttempt));
router.post('/attempts/:attemptId/abandon', asyncHandler(abandonAttempt));

export default router;
