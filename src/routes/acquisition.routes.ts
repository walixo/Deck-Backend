import { Router } from 'express';
import {
  acceptBid,
  createBid,
  getAcquisition,
  listAcquisitions,
  updateAcquisition,
  withdrawAcquisition,
  withdrawBid,
} from '../controllers/acquisition.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createBidSchema,
  listAcquisitionsSchema,
  updateAcquisitionSchema,
} from '../validators/acquisition.validators';

const router = Router();

/* Browsing needs no account — a listing is a shop window, and a sign-in wall in
   front of one costs Deck the buyer it was trying to attract. */
router.get('/', validate(listAcquisitionsSchema, 'query'), asyncHandler(listAcquisitions));

/* optionalAuth, not requireAuth: the handler needs to know whether the reader is
   the seller so a pending listing can be previewed and offers shown, but a
   signed-out reader looking at an approved one is the normal case. */
router.get('/:slug', asyncHandler(optionalAuth), asyncHandler(getAcquisition));

router.patch(
  '/:slug',
  asyncHandler(requireAuth),
  validate(updateAcquisitionSchema),
  asyncHandler(updateAcquisition),
);

router.post('/:slug/withdraw', asyncHandler(requireAuth), asyncHandler(withdrawAcquisition));

router.post(
  '/:slug/bids',
  asyncHandler(requireAuth),
  validate(createBidSchema),
  asyncHandler(createBid),
);

/* Accepting sits under the listing rather than under the bid, because it is the
   listing's state that changes — the sale, not the offer, is the event. */
router.post('/:slug/bids/:id/accept', asyncHandler(requireAuth), asyncHandler(acceptBid));

router.post('/bids/:id/withdraw', asyncHandler(requireAuth), asyncHandler(withdrawBid));

export default router;
