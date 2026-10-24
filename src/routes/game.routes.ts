import { Router } from 'express';
import {
  deleteGame,
  getGame,
  listGames,
  listMyGames,
  listScores,
  activePlayers,
  heartbeat,
  recordPlay,
  submitGame,
  submitScore,
  updateGame,
} from '../controllers/game.controller';
import {
  createProduct,
  createPurchase,
  createSession,
  getDeveloperView,
  getPurchase,
  listEntitlements,
  listProducts,
  listSales,
  mintKey,
  mintWebhookSecretFor,
  resendWebhook,
  testWebhook,
  updateDeveloperSettings,
  updateProduct,
} from '../controllers/gamePlatform.controller';
import {
  createRoom,
  endRoomByHost,
  getRoom,
  joinRoom,
  leaveRoom,
  quickMatch,
  sendMessage,
  setReady,
  setState,
  startRoom,
  streamRoom,
} from '../controllers/room.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { listGamesSchema, submitGameSchema, updateGameSchema } from '../validators/game.validators';
import {
  createProductSchema,
  developerSettingsSchema,
  mintKeySchema,
  modeQuerySchema,
  purchaseSchema,
  salesQuerySchema,
  sessionSchema,
  updateProductSchema,
} from '../validators/gamePlatform.validators';
import {
  createRoomSchema,
  joinRoomSchema,
  quickMatchSchema,
  readySchema,
  roomMessageSchema,
  roomStateSchema,
  seatOnlySchema,
  seatQuerySchema,
} from '../validators/room.validators';
import { submitScoreSchema } from '../validators/score.validators';

const router = Router();

/* The arcade is public. A game you have to sign in to see is a game nobody
   plays, and there is nothing here worth gating. */
router.get('/', validate(listGamesSchema, 'query'), asyncHandler(listGames));

/* Declared before `/:slug` — Express matches in order, and a bare `/:slug`
   would otherwise swallow this and go looking for a game slugged "mine". */
router.get('/mine', asyncHandler(requireAuth), asyncHandler(listMyGames));

/* optionalAuth: a signed-out reader is the normal case, but the handler needs
   to know whether the viewer is the author or staff to show an unapproved one. */
/* Before `/:slug`, so "players" is never read as a game. */
router.get('/players', asyncHandler(activePlayers));
router.get('/:slug', asyncHandler(optionalAuth), asyncHandler(getGame));

router.post('/', asyncHandler(requireAuth), validate(submitGameSchema), asyncHandler(submitGame));

router.patch(
  '/:slug',
  asyncHandler(requireAuth),
  validate(updateGameSchema),
  asyncHandler(updateGame),
);

router.delete('/:slug', asyncHandler(requireAuth), asyncHandler(deleteGame));

/* Unauthenticated on purpose: a play is a play whether or not somebody has an
   account, and requiring one would make the counter measure sign-ins instead. */
router.post('/:slug/play', asyncHandler(optionalAuth), asyncHandler(recordPlay));
router.post(
  '/:slug/presence',
  rateLimit({ windowMs: 60_000, max: 6, message: 'Too many heartbeats' }),
  asyncHandler(requireAuth),
  asyncHandler(heartbeat),
);

/* The leaderboard is public to read — one nobody can see without an account is
   not a leaderboard. optionalAuth so a signed-in reader also gets their own
   standing back. */
router.get('/:slug/scores', asyncHandler(optionalAuth), asyncHandler(listScores));

/* Posting one needs an account. Anonymous entries would make the board a list
   of made-up names, and there would be no way to keep one row per player. */
router.post(
  '/:slug/scores',
  asyncHandler(requireAuth),
  validate(submitScoreSchema),
  asyncHandler(submitScore),
);

/* ------------------------------------------- Deck Games platform --- */

/* Generous for a player — a game asks for a session every few minutes at most
   — and tight enough that a script cannot open a thousand checkouts. */
const playerLimiter = rateLimit({ windowMs: 60_000, max: 40 });

