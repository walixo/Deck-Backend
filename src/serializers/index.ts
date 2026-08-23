import type mongoose from 'mongoose';
import { env } from '../config/env';
import { FUNDRAISE_MIN_COMMENTS, FUNDRAISE_MIN_VOTES } from '../constants';
import type { IAdCampaign } from '../models/AdCampaign';
import type { IComment } from '../models/Comment';
import type { IContribution } from '../models/Contribution';
import type { IItem } from '../models/Item';
import type { IItemRevision } from '../models/ItemRevision';
import type { IMerchProduct } from '../models/MerchProduct';
import type { IOrder } from '../models/Order';
import type { IPayout } from '../models/Payout';
import type { IPost } from '../models/Post';
import type { IReply, ITopic } from '../models/Topic';
import type { IUser } from '../models/User';

export interface PublicUser {
  id: string;
  /** Shown as a mark beside the name wherever the account appears. */
  verified: boolean;
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
    verified: Boolean(user.verified),
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
    wallColour: item.wallColour,
    videoUrl: item.videoUrl,
    gallery: item.gallery,
    makers: item.makers,
    launchDate: item.launchDate,
    launchDateKey: item.launchDateKey,
    featured: item.featured,
    futureGen: item.futureGen,
    voteCount: item.voteCount,
    commentCount: item.commentCount,
    reviewCount: item.reviewCount,
    /* Edits since posting. The item page uses it to decide whether a history
       is worth offering, without paying for the history to find out. */
    editCount: item.editCount ?? 0,
    /* When the owner's edit window shuts. Sent so the UI can show a countdown
       and hide the edit button rather than offering an action the server will
       refuse. Staff ignore it. */
    editableUntil: new Date(
      item.launchDate.getTime() + env.editWindowHours * 60 * 60 * 1000,
    ).toISOString(),
    /* Version identity. `versions` on the detail payload carries the siblings. */
    version: item.version,
    lineage: item.lineage ? item.lineage.toString() : item._id.toString(),
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

/**
 * One entry in a launch's edit history.
 *
 * The whole snapshot goes over the wire, not just the changed fields: the
 * client renders diffs by comparing a revision with the one below it, so it
 * needs both sides. `editedByName` is sent alongside the populated user because
 * it is the name as it was at the time — the populated record shows who they
 * are now, which is a different and sometimes contradictory fact.
 */
export function toRevisionResponse(revision: IItemRevision) {
  const editor = revision.editedBy as unknown;

  return {
    id: revision._id.toString(),
    version: revision.version,
    snapshot: revision.snapshot,
    changed: revision.changed,
    note: revision.note,
    role: revision.editedByRole,
    editedByName: revision.editedByName,
    editedBy: isPopulatedUser(editor)
      ? toPublicUser(editor)
      : { id: String(editor as mongoose.Types.ObjectId) },
    createdAt: revision.createdAt,
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
export function toFundraiseResponse(item: Pick<IItem, 'fundraise' | 'voteCount' | 'commentCount'>) {
  const { status, enabled, targetMinor, raisedMinor, contributorCount, pitch, closedAt } =
    item.fundraise;

  return {
    /*
     * How close this launch is to being allowed to ask.
     *
     * Computed here rather than left to the client to work out from voteCount
     * and commentCount, because the thresholds are the server's rule and a
     * client that guesses them will eventually guess wrong — and the way it
     * goes wrong is showing somebody an enabled button that the API then
     * refuses. Sent to everyone, not just the owner: the numbers are already
     * public, and a reader seeing "3 votes to go" is a reason to vote.
     */
    eligibility: {
      votes: item.voteCount,
      votesNeeded: FUNDRAISE_MIN_VOTES,
      comments: item.commentCount,
      commentsNeeded: FUNDRAISE_MIN_COMMENTS,
      met:
        item.voteCount >= FUNDRAISE_MIN_VOTES && item.commentCount >= FUNDRAISE_MIN_COMMENTS,
    },
    /* The maker's view of where their application stands. Safe to expose
       publicly: it says a raise was applied for, not what was written in it. */
    status,
    reviewNote: item.fundraise.reviewNote,
    appliedAt: item.fundraise.appliedAt,
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

/* ----------------------------------------------------------------- blog --- */

/** A post in a list: everything a card needs, without shipping the body. */
export function toPostSummary(post: IPost) {
  const author = post.author as unknown;

  return {
    id: post._id.toString(),
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    coverUrl: post.coverUrl,
    tags: post.tags,
    status: post.status,
    publishedAt: post.publishedAt,
    readMinutes: post.readMinutes,
    author: isPopulatedUser(author) ? toPublicUser(author) : null,
  };
}

/** A post being read. The summary plus the thing people came for. */
export function toPostResponse(post: IPost) {
  return { ...toPostSummary(post), body: post.body };
}

/* ---------------------------------------------------------------- forum --- */

/**
 * A topic in the list.
 *
 * Carries `lastReplyBy` because the index's most useful column is "who spoke
 * last" — it is what tells a reader at a glance whether a thread is a
 * conversation or a post nobody answered. Deliberately omits the body: a
 * twenty-row list would otherwise ship 160KB of prose nothing renders.
 */
export function toTopicSummary(topic: ITopic) {
  const author = topic.author as unknown;
  const lastReplyBy = topic.lastReplyBy as unknown;

  return {
    id: topic._id.toString(),
    title: topic.title,
    slug: topic.slug,
    section: topic.section,
    replyCount: topic.replyCount,
    lastReplyAt: topic.lastReplyAt,
    lastReplyBy: isPopulatedUser(lastReplyBy) ? toPublicUser(lastReplyBy) : null,
    pinned: topic.pinned,
    locked: topic.locked,
    createdAt: topic.createdAt,
    author: isPopulatedUser(author) ? toPublicUser(author) : null,
  };
}

/** A topic being read. The summary plus the post itself. */
export function toTopicResponse(topic: ITopic) {
  return { ...toTopicSummary(topic), body: topic.body };
}

export function toReplyResponse(reply: IReply) {
  const author = reply.author as unknown;

  return {
    id: reply._id.toString(),
    body: reply.body,
    createdAt: reply.createdAt,
    author: isPopulatedUser(author) ? toPublicUser(author) : null,
  };
}
