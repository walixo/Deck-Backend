import {
  seeded,
  shuffle,
  type Challenge,
  type Generated,
  type Graded,
  type StepResult,
} from './types';

/**
 * Undercroft — escape a dark maze you can only see two tiles of.
 *
 * A 41×41 maze, drawn fresh for every attempt and never shown whole. The agent
 * moves a step at a time through the API and is told what lies within two
 * tiles of it. The exit is behind a blue door; the blue key lies deep down a
 * branch behind a green door; the green key behind a red door; the red key
 * somewhere loose. Pits send you back to the start. Steps are limited.
 *
 * Fair by construction: the maze is a perfect maze — one route between any
 * two tiles — so every corridor is a chokepoint and the doors can be placed
 * where they must be passed. Pits only go where no required route runs. The
 * shortest escape is computed by search over (tile, keys held), and quality
 * compares your steps with it: within 1.2× the shortest is full marks.
 */

const SIZE = 41;
const CELLS = (SIZE - 1) / 2;
const VISION = 2;
const MAX_MOVES = 32;
const DIRS: Record<string, [number, number]> = { N: [-1, 0], E: [0, 1], S: [1, 0], W: [0, -1] };

type Tile = [number, number];
const key = (t: Tile) => `${t[0]},${t[1]}`;
const unkey = (k: string): Tile => k.split(',').map(Number) as Tile;

interface Secret {
  grid: string[];
  start: Tile;
  exit: Tile;
  optimal: number;
  budget: number;
}

interface State {
  pos: Tile;
  steps: number;
  keys: string;
  opened: string;
  taken: string;
  falls: number;
  escaped: boolean;
}

function carve(rand: () => number): string[][] {
  const g = Array.from({ length: SIZE }, () => new Array<string>(SIZE).fill('#'));
  const seen = Array.from({ length: CELLS }, () => new Array<boolean>(CELLS).fill(false));
  const stack: Tile[] = [[Math.floor(rand() * CELLS), Math.floor(rand() * CELLS)]];
  seen[stack[0][0]][stack[0][1]] = true;
  g[stack[0][0] * 2 + 1][stack[0][1] * 2 + 1] = '.';
  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const next = shuffle(rand, Object.values(DIRS)).find(([dr, dc]) => {
      const nr = r + dr,
        nc = c + dc;
      return nr >= 0 && nr < CELLS && nc >= 0 && nc < CELLS && !seen[nr][nc];
    });
    if (!next) {
      stack.pop();
      continue;
    }
    const [nr, nc] = [r + next[0], c + next[1]];
    seen[nr][nc] = true;
    g[r * 2 + 1 + next[0]][c * 2 + 1 + next[1]] = '.';
    g[nr * 2 + 1][nc * 2 + 1] = '.';
    stack.push([nr, nc]);
  }
  return g;
}

const floorAround = (g: string[][], [r, c]: Tile): Tile[] =>
  Object.values(DIRS)
    .map(([dr, dc]) => [r + dr, c + dc] as Tile)
    .filter(([nr, nc]) => g[nr]?.[nc] !== undefined && g[nr][nc] !== '#');

/** Distances and parents from one tile, never passing the blocked ones. */
function bfs(g: string[][], from: Tile, blocked: Set<string> = new Set()) {
  const dist = new Map<string, number>([[key(from), 0]]);
  const parent = new Map<string, string>();
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    for (const n of floorAround(g, at)) {
      const k = key(n);
      if (dist.has(k) || blocked.has(k)) continue;
      dist.set(k, dist.get(key(at))! + 1);
      parent.set(k, key(at));
      queue.push(n);
    }
  }
  return { dist, parent };
}

function pathFrom(parent: Map<string, string>, from: Tile, to: Tile): string[] {
  const path = [key(to)];
  while (path[0] !== key(from)) path.unshift(parent.get(path[0])!);
  return path;
}

/** How far each tile is from the nearest tile of a set. */
function depthFrom(g: string[][], sources: Iterable<string>): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Tile[] = [];
  for (const s of sources) {
    dist.set(s, 0);
    queue.push(unkey(s));
  }
  for (let i = 0; i < queue.length; i++) {
    for (const n of floorAround(g, queue[i])) {
      if (dist.has(key(n))) continue;
      dist.set(key(n), dist.get(key(queue[i]))! + 1);
      queue.push(n);
    }
  }
  return dist;
}

