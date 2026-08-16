import { Router } from 'express';
import {
  createOrder,
  getOrder,
  listMyOrders,
  quoteShipping,
} from '../controllers/order.controller';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { createOrderSchema } from '../validators/merch.validators';

const router = Router();

// Shipping is quotable before sign-in so the cart can show a real total.
router.get('/shipping-quote', asyncHandler(quoteShipping));

router.post('/', asyncHandler(requireAuth), validate(createOrderSchema), asyncHandler(createOrder));
router.get('/', asyncHandler(requireAuth), asyncHandler(listMyOrders));
router.get('/:reference', asyncHandler(requireAuth), asyncHandler(getOrder));

export default router;
