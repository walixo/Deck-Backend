import type { Request, Response } from 'express';
import { assertCategory } from './category.controller';
import { Founder, type IFounder } from '../models/Founder';
import { IMPORT_STATUSES, ImportCandidate, type ImportStatus } from '../models/ImportCandidate';
import { Item } from '../models/Item';
import { LISTING_REQUEST_STATUSES, ListingRequest } from '../models/ListingRequest';
import { audit } from '../services/audit';
import { assertNoDuplicate, domainOf, publishCandidate } from '../services/imports';
import { toItemResponse } from '../serializers';
import { ApiError } from '../utils/ApiError';
import { isUnclaimedImport } from '../utils/itemScope';
import type {
  CandidateInput,
  ListingRequestInput,
  RejectCandidateInput,
  ResolveListingRequestInput,
  UpdateCandidateInput,
} from '../validators/import.validators';

/*
 * The import pipeline: staff queue in, published listings out, and the two
 * public doors back in — the founder page, and "this is mine / take it down".
 */

const STAFF_FIELDS = 'name username';

/* ----------------------------------------------------------- the queue --- */

export async function listCandidates(req: Request, res: Response): Promise<void> {
  const status = (req.query.status as ImportStatus | undefined) ?? 'pending';
  if (!IMPORT_STATUSES.includes(status)) throw ApiError.badRequest('Unknown status');

  const [candidates, counts] = await Promise.all([
    ImportCandidate.find({ status })
      .sort(status === 'pending' ? { createdAt: 1 } : { reviewedAt: -1 })
      .limit(100)
      .populate('addedBy', STAFF_FIELDS)
      .populate('item', 'name slug'),
    ImportCandidate.aggregate<{ _id: ImportStatus; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  res.json({
    success: true,
    data: candidates,
    meta: { counts: Object.fromEntries(counts.map((row) => [row._id, row.count])) },
  });
}

export async function createCandidate(req: Request, res: Response): Promise<void> {
  const input = req.body as CandidateInput;
  const domain = domainOf(input.websiteUrl);

  await assertCategory(input.category);
  await assertNoDuplicate(domain);

  const candidate = await ImportCandidate.create({
    ...input,
    country: input.country || undefined,
    logoUrl: input.logoUrl || undefined,
    domain,
    origin: 'manual',
    addedBy: req.user!._id,
  });

  res.status(201).json({ success: true, data: candidate });
}

/** Corrections before publishing. Published or rejected rows are history. */
export async function updateCandidate(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateCandidateInput;
  const candidate = await ImportCandidate.findById(req.params.id);
  if (!candidate) throw ApiError.notFound('We could not find that candidate');
  if (candidate.status !== 'pending') {
    throw ApiError.badRequest('Only a pending candidate can be edited');
  }

  if (input.category) await assertCategory(input.category);
  if (input.websiteUrl) {
    const domain = domainOf(input.websiteUrl);
    await assertNoDuplicate(domain, candidate._id);
    candidate.domain = domain;
  }

  Object.assign(candidate, {
    ...input,
    ...(input.country !== undefined ? { country: input.country || undefined } : {}),
    ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl || undefined } : {}),
  });
  await candidate.save();

  res.json({ success: true, data: candidate });
}

export async function publishImport(req: Request, res: Response): Promise<void> {
  const candidate = await ImportCandidate.findById(req.params.id);
  if (!candidate) throw ApiError.notFound('We could not find that candidate');

  const item = await publishCandidate(candidate, req.user!._id);

  await audit(req, {
    action: 'import.published',
    targetType: 'import',
    targetId: candidate._id,
    targetLabel: candidate.name,
    summary: `Published "${candidate.name}" as an imported listing`,
    after: { item: item.slug, founders: item.founders.length, sources: item.sourceUrls },
  });

  res.json({ success: true, data: { candidate, item: { name: item.name, slug: item.slug } } });
}

export async function rejectImport(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as RejectCandidateInput;
  const candidate = await ImportCandidate.findById(req.params.id);
  if (!candidate) throw ApiError.notFound('We could not find that candidate');
  if (candidate.status !== 'pending') {
    throw ApiError.badRequest('Only a pending candidate can be rejected');
  }

  candidate.status = 'rejected';
  candidate.rejectionReason = reason;
  candidate.reviewedBy = req.user!._id;
  candidate.reviewedAt = new Date();
  await candidate.save();

  await audit(req, {
    action: 'import.rejected',
    targetType: 'import',
    targetId: candidate._id,
    targetLabel: candidate.name,
    summary: `Rejected import "${candidate.name}": ${reason}`,
  });

  res.json({ success: true, data: candidate });
}

/**
 * Founder records matching a name, so the queue can attach a product to a
 * founder Deck already lists instead of creating a second record for them.
 */
export async function searchFounders(req: Request, res: Response): Promise<void> {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.json({ success: true, data: [] });
    return;
  }

  const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const founders = await Founder.find({ name: pattern })
    .select('name slug headline country')
    .limit(10);

  res.json({
    success: true,
    data: founders.map((founder) => ({
      id: founder._id.toString(),
      name: founder.name,
      slug: founder.slug,
      headline: founder.headline,
      country: founder.country,
    })),
  });
}

