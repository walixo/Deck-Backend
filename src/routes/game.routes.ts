import { Router } from 'express';
import {
  deleteGame,
  getGame,
  listGames,
  listMyGames,
  listScores,
  recordPlay,
  submitGame,
  submitScore,
  updateGame,
} from '../controllers/game.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  listGamesSchema,
  submitGameSchema,
  updateGameSchema,
} from '../validators/game.validators';
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
router.post('/:slug/play', asyncHandler(recordPlay));

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

export default router;
