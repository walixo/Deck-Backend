import { Router } from 'express';
import { verifyOrderPayment } from '../controllers/payment.controller';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/**
 * Called when the customer returns from checkout. Answers for orders,
 * contributions and ad campaigns alike, with a `kind` saying which.
 */
router.post('/:reference/verify', asyncHandler(requireAuth), asyncHandler(verifyOrderPayment));

export default router;
