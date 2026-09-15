import { Router } from 'express';
import {
  getDailyLeaderboard,
  getLaunchArchive,
  getLeaderboardDates,
  getPeriodLeaderboard,
} from '../controllers/leaderboard.controller';
import { optionalAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.get('/', asyncHandler(optionalAuth), asyncHandler(getDailyLeaderboard));
router.get('/period', asyncHandler(optionalAuth), asyncHandler(getPeriodLeaderboard));
router.get('/dates', asyncHandler(getLeaderboardDates));

/* The full archive, grouped. `/dates` caps at 14 for the board's strip; this
   one goes all the way back, because that is what an archive is for. */
router.get('/archive', asyncHandler(getLaunchArchive));

export default router;