/* Two literal segments, so it can never be mistaken for `/:slug/...`. */
router.get('/purchases/:reference', asyncHandler(requireAuth), asyncHandler(getPurchase));

router.get('/:slug/products', asyncHandler(optionalAuth), asyncHandler(listProducts));
router.post(
  '/:slug/session',
  playerLimiter,
  asyncHandler(requireAuth),
  validate(sessionSchema),
  asyncHandler(createSession),
);
router.post(
  '/:slug/purchases',
  playerLimiter,
  asyncHandler(requireAuth),
  validate(purchaseSchema),
  asyncHandler(createPurchase),
);
router.get(
  '/:slug/entitlements',
  asyncHandler(requireAuth),
  validate(modeQuerySchema, 'query'),
  asyncHandler(listEntitlements),
);

/*
 * Multiplayer rooms, from the player's side — called by the Deck page hosting
 * the game. Making and joining rooms shares the player limiter; messages have
 * their own per-player budget inside the hub, because a game sends many.
 */
const auth = asyncHandler(requireAuth);
router.post(
  '/:slug/rooms',
  playerLimiter,
  auth,
  validate(createRoomSchema),
  asyncHandler(createRoom),
);
router.post(
  '/:slug/rooms/join',
  playerLimiter,
  auth,
  validate(joinRoomSchema),
  asyncHandler(joinRoom),
);
router.post(
  '/:slug/rooms/quickmatch',
  playerLimiter,
  auth,
  validate(quickMatchSchema),
  asyncHandler(quickMatch),
);
router.get('/:slug/rooms/:roomId', auth, validate(seatQuerySchema, 'query'), asyncHandler(getRoom));
router.get(
  '/:slug/rooms/:roomId/stream',
  auth,
  validate(seatQuerySchema, 'query'),
  asyncHandler(streamRoom),
);
router.post('/:slug/rooms/:roomId/ready', auth, validate(readySchema), asyncHandler(setReady));
router.post('/:slug/rooms/:roomId/start', auth, validate(seatOnlySchema), asyncHandler(startRoom));
router.post(
  '/:slug/rooms/:roomId/messages',
  auth,
  validate(roomMessageSchema),
  asyncHandler(sendMessage),
);
router.post('/:slug/rooms/:roomId/state', auth, validate(roomStateSchema), asyncHandler(setState));
router.post('/:slug/rooms/:roomId/leave', auth, validate(seatOnlySchema), asyncHandler(leaveRoom));
router.post(
  '/:slug/rooms/:roomId/end',
  auth,
  validate(seatOnlySchema),
  asyncHandler(endRoomByHost),
);

/* The developer's dashboard. Each handler checks the caller owns the game. */
router.get('/:slug/developer', asyncHandler(requireAuth), asyncHandler(getDeveloperView));
router.patch(
  '/:slug/developer',
  asyncHandler(requireAuth),
  validate(developerSettingsSchema),
  asyncHandler(updateDeveloperSettings),
);
router.post(
  '/:slug/keys',
  asyncHandler(requireAuth),
  validate(mintKeySchema),
  asyncHandler(mintKey),
);
router.post('/:slug/webhook-secret', asyncHandler(requireAuth), asyncHandler(mintWebhookSecretFor));
router.post('/:slug/webhook/test', asyncHandler(requireAuth), asyncHandler(testWebhook));
router.post(
  '/:slug/products',
  asyncHandler(requireAuth),
  validate(createProductSchema),
  asyncHandler(createProduct),
);
router.patch(
  '/:slug/products/:productId',
  asyncHandler(requireAuth),
  validate(updateProductSchema),
  asyncHandler(updateProduct),
);
router.get(
  '/:slug/sales',
  asyncHandler(requireAuth),
  validate(salesQuerySchema, 'query'),
  asyncHandler(listSales),
);
router.post(
  '/:slug/sales/:reference/resend',
  asyncHandler(requireAuth),
  asyncHandler(resendWebhook),
);

export default router;
