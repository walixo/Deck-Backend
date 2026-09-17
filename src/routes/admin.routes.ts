import { Router } from 'express';
import {
  getOverview,
  getProxyDiagnostics,
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
import {
  listAcquisitionApplications,
  reviewAcquisition,
} from '../controllers/acquisition.controller';
import { listCustomQueue, reviewCustomDesign } from '../controllers/custom.controller';
import { rescheduleItem, setFutureGen } from '../controllers/item.controller';
import {
  createPost,
  deletePost,
  listAllPosts,
  updatePost,
} from '../controllers/post.controller';
import { listAllGames, reviewGame } from '../controllers/game.controller';
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
import { reviewAcquisitionSchema } from '../validators/acquisition.validators';
import { reviewCustomDesignSchema } from '../validators/custom.validators';
import { rescheduleItemSchema, setFutureGenSchema } from '../validators/item.validators';
import { createPostSchema, updatePostSchema } from '../validators/post.validators';
import { reviewGameSchema } from '../validators/game.validators';

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

/* Acquisitions: the queue, and the yes/no on each. Approving one puts Deck's
   name beside somebody's asking price, so it is reviewed like a fundraise. */
router.get('/acquisitions', asyncHandler(listAcquisitionApplications));
router.patch(
  '/acquisitions/:slug',
  validate(reviewAcquisitionSchema),
  asyncHandler(reviewAcquisition),
);

/* Custom prints. The one review that ends with a parcel in the post carrying
   Deck's return address, so it is gated and audited like the money ones. */
router.get('/custom', asyncHandler(listCustomQueue));
router.patch(
  '/custom/:reference',
  validate(reviewCustomDesignSchema),
  asyncHandler(reviewCustomDesign),
);

router.get('/fundraises', asyncHandler(listFundraiseApplications));
router.patch(
  '/fundraises/:slug',
  validate(reviewFundraiseSchema),
  asyncHandler(reviewFundraise),
);

/* The arcade's review queue. Approving a game puts somebody else's page one
   click from Deck's, so it goes through the same gate as everything else that
   leaves the building. */
router.get('/games', asyncHandler(listAllGames));
router.patch('/games/:id/review', validate(reviewGameSchema), asyncHandler(reviewGame));

router.get('/posts', asyncHandler(listAllPosts));
router.post('/posts', validate(createPostSchema), asyncHandler(createPost));
router.patch('/posts/:id', validate(updatePostSchema), asyncHandler(updatePost));
router.delete('/posts/:id', asyncHandler(deletePost));

/* Read-only, deliberately. There is no route to amend the trail, and the model
   refuses it even if one were added by mistake. */
router.get('/audit', validate(listAuditSchema, 'query'), asyncHandler(listAuditEvents));

/* Infrastructure, not content: answers "is TRUST_PROXY set to the right number
   on this host, through this route". See the controller for why that cannot be
   worked out from a config file. */
router.get('/diagnostics/proxy', getProxyDiagnostics);

export default router;
