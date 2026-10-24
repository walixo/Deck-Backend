import type { AgentGameConfig, CheckResult, IAgentGame } from '../../../models/AgentGame';
import type { IUser } from '../../../models/User';
import type { Challenge, Generated } from '../types';
import { hostedRunner } from './hosted';
import { ChallengeError, parseReply, type Call, type Runner } from './protocol';
import { wasmRunner } from './wasm';

/**
 * Community challenges as ordinary challenges: whichever runtime a game uses,
 * the controller sees the same `Challenge` the built-in games present.
 */

export type Version = 'draft' | 'live';

export function configOf(game: IAgentGame, version: Version): AgentGameConfig {
  if (version === 'live') {
    if (!game.live) throw new ChallengeError('This challenge has no approved version');
    return game.live;
  }
  return {
    title: game.title,
    kind: game.kind,
    summary: game.summary,
    rules: game.rules,
    answerFormat: game.answerFormat,
    limitMs: game.limitMs,
    runtime: game.runtime,
    endpointUrl: game.endpointUrl,
    moduleSha: game.moduleSha,
  };
}

function runnerFor(game: IAgentGame, config: AgentGameConfig): Runner {
  if (config.runtime === 'hosted') {
    if (!config.endpointUrl) throw new ChallengeError('No endpoint is set');
    return hostedRunner(config.endpointUrl, game.signingSecret, game.slug);
  }
  if (!config.moduleSha) throw new ChallengeError('No module has been uploaded');
  return wasmRunner(config.moduleSha);
}

async function ask<C extends Call>(runner: Runner, call: C, input: Record<string, unknown>) {
  return parseReply(call, await runner.call(call, input));
}

/** A game, in one of its versions, as a playable challenge. Load it with `+signingSecret`. */
export function communityChallenge(game: IAgentGame, version: Version): Challenge {
  const config = configOf(game, version);
  const runner = runnerFor(game, config);
  const owner = game.owner as unknown as IUser | null;
  return {
    slug: game.slug,
    title: config.title,
    kind: config.kind,
    summary: config.summary,
    rules: config.rules,
    answerFormat: config.answerFormat,
    limitMs: config.limitMs,
    base: game.base,
    author: owner?.gameId?.handle ? { handle: owner.gameId.handle } : null,
    async generate(seed) {
      const reply = await ask(runner, 'generate', { seed });
      return { puzzle: reply.puzzle, secret: reply.secret, state: reply.state };
    },
    async grade(generated, answer) {
      const reply = await ask(runner, 'grade', {
        puzzle: generated.puzzle,
        secret: generated.secret,
        answer,
      });
      return { quality: reply.quality, detail: reply.detail, stats: reply.stats };
    },
    ...(config.kind === 'explore' && {
      async step(secret, state, moves, puzzle) {
        return ask(runner, 'step', { puzzle: puzzle ?? {}, secret, state, moves });
      },
      async observe(secret, state, puzzle) {
        return (await ask(runner, 'observe', { puzzle: puzzle ?? {}, secret, state })).observation;
      },
    }),
  };
}

/* ---------------------------------------------------------------- checks --- */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Secret values long enough that finding them in the puzzle means a leak. */
function revealing(secret: unknown, out: string[] = []): string[] {
  if (typeof secret === 'string' && secret.length >= 6) out.push(JSON.stringify(secret));
  else if (Array.isArray(secret)) {
    const json = JSON.stringify(secret);
    if (json.length >= 12) out.push(json);
    secret.forEach((v) => revealing(v, out));
  } else if (secret && typeof secret === 'object') {
    Object.values(secret).forEach((v) => revealing(v, out));
  }
  return out;
}

/**
 * The automatic checks a game must pass before it can be submitted:
 * determinism, variety, no leaked secrets, a solved answer scoring full
 * marks and garbage scoring nothing, and every call answering in time.
 */
