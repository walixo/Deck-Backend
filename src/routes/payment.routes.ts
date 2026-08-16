import { Router } from 'express';
import { verifyOrderPayment } from '../controllers/payment.controller';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/** Called when the customer returns from Paystack's checkout. */
router.post('/:reference/verify', asyncHandler(requireAuth), asyncHandler(verifyOrderPayment));

export default router;
