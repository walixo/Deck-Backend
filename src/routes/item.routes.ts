import { Router } from 'express';
import { createComment, listComments } from '../controllers/comment.controller';
import {
  createItem,
  deleteItem,
  getItem,
  getSpotlight,
  listItemRevisions,
  listItems,
  releaseItem,
  updateItem,
} from '../controllers/item.controller';
import {
  applyForFundraise,
  createContribution,
  listContributions,
  updateFundraise,
} from '../controllers/fundraise.controller';
import { toggleVote } from '../controllers/vote.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { createCommentSchema } from '../validators/comment.validators';
import {
  applyFundraiseSchema,
  createContributionSchema,
  updateFundraiseSchema,
} from '../validators/fundraise.validators';
import {
  createItemSchema,
  listItemsSchema,
  releaseItemSchema,
  updateItemSchema,
} from '../validators/item.validators';

const router = Router();

router.get(
  '/',
  asyncHandler(optionalAuth),
  validate(listItemsSchema, 'query'),
  asyncHandler(listItems),
);
router.get('/spotlight', asyncHandler(optionalAuth), asyncHandler(getSpotlight));
router.get('/:slug', asyncHandler(optionalAuth), asyncHandler(getItem));

router.post('/', asyncHandler(requireAuth), validate(createItemSchema), asyncHandler(createItem));
router.patch(
  '/:id',
  asyncHandler(requireAuth),
  validate(updateItemSchema),
  asyncHandler(updateItem),
);
router.delete('/:id', asyncHandler(requireAuth), asyncHandler(deleteItem));

router.post('/:id/vote', asyncHandler(requireAuth), asyncHandler(toggleVote));

/* Raising money. The launcher opts in and out; anyone signed in can back it. */
router.patch(
  '/:slug/fundraise',
  asyncHandler(requireAuth),
  validate(updateFundraiseSchema),
  asyncHandler(updateFundraise),
);
/* Applying is the only way a raise starts. Approval is a staff route. */
router.post(
  '/:slug/fundraise/apply',
  asyncHandler(requireAuth),
  validate(applyFundraiseSchema),
  asyncHandler(applyForFundraise),
);

router.get('/:slug/contributions', asyncHandler(listContributions));
router.post(
  '/:slug/contributions',
  asyncHandler(requireAuth),
  validate(createContributionSchema),
  asyncHandler(createContribution),
);

/* Shipping a new version. Creates a launch rather than editing one, so it is a
   POST on the product rather than a PATCH on the entry. */
router.post(
  '/:slug/release',
  asyncHandler(requireAuth),
  validate(releaseItemSchema),
  asyncHandler(releaseItem),
);

/* Public: the history is only useful as a trust signal if a reader can see it. */
router.get('/:slug/revisions', asyncHandler(listItemRevisions));

router.get('/:slug/comments', asyncHandler(listComments));
router.post(
  '/:slug/comments',
  asyncHandler(requireAuth),
  validate(createCommentSchema),
  asyncHandler(createComment),
);

export default router;
