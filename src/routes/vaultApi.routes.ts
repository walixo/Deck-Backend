import { Router } from 'express';
import {
  checkCard,
  createOrder,
  getBalance,
  getOrder,
  listCatalogue,
  listOrders,
  redeem,
  requireVaultKey,
  whoAmI,
} from '../controllers/vaultApi.controller';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  apiBalanceSchema,
  apiOrderSchema,
  apiRedeemSchema,
} from '../validators/vault.validators';

/**
 * The Vault server API, `/api/vault/v1`. Every route needs a key — `vlt_…` to
 * buy cards, `vli_…` to look one up or redeem it.
 *
 * Rate limited before the key is checked, so guessing keys is slow too.
 */
const router = Router();

router.use(rateLimit({ windowMs: 60_000, max: 600, message: 'Slow down — 600 calls a minute' }));
router.use(asyncHandler(requireVaultKey));

router.get('/me', asyncHandler(whoAmI));

/* Distributors. */
router.get('/catalogue', asyncHandler(listCatalogue));
router.get('/balance', asyncHandler(getBalance));
router.get('/orders', asyncHandler(listOrders));
router.get('/orders/:reference', asyncHandler(getOrder));
router.post('/orders', validate(apiOrderSchema), asyncHandler(createOrder));

/*
 * Issuers. Redemption is limited harder than the rest: it is the one endpoint
 * where guessing is worth something, because a correct guess is money. Six a
 * second is far above any real till and far below a useful search rate.
 */
router.post('/cards/check', validate(apiBalanceSchema), asyncHandler(checkCard));
router.post(
  '/cards/redeem',
  rateLimit({ windowMs: 60_000, max: 60, message: 'Too many redemption attempts' }),
  validate(apiRedeemSchema),
  asyncHandler(redeem),
);

export default router;
