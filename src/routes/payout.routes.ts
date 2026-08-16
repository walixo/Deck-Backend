import { Router } from 'express';
import { listOwed, recordPayout } from '../controllers/payout.controller';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { recordPayoutSchema } from '../validators/payout.validators';

const router = Router();

/* The disbursement run is staff-only: it lists what every seller is owed. */
router.use(asyncHandler(requireAuth), requireAdmin);

router.get('/owed', asyncHandler(listOwed));
router.post('/', validate(recordPayoutSchema), asyncHandler(recordPayout));

export default router;
