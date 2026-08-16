import type mongoose from 'mongoose';
import type { IAdCampaign } from '../models/AdCampaign';
import type { IComment } from '../models/Comment';
import type { IContribution } from '../models/Contribution';
import type { IItem } from '../models/Item';
import type { IMerchProduct } from '../models/MerchProduct';
import type { IOrder } from '../models/Order';
import type { IPayout } from '../models/Payout';
import type { IUser } from '../models/User';

export interface PublicUser {
  id: string;
  name: string;
  username: string;
  avatarUrl?: string;
  headline?: string;
  bio?: string;
  websiteUrl?: string;
  createdAt?: Date;
}

export interface AuthenticatedUser extends PublicUser {
  email: string;
  role: string;
}

function isPopulatedUser(value: unknown): value is IUser {
  return typeof value === 'object' && value !== null && 'username' in value;
}

/** The subset of a launch an ad needs: enough to draw and link it. */
interface PopulatedItemRef {
  name: string;
  slug: string;
  logoUrl?: string;
}

function isPopulatedItem(value: unknown): value is PopulatedItemRef {
  return typeof value === 'object' && value !== null && 'slug' in value && 'name' in value;
}

export function toPublicUser(user: IUser): PublicUser {
  return {
    id: user._id.toString(),
    name: user.name,
    username: user.username,
    avatarUrl: user.avatarUrl,
    headline: user.headline,
    bio: user.bio,
    websiteUrl: user.websiteUrl,
    createdAt: user.createdAt,
  };
}

export function toAuthenticatedUser(user: IUser): AuthenticatedUser {
  return { ...toPublicUser(user), email: user.email, role: user.role };
}

export function toItemResponse(item: IItem, votedItemIds?: Set<string>) {
  const submitter = item.submittedBy as unknown;

  return {
    id: item._id.toString(),
    name: item.name,
    slug: item.slug,
    tagline: item.tagline,
    description: item.description,
    category: item.category,
    tags: item.tags,
    pricing: item.pricing,
    websiteUrl: item.websiteUrl,
    repoUrl: item.repoUrl,
    logoUrl: item.logoUrl,
    coverUrl: item.coverUrl,
    gallery: item.gallery,
    makers: item.makers,
    launchDate: item.launchDate,
    launchDateKey: item.launchDateKey,
    featured: item.featured,
    voteCount: item.voteCount,
    commentCount: item.commentCount,
    reviewCount: item.reviewCount,
    ratingAvg: Math.round(item.ratingAvg * 10) / 10,
    fundraise: toFundraiseResponse(item),
    createdAt: item.createdAt,
    hasVoted: votedItemIds ? votedItemIds.has(item._id.toString()) : false,
    submittedBy: isPopulatedUser(submitter)
      ? toPublicUser(submitter)
      : { id: String(submitter as mongoose.Types.ObjectId) },
  };
}

export function toCommentResponse(comment: IComment) {
  const author = comment.user as unknown;

  return {
    id: comment._id.toString(),
    body: comment.body,
    rating: comment.rating,
    parent: comment.parent ? comment.parent.toString() : null,
    createdAt: comment.createdAt,
    user: isPopulatedUser(author)
      ? toPublicUser(author)
      : { id: String(author as mongoose.Types.ObjectId) },
  };
}

/* ---------------------------------------------------------------- merch --- */

/**
 * Prices cross the wire as integer minor units plus a currency code. The client
 * formats them for display; it never does arithmetic that could reintroduce
 * float error.
 */
export function toMerchResponse(product: IMerchProduct) {
  const inStock = product.variants.reduce((total, variant) => total + variant.stock, 0);

  return {
    id: product._id.toString(),
    name: product.name,
    slug: product.slug,
    tagline: product.tagline,
    description: product.description,
    category: product.category,
    priceMinor: product.priceMinor,
    currency: product.currency,
    images: product.images,
    variants: product.variants.map((variant) => ({
      sku: variant.sku,
      size: variant.size,
      colour: variant.colour,
      stock: variant.stock,
      inStock: variant.stock > 0,
    })),
    featured: product.featured,
    active: product.active,
    status: product.status,
    rejectionReason: product.rejectionReason,
    /* Null for Deck's own catalogue; the maker's public profile otherwise. */
    seller: isPopulatedUser(product.seller) ? toPublicUser(product.seller) : null,
    sellerId: product.seller ? product.seller.toString() : null,
    totalStock: inStock,
    soldOut: inStock === 0,
    createdAt: product.createdAt,
  };
}