/* ------------------------------------------------------- founder pages --- */

function toFounderResponse(founder: IFounder) {
  return {
    id: founder._id.toString(),
    name: founder.name,
    slug: founder.slug,
    headline: founder.headline,
    country: founder.country,
    links: founder.links,
    sourceUrls: founder.sourceUrls,
    claimed: Boolean(founder.claimedBy),
  };
}

/**
 * A founder and the products Deck lists for them. Public.
 *
 * Shows its sources for the same reason the product page does: a page Deck
 * wrote about a real person should let anyone check where each fact came from.
 */
export async function getFounder(req: Request, res: Response): Promise<void> {
  const founder = await Founder.findOne({ slug: req.params.slug });
  if (!founder) throw ApiError.notFound('We could not find that founder');

  const items = await Item.find({ founders: founder._id }).sort({ launchDate: -1 }).limit(50);

  res.json({
    success: true,
    data: { founder: toFounderResponse(founder), items: items.map((item) => toItemResponse(item)) },
  });
}

/* ---------------------------------------------------- listing requests --- */

/**
 * "This is mine" or "take this down", from anyone, about an unclaimed import.
 *
 * Only unclaimed imports take requests: a launch a maker posted is theirs, and
 * already has the ordinary reporting routes. One open request per kind per
 * email per listing, so a refresh or a double click does not queue twice.
 */
export async function createListingRequest(req: Request, res: Response): Promise<void> {
  const input = req.body as ListingRequestInput;

  const item = await Item.findOne({ slug: req.params.slug }).select('source claimedAt name');
  if (!item) throw ApiError.notFound('We could not find that launch');
  if (!isUnclaimedImport(item)) {
    throw ApiError.badRequest('Only listings Deck made and nobody has claimed take these requests');
  }

  const open = await ListingRequest.findOne({
    item: item._id,
    kind: input.kind,
    email: input.email,
    status: 'open',
  });
  if (open) {
    res.json({ success: true, data: { id: open._id.toString(), alreadyOpen: true } });
    return;
  }

  const request = await ListingRequest.create({
    ...input,
    item: item._id,
    account: req.user?._id,
  });

  res.status(201).json({ success: true, data: { id: request._id.toString(), alreadyOpen: false } });
}

export async function listListingRequests(req: Request, res: Response): Promise<void> {
  const status = (req.query.status as string | undefined) ?? 'open';
  if (!(LISTING_REQUEST_STATUSES as readonly string[]).includes(status)) {
    throw ApiError.badRequest('Unknown status');
  }

  const requests = await ListingRequest.find({ status })
    .sort(status === 'open' ? { createdAt: 1 } : { resolvedAt: -1 })
    .limit(100)
    .populate('item', 'name slug')
    .populate('account', 'name username')
    .populate('resolvedBy', STAFF_FIELDS);

  res.json({ success: true, data: requests });
}

/**
 * Closes a request. The action itself — handing the listing over, or removing
 * it — is taken by staff with the existing tools before resolving, so this
 * records the outcome rather than performing it. Automatic claiming, by domain
 * email or a tag on the site, is the next step and will act here.
 */
export async function resolveListingRequest(req: Request, res: Response): Promise<void> {
  const { outcome, note } = req.body as ResolveListingRequestInput;
  const request = await ListingRequest.findById(req.params.id).populate('item', 'name slug');
  if (!request) throw ApiError.notFound('We could not find that request');
  if (request.status !== 'open') throw ApiError.badRequest('That request is already closed');

  request.status = outcome;
  request.resolutionNote = note;
  request.resolvedBy = req.user!._id;
  request.resolvedAt = new Date();
  await request.save();

  const item = request.item as unknown as { name?: string } | null;
  await audit(req, {
    action: outcome === 'resolved' ? 'listing.resolved' : 'listing.dismissed',
    targetType: 'listing_request',
    targetId: request._id,
    targetLabel: `${request.kind} request for ${item?.name ?? 'a removed listing'}`,
    summary: `${outcome === 'resolved' ? 'Resolved' : 'Dismissed'} a ${request.kind} request from ${request.name}${note ? `: ${note}` : ''}`,
  });

  res.json({ success: true, data: request });
}
