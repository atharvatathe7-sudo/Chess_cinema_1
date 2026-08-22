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

/**
 * Turns engine bytes into a ready-to-use worker URL.
 *
 * stockfish.js, when loaded as a worker script, reads the location of its
 * .wasm from its own URL's hash fragment (falling back to a sibling .wasm
 * path). Passing a blob URL there is what lets the whole engine run without
 * any separately hosted file — verified working in Chromium, including on the
 * Artifact sandbox. The wasm blob must carry the correct MIME type because
 * the glue uses WebAssembly.instantiateStreaming, which rejects a response
 * that is not application/wasm.
 */
export function createEngineWorkerUrls(assets: EngineAssets): EngineWorkerUrls {
  const wasmUrl = URL.createObjectURL(new Blob([assets.wasm], { type: 'application/wasm' }));
  const glueUrl = URL.createObjectURL(new Blob([assets.glue], { type: 'application/javascript' }));
  return {
    workerUrl: `${glueUrl}#${encodeURIComponent(wasmUrl)}`,
    revoke: () => {
      URL.revokeObjectURL(wasmUrl);
      URL.revokeObjectURL(glueUrl);
    }
  };
}
