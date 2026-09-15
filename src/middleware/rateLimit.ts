import type { NextFunction, Request, Response } from 'express';

/**
 * A fixed-window rate limiter, in memory, with no dependency.
 *
 * Deck runs as one Node process, and for one process a Map is the whole
 * problem solved: no Redis, no store to configure, no second thing that can be
 * down while the site is up. The trade is stated rather than hidden — run two
 * instances behind a load balancer and each keeps its own tally, so the real
 * ceiling becomes the limit times the instance count. That is still a ceiling,
 * and the day there are two instances is the day to reach for a shared store.
 *
 * What this is for is the narrow case that matters before launch: an unmetered
 * password guesser against `/api/auth/login`. bcrypt at ten rounds makes each
 * attempt cost something, but "expensive" times "unlimited" is still unlimited,
 * and a common-password list against a few thousand accounts finds someone.
 */

interface Window {
  /** When the current window closes, as a timestamp. */
  resets: number;
  hits: number;
}

export interface RateLimitOptions {
  /** How long a window lasts, in milliseconds. */
  windowMs: number;
  /** How many requests one caller may make inside it. */
  max: number;
  /** What the 429 says. Deliberately vague about why. */
  message?: string;
}

/**
 * How often to sweep expired entries, and how many entries force an early
 * sweep.
 *
 * Without this the Map is an unbounded memory leak keyed by IP address — every
 * address that ever hit the route stays in it forever, which is a slow one on a
 * quiet site and a fast one under a distributed attack. Sweeping on a timer
 * alone is not enough either: a burst from a hundred thousand addresses inside
 * one interval would arrive before the broom does.
 */
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_AT_ENTRIES = 10_000;

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, message = 'Too many attempts. Try again shortly.' } = options;

  const windows = new Map<string, Window>();
  let lastSweep = Date.now();

  const sweep = (now: number): void => {
    for (const [key, window] of windows) {
      if (window.resets <= now) windows.delete(key);
    }
    lastSweep = now;
  };

  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();

    if (now - lastSweep > SWEEP_INTERVAL_MS || windows.size > SWEEP_AT_ENTRIES) sweep(now);

    /*
     * `req.ip` and nothing else.
     *
     * Not the email or username in the body: that would let one attacker lock
     * every account on the site out of its own owner's hands by guessing at
     * each of them in turn, which turns a brute-force defence into a
     * denial-of-service tool. Express resolves this to the real client address
     * only when `trust proxy` is set, which is exactly the condition under
     * which `X-Forwarded-For` can be believed.
     */
    const key = req.ip ?? 'unknown';
    const window = windows.get(key);

    if (!window || window.resets <= now) {
      windows.set(key, { resets: now + windowMs, hits: 1 });
      next();
      return;
    }

    window.hits += 1;

    if (window.hits > max) {
      const retryAfter = Math.ceil((window.resets - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ success: false, message });
      return;
    }

    next();
  };
}

/**
 * The credential endpoints: ten attempts a quarter-hour from one address.
 *
 * Generous for a person — nobody mistypes their password ten times in fifteen
 * minutes — and ruinous for a script, which wants thousands. Registration is
 * behind the same limiter because an open sign-up route is the other way to
 * make a server do unbounded bcrypt work.
 */
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10 });
