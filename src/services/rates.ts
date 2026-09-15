import { env } from '../config/env';

/**
 * Exchange rates, for display only.
 *
 * **Naira is the ledger currency and nothing here changes that.** Every
 * `*Minor` field, every Paystack charge and every payout stays in kobo. What
 * this provides is a number to *show* somebody in Toronto beside the naira
 * figure, so they know roughly what they are looking at before they decide to
 * care. The naira is always shown too, and the last screen before payment shows
 * naira alone — see the note in the frontend `Money` component.
 *
 * That separation is the whole design. Storing prices in several currencies
 * means a rate at write time and another at read time, and reconciliation
 * becomes "which rate was this row priced at?" — a question with no good answer
 * six months later.
 *
 * **One fetch a day, cached in memory.** Rates move by fractions of a percent
 * over a day and this is a browsing aid, not a quote. A single upstream call
 * per process per day is enough, and it means an outage at the rate provider
 * costs nothing: the last good table stays in memory, and if the very first
 * fetch fails there is a hardcoded fallback below.
 *
 * No Redis. The cache is one object in one process; a shared cache would be
 * infrastructure bought to avoid an HTTP request a day.
 */

/** Rates as "how many units of X is one unit of BASE" — BASE being env.currency. */
export interface RateTable {
  base: string;
  rates: Record<string, number>;
  /** When this table was fetched. Sent to the client so it can say "as of". */
  fetchedAt: string;
  /** False when this is the hardcoded table because the fetch failed. */
  live: boolean;
}

/**
 * The currencies Deck offers to display in.
 *
 * A short list on purpose. Every extra one is another row a reader has to skim
 * in the picker and another rate to be wrong about, and the point is to cover
 * where Deck's readers actually are rather than to be a currency converter.
 */
export const DISPLAY_CURRENCIES = ['NGN', 'USD', 'EUR', 'GBP', 'GHS', 'KES', 'ZAR', 'CAD'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

/**
 * Last-resort rates, roughly mid-2026, NGN base.
 *
 * Deliberately present. A shop that stops rendering prices because a free
 * exchange-rate API is down is a worse outcome than a shop showing a slightly
 * stale conversion beside an exact naira figure — and the naira figure, the one
 * that gets charged, is never derived from these.
 */
const FALLBACK: Record<string, number> = {
  NGN: 1,
  USD: 0.00065,
  EUR: 0.0006,
  GBP: 0.00051,
  GHS: 0.0079,
  KES: 0.084,
  ZAR: 0.0118,
  CAD: 0.00089,
};

const TTL_MS = 24 * 60 * 60 * 1000;

let cache: RateTable | null = null;
/** Shared so twenty concurrent requests on a cold cache make one upstream call. */
let inflight: Promise<RateTable> | null = null;

function fallbackTable(): RateTable {
  return {
    base: env.currency,
    /* The fallback is written NGN-base. Running Deck on another settlement
       currency would make it wrong, so it is only offered when it matches —
       a wrong number is worse than an absent one. */
    rates: env.currency === 'NGN' ? { ...FALLBACK } : { [env.currency]: 1 },
    fetchedAt: new Date().toISOString(),
    live: false,
  };
}

async function fetchRates(): Promise<RateTable> {
  const symbols = DISPLAY_CURRENCIES.join(',');
  const url = `https://api.exchangerate.host/latest?base=${env.currency}&symbols=${symbols}`;

  /* Bounded, because a hung request would otherwise hold every caller waiting
     on `inflight` for as long as the socket stays open. Four seconds is longer
     than this call ever legitimately takes. */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`rates: HTTP ${response.status}`);

    const body = (await response.json()) as { rates?: Record<string, number> };
    const rates = body.rates ?? {};

    /* A malformed or empty payload is a failure, not an empty table. Accepting
       `{}` here would cache "no currencies are convertible" for a day. */
    if (typeof rates.USD !== 'number') throw new Error('rates: payload had no USD');

    return {
      base: env.currency,
      rates: { ...rates, [env.currency]: 1 },
      fetchedAt: new Date().toISOString(),
      live: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The current rate table. Never throws and never blocks longer than one fetch.
 *
 * On failure it returns whatever it had — a stale live table if there is one,
 * the fallback otherwise. Callers get a usable table in every case, which is
 * what lets the display layer be unconditional.
 */
export async function getRates(): Promise<RateTable> {
  const fresh = cache && Date.now() - new Date(cache.fetchedAt).getTime() < TTL_MS;
  if (cache && fresh) return cache;

  if (!inflight) {
    inflight = fetchRates()
      .then((table) => {
        cache = table;
        return table;
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console -- a degraded price display is worth a line in the log.
        console.warn('[rates] fetch failed, using', cache ? 'stale cache' : 'fallback', error);
        /* A stale live table beats the hardcoded one: it was right yesterday. */
        return cache ?? fallbackTable();
      })
      .finally(() => {
        inflight = null;
      });
  }

  return inflight;
}
