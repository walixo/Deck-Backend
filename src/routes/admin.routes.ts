import { Router } from 'express';
import {
  getOverview,
  listAllOrders,
  listAuditEvents,
  listUsers,
  updateOrderStatus,
  updateUserRole,
} from '../controllers/admin.controller';
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
} from '../validators/admin.validators';

const router = Router();

/* One gate for the whole surface. Every route below is staff-only, and saying
   so once is harder to get wrong than repeating it per handler. */
router.use(asyncHandler(requireAuth), requireAdmin);

router.get('/overview', asyncHandler(getOverview));

router.get('/users', validate(listUsersSchema, 'query'), asyncHandler(listUsers));
router.patch('/users/:id/role', validate(updateRoleSchema), asyncHandler(updateUserRole));

router.get('/orders', validate(listOrdersSchema, 'query'), asyncHandler(listAllOrders));
router.patch(
  '/orders/:reference/status',
  validate(updateOrderStatusSchema),
  asyncHandler(updateOrderStatus),
);

/* Read-only, deliberately. There is no route to amend the trail, and the model
   refuses it even if one were added by mistake. */
router.get('/audit', validate(listAuditSchema, 'query'), asyncHandler(listAuditEvents));

export default router;
