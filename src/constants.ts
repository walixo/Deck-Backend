import { env } from './config/env';

export const CATEGORIES = [
  'ai-model',
  'ai-tool',
  'claude-skill',
  'developer-tool',
  'mobile-app',
  'website',
  'hardware',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  'ai-model': 'AI Models',
  'ai-tool': 'AI Tools',
  'claude-skill': 'Claude Skills',
  'developer-tool': 'Developer Tools',
  'mobile-app': 'Mobile Apps',
  website: 'Websites',
  hardware: 'Hardware',
};

export const PRICING_MODELS = ['free', 'freemium', 'paid', 'open-source'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const SORT_OPTIONS = ['trending', 'newest', 'top', 'discussed'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

/* ---------------------------------------------------------------- merch --- */

export const MERCH_CATEGORIES = ['apparel', 'stickers', 'print', 'accessories'] as const;
export type MerchCategory = (typeof MERCH_CATEGORIES)[number];

export const MERCH_CATEGORY_LABELS: Record<MerchCategory, string> = {
  apparel: 'Apparel',
  stickers: 'Stickers',
  print: 'Print',
  accessories: 'Accessories',
};

export const MERCH_SORT_OPTIONS = ['featured', 'newest', 'price-low', 'price-high'] as const;
export type MerchSortOption = (typeof MERCH_SORT_OPTIONS)[number];

/**
 * Where a listing sits in the review queue. `active` is separate and belongs to
 * the seller — it is their own show/hide switch. A product is buyable only when
 * it is both approved by Deck and switched on by its seller.
 */
export const MERCH_STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const;
export type MerchStatus = (typeof MERCH_STATUSES)[number];

export const ORDER_STATUSES = [
  'awaiting_payment',
  'paid',
  'shipped',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Money is stored and moved as integer minor units everywhere — kobo for NGN,
 * cents for USD. Floats cannot represent 0.1 exactly, so a cart of three
 * 19.99 tees would drift; the client never sees or sends a decimal price. This
 * is also exactly the unit Paystack expects, so nothing is converted.
 *
 * Set CURRENCY to something your Paystack account is enabled for.
 */
export const CURRENCY = env.currency;

/** Flat shipping, in minor units of CURRENCY. Free above the threshold. */
export const SHIPPING_FLAT_MINOR = env.shippingFlatMinor;
export const FREE_SHIPPING_THRESHOLD_MINOR = env.freeShippingThresholdMinor;

/** Guards against a fat-fingered or hostile quantity in the cart payload. */
export const MAX_QUANTITY_PER_LINE = 10;
export const MAX_LINES_PER_ORDER = 20;

/* ------------------------------------------------------------ fundraise --- */

export const CONTRIBUTION_STATUSES = ['pending', 'paid', 'failed'] as const;
export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number];

/** Deck's commission, as a percentage of gross. */
export const PLATFORM_FEE_PERCENT = env.platformFeePercent;

/** Contribution bounds, in minor units of CURRENCY. */
export const MIN_CONTRIBUTION_MINOR = env.minContributionMinor;
export const MAX_CONTRIBUTION_MINOR = env.maxContributionMinor;

/* ------------------------------------------------------------------ ads --- */

/** Where a paid placement can appear. One live ad per placement at a time. */
export const AD_PLACEMENTS = ['home', 'discover', 'board'] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

export const AD_PLACEMENT_LABELS: Record<AdPlacement, string> = {
  home: 'Home, under the launch wall',
  discover: 'Discover, above the results',
  board: 'The daily board, above the rankings',
};

/**
 * The rate card, in minor units per day.
 *
 * Server-side and nowhere else: the client picks a placement and a number of
 * days, and the price is derived here. The same rule the shop follows — a
 * tampered payload can change what someone buys, never what it costs.
 */
export const AD_DAY_RATE_MINOR: Record<AdPlacement, number> = {
  home: Number(process.env.AD_RATE_HOME_MINOR ?? 1_500_000),
  discover: Number(process.env.AD_RATE_DISCOVER_MINOR ?? 1_000_000),
  board: Number(process.env.AD_RATE_BOARD_MINOR ?? 800_000),
};

/** The only run lengths on offer. Arbitrary durations invite pro-rata bugs. */
export const AD_DURATIONS = [7, 14, 30] as const;
export type AdDuration = (typeof AD_DURATIONS)[number];

/**
 * A campaign's lifecycle.
 *
 * Review happens *before* payment, deliberately. Taking the money first would
 * mean owing a refund every time an ad is turned down, and Deck has no refund
 * flow — so the order of these two steps is the difference between a rejection
 * being a non-event and being a support ticket about somebody's money.
 *
 * `live` covers scheduled, running and finished: all three are just the window
 * compared to now. Storing them would mean a job to keep them true, and a row
 * that silently disagrees with the calendar.
 */
export const AD_STATUSES = [
  'pending_review',
  'rejected',
  'awaiting_payment',
  'live',
  'cancelled',
] as const;
export type AdStatus = (typeof AD_STATUSES)[number];

/* ---------------------------------------------------------------- audit --- */

/**
 * Every privileged action Deck records.
 *
 * Named `subject.verb-in-past-tense` so the log reads as a list of things that
 * happened rather than a list of endpoints that were called. The enum is closed
 * on purpose: a new privileged action has to be added here, which makes
 * "should this be audited?" a question you answer while writing it, not one
 * somebody asks after an incident.
 */
export const AUDIT_ACTIONS = [
  'role.granted',
  'role.revoked',
  'merch.approved',
  'merch.rejected',
  'merch.edited',
  'merch.retired',
  'order.shipped',
  'order.delivered',
  'payout.recorded',
  'item.edited',
  'item.deleted',
  'fundraise.changed',
  'comment.deleted',
  'ad.approved',
  'ad.rejected',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGETS = ['user', 'merch', 'order', 'payout', 'item', 'comment', 'ad'] as const;
export type AuditTarget = (typeof AUDIT_TARGETS)[number];