/** A dead end off the given routes, reachable, deep enough to hide a door in. */
function hideKey(
  g: string[][],
  rand: () => number,
  reachable: Map<string, number>,
  routes: Set<string>,
  minDepth: number,
): string | null {
  const depth = depthFrom(g, routes);
  const ends = [...reachable.keys()].filter(
    (k) =>
      !routes.has(k) && floorAround(g, unkey(k)).length === 1 && (depth.get(k) ?? 0) >= minDepth,
  );
  if (!ends.length) return null;
  ends.sort((a, b) => depth.get(b)! - depth.get(a)!);
  return ends[Math.floor(rand() * Math.min(5, ends.length))];
}

/** The shortest escape, by search over (tile, keys held). */
function shortest(grid: string[], start: Tile): number {
  const bit = (ch: string) => ({ r: 1, g: 2, b: 4 })[ch as 'r' | 'g' | 'b'] ?? 0;
  const seen = new Set<string>([`${key(start)}|0`]);
  let frontier: [Tile, number][] = [[start, 0]];
  for (let steps = 0; frontier.length; steps++) {
    const next: [Tile, number][] = [];
    for (const [[r, c], held] of frontier) {
      if (grid[r][c] === 'E') return steps;
      for (const [dr, dc] of Object.values(DIRS)) {
        const nr = r + dr,
          nc = c + dc;
        const ch = grid[nr]?.[nc];
        if (!ch || ch === '#' || ch === '^') continue;
        if ('RGB'.includes(ch) && !(held & bit(ch.toLowerCase()))) continue;
        const nextHeld = held | bit(ch);
        const k = `${nr},${nc}|${nextHeld}`;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push([[nr, nc], nextHeld]);
      }
    }
    frontier = next;
  }
  return -1;
}

function build(rand: () => number): Secret | null {
  const g = carve(rand);
  const cell = () =>
    [Math.floor(rand() * CELLS) * 2 + 1, Math.floor(rand() * CELLS) * 2 + 1] as Tile;
  const start = cell();
  const fromStart = bfs(g, start);
  const exitKey = [...fromStart.dist.entries()]
    .filter(([k]) => unkey(k).every((v) => v % 2 === 1))
    .sort((a, b) => b[1] - a[1])[0][0];
  const exit = unkey(exitKey);

  const main = pathFrom(fromStart.parent, start, exit);
  const blueDoor = main[Math.floor(main.length * 0.72)];
  const routes = new Set(main);

  const doors: string[] = [blueDoor];
  const keys: string[] = [];
  /* Blue key behind the green door, green behind red, red loose. */
  for (const minDepth of [10, 10, 6]) {
    const reach = bfs(g, start, new Set(doors)).dist;
    const k = hideKey(g, rand, reach, routes, minDepth);
    if (!k) return null;
    const route = pathFrom(bfs(g, start, new Set(doors)).parent, start, unkey(k));
    const branch = route.filter((t) => !routes.has(t));
    route.forEach((t) => routes.add(t));
    keys.push(k);
    if (keys.length < 3) {
      if (branch.length < 6) return null;
      doors.push(branch[Math.floor(branch.length / 2)]);
    }
  }

  const put = (k: string, ch: string) => {
    const [r, c] = unkey(k);
    g[r][c] = ch;
  };
  put(key(start), 'S');
  put(exitKey, 'E');
  ['B', 'G', 'R'].forEach((ch, i) => put(doors[i], ch));
  ['b', 'g', 'r'].forEach((ch, i) => put(keys[i], ch));

  /* Pits, only where no required route runs and never next to the start. */
  const open = [...fromStart.dist.entries()]
    .filter(([k, d]) => d >= 4 && !routes.has(k) && g[unkey(k)[0]][unkey(k)[1]] === '.')
    .map(([k]) => k);
  shuffle(rand, open)
    .slice(0, 18)
    .forEach((k) => put(k, '^'));

  const grid = g.map((row) => row.join(''));
  const optimal = shortest(grid, start);
  if (optimal < 0) return null;
  return { grid, start, exit, optimal, budget: Math.max(600, optimal * 3) };
}

function tileAt(secret: Secret, state: State, [r, c]: Tile): string {
  const ch = secret.grid[r]?.[c];
  if (ch === undefined) return ' ';
  if ('rgb'.includes(ch) && state.taken.includes(ch)) return '.';
  if ('RGB'.includes(ch) && state.opened.includes(ch)) return '.';
  return ch;
}

function look(secret: Secret, state: State) {
  const [r, c] = state.pos;
  const view: string[] = [];
  for (let dr = -VISION; dr <= VISION; dr++) {
    let row = '';
    for (let dc = -VISION; dc <= VISION; dc++) {
      row += dr === 0 && dc === 0 ? '@' : tileAt(secret, state, [r + dr, c + dc]);
    }
    view.push(row);
  }
  return {
    position: state.pos,
    steps: state.steps,
    budget: secret.budget,
    keys: state.keys.split(''),
    falls: state.falls,
    escaped: state.escaped,
    view,
  };
}

