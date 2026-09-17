import { Router } from 'express';
import { getMyLaunchViews } from '../controllers/analytics.controller';
import { getTopMakers, getUserProfile } from '../controllers/user.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { launchViewsSchema } from '../validators/analytics.validators';

const router = Router();

router.get('/top', asyncHandler(getTopMakers));

/*
 * Above `/:username`, and two segments deep so it could not collide with one
 * anyway — but the ordering is what the next person will check, so it stays
 * explicit. A maker's own traffic is nobody else's business, hence requireAuth
 * and a query scoped to `req.user` rather than to anything in the path: there
 * is no id here to tamper with.
 */
router.get(
  '/me/launch-views',
  asyncHandler(requireAuth),
  validate(launchViewsSchema, 'query'),
  asyncHandler(getMyLaunchViews),
);

router.get('/:username', asyncHandler(optionalAuth), asyncHandler(getUserProfile));

export default router;
