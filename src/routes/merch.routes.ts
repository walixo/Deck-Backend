import { Router } from 'express';
import {
  createMerchProduct,
  deleteMerchProduct,
  getMerchCategories,
  getMerchProduct,
  listMerch,
  listMyMerch,
  listPendingMerch,
  reviewMerchProduct,
  updateMerchProduct,
} from '../controllers/merch.controller';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createMerchSchema,
  listMerchSchema,
  rejectMerchSchema,
  updateMerchSchema,
} from '../validators/merch.validators';

const router = Router();

// Browsing the shop needs no account.
router.get('/', validate(listMerchSchema, 'query'), asyncHandler(listMerch));
router.get('/categories', asyncHandler(getMerchCategories));

/*
 * Fixed segments are declared before '/:slug', or 'mine' and 'pending' would be
 * swallowed as product slugs and 404.
 */
router.get('/mine', asyncHandler(requireAuth), asyncHandler(listMyMerch));
router.get('/pending', asyncHandler(requireAuth), requireAdmin, asyncHandler(listPendingMerch));

router.get('/:slug', asyncHandler(getMerchProduct));

/* Anyone with a payout account can list; the controller decides whether it goes
   live immediately (staff) or into the review queue (everyone else). */
router.post(
  '/',
  asyncHandler(requireAuth),
  validate(createMerchSchema),
  asyncHandler(createMerchProduct),
);
router.patch(
  '/:id',
  asyncHandler(requireAuth),
  validate(updateMerchSchema),
  asyncHandler(updateMerchProduct),
);
router.delete('/:id', asyncHandler(requireAuth), asyncHandler(deleteMerchProduct));

router.post(
  '/:id/approve',
  asyncHandler(requireAuth),
  requireAdmin,
  asyncHandler(reviewMerchProduct),
);
router.post(
  '/:id/reject',
  asyncHandler(requireAuth),
  requireAdmin,
  validate(rejectMerchSchema),
  asyncHandler(reviewMerchProduct),
);

export default router;
