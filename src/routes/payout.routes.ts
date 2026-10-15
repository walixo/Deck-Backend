import { Router } from 'express';
import { listOwed, runTransfersNow } from '../controllers/payout.controller';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/* Staff-only: it lists what every seller is owed. */
router.use(asyncHandler(requireAuth), requireAdmin);

router.get('/owed', asyncHandler(listOwed));
/* The hourly transfer run, on demand. There is no route to record a payout by
   hand any more — every payout row comes from a transfer Bachs made. */
router.post('/run', asyncHandler(runTransfersNow));

export default router;
