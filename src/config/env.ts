import dotenv from 'dotenv';

dotenv.config();

const production = (process.env.NODE_ENV ?? 'development') === 'production';

/** The stand-ins that make a fresh clone run with no setup. */
const DEV_MONGO_URI = 'mongodb://127.0.0.1:27017/deck';
const DEV_JWT_SECRET = 'deck-dev-secret';

/**
 * A value that may fall back in development and must be set in production.
 *
 * Checking for *absence alone* was the bug this replaces: with a fallback
 * supplied, the old guard could never fire, so a deploy that forgot
 * `JWT_SECRET` booted happily and signed its tokens with a string published in
 * this repository. Anybody who could read the source could mint a staff
 * session, and nothing would look wrong.
 *
 * Failing to boot is the right outcome. A server that will not start is
 * noticed in the first minute; one that starts with a known secret is not
 * noticed at all.
 *
 * What it checks is *presence*, not the value. Refusing a value because it
 * matches the development default is a check I wrote and then removed: it
 * cannot tell "fell back to localhost" from "deliberately pointed at the
 * database on this same box", and the second is a perfectly good way to run a
 * single server. Where the value itself is the danger rather than the absence
 * — the signing secret — that is policed separately, below.
 */
function requiredInProduction(key: string, devFallback: string): string {
  const value = process.env[key];

  if (production && !value) {
    throw new Error(
      `${key} must be set in production. The development fallback is not a ` +
        `default worth inheriting by accident.`,
    );
  }

  return value ?? devFallback;
}

/**
 * How short a signing secret may be before it is not one.
 *
 * A token is only as private as the string that signed it, and a memorable
 * password is brute-forced offline in an afternoon. 32 characters of anything
 * random clears it; `openssl rand -base64 48` is the usual way to get some.
 */
const MIN_SECRET_LENGTH = 32;

function readJwtSecret(): string {
  const secret = requiredInProduction('JWT_SECRET', DEV_JWT_SECRET);

  /* The one value where the *content* is the vulnerability: this exact string
     is in the repository, so setting it deliberately is no better than
     forgetting to set anything. */
  if (production && secret === DEV_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is still the development value, which is published in this ' +
        'repository. Anyone who can read the source could forge a session.',
    );
  }

  if (production && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production ` +
        `(this one is ${secret.length}). Try: openssl rand -base64 48`,
    );
  }

  return secret;
}

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

function readCloudinary(): CloudinaryConfig | null {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  const given = [cloudName, apiKey, apiSecret].filter(Boolean).length;
  if (given === 0) return null;

  if (given < 3) {
    throw new Error(
      'Cloudinary is half-configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY ' +
        'and CLOUDINARY_API_SECRET together, or none of them to store images on disk.',
    );
  }

  return {
    cloudName: cloudName as string,
    apiKey: apiKey as string,
    apiSecret: apiSecret as string,
  };
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  mongoUri: requiredInProduction('MONGODB_URI', DEV_MONGO_URI),
  jwtSecret: readJwtSecret(),
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

  /*
   * Cloudinary, or nothing.
   *
   * All three or none: two out of three is a typo, and a typo that silently
   * falls back to writing images onto a disk that gets wiped on the next deploy
   * is the kind of thing nobody notices until the logos have gone. Absent
   * entirely is a legitimate configuration — local development stores to disk
   * and needs no account — so the check is for a *partial* answer, not a
   * missing one.
   */
  cloudinary: readCloudinary(),

  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },
};
