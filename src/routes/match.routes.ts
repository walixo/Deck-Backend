import {
  buyBrandCard,
  listBrandCards,
  verifyBrandCard,
} from '../controllers/matchBrandCards.controller';
import {
  buyGiftCard,
  listGiftCards,
  redeemGiftCard,
  verifyGiftCard,
} from '../controllers/matchGiftCards.controller';
import { Router } from 'express';
import {
  callQuality,
  connected,
  iceServers,
  keepTalking,
  createMe,
  extend,
  getMe,
  joinQueue,
  leaveCall,
  leaveQueue,
  matches,
  online,
  report,
  requestSection,
  share,
  stopPaying,
  signal,
  stream,
  subscribePush,
  unsubscribePush,
  updateMe,
} from '../controllers/match.controller';
import {
  buyPlus,
  createTopup,
  getWallet,
  joinNight,
  sendGift,
  startVerification,
  submitVerification,
  verifyTopup,
} from '../controllers/matchWallet.controller';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createMatchProfileSchema,
  matchBrandBuySchema,
  matchGiftCardSchema,
  matchGiftSchema,
  matchQualitySchema,
  matchRedeemSchema,
  matchPushSchema,
  matchReportSchema,
  matchSectionRequestSchema,
  matchSignalSchema,
  matchTopupSchema,
  matchVerificationSchema,
  updateMatchProfileSchema,
} from '../validators/match.validators';

/** Match — `/api/match`. Everything but the online count needs an account. */
const router = Router();
const auth = asyncHandler(requireAuth);

/* Generous for a person skipping through calls; tight for a script. */
const queueLimiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Slow down a little' });
/* A call's set-up is a burst of network candidates. */
const signalLimiter = rateLimit({ windowMs: 60_000, max: 240 });
const reportLimiter = rateLimit({ windowMs: 60 * 60_000, max: 20 });
/*
 * Spending and top-ups: plenty for a person, little for a script. Counted per
 * account (it runs after sign-in), since many people share one mobile IP.
 */
const moneyLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: 'Slow down a little',
  key: (req) => (req.user ? `user:${String(req.user._id)}` : undefined),
});

router.get('/online', online);
router.get('/me', auth, asyncHandler(getMe));
router.post('/me', auth, validate(createMatchProfileSchema), asyncHandler(createMe));
router.patch('/me', auth, validate(updateMatchProfileSchema), asyncHandler(updateMe));
router.post(
  '/me/section-request',
  reportLimiter,
  auth,
  validate(matchSectionRequestSchema),
  asyncHandler(requestSection),
);
router.post('/push', auth, validate(matchPushSchema), asyncHandler(subscribePush));
router.delete('/push', auth, asyncHandler(unsubscribePush));
router.get('/matches', auth, asyncHandler(matches));
router.get('/stream', auth, asyncHandler(stream));
router.post('/queue', queueLimiter, auth, asyncHandler(joinQueue));
router.delete('/queue', auth, leaveQueue);
router.post('/calls/:callId/signal', signalLimiter, auth, validate(matchSignalSchema), signal);
/* Asked for before joining the line; the relay's credentials are short-lived. */
const iceLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  key: (req) => (req.user ? `user:${String(req.user._id)}` : undefined),
});
router.get('/ice', auth, iceLimiter, asyncHandler(iceServers));
router.post('/calls/:callId/connected', auth, connected);
router.post('/calls/:callId/extend', auth, extend);
router.post('/calls/:callId/pay', auth, moneyLimiter, asyncHandler(keepTalking));
router.delete('/calls/:callId/pay', auth, asyncHandler(stopPaying));
router.post(
  '/calls/:callId/gift',
  auth,
  moneyLimiter,
  validate(matchGiftSchema),
  asyncHandler(sendGift),
);
/* Sent after every call, so counted per account, generously. */
const qualityLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 120,
  key: (req) => (req.user ? `user:${String(req.user._id)}` : undefined),
});
router.post(
  '/calls/:callId/quality',
  auth,
  qualityLimiter,
  validate(matchQualitySchema),
  asyncHandler(callQuality),
);
router.post('/calls/:callId/leave', auth, leaveCall);
router.post('/calls/:callId/share', auth, asyncHandler(share));
router.post(
  '/calls/:callId/report',
  reportLimiter,
  auth,
  validate(matchReportSchema),
  asyncHandler(report),
);

/* The wallet. */
router.get('/wallet', auth, asyncHandler(getWallet));
router.post(
  '/wallet/topups',
  auth,
  moneyLimiter,
  validate(matchTopupSchema),
  asyncHandler(createTopup),
);
router.post('/wallet/topups/:reference/verify', auth, asyncHandler(verifyTopup));
router.post('/plus', auth, moneyLimiter, asyncHandler(buyPlus));
router.post('/night/entry', auth, moneyLimiter, asyncHandler(joinNight));
router.post('/verification/start', auth, moneyLimiter, asyncHandler(startVerification));
router.post(
  '/verification',
  auth,
  moneyLimiter,
  validate(matchVerificationSchema),
  asyncHandler(submitVerification),
);

/* Gift cards. Redeeming is held to a few tries, so codes can't be guessed. */
const redeemLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Too many tries — wait a few minutes and check the code',
  key: (req) => (req.user ? `user:${String(req.user._id)}` : undefined),
});
router.get('/giftcards', auth, asyncHandler(listGiftCards));
router.post(
  '/giftcards',
  auth,
  moneyLimiter,
  validate(matchGiftCardSchema),
  asyncHandler(buyGiftCard),
);
router.post('/giftcards/:reference/verify', auth, asyncHandler(verifyGiftCard));
router.post(
  '/giftcards/redeem',
  auth,
  redeemLimiter,
  validate(matchRedeemSchema),
  asyncHandler(redeemGiftCard),
);

/* Other brands' gift cards, through Reloadly. */
router.get('/brand-cards', auth, asyncHandler(listBrandCards));
router.post(
  '/brand-cards',
  auth,
  moneyLimiter,
  validate(matchBrandBuySchema),
  asyncHandler(buyBrandCard),
);
router.post('/brand-cards/:reference/verify', auth, asyncHandler(verifyBrandCard));

export default router;
