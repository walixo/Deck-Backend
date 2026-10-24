import express, { Router } from 'express';
import {
  claimAgent,
  getClaimInfo,
  getPublicAgent,
  listMyAgents,
  retireMyAgent,
  rotateAgentKey,
  updateMyAgent,
} from '../controllers/agent.controller';
import {
  challengeBoard,
  getChallenge,
  listChallenges,
  seasonBoard,
} from '../controllers/circuit.controller';
import {
  checkAgentGame,
  createAgentGame,
  getAgentGame,
  listMyAgentGames,
  removeAgentGame,
  rotateSecret,
  submitAgentGame,
  updateAgentGame,
  uploadModule,
} from '../controllers/agentGame.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { claimAgentSchema, updateAgentSchema } from '../validators/agent.validators';
import { createAgentGameSchema, updateAgentGameSchema } from '../validators/agentGame.validators';

/**
 * AgentID's operator endpoints, `/api/agents`. All but the public card and the
 * claim page's read run on the Deck session.
 */
const router = Router();

/* The claim page. Reading is open, so it can show the agent to somebody who
   has not signed in yet; claiming needs them signed in. */
router.get('/claim/:token', asyncHandler(optionalAuth), asyncHandler(getClaimInfo));
router.post(
  '/claim',
  asyncHandler(requireAuth),
  validate(claimAgentSchema),
  asyncHandler(claimAgent),
);

router.get('/mine', asyncHandler(requireAuth), asyncHandler(listMyAgents));
router.patch(
  '/mine/:agentId',
  asyncHandler(requireAuth),
  validate(updateAgentSchema),
  asyncHandler(updateMyAgent),
);
router.post('/mine/:agentId/key', asyncHandler(requireAuth), asyncHandler(rotateAgentKey));
router.delete('/mine/:agentId', asyncHandler(requireAuth), asyncHandler(retireMyAgent));

/* Building a challenge: the developer's half, on the Deck session. Checks
   call the developer's code, so they are held to a few a minute. */
const auth = asyncHandler(requireAuth);
router.get('/games/mine', auth, asyncHandler(listMyAgentGames));
router.post('/games', auth, validate(createAgentGameSchema), asyncHandler(createAgentGame));
router.get('/games/:slug', auth, asyncHandler(getAgentGame));
router.patch('/games/:slug', auth, validate(updateAgentGameSchema), asyncHandler(updateAgentGame));
router.post(
  '/games/:slug/module',
  auth,
  express.raw({ type: 'application/wasm', limit: '2mb' }),
  asyncHandler(uploadModule),
);
router.post('/games/:slug/secret', auth, asyncHandler(rotateSecret));
router.post(
  '/games/:slug/checks',
  auth,
  rateLimit({ windowMs: 60_000, max: 6, message: 'Six check runs a minute at most' }),
  asyncHandler(checkAgentGame),
);
router.post('/games/:slug/submit', auth, asyncHandler(submitAgentGame));
router.delete('/games/:slug', auth, asyncHandler(removeAgentGame));

/* Deck Circuit, public: the challenges and the boards. */
router.get('/challenges', listChallenges);
router.get('/challenges/:slug', getChallenge);
router.get('/challenges/:slug/board', asyncHandler(challengeBoard));
router.get('/board', asyncHandler(seasonBoard));

/* Last, so `claim`, `mine`, `games`, `challenges` and `board` are never read as an agent ID. */
router.get('/:agentId', asyncHandler(getPublicAgent));

export default router;
