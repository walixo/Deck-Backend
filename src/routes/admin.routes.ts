import { Router } from 'express';
import {
  getOverview,
  listAllOrders,
  listAuditEvents,
  listUsers,
  updateOrderStatus,
  updateUserRole,
  setUserVerified,
} from '../controllers/admin.controller';
import {
  createCategory,
  deleteCategory,
  updateCategory,
} from '../controllers/category.controller';
import {
  listFundraiseApplications,
  reviewFundraise,
} from '../controllers/fundraise.controller';
import { rescheduleItem, setFutureGen } from '../controllers/item.controller';
import {
  createPost,
  deletePost,
  listAllPosts,
  updatePost,
} from '../controllers/post.controller';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  listAuditSchema,
  listOrdersSchema,
  listUsersSchema,
  updateOrderStatusSchema,
  updateRoleSchema,
  verifyUserSchema,
} from '../validators/admin.validators';
import {
  createCategorySchema,
  updateCategorySchema,
} from '../validators/category.validators';
import { reviewFundraiseSchema } from '../validators/fundraise.validators';
import { rescheduleItemSchema, setFutureGenSchema } from '../validators/item.validators';
import { createPostSchema, updatePostSchema } from '../validators/post.validators';

const router = Router();

/* One gate for the whole surface. Every route below is staff-only, and saying
   so once is harder to get wrong than repeating it per handler. */
router.use(asyncHandler(requireAuth), requireAdmin);

router.get('/overview', asyncHandler(getOverview));

router.get('/users', validate(listUsersSchema, 'query'), asyncHandler(listUsers));
router.patch('/users/:id/role', validate(updateRoleSchema), asyncHandler(updateUserRole));
router.patch(
  '/users/:id/verify',
  validate(verifyUserSchema),
  asyncHandler(setUserVerified),
);

router.get('/orders', validate(listOrdersSchema, 'query'), asyncHandler(listAllOrders));
router.patch(
  '/orders/:reference/status',
  validate(updateOrderStatusSchema),
  asyncHandler(updateOrderStatus),
);

/* Lives here rather than on /api/items because it is not an edit: it decides
   which daily board a launch competes on, and can rewrite a finished one. */
router.patch(
  '/items/:id/schedule',
  validate(rescheduleItemSchema),
  asyncHandler(rescheduleItem),
);

/* Future Gen membership. Staff-curated for the same reason fundraises are
   staff-approved: the page ends in strangers sending money to teenagers. */
router.patch(
  '/items/:id/future-gen',
  validate(setFutureGenSchema),
  asyncHandler(setFutureGen),
);

/* Categories are staff-managed: they decide the shape of the whole board, and
   a slug typo becomes a broken filter URL for everyone. */
router.post('/categories', validate(createCategorySchema), asyncHandler(createCategory));
router.patch('/categories/:id', validate(updateCategorySchema), asyncHandler(updateCategory));
router.delete('/categories/:id', asyncHandler(deleteCategory));

router.get('/fundraises', asyncHandler(listFundraiseApplications));
router.patch(
  '/fundraises/:slug',
  validate(reviewFundraiseSchema),
  asyncHandler(reviewFundraise),
);

router.get('/posts', asyncHandler(listAllPosts));
router.post('/posts', validate(createPostSchema), asyncHandler(createPost));
router.patch('/posts/:id', validate(updatePostSchema), asyncHandler(updatePost));
router.delete('/posts/:id', asyncHandler(deletePost));

/* Read-only, deliberately. There is no route to amend the trail, and the model
   refuses it even if one were added by mistake. */
router.get('/audit', validate(listAuditSchema, 'query'), asyncHandler(listAuditEvents));

export default router;
