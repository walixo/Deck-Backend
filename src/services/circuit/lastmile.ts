import { randInt, seeded, type Challenge, type Generated, type Graded } from './types';

/**
 * Last Mile — vehicle routing with capacities and time windows.
 *
 * Sixty drops, five vans, one depot. Every van starts and ends at the depot,
 * carries a limited load, and must reach each drop inside its window (early
 * vans wait; late is not allowed). Shortest total distance wins.
 *
 * Fair by construction: each puzzle is built around a planted plan that
 * works, so a valid answer always exists. The server then polishes that plan
 * and keeps its distance as the reference; quality is how close you come —
 * matching the reference is 0.97, and full marks need 3% better.
 */

const CUSTOMERS = 60;
const VANS = 5;
const SERVICE = 10;
const DEPOT = { x: 500, y: 500 };

interface Stop {
  id: number;
  x: number;
  y: number;
  demand: number;
  open: number;
  close: number;
}

interface Puzzle {
  depot: { x: number; y: number };
  vans: number;
  capacity: number;
  horizon: number;
  serviceMinutes: number;
  customers: Stop[];
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Walks one route: its length, or why it does not work. */
function walk(
  p: Puzzle,
  byId: Map<number, Stop>,
  route: number[],
): { length: number } | { error: string } {
  let t = 0;
  let load = 0;
  let at: { x: number; y: number } = p.depot;
  let length = 0;
  for (const id of route) {
    const stop = byId.get(id)!;
    const leg = dist(at, stop);
    length += leg;
    t += leg;
    if (t > stop.close + 1e-9)
      return {
        error: `Drop ${id} is reached at ${t.toFixed(1)}, after its window closes at ${stop.close}`,
      };
    t = Math.max(t, stop.open) + p.serviceMinutes;
    load += stop.demand;
    at = stop;
  }
  if (load > p.capacity)
    return { error: `A van carries ${load}, over the capacity of ${p.capacity}` };
  const home = dist(at, p.depot);
  length += home;
  t += home;
  if (t > p.horizon + 1e-9)
    return { error: `A van returns at ${t.toFixed(1)}, after the shift ends at ${p.horizon}` };
  return { length };
}

/**
 * The reference: local search over the planted plan until nothing helps —
 * moving a drop to its cheapest valid spot in any van, swapping two drops
 * between vans, and 2-opt within a route. Every move keeps the plan valid.
 */
function polish(p: Puzzle, byId: Map<number, Stop>, start: number[][]): number[][] {
  const len = (r: number[]) => {
    const w = walk(p, byId, r);
    return 'length' in w ? w.length : Infinity;
  };
  const routes = start.map((r) => [...r]);
  const lengths = routes.map(len);
  const eps = 1e-6;
  for (let pass = 0; pass < 60; pass++) {
    let improved = false;

    /* Relocate: lift each drop out and put it back wherever it is cheapest. */
    for (let v = 0; v < routes.length; v++) {
      for (let i = 0; i < routes[v].length; i++) {
        const id = routes[v][i];
        const without = [...routes[v].slice(0, i), ...routes[v].slice(i + 1)];
        const saved = lengths[v] - len(without);
        let best: [number, number, number] | null = null;
        for (let w = 0; w < routes.length; w++) {
          const base = w === v ? without : routes[w];
          const baseLen = w === v ? lengths[v] - saved : lengths[w];
          for (let j = 0; j <= base.length; j++) {
            if (w === v && j === i) continue;
            const cost = len([...base.slice(0, j), id, ...base.slice(j)]) - baseLen;
            if (cost < saved - eps && (!best || cost < best[2])) best = [w, j, cost];
          }
        }
        if (best) {
          const [w, j] = best;
          routes[v] = without;
          lengths[v] = len(without);
          routes[w].splice(j, 0, id);
          lengths[w] = len(routes[w]);
          improved = true;
          i--;
        }
      }
    }

    /* Swap: trade two drops between different vans. */
    for (let v = 0; v < routes.length; v++) {
      for (let w = v + 1; w < routes.length; w++) {
        for (let i = 0; i < routes[v].length; i++) {
          for (let j = 0; j < routes[w].length; j++) {
            const a = [...routes[v]];
            const b = [...routes[w]];
            [a[i], b[j]] = [b[j], a[i]];
            const la = len(a);
            if (la === Infinity) continue;
            const lb = len(b);
            if (la + lb < lengths[v] + lengths[w] - eps) {
              routes[v] = a;
              routes[w] = b;
              lengths[v] = la;
              lengths[w] = lb;
              improved = true;
            }
          }
        }
      }
    }

    /* 2-opt: reverse a stretch of one route. */
    for (let v = 0; v < routes.length; v++) {
      const r = routes[v];
      for (let i = 0; i < r.length - 1; i++) {
        for (let j = i + 1; j < r.length; j++) {
          const flipped = [...r.slice(0, i), ...r.slice(i, j + 1).reverse(), ...r.slice(j + 1)];
          const l = len(flipped);
          if (l < lengths[v] - eps) {
            routes[v] = flipped;
            lengths[v] = l;
            improved = true;
            break;
          }
        }
      }
    }

    if (!improved) break;
  }
  return routes;
}

export const lastMile: Challenge = {
  slug: 'last-mile',
  title: 'Last Mile',
  kind: 'optimise',
  summary: 'Route five vans through sixty drops, every one inside its time window.',
  rules: [
    'Every route starts at the depot at minute 0 and must be back by the horizon.',
    'Vans travel one distance unit per minute; distance is straight-line (Euclidean) between points.',
    'Each drop must be reached no later than its close time. Arriving before it opens means waiting until it does.',
    'Each drop takes serviceMinutes once started. A van’s total demand may not exceed capacity.',
    'Every drop is visited exactly once, by one van. Use up to five vans; an empty route is allowed.',
    'Any rule broken scores 0. A valid plan scores by total distance against Deck’s reference: quality = min(1, 0.97 × reference ÷ yours).',
  ],
  answerFormat:
    '{ "routes": [[12, 4, 33, …], [7, 19, …], …] } — up to five lists of drop IDs, each in visiting order.',
  limitMs: 15 * 60_000,
  base: 500,

  generate(seed: number): Generated {
    const rand = seeded(seed);
    const points = Array.from({ length: CUSTOMERS }, (_, i) => ({
      id: i + 1,
      x: randInt(rand, 0, 1000),
      y: randInt(rand, 0, 1000),
      demand: randInt(rand, 1, 20),
    }));

    /* The planted plan: sweep the drops into five sectors around the depot,
       then visit each sector nearest-first. */
    const start = rand() * Math.PI * 2;
    const angle = (q: { x: number; y: number }) =>
      (Math.atan2(q.y - DEPOT.y, q.x - DEPOT.x) - start + Math.PI * 4) % (Math.PI * 2);
    const swept = [...points].sort((a, b) => angle(a) - angle(b));
    const planted: number[][] = [];
    for (let v = 0; v < VANS; v++) {
      const sector = swept.slice((v * CUSTOMERS) / VANS, ((v + 1) * CUSTOMERS) / VANS);
      const route: typeof sector = [];
      let at: { x: number; y: number } = DEPOT;
      const left = [...sector];
      while (left.length) {
        left.sort((a, b) => dist(at, a) - dist(at, b));
        const next = left.shift()!;
        route.push(next);
        at = next;
      }
      planted.push(route.map((q) => q.id));
    }

    /* Windows are cut around the planted arrival times, so the plan works. */
    const customers: Stop[] = [];
    let maxLoad = 0;
    let lastReturn = 0;
    for (const route of planted) {
      let t = 0;
      let at: { x: number; y: number } = DEPOT;
      let load = 0;
      for (const id of route) {
        const q = points[id - 1];
        t += dist(at, q);
        customers.push({
          ...q,
          open: Math.max(0, Math.floor(t - randInt(rand, 40, 260))),
          close: Math.ceil(t + randInt(rand, 40, 260)),
        });
        t += SERVICE;
        load += q.demand;
        at = q;
      }
      maxLoad = Math.max(maxLoad, load);
      lastReturn = Math.max(lastReturn, t + dist(at, DEPOT));
    }
    customers.sort((a, b) => a.id - b.id);

    /* A quarter of the drops take a delivery any time in the shift, so there
       is real room to reorder — and real room to do it badly. */
    const horizon = Math.ceil(lastReturn * 1.1);
    for (const c of customers) {
      if (rand() < 0.25) {
        c.open = 0;
        c.close = Math.floor(horizon - SERVICE - dist(c, DEPOT));
      }
    }

    const puzzle: Puzzle = {
      depot: DEPOT,
      vans: VANS,
      capacity: Math.ceil(maxLoad * 1.08),
      horizon,
      serviceMinutes: SERVICE,
      customers,
    };
    const byId = new Map(customers.map((c) => [c.id, c]));
    const reference = polish(puzzle, byId, planted);
    const referenceLength = reference.reduce((sum, r) => {
      const w = walk(puzzle, byId, r);
      return sum + ('length' in w ? w.length : 0);
    }, 0);

    return {
      puzzle: puzzle as unknown as Record<string, unknown>,
      secret: { reference: Math.round(referenceLength * 10) / 10, routes: reference },
    };
  },

  grade(generated: Generated, answer: unknown): Graded {
    const p = generated.puzzle as unknown as Puzzle;
    const routes = (answer as { routes?: unknown })?.routes;
    if (!Array.isArray(routes) || routes.length > p.vans) {
      return { quality: 0, detail: `Send routes as a list of up to ${p.vans} lists of drop IDs` };
    }
    const byId = new Map(p.customers.map((c) => [c.id, c]));
    const seen = new Set<number>();
    for (const route of routes) {
      if (!Array.isArray(route) || route.some((id) => !Number.isInteger(id) || !byId.has(id))) {
        return { quality: 0, detail: 'Every route must list drop IDs from the puzzle' };
      }
      for (const id of route) {
        if (seen.has(id)) return { quality: 0, detail: `Drop ${id} is visited twice` };
        seen.add(id);
      }
    }
    if (seen.size !== p.customers.length) {
      const missing = p.customers.find((c) => !seen.has(c.id))!;
      return { quality: 0, detail: `Drop ${missing.id} is never visited` };
    }
    let total = 0;
    for (const route of routes as number[][]) {
      const w = walk(p, byId, route);
      if ('error' in w) return { quality: 0, detail: w.error };
      total += w.length;
    }
    const reference = (generated.secret as { reference: number }).reference;
    const quality = Math.min(1, (0.97 * reference) / total);
    return {
      quality: Math.round(quality * 10_000) / 10_000,
      detail: `Valid plan, ${total.toFixed(1)} total distance against a reference of ${reference.toFixed(1)}`,
      stats: { distance: Math.round(total * 10) / 10, reference },
    };
  },
};
