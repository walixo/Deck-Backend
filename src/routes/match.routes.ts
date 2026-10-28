import { Router } from 'express';
import {
  connected,
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
  signal,
  stream,
  subscribePush,
  unsubscribePush,
  updateMe,
} from '../controllers/match.controller';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createMatchProfileSchema,
  matchPushSchema,
  matchReportSchema,
  matchSectionRequestSchema,
  matchSignalSchema,
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
router.post('/calls/:callId/connected', auth, connected);
router.post('/calls/:callId/extend', auth, extend);
router.post('/calls/:callId/leave', auth, leaveCall);
router.post('/calls/:callId/share', auth, asyncHandler(share));
router.post(
  '/calls/:callId/report',
  reportLimiter,
  auth,
  validate(matchReportSchema),
  asyncHandler(report),
);

export default router;
