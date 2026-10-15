import { Router } from 'express';
import {
  deliverGamePurchase,
  getGamePurchase,
  listGameProducts,
  listPlayerPurchases,
  requireGameKey,
  verifySession,
  whoAmI,
} from '../controllers/gameApi.controller';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  playerPurchasesQuerySchema,
  verifySessionSchema,
} from '../validators/gamePlatform.validators';

/**
 * The server API for game developers, `/api/games/v1`. Every route needs a
 * Deck Games API key; see `gameApi.controller.ts`.
 *
 * Rate limited before the key is checked, so guessing keys is slow too.
 */
const router = Router();

router.use(rateLimit({ windowMs: 60_000, max: 600, message: 'Slow down — 600 calls a minute' }));
router.use(asyncHandler(requireGameKey));

router.get('/me', asyncHandler(whoAmI));
router.post('/session/verify', validate(verifySessionSchema), asyncHandler(verifySession));
router.get('/products', asyncHandler(listGameProducts));
router.get('/purchases/:reference', asyncHandler(getGamePurchase));
router.post('/purchases/:reference/deliver', asyncHandler(deliverGamePurchase));
router.get(
  '/players/:playerId/purchases',
  validate(playerPurchasesQuerySchema, 'query'),
  asyncHandler(listPlayerPurchases),
);

export default router;
