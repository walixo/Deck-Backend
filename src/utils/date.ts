/** Start of the UTC day for a given date (leaderboards run on UTC days). */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function endOfUtcDay(date: Date): Date {
  const start = startOfUtcDay(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Parses YYYY-MM-DD (or anything Date understands); falls back to today. */
export function parseDateParam(value?: string): Date {
  if (!value) return new Date();
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function toDateKey(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}
