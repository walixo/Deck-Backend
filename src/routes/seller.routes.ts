import { Router } from 'express';
import { listMyPayouts } from '../controllers/payout.controller';
import { getMyEarnings, payoutAccountsRetired } from '../controllers/seller.controller';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.use(asyncHandler(requireAuth));

router.get('/earnings', asyncHandler(getMyEarnings));
router.get('/payouts', asyncHandler(listMyPayouts));

/* Retired with the move to direct disbursement. Answering 410 rather than 404
   tells a stale browser bundle that this went away, not that it broke. */
router.all(/^\/(account|banks|resolve)$/, () => payoutAccountsRetired());

export default router;
