import { Router } from 'express';
import { getCategories, getStats, getTags } from '../controllers/meta.controller';
import { asyncHandler } from '../utils/asyncHandler';
import adRoutes from './ad.routes';
import adminRoutes from './admin.routes';
import authRoutes from './auth.routes';
import commentRoutes from './comment.routes';
import itemRoutes from './item.routes';
import leaderboardRoutes from './leaderboard.routes';
import merchRoutes from './merch.routes';
import orderRoutes from './order.routes';
import paymentRoutes from './payment.routes';
import payoutRoutes from './payout.routes';
import sellerRoutes from './seller.routes';
import shareRoutes from './share.routes';
import uploadRoutes from './upload.routes';
import userRoutes from './user.routes';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
});

router.get('/categories', asyncHandler(getCategories));
router.get('/tags', asyncHandler(getTags));
router.get('/stats', asyncHandler(getStats));

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/ads', adRoutes);
router.use('/share', shareRoutes);
router.use('/items', itemRoutes);
router.use('/comments', commentRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/users', userRoutes);
router.use('/uploads', uploadRoutes);
router.use('/merch', merchRoutes);
router.use('/sellers', sellerRoutes);
router.use('/payouts', payoutRoutes);
router.use('/orders', orderRoutes);
router.use('/orders', paymentRoutes);

export default router;
