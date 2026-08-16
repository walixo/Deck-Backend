import { Router } from 'express';
import {
  getDailyLeaderboard,
  getLeaderboardDates,
  getPeriodLeaderboard,
} from '../controllers/leaderboard.controller';
import { optionalAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.get('/', asyncHandler(optionalAuth), asyncHandler(getDailyLeaderboard));
router.get('/period', asyncHandler(optionalAuth), asyncHandler(getPeriodLeaderboard));
router.get('/dates', asyncHandler(getLeaderboardDates));

export default router;
