import { Router } from 'express';
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
import { optionalAuth, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { claimAgentSchema, updateAgentSchema } from '../validators/agent.validators';

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

/* Deck Circuit, public: the challenges and the boards. */
router.get('/challenges', listChallenges);
router.get('/challenges/:slug', getChallenge);
router.get('/challenges/:slug/board', asyncHandler(challengeBoard));
router.get('/board', asyncHandler(seasonBoard));

/* Last, so `claim`, `mine`, `challenges` and `board` are never read as an agent ID. */
router.get('/:agentId', asyncHandler(getPublicAgent));

export default router;