export const undercroft: Challenge = {
  slug: 'undercroft',
  title: 'Undercroft',
  kind: 'explore',
  summary: 'Escape a dark 41×41 maze through a chain of locked doors, seeing two tiles at a time.',
  rules: [
    'The maze is 41×41 and is never shown whole. After every call you see the 5×5 tiles around you; you are @ at the centre.',
    'Move with N, E, S and W, up to 32 moves per call. Every move costs a step, including walking into a wall.',
    'Legend: # wall, . floor, S start, E exit, r g b keys, R G B locked doors, ^ pit, a space is outside the maze.',
    'Step onto a key to pick it up. Walk into a door holding its key to open it; without the key you bump and stay put.',
    'The exit is behind the blue door. The keys are chained: one door must be opened to reach the next key.',
    'Step into a pit and you climb out back at the start, keeping your keys.',
    'Reach E to finish. Run out of steps, or time, and the attempt scores 0.',
    'Quality = min(1, 1.2 × shortest possible steps ÷ your steps). The shortest route is computed with the whole map, which you do not have. The step budget is 3× the shortest route.',
  ],
  answerFormat:
    'POST moves: { "moves": "NNEESW" } — up to 32 of N, E, S, W per call. There is no answer to submit; reaching E grades the run.',
  limitMs: 20 * 60_000,
  base: 400,

  generate(seed: number): Generated {
    for (let attempt = 0; ; attempt++) {
      const secret = build(seeded(seed + attempt * 7919));
      if (!secret) continue;
      const state: State = {
        pos: secret.start,
        steps: 0,
        keys: '',
        opened: '',
        taken: '',
        falls: 0,
        escaped: false,
      };
      return {
        puzzle: {
          width: SIZE,
          height: SIZE,
          vision: VISION,
          budget: secret.budget,
          start: secret.start,
          maxMovesPerCall: MAX_MOVES,
        },
        secret: secret as unknown as Record<string, unknown>,
        state: state as unknown as Record<string, unknown>,
      };
    }
  },

  observe(secret, state) {
    return look(secret as unknown as Secret, state as unknown as State);
  },

  step(secretIn, stateIn, moves): StepResult {
    const secret = secretIn as unknown as Secret;
    const state = { ...(stateIn as unknown as State) };
    const events: string[] = [];
    let finished: Graded | undefined;

    for (const m of moves.slice(0, MAX_MOVES)) {
      if (state.escaped || state.steps >= secret.budget) break;
      const [dr, dc] = DIRS[m];
      const target: Tile = [state.pos[0] + dr, state.pos[1] + dc];
      const ch = tileAt(secret, state, target);
      state.steps++;
      if (ch === '#' || ch === ' ') {
        events.push(`${m}: wall`);
        continue;
      }
      if ('RGB'.includes(ch)) {
        const needed = ch.toLowerCase();
        if (!state.keys.includes(needed)) {
          events.push(`${m}: the ${{ R: 'red', G: 'green', B: 'blue' }[ch]} door is locked`);
          continue;
        }
        state.opened += ch;
        events.push(`${m}: opened the ${{ R: 'red', G: 'green', B: 'blue' }[ch]} door`);
      }
      if (ch === '^') {
        state.falls++;
        state.pos = secret.start;
        events.push(`${m}: fell into a pit — back at the start`);
        continue;
      }
      state.pos = target;
      if ('rgb'.includes(ch)) {
        state.keys += ch;
        state.taken += ch;
        events.push(`${m}: picked up the ${{ r: 'red', g: 'green', b: 'blue' }[ch]} key`);
      }
      if (ch === 'E') {
        state.escaped = true;
        events.push(`${m}: escaped`);
        finished = {
          quality: Math.round(Math.min(1, (1.2 * secret.optimal) / state.steps) * 10_000) / 10_000,
          detail: `Escaped in ${state.steps} steps; the shortest possible route was ${secret.optimal}`,
          stats: { steps: state.steps, optimal: secret.optimal, falls: state.falls },
        };
      }
    }

    if (!finished && state.steps >= secret.budget) {
      finished = {
        quality: 0,
        detail: `Out of steps after ${state.steps}; the exit was not reached`,
        stats: { steps: state.steps, optimal: secret.optimal, falls: state.falls },
      };
    }

    return {
      state: state as unknown as Record<string, unknown>,
      observation: { ...look(secret, state), events },
      finished,
    };
  },
};
