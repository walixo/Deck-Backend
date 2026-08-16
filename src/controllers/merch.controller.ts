import type { Request, Response } from 'express';
import type { FilterQuery } from 'mongoose';
import { MerchProduct, type IMerchProduct } from '../models/MerchProduct';
import { audit } from '../services/audit';
import { toMerchResponse } from '../serializers';
import { ApiError } from '../utils/ApiError';
import { uniqueSlug } from '../utils/slug';
import type {
  CreateMerchInput,
  ListMerchQuery,
  RejectMerchInput,
  UpdateMerchInput,
} from '../validators/merch.validators';

/** Whole currency units in, integer minor units out. */
function toMinor(price: number): number {
  return Math.round(price * 100);
}

/**
 * The one definition of "buyable".
 *
 * Two separate switches have to agree: Deck approved it, and the seller has it
 * switched on. Every public read goes through this so a listing can never
 * appear in one place while being hidden in another.
 */
const PUBLIC: FilterQuery<IMerchProduct> = { status: 'approved', active: true };

function buildFilter(query: ListMerchQuery): FilterQuery<IMerchProduct> {
  const filter: FilterQuery<IMerchProduct> = { ...PUBLIC };

  if (query.category) filter.category = query.category;
  if (query.seller) filter.seller = query.seller;
  /* `source` lets the shop separate Deck's own goods from the community's. */
  if (query.source === 'deck') filter.seller = null;
  if (query.source === 'makers') filter.seller = { $ne: null };

  if (query.search) {
    const pattern = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: pattern }, { tagline: pattern }, { description: pattern }];
  }

  return filter;
}

const SORTS: Record<ListMerchQuery['sort'], Record<string, 1 | -1>> = {
  featured: { featured: -1, createdAt: -1 },
  newest: { createdAt: -1 },
  'price-low': { priceMinor: 1 },
  'price-high': { priceMinor: -1 },
};

export async function listMerch(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListMerchQuery;
  const filter = buildFilter(query);
  const skip = (query.page - 1) * query.limit;

  const [total, products] = await Promise.all([
    MerchProduct.countDocuments(filter),
    MerchProduct.find(filter)
      .populate('seller', 'username name avatarUrl')
      .sort(SORTS[query.sort])
      .skip(skip)
      .limit(query.limit),
  ]);

  res.json({
    success: true,
    data: products.map(toMerchResponse),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + products.length < total,
    },
  });
}

export async function getMerchProduct(req: Request, res: Response): Promise<void> {
  const product = await MerchProduct.findOne({ slug: req.params.slug, ...PUBLIC }).populate(
    'seller',
    'username name avatarUrl',
  );
  if (!product) throw ApiError.notFound('We could not find that product');

  /* Related picks stay within the same seller's shelf when there is one — a
     maker's page should read as their stall, not a jump into Deck's catalogue. */
  const related = await MerchProduct.find({
    _id: { $ne: product._id },
    ...PUBLIC,
    ...(product.seller ? { seller: product.seller } : { category: product.category }),
  })
    .populate('seller', 'username name avatarUrl')
    .sort({ featured: -1, createdAt: -1 })
    .limit(3);

  res.json({
    success: true,
    data: { ...toMerchResponse(product), related: related.map(toMerchResponse) },
  });
}

