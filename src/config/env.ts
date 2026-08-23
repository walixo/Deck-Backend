import dotenv from 'dotenv';

dotenv.config();

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/deck'),
  jwtSecret: required('JWT_SECRET', 'deck-dev-secret'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  /* Paystack. The secret key is server-only and never sent to the browser;
     without it the shop still runs, it just cannot take card payments. */
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY ?? '',
  /** Where Paystack returns the customer after checkout. */
  paystackCallbackUrl: process.env.PAYSTACK_CALLBACK_URL ?? 'http://localhost:5173/orders/callback',
  /** Must be a currency your Paystack account is enabled for (NGN, GHS, ZAR, KES, USD). */
  currency: (process.env.CURRENCY ?? 'NGN').toUpperCase(),
  /* Shipping, in minor units of CURRENCY. Defaults suit NGN (₦2,500 flat, free
     over ₦50,000) — change these when you change currency. */
  shippingFlatMinor: Number(process.env.SHIPPING_FLAT_MINOR ?? 250_000),
  freeShippingThresholdMinor: Number(process.env.FREE_SHIPPING_THRESHOLD_MINOR ?? 5_000_000),

  /*
   * Deck's cut of everything that passes through a seller or a fundraise, as a
   * percentage. Defaults to 0 so the platform takes nothing until you decide it
   * should — but the fee is computed and recorded on every transaction either
   * way, so turning it on later needs no backfill.
   *
   * Clamped to 0–50: a typo of `900` here would otherwise quietly hand Paystack
   * a split that swallows the seller's whole payout.
   */
  platformFeePercent: Math.min(50, Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT ?? 0))),

  /*
   * How long a launch must wait before it can ship a new version.
   *
   * Every release earns a fresh day on the board with its votes reset, which is
   * the right reward for actually shipping something and an obvious thing to
   * farm otherwise — "v1.0.1" every morning would put one product on the board
   * permanently. Thirty days is short enough not to punish a real cadence and
   * long enough that gaming it costs more attention than it returns.
   *
   * Product Hunt uses six months; Deck's board turns over daily rather than
   * weekly, so the same reasoning lands on a shorter number.
   */
  releaseCooldownDays: Math.max(0, Number(process.env.RELEASE_COOLDOWN_DAYS ?? 30)),

  /*
   * How long after posting a launch stays editable.
   *
   * A launch goes live the instant it is submitted, which means the first thing
   * a maker does after publishing is spot the typo. Without a window the only
   * fix is to delete and repost, losing whatever votes and comments arrived in
   * the meantime — so people either live with the mistake or game the board.
   *
   * Four hours is long enough to cover "I posted this and went to bed", short
   * enough that the text somebody voted on is the text that stays. After it
   * closes, changing the product means shipping a release.
   */
  editWindowHours: Math.max(0, Number(process.env.EDIT_WINDOW_HOURS ?? 4)),

  /** Floor on a single fundraise contribution, in minor units (₦1,000). */
  minContributionMinor: Number(process.env.MIN_CONTRIBUTION_MINOR ?? 100_000),
  /** Ceiling, mostly to keep a fat-fingered amount out of the payment provider. */
  maxContributionMinor: Number(process.env.MAX_CONTRIBUTION_MINOR ?? 500_000_000),

  /*
   * How many reverse proxies sit in front of this server, or false for none.
   * Only set it when there really is one: with no proxy, trusting
   * X-Forwarded-For lets a client claim any IP it likes, which would poison
   * the audit trail rather than inform it.
   */
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || 1 : (false as const),

  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },
};
