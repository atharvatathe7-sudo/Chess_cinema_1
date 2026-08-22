/**
 * Supplies the Stockfish engine bytes to the worker layer.
 *
 * There is exactly ONE way the engine is started (blob URL for the glue
 * script, blob URL for the .wasm, wired together through the script URL's
 * hash fragment — the mechanism stockfish.js itself documents). Only the
 * *source of the bytes* varies:
 *
 *   - Normal build / dev server: fetched from the site's own /engine/ path,
 *     where Vite copies them verbatim from public/.
 *   - Self-contained single-file build (the Claude Artifact used for phone
 *     testing): the same bytes are inlined as base64 on window, because that
 *     deployment target serves exactly one HTML file and cannot host a
 *     separate 7 MB asset.
 *
 * Both paths converge on the same blob URLs and the same worker construction,
 * so there is no second engine integration to keep in sync.
 */

const GLUE_FILENAME = 'stockfish-18-lite-single.js';
const WASM_FILENAME = 'stockfish-18-lite-single.wasm';

/** Shape of the inline payload embedded by scripts/build-artifact.mjs. */
interface InlineEngine {
  readonly glue: string;
  readonly wasmBase64: string;
}

declare global {
  interface Window {
    __CHESS_CINEMA_ENGINE__?: InlineEngine;
  }
}

export interface EngineAssets {
  /** The Emscripten glue script source. */
  readonly glue: string;
  /** The raw WebAssembly binary. */
  readonly wasm: ArrayBuffer;
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** True when the page carries the engine inline (single-file/Artifact build). */
export function hasInlineEngine(): boolean {
  return typeof window !== 'undefined' && window.__CHESS_CINEMA_ENGINE__ !== undefined;
}

export async function loadEngineAssets(): Promise<EngineAssets> {
  const inline = typeof window !== 'undefined' ? window.__CHESS_CINEMA_ENGINE__ : undefined;
  if (inline) {
    return { glue: inline.glue, wasm: decodeBase64(inline.wasmBase64) };
  }

  const base = import.meta.env.BASE_URL ?? '/';
  const [glue, wasm] = await Promise.all([
    fetch(`${base}engine/${GLUE_FILENAME}`).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch engine script: HTTP ${r.status}`);
      return r.text();
    }),
    fetch(`${base}engine/${WASM_FILENAME}`).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch engine wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
  ]);
  return { glue, wasm };
}

export interface EngineWorkerUrls {
  /** URL to pass to `new Worker(...)`, already carrying the wasm location in its hash. */
  readonly workerUrl: string;
  /** Call when the worker is disposed, to release both object URLs. */
  readonly revoke: () => void;
}

/** Chunked to avoid blowing the call-stack limit of String.fromCharCode(...bytes) on a ~7 MB array. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Diagnosed against the real Claude Artifact sandbox (see the standalone
 * Stockfish Load Diagnostic): Worker creation and the glue script's own
 * top-level execution both succeed there — `worker-src blob:` is allowed —
 * but the glue script's internal `fetch(wasmBlobUrl)` call fails outright,
 * consistent with `connect-src` not permitting `blob:` even though
 * `worker-src` does. Those are independent CSP directives.
 *
 * This prelude is prepended to the worker script, ahead of the unmodified
 * Stockfish glue code, and overrides `self.fetch` so a request for the
 * engine's own wasm URL resolves from an ArrayBuffer already embedded in
 * this same script — a plain in-memory Response, never a network or blob
 * request — so it is invisible to connect-src entirely. Every other fetch
 * (there is no other one in the glue script) passes through untouched.
 */
function buildWasmFetchInterceptPrelude(wasmUrl: string, wasmBase64: string): string {
  return [
    '(function () {',
    `  var WASM_URL = ${JSON.stringify(wasmUrl)};`,
    `  var WASM_BASE64 = ${JSON.stringify(wasmBase64)};`,
    '  var binary = atob(WASM_BASE64);',
    '  var bytes = new Uint8Array(binary.length);',
    '  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);',
    '  var originalFetch = typeof self.fetch === "function" ? self.fetch.bind(self) : null;',
    '  self.fetch = function (input, init) {',
    '    var url = typeof input === "string" ? input : (input && input.url) || String(input);',
    '    if (url === WASM_URL) {',
    '      return Promise.resolve(new Response(bytes.slice(), {',
    '        status: 200,',
    '        headers: { "Content-Type": "application/wasm" }',
    '      }));',
    '    }',
    '    if (!originalFetch) return Promise.reject(new Error("fetch is not available in this worker"));',
    '    return originalFetch(input, init);',
    '  };',
    '})();'
  ].join('\n');
}

/**
 * Turns engine bytes into a ready-to-use worker URL.
 *
 * stockfish.js, when loaded as a worker script, reads the location of its
 * .wasm from its own URL's hash fragment (falling back to a sibling .wasm
 * path). The wasm blob URL is still created and still wired through the
 * hash exactly as before — the glue script is unmodified and still expects
 * it there — but the fetch prelude above means that URL is answered from
 * memory rather than actually fetched, so its bytes never need to cross the
 * network or blob storage at all. The wasm blob must still carry the
 * correct MIME type for anything that DOES resolve it normally (the plain
 * Vite build has no reason to fail that fetch, so this keeps working
 * identically there too, just without depending on it).
 */
export function createEngineWorkerUrls(assets: EngineAssets): EngineWorkerUrls {
  const wasmUrl = URL.createObjectURL(new Blob([assets.wasm], { type: 'application/wasm' }));
  const prelude = buildWasmFetchInterceptPrelude(wasmUrl, toBase64(assets.wasm));
  const workerSource = `${prelude}\n${assets.glue}`;
  const glueUrl = URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' }));
  return {
    workerUrl: `${glueUrl}#${encodeURIComponent(wasmUrl)}`,
    revoke: () => {
      URL.revokeObjectURL(wasmUrl);
      URL.revokeObjectURL(glueUrl);
    }
  };
}
