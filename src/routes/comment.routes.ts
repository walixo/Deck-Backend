import { Router } from 'express';
import { deleteComment } from '../controllers/comment.controller';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.delete('/:commentId', asyncHandler(requireAuth), asyncHandler(deleteComment));

export default router;
