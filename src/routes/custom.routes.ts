import { Router } from 'express';
import {
  createCustomDesign,
  deleteCustomDesign,
  getCustomDesign,
  generateLifestyle,
  inspectArtwork,
  listMyDesigns,
  updateCustomDesign,
} from '../controllers/custom.controller';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createCustomDesignSchema,
  inspectArtworkSchema,
  updateCustomDesignSchema,
} from '../validators/custom.validators';

const router = Router();

/* Everything here needs an account. Uploading artwork is already gated, and a
   design belongs to somebody — there is no anonymous version of this. */
router.use(asyncHandler(requireAuth));

/* Measure first, commit later. The page calls this the moment a file lands so
   it can show warnings and prices before anything is saved. */
router.post('/inspect', validate(inspectArtworkSchema), asyncHandler(inspectArtwork));

router.get('/', asyncHandler(listMyDesigns));
router.post('/', validate(createCustomDesignSchema), asyncHandler(createCustomDesign));

router.get('/:reference', asyncHandler(getCustomDesign));
router.patch('/:reference', validate(updateCustomDesignSchema), asyncHandler(updateCustomDesign));
router.delete('/:reference', asyncHandler(deleteCustomDesign));

/* The only generative call on Deck. Owner-only and once per design — see the
   note on the controller for why it is not a button you can lean on. */
router.post('/:reference/lifestyle', asyncHandler(generateLifestyle));

export default router;