/** Categories with live counts, for the shop's filter row. */
export async function getMerchCategories(_req: Request, res: Response): Promise<void> {
  const rows = await MerchProduct.aggregate<{ _id: string; count: number }>([
    { $match: PUBLIC },
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);

  res.json({ success: true, data: rows.map((row) => ({ slug: row._id, count: row.count })) });
}

/**
 * Lists a product.
 *
 * Anyone signed in can sell. Deck collects the money and disburses it later, so
 * there is nothing a seller has to set up first — the review queue, not a bank
 * form, is what stands between a new listing and the shop.
 *
 * Staff create straight into the catalogue; everyone else joins the queue.
 */
export async function createMerchProduct(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateMerchInput;
  const user = req.user!;
  const isStaff = user.role === 'admin';

  const duplicate = await MerchProduct.findOne({
    'variants.sku': { $in: input.variants.map((v) => v.sku) },
  });
  if (duplicate) throw ApiError.conflict('One of those SKUs is already in use');

  const slug = await uniqueSlug(input.name, async (candidate) => {
    const exists = await MerchProduct.exists({ slug: candidate });
    return exists !== null;
  });

  const { price, ...rest } = input;
  const product = await MerchProduct.create({
    ...rest,
    slug,
    priceMinor: toMinor(price),
    seller: isStaff ? null : user._id,
    status: isStaff ? 'approved' : 'pending',
    // Only staff can promote a listing to the top of the shop.
    featured: isStaff ? input.featured : false,
  });

  res.status(201).json({ success: true, data: toMerchResponse(product) });
}

/** Loads a product the caller is allowed to change, or refuses. */
async function loadOwned(req: Request): Promise<IMerchProduct> {
  const product = await MerchProduct.findById(req.params.id);
  if (!product) throw ApiError.notFound('We could not find that product');

  const user = req.user!;
  const isOwner = product.seller?.toString() === user._id.toString();
  if (!isOwner && user.role !== 'admin') {
    throw ApiError.forbidden('That listing belongs to someone else');
  }

  return product;
}

export async function updateMerchProduct(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateMerchInput;
  const product = await loadOwned(req);
  const isStaff = req.user!.role === 'admin';

  const { price, featured, ...rest } = input;
  Object.assign(product, rest);
  if (price !== undefined) product.priceMinor = toMinor(price);
  if (featured !== undefined && isStaff) product.featured = featured;

  /*
   * A seller editing an approved listing sends it back for review. Otherwise
   * approval would be a one-time gate: get a plain tote through, then rewrite
   * it into whatever you liked.
   */
  if (!isStaff && product.seller && product.status === 'approved') {
    product.status = 'pending';
  }

  await product.save();

  /* Only staff acting on someone else's listing is worth a line. A seller
     editing their own shelf is ordinary work, and logging it would bury the
     entries that matter under noise. */
  if (isStaff && product.seller && product.seller.toString() !== req.user!._id.toString()) {
    await audit(req, {
      action: 'merch.edited',
      targetType: 'merch',
      targetId: product._id,
      targetLabel: product.name,
      summary: `Edited "${product.name}", a listing belonging to someone else`,
      after: { fields: Object.keys(rest) },
    });
  }

  res.json({ success: true, data: toMerchResponse(product) });
}

export async function deleteMerchProduct(req: Request, res: Response): Promise<void> {
  const product = await loadOwned(req);

  // Soft delete — hard-deleting would break the order history that references it.
  product.active = false;
  await product.save();

  if (req.user!.role === 'admin' && product.seller?.toString() !== req.user!._id.toString()) {
    await audit(req, {
      action: 'merch.retired',
      targetType: 'merch',
      targetId: product._id,
      targetLabel: product.name,
      summary: `Retired "${product.name}" from the shop`,
      before: { active: true },
      after: { active: false },
    });
  }

  res.json({ success: true, data: { id: product._id.toString(), active: false } });
}

/** The seller's own shelf, in every state including rejected. */
export async function listMyMerch(req: Request, res: Response): Promise<void> {
  const products = await MerchProduct.find({ seller: req.user!._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: products.map(toMerchResponse) });
}

/** The review queue. Staff only. */
export async function listPendingMerch(_req: Request, res: Response): Promise<void> {
  const products = await MerchProduct.find({ status: 'pending', seller: { $ne: null } })
    .populate('seller', 'username name avatarUrl')
    .sort({ createdAt: 1 });

  res.json({ success: true, data: products.map(toMerchResponse) });
}

export async function reviewMerchProduct(req: Request, res: Response): Promise<void> {
  const product = await MerchProduct.findById(req.params.id);
  if (!product) throw ApiError.notFound('We could not find that product');

  const approving = req.path.endsWith('/approve');
  const { reason } = (req.body ?? {}) as RejectMerchInput;

  const previous = product.status;
  product.status = approving ? 'approved' : 'rejected';
  product.rejectionReason = approving ? undefined : reason;
  product.reviewedAt = new Date();
  await product.save();

  await audit(req, {
    action: approving ? 'merch.approved' : 'merch.rejected',
    targetType: 'merch',
    targetId: product._id,
    targetLabel: product.name,
    summary: approving
      ? `Approved "${product.name}" for the shop`
      : `Rejected "${product.name}": ${reason}`,
    before: { status: previous },
    after: { status: product.status, rejectionReason: product.rejectionReason },
  });

  res.json({ success: true, data: toMerchResponse(product) });
}
