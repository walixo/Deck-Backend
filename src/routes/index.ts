import { Router } from 'express';
import { getExchangeRates, getStats, getTags } from '../controllers/meta.controller';
import { listCategories } from '../controllers/category.controller';
import { asyncHandler } from '../utils/asyncHandler';
import acquisitionRoutes from './acquisition.routes';
import adRoutes from './ad.routes';
import adminRoutes from './admin.routes';
import agentApiRoutes from './agentApi.routes';
import agentRoutes from './agent.routes';
import authRoutes from './auth.routes';
import commentRoutes from './comment.routes';
import customRoutes from './custom.routes';
import forumRoutes from './forum.routes';
import gameApiRoutes from './gameApi.routes';
import gameIdOAuthRoutes from './gameIdOAuth.routes';
import gameIdRoutes from './gameId.routes';
import gameRoutes from './game.routes';
import itemRoutes from './item.routes';
import postRoutes from './post.routes';
import leaderboardRoutes from './leaderboard.routes';
import merchRoutes from './merch.routes';
import notificationRoutes from './notification.routes';
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

router.get('/categories', asyncHandler(listCategories));
router.get('/tags', asyncHandler(getTags));
router.get('/stats', asyncHandler(getStats));
router.get('/rates', asyncHandler(getExchangeRates));

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/ads', adRoutes);
router.use('/acquisitions', acquisitionRoutes);
router.use('/share', shareRoutes);
router.use('/items', itemRoutes);
router.use('/posts', postRoutes);
router.use('/comments', commentRoutes);
router.use('/forum', forumRoutes);
/* Before `/games`: the developer server API has its own auth, and must never
   fall through to the player-facing router. */
router.use('/games/v1', gameApiRoutes);
/* GameID: the public OAuth endpoints first, then the Deck-side ones. */
router.use('/gameid/oauth', gameIdOAuthRoutes);
router.use('/gameid', gameIdRoutes);
/* AgentID: the agent's own key-authenticated API first, then the operator's. */
router.use('/agents/v1', agentApiRoutes);
router.use('/agents', agentRoutes);
router.use('/games', gameRoutes);
router.use('/custom', customRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/notifications', notificationRoutes);
router.use('/users', userRoutes);
router.use('/uploads', uploadRoutes);
router.use('/merch', merchRoutes);
router.use('/sellers', sellerRoutes);
router.use('/payouts', payoutRoutes);
router.use('/orders', orderRoutes);
router.use('/orders', paymentRoutes);

export default router;
