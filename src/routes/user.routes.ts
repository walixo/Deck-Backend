import { Router } from 'express';
import { getTopMakers, getUserProfile } from '../controllers/user.controller';
import { optionalAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.get('/top', asyncHandler(getTopMakers));
router.get('/:username', asyncHandler(optionalAuth), asyncHandler(getUserProfile));

export default router;
