import { env } from '../config/env';

/**
 * Every fee and share calculation on Deck goes through here.
 *
 * There is exactly one rounding rule and one place it lives. Deck now collects
 * the whole charge and owes sellers their part of it, which makes the arithmetic
 * more important rather than less: nothing external will catch a discrepancy, so
 * the numbers have to reconcile on their own. The fee is rounded and the net is
 * defined as the remainder — never rounded independently — so the two always add
 * back to the gross exactly.
 */
export interface FeeSplit {
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
}

export function applyPlatformFee(grossMinor: number): FeeSplit {
  const gross = Math.max(0, Math.round(grossMinor));
  const feeMinor = Math.round((gross * env.platformFeePercent) / 100);

  return { grossMinor: gross, feeMinor, netMinor: gross - feeMinor };
}

/**
 * Divides an amount across weighted parties so the parts sum to the whole.
 *
 * Used for shipping: one flat fee, several sellers, and no way to split it
 * evenly in minor units. Rounding each share independently would leave a kobo
 * unaccounted for — over thousands of orders that is a ledger that never
 * balances and nobody can explain.
 *
 * Largest-remainder: floor every share, then hand the leftover units out one at
 * a time to whoever lost the most to rounding. Ties break toward the earlier
 * entry, so the same input always produces the same output.
 */
export function allocate(totalMinor: number, weights: number[]): number[] {
  const total = Math.max(0, Math.round(totalMinor));
  if (weights.length === 0 || total === 0) return weights.map(() => 0);

  const sum = weights.reduce((running, weight) => running + Math.max(0, weight), 0);

  // Nothing to weigh by — split as evenly as the units allow.
  if (sum <= 0) {
    const base = Math.floor(total / weights.length);
    const shares = weights.map(() => base);
    for (let index = 0; index < total - base * weights.length; index += 1) shares[index] += 1;
    return shares;
  }

  const exact = weights.map((weight) => (Math.max(0, weight) * total) / sum);
  const shares = exact.map((value) => Math.floor(value));
  let remainder = total - shares.reduce((running, value) => running + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let position = 0; remainder > 0; position += 1, remainder -= 1) {
    shares[order[position % order.length].index] += 1;
  }

  return shares;
}