export function toOrderResponse(order: IOrder) {
  return {
    id: order._id.toString(),
    reference: order.reference,
    email: order.email,
    status: order.status,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    shippingMinor: order.shippingMinor,
    totalMinor: order.totalMinor,
    shippingAddress: order.shippingAddress,
    lines: order.lines.map((line) => ({
      sku: line.sku,
      name: line.name,
      size: line.size,
      colour: line.colour,
      unitPriceMinor: line.unitPriceMinor,
      quantity: line.quantity,
      image: line.image,
      sellerId: line.seller ? line.seller.toString() : null,
    })),
    createdAt: order.createdAt,
  };
}

/** One disbursement Deck has sent a seller. */
export function toPayoutResponse(payout: IPayout) {
  return {
    id: payout._id.toString(),
    reference: payout.reference,
    amountMinor: payout.amountMinor,
    currency: payout.currency,
    destination: payout.destination,
    note: payout.note,
    paidAt: payout.paidAt,
  };
}

/** The public state of a launch's raise — what the progress bar reads. */
export function toFundraiseResponse(item: Pick<IItem, 'fundraise'>) {
  const { enabled, targetMinor, raisedMinor, contributorCount, pitch, closedAt } = item.fundraise;

  return {
    enabled,
    targetMinor,
    raisedMinor,
    contributorCount,
    pitch,
    closed: Boolean(closedAt),
    /* Capped at 100 so an over-funded raise does not overflow its own bar; the
       raw figures are right there if the UI wants to say "312% funded". */
    percent: targetMinor > 0 ? Math.min(100, Math.round((raisedMinor / targetMinor) * 100)) : 0,
    /* Accepting money needs the raise on, not closed, and a target to aim at. */
    open: enabled && !closedAt && targetMinor > 0,
  };
}

export function toContributionResponse(contribution: IContribution) {
  const supporter =
    !contribution.anonymous && isPopulatedUser(contribution.contributor)
      ? toPublicUser(contribution.contributor)
      : null;

  return {
    id: contribution._id.toString(),
    reference: contribution.reference,
    amountMinor: contribution.amountMinor,
    currency: contribution.currency,
    status: contribution.status,
    message: contribution.message,
    anonymous: contribution.anonymous,
    /* Null either because they asked to be anonymous or because the caller did
       not populate the join — both mean "do not show a name". */
    supporter,
    createdAt: contribution.createdAt,
  };
}

/* ------------------------------------------------------------------ ads --- */

function adWindow(campaign: IAdCampaign) {
  const now = Date.now();
  if (campaign.status !== 'live') return campaign.status;
  if (campaign.startAt.getTime() > now) return 'scheduled';
  if (campaign.endAt.getTime() <= now) return 'finished';
  return 'running';
}

/**
 * A campaign as its advertiser and Deck staff see it.
 *
 * `phase` is derived, not stored: scheduled, running and finished are only the
 * window compared against now, and persisting them would need a job to keep
 * them true.
 */
export function toAdCampaignResponse(campaign: IAdCampaign) {
  const item = campaign.item as unknown;

  return {
    id: campaign._id.toString(),
    reference: campaign.reference,
    placement: campaign.placement,
    headline: campaign.headline,
    body: campaign.body,
    imageUrl: campaign.imageUrl,
    ctaLabel: campaign.ctaLabel,
    days: campaign.days,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    priceMinor: campaign.priceMinor,
    currency: campaign.currency,
    status: campaign.status,
    phase: adWindow(campaign),
    rejectionReason: campaign.rejectionReason,
    impressions: campaign.impressions,
    clicks: campaign.clicks,
    /* Divide-by-zero guarded: a campaign that has never served has no rate. */
    clickRate: campaign.impressions > 0 ? campaign.clicks / campaign.impressions : 0,
    item: isPopulatedItem(item)
      ? { name: item.name, slug: item.slug, logoUrl: item.logoUrl }
      : null,
    advertiser: isPopulatedUser(campaign.advertiser) ? toPublicUser(campaign.advertiser) : null,
    createdAt: campaign.createdAt,
  };
}

/**
 * What the public slot gets.
 *
 * Deliberately thin: the creative, a reference to click through, and nothing
 * about who bought it, what they paid, or how it is performing. A served ad is
 * read by every visitor, so it carries only what is needed to draw it.
 */
export function toServedAdResponse(campaign: IAdCampaign) {
  const item = campaign.item as unknown;

  return {
    reference: campaign.reference,
    headline: campaign.headline,
    body: campaign.body,
    imageUrl: campaign.imageUrl,
    ctaLabel: campaign.ctaLabel,
    item: isPopulatedItem(item)
      ? { name: item.name, slug: item.slug, logoUrl: item.logoUrl }
      : null,
  };
}
