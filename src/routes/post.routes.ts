import { Router } from 'express';
import {
  createPost,
  deletePost,
  getPost,
  listMyPosts,
  listPosts,
  updatePost,
} from '../controllers/post.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createPostSchema,
  listPostsSchema,
  updatePostSchema,
} from '../validators/post.validators';

const router = Router();

router.get('/', validate(listPostsSchema, 'query'), asyncHandler(listPosts));

/*
 * Writing is open to every account.
 *
 * `/mine` is declared before `/:slug` — Express matches in order, and a bare
 * `/:slug` would otherwise swallow it and go looking for a post slugged "mine".
 */
router.get('/mine', asyncHandler(requireAuth), asyncHandler(listMyPosts));

router.post('/', asyncHandler(requireAuth), validate(createPostSchema), asyncHandler(createPost));

/* optionalAuth, not requireAuth: the handler needs to know whether the reader
   is staff so a draft can be previewed, but a signed-out reader is normal. */
router.get('/:slug', asyncHandler(optionalAuth), asyncHandler(getPost));

router.patch(
  '/:id',
  asyncHandler(requireAuth),
  validate(updatePostSchema),
  asyncHandler(updatePost),
);

router.delete('/:id', asyncHandler(requireAuth), asyncHandler(deletePost));

export default router;
