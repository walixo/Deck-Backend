import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { CURRENCY, MAX_CONTRIBUTION_MINOR, MIN_CONTRIBUTION_MINOR } from '../constants';
import { Contribution } from '../models/Contribution';
import { Item } from '../models/Item';
import { audit } from '../services/audit';
import { applyPlatformFee } from '../services/money';
import { initializeTransaction, paystackConfigured } from '../services/paystack';
import { toContributionResponse, toFundraiseResponse } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type {
  CreateContributionInput,
  UpdateFundraiseInput,
} from '../validators/fundraise.validators';

/** Same alphabet as order references: no 0/O/1/I, safe to read aloud. */
function contributionReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  return `BACK-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

/**
 * Opts a launch into raising money, or back out of it.
 *
 * Only the person who submitted the launch can touch this. Turning it off stops
 * new contributions but leaves the history and the running total alone — money
 * that has already been sent was sent, and hiding it would misstate the record.
 */
export async function updateFundraise(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateFundraiseInput;
  const item = await Item.findOne({ slug: req.params.slug });
  if (!item) throw ApiError.notFound('We could not find that launch');

  const user = req.user!;
  if (item.submittedBy.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.forbidden('That launch belongs to someone else');
  }

  const before = {
    enabled: item.fundraise.enabled,
    targetMinor: item.fundraise.targetMinor,
    closed: Boolean(item.fundraise.closedAt),
  };

  item.fundraise.enabled = input.enabled;
  if (input.target !== undefined) item.fundraise.targetMinor = Math.round(input.target * 100);
  if (input.pitch !== undefined) item.fundraise.pitch = input.pitch || undefined;
  if (input.closed !== undefined) item.fundraise.closedAt = input.closed ? new Date() : null;

  await item.save();

  /* A launcher configuring their own raise is ordinary. Staff reaching into
     somebody else's money-collection settings is not. */
  if (user.role === 'admin' && item.submittedBy.toString() !== user._id.toString()) {
    await audit(req, {
      action: 'fundraise.changed',
      targetType: 'item',
      targetId: item._id,
      targetLabel: item.name,
      summary: `Changed the fundraise on "${item.name}", a launch belonging to someone else`,
      before,
      after: {
        enabled: item.fundraise.enabled,
        targetMinor: item.fundraise.targetMinor,
        closed: Boolean(item.fundraise.closedAt),
      },
    });
  }

  res.json({ success: true, data: toFundraiseResponse(item) });
}

/**
 * Backs a launch.
 *
 * The amount is priced here and the split is computed here — the client sends a
 * figure, but what the launcher receives is derived from it server-side, so a
 * tampered payload can change how much someone gives and nothing else.
 *
 * The contribution is written `pending` and only counts once Paystack confirms
 * the charge. Nothing is added to the running total on the strength of the
 * browser coming back from checkout.
 */
export async function createContribution(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateContributionInput;
  const user = req.user!;

  const item = await Item.findOne({ slug: req.params.slug });
  if (!item) throw ApiError.notFound('We could not find that launch');

  if (!item.fundraise.enabled) {
    throw ApiError.badRequest('This launch is not raising money');
  }
  if (item.fundraise.closedAt) {
    throw ApiError.badRequest('This raise has closed');
  }
  if (item.submittedBy.toString() === user._id.toString()) {
    throw ApiError.badRequest('You cannot contribute to your own launch');
  }

  const amountMinor = Math.round(input.amount * 100);
  if (amountMinor < MIN_CONTRIBUTION_MINOR || amountMinor > MAX_CONTRIBUTION_MINOR) {
    throw ApiError.badRequest('That amount is outside what we can take');
  }

  if (!paystackConfigured()) {
    throw ApiError.badRequest('Card payments are not configured on this server');
  }

  const { feeMinor, netMinor } = applyPlatformFee(amountMinor);
  const reference = contributionReference();

  const contribution = await Contribution.create({
    reference,
    item: item._id,
    beneficiary: item.submittedBy,
    contributor: user._id,
    email: user.email,
    amountMinor,
    platformFeeMinor: feeMinor,
    netMinor,
    currency: CURRENCY,
    status: 'pending',
    message: input.message || undefined,
    anonymous: input.anonymous,
  });

  try {
    const transaction = await initializeTransaction({
      email: user.email,
      amountMinor,
      reference,
      currency: CURRENCY,
      callbackUrl: `${env.paystackCallbackUrl}?reference=${reference}`,
      metadata: { contributionId: contribution.id, itemSlug: item.slug, kind: 'contribution' },
    });

    contribution.authorizationUrl = transaction.authorizationUrl;
    await contribution.save();

    res.status(201).json({
      success: true,
      data: {
        ...toContributionResponse(contribution),
        authorizationUrl: transaction.authorizationUrl,
      },
    });
  } catch (error) {
    /* No redirect means the row can never be paid — leaving it would litter the
       supporter's history with a contribution they were never able to make. */
    await Contribution.deleteOne({ _id: contribution._id });
    throw error;
  }
}

/** Recent supporters, with anonymous ones kept anonymous. */
export async function listContributions(req: Request, res: Response): Promise<void> {
  const item = await Item.findOne({ slug: req.params.slug }).select('_id fundraise');
  if (!item) throw ApiError.notFound('We could not find that launch');

  const contributions = await Contribution.find({ item: item._id, status: 'paid' })
    .populate('contributor', 'username name avatarUrl')
    .sort({ createdAt: -1 })
    .limit(20);

  res.json({
    success: true,
    data: contributions.map(toContributionResponse),
    meta: toFundraiseResponse(item),
  });
}
