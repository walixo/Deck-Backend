import { Router } from 'express';
import {
  getMyPayoutAccount,
  listMyPayouts,
  refreshMyPayoutAccount,
  startPayoutOnboarding,
} from '../controllers/payout.controller';
import { getMyEarnings, payoutAccountsRetired } from '../controllers/seller.controller';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.use(asyncHandler(requireAuth));

router.get('/earnings', asyncHandler(getMyEarnings));
router.get('/payouts', asyncHandler(listMyPayouts));

/*
 * The Bachs sub-account that earnings are transferred to. A new path rather
 * than reviving `/account`, which an earlier, retired payout-account design
 * used and which still answers 410 below — an old cached bundle calling it
 * should keep being told it went away, not reach something different.
 */
router.get('/payout-account', asyncHandler(getMyPayoutAccount));
router.post('/payout-account/onboarding', asyncHandler(startPayoutOnboarding));
router.post('/payout-account/refresh', asyncHandler(refreshMyPayoutAccount));

/* Retired with the move to direct disbursement. Answering 410 rather than 404
   tells a stale browser bundle that this went away, not that it broke. */
router.all(/^\/(account|banks|resolve)$/, () => payoutAccountsRetired());

export default router;
