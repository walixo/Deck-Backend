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

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * One social provider's credentials, or nothing.
 *
 * Same all-or-nothing rule as Cloudinary and for the same reason: an id
 * without a secret is a typo, and the failure it produces arrives much later,
 * as a redirect to a provider that bounces the user straight back. Absent
 * entirely is legitimate — sign-in with a password works on its own, and a
 * local checkout should not need a GitHub app registered to run.
 */
function readOAuthProvider(name: string): OAuthProviderConfig | null {
  const clientId = process.env[`${name}_CLIENT_ID`];
  const clientSecret = process.env[`${name}_CLIENT_SECRET`];

  const given = [clientId, clientSecret].filter(Boolean).length;
  if (given === 0) return null;

  if (given < 2) {
    throw new Error(
      `${name} sign-in is half-configured. Set ${name}_CLIENT_ID and ` +
        `${name}_CLIENT_SECRET together, or neither.`,
    );
  }

  return { clientId: clientId as string, clientSecret: clientSecret as string };
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  mongoUri: requiredInProduction('MONGODB_URI', DEV_MONGO_URI),
  jwtSecret: readJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  /*
   * Bachs — payments, sub-accounts and transfers. See services/bachs.
   *
   * The secret key is server-only and never sent to the browser. Without it
   * the shop still runs, it just cannot take payments. The key's own prefix
   * picks the host: `sk_sandbox_` goes to the sandbox, anything else to live.
   * `BACHS_API_URL` overrides that, which is only for pointing at a mock.
   */
  bachs: {
    /* Trimmed, and stripped of wrapping quotes: a key pasted into a hosting
       dashboard easily picks up a trailing newline or the quotes from a .env
       line, and Bachs rejects the whole thing as an unknown key — with no
       request reaching its logs to say why. */
    secretKey: (process.env.BACHS_SECRET_KEY ?? '')
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim(),
    /* Per webhook endpoint, from the Bachs developer portal → Webhooks. The
       endpoint must have its event source set to `all` so Connect events
       (account and capability changes) arrive alongside payments. */
    webhookSecret: process.env.BACHS_WEBHOOK_SECRET ?? '',
    apiUrl: process.env.BACHS_API_URL ?? '',
  },
  /**
   * Where the customer lands after a hosted checkout. Bachs sends them to
   * `success_url` or `cancel_url`; both point here with the reference
   * attached, and the page confirms with the server rather than trusting the
   * redirect. Previously `PAYSTACK_CALLBACK_URL`, which is still read so a
   * deployment that has not renamed it keeps working.
   */
  paymentReturnUrl:
    process.env.PAYMENT_RETURN_URL ??
    process.env.PAYSTACK_CALLBACK_URL ??
    'http://localhost:3000/orders/callback',
  /**
   * How long earnings sit before they are transferred to a sub-account.
   *
   * Money is collected into Deck's balance at sale time and only moved once
   * this has passed, so a refund inside the window comes out before anybody
   * has been paid rather than after. Fourteen days is the default chosen for
   * Deck; the transfer run reads it fresh each time.
   */
  payoutHoldDays: Math.max(0, Number(process.env.PAYOUT_HOLD_DAYS ?? 14)),
  /** Must be a currency your Bachs account is enabled for. */
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
   * Clamped to 0–50: a typo of `900` here would otherwise quietly hand Bachs
   * a split that swallows the seller's whole payout.
   */
  platformFeePercent: Math.min(50, Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT ?? 0))),
  /*
   * Deck's cut of in-game purchases on Deck Games. 20 means the developer keeps
   * 80%. Separate from PLATFORM_FEE_PERCENT because it is a different deal with
   * different people: a seller ships goods, a developer ships a game Deck hosts,
   * reviews and sells for them. Clamped like the other so a typo cannot take a
   * developer's whole share.
   */
  gameFeePercent: Math.min(50, Math.max(0, Number(process.env.GAME_FEE_PERCENT ?? 20))),

  /*
   * Match: how long two people talk, and how long afterwards they may choose
   * to swap X and Instagram usernames. Settable so a test need not wait two minutes.
   */
  matchCallSeconds: Math.min(600, Math.max(5, Number(process.env.MATCH_CALL_SECONDS ?? 120))),
  matchShareSeconds: Math.min(600, Math.max(5, Number(process.env.MATCH_SHARE_SECONDS ?? 90))),
  /*
   * Match is open in the evening, Lagos time: "20-22" is 8pm to 10pm at
   * GMT+1. MATCH_ALWAYS_OPEN=true lifts the hours, for development and tests.
   */
  matchHours: (() => {
    const [open, close] = (process.env.MATCH_HOURS ?? '20-22').split('-').map(Number);
    return { open: open ?? 20, close: close ?? 22 };
  })(),
  matchUtcOffset: Number(process.env.MATCH_UTC_OFFSET ?? 1),
  matchAlwaysOpen: process.env.MATCH_ALWAYS_OPEN === 'true',
  /* Below this many people online, Match says "busy" or "quiet" instead of a number. */
  matchCountsFrom: Math.max(0, Number(process.env.MATCH_COUNTS_FROM ?? 20)),
  /*
   * Web Push, for "ping me when someone's free". Generate once with
   * `npx web-push generate-vapid-keys`; the private key is a secret. Without
   * both keys the ping option simply does not appear.
   */
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject: process.env.VAPID_SUBJECT ?? 'mailto:hello@onedeck.africa',
  },

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
   *
   * TEMPORARILY OFF (October 2026): the default is 0, so a launch can ship a
   * new version immediately. The controller already treats 0 as "no
   * cooldown", so nothing else changed. To restore the rule, set
   * `RELEASE_COOLDOWN_DAYS=30` on the API host — no deploy needed — or put the
   * default back to 30 here. While it is off, the farming risk above is live:
   * one product can re-enter today's board as often as its maker likes.
   */
  releaseCooldownDays: Math.max(0, Number(process.env.RELEASE_COOLDOWN_DAYS ?? 0)),

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

  /*
   * Social sign-in. Each provider is independent — GitHub can be live while
   * Google is not, and the sign-in page only offers what is configured.
   */
  oauth: {
    github: readOAuthProvider('GITHUB'),
    google: readOAuthProvider('GOOGLE'),
  },

  /*
   * Where the browser comes back to after a provider redirect.
   *
   * `PUBLIC_API_URL` is this server's own address as the outside world sees
   * it, which is not something Express can work out for itself — behind a
   * proxy the host header is whatever the proxy decided to send. It has to
   * match the callback URL registered with each provider exactly, character
   * for character, or the provider refuses the exchange.
   */
  publicApiUrl: (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, ''),

  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  /**
   * GameID — Deck as an OAuth 2.0 / OpenID Connect provider.
   *
   * `issuer` is the public origin apps see in tokens and discovery; it defaults
   * to the first client origin, since the consent page lives on the frontend.
   * `privateKey` is an RSA private key in PEM (newlines may be written as \n)
   * that signs ID tokens; without one, development generates a throwaway key
   * at boot and production refuses to sign. `subjectSecret` keys the per-app
   * subject identifiers — change it and every app sees every user as new.
   */
  gameId: {
    issuer: (process.env.GAMEID_ISSUER ?? '').replace(/\/+$/, ''),
    privateKey: (process.env.GAMEID_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    subjectSecret: process.env.GAMEID_SUBJECT_SECRET ?? '',
  },

  /**
   * Lets game webhooks reach localhost and private addresses, over http — for
   * running Deck and a game server on one machine. Honoured only outside
   * production, whatever the variable says: in production this would reopen
   * the SSRF hole the address check exists to close.
   */
  get allowPrivateWebhooks(): boolean {
    return !this.isProduction && process.env.GAME_WEBHOOKS_ALLOW_PRIVATE === 'true';
  },
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },
};
