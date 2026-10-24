import { seeded, shuffle, type Challenge, type Generated, type Graded } from './types';

/**
 * Cage Lock — a 9×9 KenKen with no given digits, and a quarter of the
 * operations hidden.
 *
 * Every row and column holds 1–9 once. The grid is cut into cages; each cage
 * shows a target and, usually, an operation its digits must produce it with.
 * Cages marked `?` hide the operation: any operation that fits the cage's size
 * and makes the target is accepted. Hidden operations are what make it hard —
 * a `?` pair with target 2 could be 1+1 (impossible in a row), 3−1, 4÷2, 1×2…
 *
 * The puzzle is cut from a random Latin square, so it always has a solution;
 * it may have more than one, and any grid that keeps every rule is correct.
 */

const N = 9;
type Op = '+' | '-' | '*' | '/' | '=' | '?';
interface Cage {
  cells: [number, number][];
  op: Op;
  target: number;
}

/** A uniform-ish random Latin square: each row a random perfect matching. */
function latinSquare(rand: () => number): number[][] {
  for (;;) {
    const grid: number[][] = [];
    const usedInCol = Array.from({ length: N }, () => new Set<number>());
    let ok = true;
    for (let r = 0; r < N && ok; r++) {
      /* Match symbols to columns, avoiding symbols a column already has.
         Hall's theorem says a Latin rectangle always extends; the random
         augmenting order keeps rows from looking alike. */
      const colOf = new Array<number>(N + 1).fill(-1);
      const symOf = new Array<number>(N).fill(0);
      const symbols = shuffle(
        rand,
        [...Array(N).keys()].map((i) => i + 1),
      );
      const tryAssign = (s: number, seen: Set<number>): boolean => {
        for (const c of shuffle(rand, [...Array(N).keys()])) {
          if (usedInCol[c].has(s) || seen.has(c)) continue;
          seen.add(c);
          if (symOf[c] === 0 || tryAssign(symOf[c], seen)) {
            symOf[c] = s;
            colOf[s] = c;
            return true;
          }
        }
        return false;
      };
      for (const s of symbols) {
        if (!tryAssign(s, new Set())) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      symOf.forEach((s, c) => usedInCol[c].add(s));
      grid.push(symOf);
    }
    if (ok) return grid;
  }
}

function cut(rand: () => number, grid: number[][]): Cage[] {
  const owner = Array.from({ length: N }, () => new Array<number>(N).fill(-1));
  const groups: [number, number][][] = [];
  const sizes = [1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5];
  const order = shuffle(
    rand,
    [...Array(N * N).keys()].map((i) => [Math.floor(i / N), i % N] as [number, number]),
  );
  for (const [r0, c0] of order) {
    if (owner[r0][c0] !== -1) continue;
    const want = sizes[Math.floor(rand() * sizes.length)];
    const cells: [number, number][] = [[r0, c0]];
    owner[r0][c0] = groups.length;
    while (cells.length < want) {
      const frontier: [number, number][] = [];
      for (const [r, c] of cells) {
        for (const [dr, dc] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nr = r + dr,
            nc = c + dc;
          if (nr >= 0 && nr < N && nc >= 0 && nc < N && owner[nr][nc] === -1)
            frontier.push([nr, nc]);
        }
      }
      if (!frontier.length) break;
      const [nr, nc] = frontier[Math.floor(rand() * frontier.length)];
      owner[nr][nc] = groups.length;
      cells.push([nr, nc]);
    }
    groups.push(cells);
  }

  /* No more than three single cells: each one is a free digit. The rest are
     folded into a neighbouring cage that still has room. */
  let singles = groups.filter((g) => g.length === 1).length;
  for (let g = 0; g < groups.length && singles > 3; g++) {
    if (groups[g].length !== 1) continue;
    const [r, c] = groups[g][0];
    for (const [dr, dc] of shuffle(rand, [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])) {
      const nr = r + dr,
        nc = c + dc;
      if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
      const into = owner[nr][nc];
      if (into === g || groups[into].length >= 6 || groups[into].length === 0) continue;
      groups[into].push([r, c]);
      owner[r][c] = into;
      groups[g] = [];
      singles--;
      break;
    }
  }

  return groups
    .filter((g) => g.length)
    .map((cells) => {
      const values = cells.map(([r, c]) => grid[r][c]);
      if (cells.length === 1) return { cells, op: '=' as Op, target: values[0] };
      let op: Op;
      let target: number;
      if (cells.length === 2) {
        const [hi, lo] = values[0] > values[1] ? values : [values[1], values[0]];
        const pick = rand();
        if (hi % lo === 0 && pick < 0.45) {
          op = '/';
          target = hi / lo;
        } else if (pick < 0.7) {
          op = '-';
          target = hi - lo;
        } else if (pick < 0.85) {
          op = '+';
          target = hi + lo;
        } else {
          op = '*';
          target = hi * lo;
        }
      } else if (rand() < 0.55) {
        op = '+';
        target = values.reduce((a, b) => a + b, 0);
      } else {
        op = '*';
        target = values.reduce((a, b) => a * b, 1);
      }
      /* A quarter of the cages keep their operation to themselves. */
      if (rand() < 0.25) op = '?';
      return { cells, op, target };
    });
}

function satisfies(values: number[], op: Op, target: number): boolean {
  const sum = values.reduce((a, b) => a + b, 0);
  const product = values.reduce((a, b) => a * b, 1);
  const pair = values.length === 2;
  const hi = Math.max(...values),
    lo = Math.min(...values);
  switch (op) {
    case '=':
      return values.length === 1 && values[0] === target;
    case '+':
      return sum === target;
    case '*':
      return product === target;
    case '-':
      return pair && hi - lo === target;
    case '/':
      return pair && hi % lo === 0 && hi / lo === target;
    case '?':
      return (
        sum === target ||
        product === target ||
        (pair && (hi - lo === target || (hi % lo === 0 && hi / lo === target)))
      );
  }
}

function parseGrid(answer: unknown): number[][] | string {
  const rows = (answer as { grid?: unknown })?.grid ?? answer;
  if (!Array.isArray(rows) || rows.length !== N) return 'Send grid as 9 rows';
  const grid: number[][] = [];
  for (const [i, row] of rows.entries()) {
    const cells = typeof row === 'string' ? row.split('').map(Number) : row;
    if (!Array.isArray(cells) || cells.length !== N) return `Row ${i + 1} needs 9 digits`;
    if (cells.some((v) => !Number.isInteger(v) || v < 1 || v > N)) {
      return `Row ${i + 1} must use only the digits 1–9`;
    }
    grid.push(cells as number[]);
  }
  return grid;
}

export const cageLock: Challenge = {
  slug: 'cage-lock',
  title: 'Cage Lock',
  kind: 'solve',
  summary: 'A 9×9 KenKen with no givens — and a quarter of the operations hidden.',
  rules: [
    'Fill the 9×9 grid so every row and every column contains each digit 1–9 exactly once.',
    'Each cage lists its cells as [row, column] pairs, counted from 0, with an operation and a target.',
    '+ and * cages: the digits sum or multiply to the target. Digits may repeat inside a cage if row and column allow it.',
    '- and / cages always have two cells: the larger digit minus, or divided by, the smaller gives the target.',
    '= cages are a single cell holding the target.',
    '? cages hide their operation: any of +, *, and (for two cells) - or / that makes the target is accepted.',
    'Any grid that keeps every rule is correct — you do not need to find a particular solution.',
  ],
  answerFormat:
    '{ "grid": ["123456789", …] } — nine strings of nine digits, top row first. Nine arrays of numbers also work.',
  limitMs: 10 * 60_000,
  base: 300,

  generate(seed: number): Generated {
    const rand = seeded(seed);
    const solution = latinSquare(rand);
    const cages = cut(rand, solution);
    return {
      puzzle: { size: N, cages },
      secret: { solution: solution.map((row) => row.join('')) },
    };
  },

  grade(generated: Generated, answer: unknown): Graded {
    const grid = parseGrid(answer);
    if (typeof grid === 'string') return { quality: 0, detail: grid };
    for (let i = 0; i < N; i++) {
      if (new Set(grid[i]).size !== N)
        return { quality: 0, detail: `Row ${i + 1} repeats a digit` };
      if (new Set(grid.map((row) => row[i])).size !== N) {
        return { quality: 0, detail: `Column ${i + 1} repeats a digit` };
      }
    }
    const cages = (generated.puzzle as { cages: Cage[] }).cages;
    for (const [index, cage] of cages.entries()) {
      const values = cage.cells.map(([r, c]) => grid[r][c]);
      if (!satisfies(values, cage.op, cage.target)) {
        return {
          quality: 0,
          detail: `Cage ${index} (${cage.op} ${cage.target}) is not satisfied by ${values.join(', ')}`,
        };
      }
    }
    return {
      quality: 1,
      detail: 'Every row, column and cage holds',
      stats: { cages: cages.length },
    };
  },
};
