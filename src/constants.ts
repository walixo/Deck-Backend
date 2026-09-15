import { env } from './config/env';

/**
 * The icons a category may use.
 *
 * A curated set, not free choice. An icon set only works if it holds together —
 * one stroke weight, one optical size, inheriting the theme's colour so it reads
 * on both canvases. These are Heroicons outline names, resolved to components on
 * the frontend; the backend only ever stores and validates the key.
 *
 * Living here rather than in the frontend because the model validates against
 * it: an icon key that does not exist should be rejected at write time, not
 * discovered as a blank square months later.
 */
export const CATEGORY_ICONS = {
  'cpu-chip': 'Chip, silicon, models',
  sparkles: 'AI, generative, magic',
  'command-line': 'CLI, terminal, scripts',
  'code-bracket': 'Code, libraries, SDKs',
  'device-phone-mobile': 'Mobile apps',
  'globe-alt': 'Websites, the web',
  cube: 'Hardware, physical things',
  'puzzle-piece': 'Plugins, extensions',
  bolt: 'Speed, automation',
  beaker: 'Experiments, research',
  'chart-bar': 'Analytics, data',
  'circle-stack': 'Databases, storage',
  cloud: 'Infrastructure, hosting',
  'credit-card': 'Payments, fintech',
  'document-text': 'Docs, writing',
  envelope: 'Email, messaging',
  film: 'Video, media',
  'finger-print': 'Identity, auth',
  'lock-closed': 'Security, privacy',
  megaphone: 'Marketing, growth',
  'musical-note': 'Audio, music',
  'paint-brush': 'Design, creative',
  photo: 'Images, galleries',
  'rocket-launch': 'Launches, startups',
  'shopping-bag': 'Commerce, retail',
  'squares-plus': 'Templates, kits',
  users: 'Community, social',
  'wrench-screwdriver': 'Tools, utilities',
  window: 'Desktop apps',
  'academic-cap': 'Learning, education',
} as const;

export type CategoryIconKey = keyof typeof CATEGORY_ICONS;

/**
 * The categories Deck ships with. These SEED the Category collection on first
 * run; after that the database is the source of truth and this list is history.
 * Nothing at runtime should validate against it.
 */
export const SEED_CATEGORIES = [
  { slug: 'ai-model', label: 'AI Models', icon: 'cpu-chip', order: 10 },
  { slug: 'ai-tool', label: 'AI Tools', icon: 'sparkles', order: 20 },
  { slug: 'claude-skill', label: 'Claude Skills', icon: 'puzzle-piece', order: 30 },
  { slug: 'developer-tool', label: 'Developer Tools', icon: 'command-line', order: 40 },
  { slug: 'mobile-app', label: 'Mobile Apps', icon: 'device-phone-mobile', order: 50 },
  { slug: 'website', label: 'Websites', icon: 'globe-alt', order: 60 },
  { slug: 'hardware', label: 'Hardware', icon: 'cube', order: 70 },
] as const;

/**
 * A category slug.
 *
 * Deliberately `string` and not a union. Categories live in the database now, so
 * the set is not knowable at compile time — a union here would be a type that
 * lies the moment somebody adds one through the admin area. Validity is checked
 * against the collection at write time instead.
 */
export type Category = string;

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

/*
 * What a launch has to have done before it can ask to raise money.
 *
 * Traction, not merit — nobody here is judging the idea. The point is that a
 * fundraise application should cost something that cannot be manufactured on
 * the way in, and the cheapest thing to manufacture is a launch posted five
 * minutes ago by an account created ten minutes ago. Twenty votes and three
 * comments means real people found it and at least a few of them had something
 * to say, which is the weakest signal worth gating on.
 *
 * Deliberately visible in the UI rather than enforced silently: a maker who
 * cannot apply yet should be able to see exactly how far off they are.
 */
export const FUNDRAISE_MIN_VOTES = 20;
export const FUNDRAISE_MIN_COMMENTS = 3;

/* ------------------------------------------------------ custom prints --- */

/**
 * What Deck charges to print somebody's own artwork, in minor units.
 *
 * Server-side and nowhere else, exactly like the ad rate card: the client picks
 * a product and the price is derived here. A tampered payload can change what
 * somebody orders, never what it costs.
 *
 * `inkSurcharge` is charged on heavy coverage — a design that inks most of the
 * garment genuinely costs more to produce, and pricing it the same as a small
 * chest mark means the small ones subsidise the large ones.
 */
export const CUSTOM_PRINT_PRICING = {
  sticker: { baseMinor: 120_000, label: 'Die-cut sticker', apparel: false },
  'sticker-sheet': { baseMinor: 350_000, label: 'Sticker sheet', apparel: false },
  tee: { baseMinor: 950_000, label: 'T-shirt', apparel: true },
  hoodie: { baseMinor: 1_850_000, label: 'Hoodie', apparel: true },
} as const;

/** Added when ink coverage is above the threshold. See analyseArtwork. */
export const CUSTOM_INK_SURCHARGE_MINOR = 250_000;
export const CUSTOM_INK_SURCHARGE_ABOVE = 0.55;

/** Apparel sizes Deck prints. Stickers have no size. */
export const CUSTOM_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'] as const;

/* --------------------------------------------------------- acquisitions --- */

/**
 * Deck's cut of an acquisition, as a percentage of the agreed price.
 *
 * Separate from PLATFORM_FEE_PERCENT, which is the shop's. They are different
 * businesses with different economics — a t-shirt order settles in days and
 * costs Deck a payment fee, whereas brokering a product sale is a review, a
 * listing, and a negotiation that may run for months. One constant serving both
 * would mean changing shop pricing every time this moved.
 *
 * The rate in force is copied onto each deal when a bid is accepted, so
 * changing this never rewrites what a past sale owed.
 */
export const ACQUISITION_FEE_PERCENT = Number(process.env.ACQUISITION_FEE_PERCENT ?? 8);

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
  'user.verified',
  'user.unverified',
  'post.created',
  'post.published',
  'post.unpublished',
  'post.deleted',
  'merch.approved',
  'merch.rejected',
  'merch.edited',
  'merch.retired',
  'order.shipped',
  'order.delivered',
  'payout.recorded',
  'item.edited',
  'item.deleted',
  'item.rescheduled',
  'category.created',
  'category.updated',
  'category.removed',
  'fundraise.changed',
  'fundraise.approved',
  'fundraise.rejected',
  'futuregen.added',
  'futuregen.removed',
  'comment.deleted',
  'topic.edited',
  'topic.deleted',
  'topic.moderated',
  'reply.deleted',
  'acquisition.approved',
  'acquisition.rejected',
  'acquisition.sold',
  'acquisition.removed',
  'custom.approved',
  'custom.rejected',
  'game.approved',
  'game.rejected',
  'game.edited',
  'game.removed',
  'ad.approved',
  'ad.rejected',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGETS = [
  'user',
  'merch',
  'order',
  'payout',
  'item',
  'category',
  'comment',
  'ad',
  'post',
  'topic',
  'acquisition',
  'custom',
  'game',
] as const;
export type AuditTarget = (typeof AUDIT_TARGETS)[number];
