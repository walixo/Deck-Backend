import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AgentGameModule } from '../../../models/AgentGame';
import { ChallengeError, type Call, type Runner } from './protocol';

/**
 * WebAssembly challenges: a module the developer uploads, run by Deck.
 *
 * The module is pure — it may import nothing, so it has no clock, no
 * randomness, no network and no files; the seed is its only source of
 * variety, which is what makes it deterministic. It exports its memory, an
 * `alloc(size) → pointer`, and one function per call:
 *
 *   generate · grade · solve, and step · observe for explore challenges
 *   (pointer: i32, length: i32) → i64   // (outPointer << 32) | outLength
 *
 * Input and output are UTF-8 JSON in the module's own memory. Each call runs
 * in a fresh worker thread that is stopped after two seconds, so a module that
 * loops forever costs one worker, not the API. Its memory must declare a
 * maximum of 256 MB, checked on upload.
 */

/* Node runs WebAssembly natively; this project's TypeScript libs just do not
   describe it, so the few parts used here are described locally. */
type WasmModule = object;
interface WasmApi {
  compile(bytes: Uint8Array): Promise<WasmModule>;
  Module: {
    imports(module: WasmModule): { module: string; name: string; kind: string }[];
    exports(module: WasmModule): { name: string; kind: string }[];
  };
}
const Wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

export const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 4096; // 64 KB pages: 256 MB
const CALL_TIMEOUT_MS = 2000;

const REQUIRED = ['memory', 'alloc', 'generate', 'grade'];
const EXPLORE = ['step', 'observe'];

function readLeb(bytes: Uint8Array, at: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result >>> 0, pos];
    shift += 7;
    if (shift > 35) throw new ChallengeError('The module is malformed');
  }
}

/** The memory section's limits, read straight from the binary. */
function memoryLimits(bytes: Uint8Array): { min: number; max: number | null } | null {
  let pos = 8;
  while (pos < bytes.length) {
    const id = bytes[pos++];
    const [size, start] = readLeb(bytes, pos);
    if (id === 5) {
      const [count, at] = readLeb(bytes, start);
      if (count === 0) return null;
      const flags = bytes[at];
      const [min, next] = readLeb(bytes, at + 1);
      const max = flags & 1 ? readLeb(bytes, next)[0] : null;
      return { min, max };
    }
    pos = start + size;
  }
  return null;
}

/**
 * Checks an upload: a valid module, no imports, the exports the challenge's
 * kind needs, and a capped memory. Returns its hash and export names.
 */
export async function inspectModule(
  bytes: Buffer,
  kind: string,
): Promise<{ sha: string; exports: string[] }> {
  if (bytes.length > MAX_MODULE_BYTES) throw new ChallengeError('Modules are limited to 2 MB');
  let module: WasmModule;
  try {
    module = await Wasm.compile(bytes);
  } catch (error) {
    throw new ChallengeError(`That is not a valid WebAssembly module: ${(error as Error).message}`);
  }
  const imports = Wasm.Module.imports(module);
  if (imports.length) {
    throw new ChallengeError(
      `The module may not import anything; it imports ${imports.map((i) => `${i.module}.${i.name}`).join(', ')}`,
    );
  }
  const exports = Wasm.Module.exports(module).map((e) => e.name);
  const needed = kind === 'explore' ? [...REQUIRED, ...EXPLORE] : REQUIRED;
  const missing = needed.filter((name) => !exports.includes(name));
  if (missing.length) throw new ChallengeError(`The module must export ${missing.join(', ')}`);
  const limits = memoryLimits(bytes);
  if (!limits || limits.max === null || limits.max > MAX_PAGES) {
    throw new ChallengeError(
      'The module’s memory must declare a maximum of 256 MB (4096 pages) or less',
    );
  }
  return { sha: crypto.createHash('sha256').update(bytes).digest('hex'), exports };
}

/* Compiled modules, by hash. A handful at most are hot at once. */
const compiled = new Map<string, WasmModule>();

async function moduleFor(sha: string): Promise<WasmModule> {
  const hit = compiled.get(sha);
  if (hit) return hit;
  const stored = await AgentGameModule.findOne({ sha }).select('bytes');
  if (!stored) throw new ChallengeError('The module for this challenge is missing');
  const module = await Wasm.compile(stored.bytes);
  if (compiled.size >= 24) compiled.delete(compiled.keys().next().value!);
  compiled.set(sha, module);
  return module;
}

/* Runs one call inside the worker. Plain JavaScript, passed as source, so it
   needs no file of its own in the build. */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { module, fn, input } = workerData;
try {
  const instance = new WebAssembly.Instance(module, {});
  const { memory, alloc } = instance.exports;
  const call = instance.exports[fn];
  if (typeof call !== 'function') throw new Error('The module does not export ' + fn);
  const bytes = new TextEncoder().encode(input);
  const ptr = alloc(bytes.length);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  const packed = BigInt.asUintN(64, BigInt(call(ptr, bytes.length)));
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  if (outLen > 524288) throw new Error('replied with over 512 KB');
  const out = new TextDecoder().decode(new Uint8Array(memory.buffer, outPtr, outLen));
  parentPort.postMessage({ ok: true, out });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
}
`;

function runInWorker(module: WasmModule, fn: Call, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { module, fn, input },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new ChallengeError(`${fn} took longer than ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    worker.once('message', (msg: { ok: boolean; out?: string; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok) resolve(msg.out!);
      else reject(new ChallengeError(`${fn} failed: ${msg.error}`));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(new ChallengeError(`${fn} crashed: ${error.message}`));
    });
  });
}

export function wasmRunner(sha: string): Runner {
  return {
    async call(call, input) {
      const module = await moduleFor(sha);
      const out = await runInWorker(module, call, JSON.stringify(input));
      try {
        return JSON.parse(out) as unknown;
      } catch {
        throw new ChallengeError(`${call} did not return JSON`);
      }
    },
  };
}
