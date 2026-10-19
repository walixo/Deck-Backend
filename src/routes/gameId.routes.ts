import { Router } from 'express';
import {
  createApp,
  decideAuthorize,
  getAuthorizeInfo,
  getMyApp,
  getMyGameId,
  listConnections,
  listMyApps,
  revokeConnection,
  rotateAppSecret,
  updateMyApp,
  updateMyGameId,
} from '../controllers/gameId.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  authorizeDecisionSchema,
  authorizeQuerySchema,
  createAppSchema,
  updateAppSchema,
  updateGameIdSchema,
} from '../validators/gameId.validators';

/** GameID's Deck-side endpoints, `/api/gameid`. All use the Deck session. */
const router = Router();

router.get('/me', asyncHandler(requireAuth), asyncHandler(getMyGameId));
router.patch('/me', asyncHandler(requireAuth), validate(updateGameIdSchema), asyncHandler(updateMyGameId));

/* The consent page. Reading is open — it has to describe the app to somebody
   who has not signed in yet — but answering needs the player. */
router.get(
  '/authorize',
  asyncHandler(optionalAuth),
  validate(authorizeQuerySchema, 'query'),
  asyncHandler(getAuthorizeInfo),
);
router.post(
  '/authorize',
  asyncHandler(requireAuth),
  validate(authorizeDecisionSchema),
  asyncHandler(decideAuthorize),
);

router.get('/connections', asyncHandler(requireAuth), asyncHandler(listConnections));
router.delete('/connections/:clientId', asyncHandler(requireAuth), asyncHandler(revokeConnection));

router.get('/apps', asyncHandler(requireAuth), asyncHandler(listMyApps));
router.post('/apps', asyncHandler(requireAuth), validate(createAppSchema), asyncHandler(createApp));
router.get('/apps/:clientId', asyncHandler(requireAuth), asyncHandler(getMyApp));
router.patch('/apps/:clientId', asyncHandler(requireAuth), validate(updateAppSchema), asyncHandler(updateMyApp));
router.post('/apps/:clientId/secret', asyncHandler(requireAuth), asyncHandler(rotateAppSecret));

export default router;
