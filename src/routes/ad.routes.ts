import { Router } from 'express';
import {
  createAd,
  getRateCard,
  listMyAds,
  listPendingAds,
  payForAd,
  recordAdClick,
  reviewAd,
  serveAd,
} from '../controllers/ad.controller';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { createAdSchema, rejectAdSchema } from '../validators/ad.validators';

const router = Router();

/* Serving is public and unauthenticated — it runs on every page view, so it
   stays as cheap as a single indexed lookup. */
router.get('/rates', getRateCard);
router.get('/slot/:placement', asyncHandler(serveAd));
router.post('/:reference/click', asyncHandler(recordAdClick));

/* Fixed segments before the reference, or "mine" and "pending" are swallowed. */
router.get('/mine', asyncHandler(requireAuth), asyncHandler(listMyAds));
router.get('/pending', asyncHandler(requireAuth), requireAdmin, asyncHandler(listPendingAds));

router.post('/', asyncHandler(requireAuth), validate(createAdSchema), asyncHandler(createAd));
router.post('/:reference/pay', asyncHandler(requireAuth), asyncHandler(payForAd));

router.post('/:reference/approve', asyncHandler(requireAuth), requireAdmin, asyncHandler(reviewAd));
router.post(
  '/:reference/reject',
  asyncHandler(requireAuth),
  requireAdmin,
  validate(rejectAdSchema),
  asyncHandler(reviewAd),
);

export default router;
