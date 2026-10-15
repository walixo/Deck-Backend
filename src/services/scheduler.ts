import { bachsConfigured } from './bachs';
import { retryGameWebhooks } from './gameWebhooks';
import { sweepExpiredCheckouts } from './paymentsSweep';
import { runTransfers } from './payouts';

/**
 * Background jobs, in the API process itself.
 *
 * No job queue, no Redis, no separate worker — Deck runs as one Node process
 * and the project rules keep it that way until there is a reason not to. A
 * `setInterval` per job is the whole mechanism. The trade is stated rather
 * than hidden: run two instances and both will run the jobs. The transfer run
 * survives that (idempotency keys and pending payouts stop a double payment),
 * but it wastes calls, and the day there are two instances is the day to give
 * this a lock or its own process.
 *
 * Each job is single-flight: if a run is still going when the next tick
 * arrives, the tick is skipped rather than starting a second run alongside it.
 */

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  /** Only meaningful with payments configured. */
  needsPayments?: boolean;
}

const JOBS: Job[] = [
  /* Often enough that an abandoned basket frees its stock within the hour. */
  {
    name: 'sweep-checkouts',
    everyMs: 15 * 60 * 1000,
    run: sweepExpiredCheckouts,
    needsPayments: true,
  },
  /* Hourly is plenty for money on a 14-day hold. */
  { name: 'transfers', everyMs: 60 * 60 * 1000, run: runTransfers, needsPayments: true },
  /* Developers' webhooks. Runs without payments too: test purchases send
     real webhooks, and a developer integrating locally needs the retries. */
  { name: 'game-webhooks', everyMs: 2 * 60 * 1000, run: retryGameWebhooks },
];

const timers: NodeJS.Timeout[] = [];

/** A result whose every count is zero. */
const isIdle = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  Object.values(result).every((value) => value === 0);

export function startScheduler(): void {
  const jobs = JOBS.filter((job) => !job.needsPayments || bachsConfigured());
  if (jobs.length < JOBS.length) {
    // eslint-disable-next-line no-console
    console.log('[scheduler] payments are not configured — payment jobs not started');
  }

  for (const job of jobs) {
    let running = false;

    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const result = await job.run();
        /* A two-minute job that found nothing to do every time would bury
           the log lines that matter. Only runs that did something are logged. */
        if (!isIdle(result)) {
          // eslint-disable-next-line no-console
          console.log(`[scheduler] ${job.name}`, JSON.stringify(result));
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[scheduler] ${job.name} failed:`, error);
      } finally {
        running = false;
      }
    };

    /* First run shortly after boot rather than a full interval later — a deploy
       should not push the next transfer run back by an hour. Unref'd so a
       pending job never holds a shutting-down process open. */
    const first = setTimeout(() => void tick(), 30_000);
    first.unref();
    const every = setInterval(() => void tick(), job.everyMs);
    every.unref();
    timers.push(first, every);
  }

  // eslint-disable-next-line no-console
  console.log(`[scheduler] started ${jobs.map((job) => job.name).join(', ')}`);
}

export function stopScheduler(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;
}