export async function runChecks(
  game: IAgentGame,
): Promise<{ passed: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });
  const config = configOf(game, 'draft');
  let slowest = 0;
  let runner: Runner;
  try {
    runner = runnerFor(game, config);
  } catch (error) {
    add('Runtime', false, (error as Error).message);
    return { passed: false, results };
  }
  const timed = async <C extends Call>(call: C, input: Record<string, unknown>) => {
    const started = Date.now();
    try {
      return await ask(runner, call, input);
    } finally {
      slowest = Math.max(slowest, Date.now() - started);
    }
  };

  let first: Generated;
  try {
    const [a, b, c] = [
      await timed('generate', { seed: 1234567 }),
      await timed('generate', { seed: 1234567 }),
      await timed('generate', { seed: 7654321 }),
    ];
    first = a;
    add('Generates a puzzle', true, 'generate answered in the right shape');
    add(
      'Same seed, same puzzle',
      same(a, b),
      same(a, b)
        ? 'Two runs with one seed matched exactly'
        : 'Two runs with the same seed gave different puzzles',
    );
    add(
      'Different seeds, different puzzles',
      !same(a.puzzle, c.puzzle),
      same(a.puzzle, c.puzzle)
        ? 'Two seeds gave the same puzzle'
        : 'Two seeds gave different puzzles',
    );
    if (config.kind === 'explore')
      add(
        'Starts with state',
        Boolean(a.state),
        a.state
          ? 'generate returned a starting state'
          : 'Explore challenges must return state from generate',
      );
    const puzzleJson = JSON.stringify(a.puzzle);
    const leaks = revealing(a.secret).filter((value) => puzzleJson.includes(value));
    add(
      'Puzzle keeps the secret',
      !leaks.length,
      leaks.length
        ? `The puzzle contains ${leaks[0].slice(0, 60)} from the secret`
        : 'Nothing from the secret appears in the puzzle',
    );
  } catch (error) {
    add('Generates a puzzle', false, (error as Error).message);
    return { passed: false, results };
  }

  try {
    const solved = await timed('solve', { puzzle: first.puzzle, secret: first.secret });
    if (config.kind === 'explore') {
      let state = first.state ?? {};
      let finished: { quality: number; detail: string } | undefined;
      const moves = solved.moves ?? '';
      for (let i = 0; i < moves.length && !finished; i += 32) {
        const reply = await timed('step', {
          puzzle: first.puzzle,
          secret: first.secret,
          state,
          moves: moves.slice(i, i + 32),
        });
        state = reply.state;
        finished = reply.finished;
      }
      add(
        'A solved run finishes',
        Boolean(finished && finished.quality > 0),
        finished
          ? `solve's moves finished with quality ${finished.quality}`
          : 'solve’s moves did not finish the run',
      );
      await timed('observe', {
        puzzle: first.puzzle,
        secret: first.secret,
        state: first.state ?? {},
      });
      const garbage = await timed('step', {
        puzzle: first.puzzle,
        secret: first.secret,
        state: first.state ?? {},
        moves: 'NNNNSSSSEEEEWWWW',
      });
      add(
        'Survives wrong moves',
        !garbage.finished || garbage.finished.quality < 1,
        'step handled aimless moves without crashing',
      );
    } else {
      const right = await timed('grade', {
        puzzle: first.puzzle,
        secret: first.secret,
        answer: solved.answer,
      });
      add(
        'A solved answer scores full marks',
        right.quality >= 0.99,
        `solve’s answer graded ${right.quality}${right.detail ? ` — ${right.detail}` : ''}`,
      );
      const wrong = await Promise.all([
        timed('grade', { puzzle: first.puzzle, secret: first.secret, answer: null }),
        timed('grade', { puzzle: first.puzzle, secret: first.secret, answer: { nonsense: true } }),
      ]);
      add(
        'Garbage scores nothing',
        wrong.every((r) => r.quality === 0),
        wrong.every((r) => r.quality === 0)
          ? 'null and a nonsense answer both graded 0'
          : 'A nonsense answer scored above 0',
      );
    }
  } catch (error) {
    add('Solves and grades', false, (error as Error).message);
  }

  add('Answers quickly', slowest <= 2000, `Slowest call took ${slowest} ms (limit 2000 ms)`);
  return { passed: results.every((r) => r.ok), results };
}
