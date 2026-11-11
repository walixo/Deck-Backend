import { Router } from 'express';
import {
  consoleRedeem,
  createIssuer,
  createPartner,
  createProduct,
  getFulfilSecret,
  getIssuerSummary,
  getMyIssuer,
  getMyPartner,
  getWebhookSecret,
  listIssuerOrders,
  listIssuerRedemptions,
  listLedger,
  listMyCards,
  listMyProducts,
  mintIssuerKey,
  mintPartnerKey,
  pauseProduct,
  revealMyCard,
  submitIssuer,
  topUp,
  updateIssuer,
  updatePartner,
  updateProduct,
} from '../controllers/vault.controller';
import { browse, buy, getMyOrder, getStorefront, getVaultStats } from '../controllers/vaultStore.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  buyCardSchema,
  consoleRedeemSchema,
  createIssuerSchema,
  createPartnerSchema,
  createProductSchema,
  mintKeySchema,
  topupSchema,
  updateIssuerSchema,
  updatePartnerSchema,
} from '../validators/vault.validators';

/**
 * Vault's own routes, `/api/vault` — the shop and the two dashboards.
 *
 * The server API is mounted separately at `/api/vault/v1` and ahead of this
 * one, so a key-authenticated call can never fall through to a route that
 * expects a session.
 */
const router = Router();

/* ------------------------------------------------------------------ public */

router.get('/stats', asyncHandler(getVaultStats));
router.get('/shop', asyncHandler(browse));
router.get('/shop/:slug', asyncHandler(optionalAuth), asyncHandler(getStorefront));
router.post(
  '/shop/:slug/buy',
  asyncHandler(requireAuth),
  rateLimit({ windowMs: 60_000, max: 20, message: 'Too many purchases started' }),
  validate(buyCardSchema),
  asyncHandler(buy),
);
router.get('/orders/:reference', asyncHandler(requireAuth), asyncHandler(getMyOrder));

/* The buyer's own cards. */
router.get('/cards', asyncHandler(requireAuth), asyncHandler(listMyCards));
router.get('/cards/:id/reveal', asyncHandler(requireAuth), asyncHandler(revealMyCard));

/* ------------------------------------------------------------------ issuer */

router.get('/issuer', asyncHandler(requireAuth), asyncHandler(getMyIssuer));
router.post('/issuer', asyncHandler(requireAuth), validate(createIssuerSchema), asyncHandler(createIssuer));
router.patch('/issuer', asyncHandler(requireAuth), validate(updateIssuerSchema), asyncHandler(updateIssuer));
router.post('/issuer/submit', asyncHandler(requireAuth), asyncHandler(submitIssuer));
router.post('/issuer/keys', asyncHandler(requireAuth), validate(mintKeySchema), asyncHandler(mintIssuerKey));
router.get('/issuer/fulfil-secret', asyncHandler(requireAuth), asyncHandler(getFulfilSecret));
router.post('/issuer/fulfil-secret', asyncHandler(requireAuth), asyncHandler(getFulfilSecret));

router.get('/issuer/products', asyncHandler(requireAuth), asyncHandler(listMyProducts));
router.post('/issuer/products', asyncHandler(requireAuth), validate(createProductSchema), asyncHandler(createProduct));
router.put('/issuer/products/:id', asyncHandler(requireAuth), validate(createProductSchema), asyncHandler(updateProduct));
router.post('/issuer/products/:id/pause', asyncHandler(requireAuth), asyncHandler(pauseProduct));

router.get('/issuer/summary', asyncHandler(requireAuth), asyncHandler(getIssuerSummary));
router.get('/issuer/orders', asyncHandler(requireAuth), asyncHandler(listIssuerOrders));
router.get('/issuer/redemptions', asyncHandler(requireAuth), asyncHandler(listIssuerRedemptions));
router.post(
  '/issuer/redeem',
  asyncHandler(requireAuth),
  rateLimit({ windowMs: 60_000, max: 60, message: 'Too many redemption attempts' }),
  validate(consoleRedeemSchema),
  asyncHandler(consoleRedeem),
);

/* ----------------------------------------------------------------- partner */

router.get('/partner', asyncHandler(requireAuth), asyncHandler(getMyPartner));
router.post('/partner', asyncHandler(requireAuth), validate(createPartnerSchema), asyncHandler(createPartner));
router.patch('/partner', asyncHandler(requireAuth), validate(updatePartnerSchema), asyncHandler(updatePartner));
router.post('/partner/keys', asyncHandler(requireAuth), validate(mintKeySchema), asyncHandler(mintPartnerKey));
router.get('/partner/webhook-secret', asyncHandler(requireAuth), asyncHandler(getWebhookSecret));
router.post('/partner/webhook-secret', asyncHandler(requireAuth), asyncHandler(getWebhookSecret));
router.get('/partner/ledger', asyncHandler(requireAuth), asyncHandler(listLedger));
router.post('/partner/topup', asyncHandler(requireAuth), validate(topupSchema), asyncHandler(topUp));

export default router;
