import { Router } from 'express';
import { getEmbedBadge, getShareKit } from '../controllers/share.controller';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/* Both public: a badge that needed a token could not be embedded anywhere. */
router.get('/:slug/badge.svg', asyncHandler(getEmbedBadge));
router.get('/:slug', asyncHandler(getShareKit));

export default router;
