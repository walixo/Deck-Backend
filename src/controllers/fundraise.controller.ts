import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import {
  CURRENCY,
  FUNDRAISE_MIN_COMMENTS,
  FUNDRAISE_MIN_VOTES,
  MAX_CONTRIBUTION_MINOR,
  MIN_CONTRIBUTION_MINOR,
} from '../constants';
import { Contribution } from '../models/Contribution';
import { Item, type IItem } from '../models/Item';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { applyPlatformFee } from '../services/money';
import { initializeTransaction, paystackConfigured } from '../services/paystack';
import { toContributionResponse, toFundraiseResponse, toPublicUser } from '../serializers';
import { ApiError } from '../utils/ApiError';
import type {
  ApplyFundraiseInput,
  CreateContributionInput,
  ReviewFundraiseInput,
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

/**
 * Applies to run a fundraise on a launch.
 *
 * Replaces the checkbox that used to let any maker start collecting money from
 * strangers on Deck's rails unreviewed. Applying is all a maker can do; only an
 * approval turns the raise on.
 *
 * Re-applying after a rejection is allowed — the usual outcome of a rejection is
 * "tell us more", and forcing a new launch to fix a thin answer would be absurd.
 * Re-applying while pending is not, so the queue cannot be flooded.
 */
export async function applyForFundraise(req: Request, res: Response): Promise<void> {
  const input = req.body as ApplyFundraiseInput;

  const item = await Item.findOne({ slug: req.params.slug });
  if (!item) throw ApiError.notFound('We could not find that launch');

  const user = req.user!;
  if (item.submittedBy.toString() !== user._id.toString()) {
    throw ApiError.forbidden('Only the person who launched this can apply');
  }

  if (item.fundraise.status === 'pending') {
    throw ApiError.badRequest('That application is already with us — we will come back to you');
  }
  if (item.fundraise.status === 'approved') {
    throw ApiError.badRequest('This launch already has an approved fundraise');
  }

  /*
   * The traction gate, checked here and not only in the UI.
   *
   * The button is hidden until this passes, which handles the honest case. This
   * handles the other one: the endpoint is a plain POST and hiding a button
   * does not stop anybody from calling it. The message names both numbers and
   * where the launch stands on each, because "not eligible" with no figures is
   * the kind of refusal that generates a support message.
   */
  const shortVotes = Math.max(0, FUNDRAISE_MIN_VOTES - item.voteCount);
  const shortComments = Math.max(0, FUNDRAISE_MIN_COMMENTS - item.commentCount);
  if (shortVotes > 0 || shortComments > 0) {
    const missing = [
      shortVotes > 0 ? `${shortVotes} more ${shortVotes === 1 ? 'vote' : 'votes'}` : null,
      shortComments > 0
        ? `${shortComments} more ${shortComments === 1 ? 'comment' : 'comments'}`
        : null,
    ].filter(Boolean);

    throw ApiError.badRequest(
      `A launch needs ${FUNDRAISE_MIN_VOTES} votes and ${FUNDRAISE_MIN_COMMENTS} comments before it can raise. ` +
        `${item.name} needs ${missing.join(' and ')}.`,
    );
  }

  item.fundraise.status = 'pending';
  item.fundraise.application = {
    purpose: input.purpose,
    useOfFunds: input.useOfFunds,
    timeline: input.timeline,
    contact: input.contact,
  };
  item.fundraise.targetMinor = Math.round(input.target * 100);
  item.fundraise.appliedAt = new Date();
  /* Cleared so a re-application does not show the previous verdict beside it. */
  item.fundraise.reviewedAt = null;
  item.fundraise.reviewedBy = null;
  item.fundraise.reviewNote = undefined;

  await item.save();

  res.status(201).json({ success: true, data: toFundraiseResponse(item) });
}

/**
 * The staff decision on an application. Approval is what turns a raise on.
 *
 * Always audited, in both directions: this is the gate on somebody being able
 * to collect money through Deck, which is the most consequential yes/no in the
 * admin area.
 */
export async function reviewFundraise(req: Request, res: Response): Promise<void> {
  const { approve, note } = req.body as ReviewFundraiseInput;

  const item = await Item.findOne({ slug: req.params.slug });
  if (!item) throw ApiError.notFound('We could not find that launch');

  if (item.fundraise.status !== 'pending') {
    throw ApiError.badRequest('There is no application waiting on that launch');
  }

  item.fundraise.status = approve ? 'approved' : 'rejected';
  item.fundraise.enabled = approve;
  item.fundraise.reviewedAt = new Date();
  item.fundraise.reviewedBy = req.user!._id;
  item.fundraise.reviewNote = note?.trim() || undefined;

  await item.save();

  await audit(req, {
    action: approve ? 'fundraise.approved' : 'fundraise.rejected',
    targetType: 'item',
    targetId: item._id,
    targetLabel: item.name,
    summary: approve
      ? `Approved the fundraise on "${item.name}"`
      : `Turned down the fundraise on "${item.name}" — ${note}`,
    after: { status: item.fundraise.status, targetMinor: item.fundraise.targetMinor, note },
  });

  /* Both outcomes. A rejection the applicant is never told about is just an
     application that vanished, and the note is the whole point of writing one. */
  void notify({
    user: item.submittedBy,
    kind: 'fundraise.reviewed',
    title: approve
      ? `Your fundraise on ${item.name} was approved`
      : `Your fundraise on ${item.name} was not approved`,
    body: approve
      ? 'It can start taking contributions now.'
      : note?.trim() || 'Staff reviewed the application and could not approve it this time.',
    link: `/item/${item.slug}`,
  });

  res.json({ success: true, data: toFundraiseResponse(item) });
}

const REVIEW_FIELDS = 'name username avatarUrl headline verified';

/** Shared shape for both halves of the review page. */
function toApplicationRow(item: IItem) {
  return {
    slug: item.slug,
    name: item.name,
    logoUrl: item.logoUrl,
    status: item.fundraise.status,
    appliedAt: item.fundraise.appliedAt,
    reviewedAt: item.fundraise.reviewedAt,
    targetMinor: item.fundraise.targetMinor,
    raisedMinor: item.fundraise.raisedMinor,
    contributorCount: item.fundraise.contributorCount,
    /* Whether money is actually being taken right now. Approval alone is not
       enough — the maker can pause a raise, and a paused one should not sit in
       the "active" column looking like it is collecting. */
    live: item.fundraise.enabled && !item.fundraise.closedAt,
    percent:
      item.fundraise.targetMinor > 0
        ? Math.min(100, Math.round((item.fundraise.raisedMinor / item.fundraise.targetMinor) * 100))
        : 0,
    application: item.fundraise.application,
    submittedBy: toPublicUser(item.submittedBy as never),
  };
}

/**
 * Everything on this page in one request: the queue and the book.
 *
 * Two lists rather than two endpoints, because they are read together — the
 * question "should I approve this" is much easier to answer next to how the
 * already-approved ones are doing. Pending is oldest-first, because it is a
 * queue; approved is by amount raised, because it is a ledger.
 */
export async function listFundraiseApplications(_req: Request, res: Response): Promise<void> {
  const [pending, approved] = await Promise.all([
    Item.find({ 'fundraise.status': 'pending' })
      .sort({ 'fundraise.appliedAt': 1 })
      .populate('submittedBy', REVIEW_FIELDS),
    Item.find({ 'fundraise.status': 'approved' })
      .sort({ 'fundraise.raisedMinor': -1 })
      .populate('submittedBy', REVIEW_FIELDS),
  ]);

  const rows = approved.map(toApplicationRow);

  res.json({
    success: true,
    data: {
      pending: pending.map(toApplicationRow),
      approved: rows,
      totals: {
        /* Across every approved raise. Derived here rather than stored — the
           same reasoning as the seller ledger. */
        raisedMinor: rows.reduce((sum, row) => sum + row.raisedMinor, 0),
        targetMinor: rows.reduce((sum, row) => sum + row.targetMinor, 0),
        backers: rows.reduce((sum, row) => sum + row.contributorCount, 0),
        live: rows.filter((row) => row.live).length,
      },
    },
  });
}
