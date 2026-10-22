import { Router } from 'express';
import {
  deliverGamePurchase,
  endApiRoom,
  getApiRoom,
  getGamePurchase,
  listGameProducts,
  listPlayerPurchases,
  requireGameKey,
  sendApiRoomMessage,
  setApiRoomState,
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
import {
  endRoomSchema,
  serverMessageSchema,
  serverStateSchema,
} from '../validators/room.validators';

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

/* Multiplayer rooms: read one, drive it, end it with results. */
router.get('/rooms/:roomId', asyncHandler(getApiRoom));
router.post('/rooms/:roomId/state', validate(serverStateSchema), asyncHandler(setApiRoomState));
router.post(
  '/rooms/:roomId/messages',
  validate(serverMessageSchema),
  asyncHandler(sendApiRoomMessage),
);
router.post('/rooms/:roomId/end', validate(endRoomSchema), asyncHandler(endApiRoom));

export default router;
