import { Router } from 'express';
import { listNotifications, markAllRead, markRead } from '../controllers/notification.controller';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { listNotificationsSchema } from '../validators/notification.validators';

const router = Router();

/* Every route here is about the caller's own notifications, so the guard goes
   on the router rather than being repeated — and no route takes a user id,
   which means there is nothing to tamper with. */
router.use(asyncHandler(requireAuth));

router.get('/', validate(listNotificationsSchema, 'query'), asyncHandler(listNotifications));
router.post('/read', asyncHandler(markAllRead));
router.post('/:id/read', asyncHandler(markRead));

export default router;
