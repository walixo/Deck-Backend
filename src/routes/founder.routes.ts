import { Router } from 'express';
import { getFounder } from '../controllers/import.controller';
import { asyncHandler } from '../utils/asyncHandler';

/* Founder pages are public: a founder Deck lists should be able to see exactly
   what Deck says about them, without an account. */
const router = Router();

router.get('/:slug', asyncHandler(getFounder));

export default router;
