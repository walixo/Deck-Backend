import { Router } from 'express';
import {
  createReply,
  createTopic,
  deleteReply,
  deleteTopic,
  getTopic,
  listTopics,
  moderateTopic,
  updateTopic,
} from '../controllers/forum.controller';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createReplySchema,
  createTopicSchema,
  listTopicsSchema,
  moderateTopicSchema,
  updateTopicSchema,
} from '../validators/forum.validators';

const router = Router();

/* Reading the forum needs no account — a question and its answers are the most
   linkable thing on Deck, and a sign-in wall in front of them wastes both. */
router.get('/', validate(listTopicsSchema, 'query'), asyncHandler(listTopics));
router.get('/:slug', asyncHandler(getTopic));

router.post('/', asyncHandler(requireAuth), validate(createTopicSchema), asyncHandler(createTopic));

router.patch(
  '/:slug',
  asyncHandler(requireAuth),
  validate(updateTopicSchema),
  asyncHandler(updateTopic),
);

router.delete('/:slug', asyncHandler(requireAuth), asyncHandler(deleteTopic));

/* Pinning and locking sit behind requireAdmin as well as requireAuth: they
   change what everybody else can do with a thread. */
router.patch(
  '/:slug/moderate',
  asyncHandler(requireAuth),
  requireAdmin,
  validate(moderateTopicSchema),
  asyncHandler(moderateTopic),
);

router.post(
  '/:slug/replies',
  asyncHandler(requireAuth),
  validate(createReplySchema),
  asyncHandler(createReply),
);

router.delete('/replies/:id', asyncHandler(requireAuth), asyncHandler(deleteReply));

export default router;
