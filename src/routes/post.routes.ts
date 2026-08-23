import { Router } from 'express';
import { getPost, listPosts } from '../controllers/post.controller';
import { optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { listPostsSchema } from '../validators/post.validators';

const router = Router();

router.get('/', validate(listPostsSchema, 'query'), asyncHandler(listPosts));

/* optionalAuth, not requireAuth: the handler needs to know whether the reader
   is staff so a draft can be previewed, but a signed-out reader is normal. */
router.get('/:slug', asyncHandler(optionalAuth), asyncHandler(getPost));

export default router;
