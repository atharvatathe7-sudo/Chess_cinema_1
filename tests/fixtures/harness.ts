import { ChessJsEngine } from '../../src/chess/ChessJsEngine';
import { AssetManager } from '../../src/assets/AssetManager';
import { PIECE_MANIFEST } from '../../src/assets/pieceManifest';
import { loadImage } from '../../src/assets/browserPieceLoader';
import { createInitialState, type AppState } from '../../src/state/AppState';
import { Store } from '../../src/state/store';
import { loadPgn, seekTo } from '../../src/state/actions';
import { previewTick } from '../../src/preview/PreviewLoop';
import { renderExportFrame, runExport, type RunExportOptions } from '../../src/export/runExport';
import { PngSequenceEncoder } from '../../src/export/PngSequenceEncoder';
import type { Encoder } from '../../src/export/Encoder';
import { render } from '../../src/render/Renderer';
import type { RenderDims } from '../../src/render/coords';
import { validateTimeline } from '../../src/timeline/invariants';
import type { Timeline } from '../../src/timeline/types';

const assets = new AssetManager<HTMLImageElement>(PIECE_MANIFEST, loadImage);
const assetsReady = assets.load();

function ctxOf(canvasId: string): CanvasRenderingContext2D {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`harness: no 2d context for #${canvasId}`);
  return ctx;
}

function dimsOf(canvasId: string): RenderDims {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
  return { width: canvas.width, height: canvas.height };
}

function hashImageData(data: Uint8ClampedArray | Uint8Array): string {
  // FNV-1a, good enough to detect any pixel difference for test purposes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const harness = {
  assets,

  async ready(): Promise<void> {
    const result = await assetsReady;
    if (!result.ok) throw new Error(`harness: asset load failed: ${result.error.message}`);
  },

  buildFixtureState(pgn: string): AppState {
    const store = new Store<AppState>(createInitialState());
    const result = loadPgn(store, pgn, new ChessJsEngine());
    if (!result.ok) throw new Error(`harness: fixture PGN failed to parse: ${result.error.message}`);
    return store.getState();
  },

  buildFixtureStore(pgn: string): Store<AppState> {
    const store = new Store<AppState>(createInitialState());
    const result = loadPgn(store, pgn, new ChessJsEngine());
    if (!result.ok) throw new Error(`harness: fixture PGN failed to parse: ${result.error.message}`);
    return store;
  },

  withTimeMs(state: AppState, logicalTimeMs: number): AppState {
    return { ...state, playback: { ...state.playback, logicalTimeMs } };
  },

  /** Calls render/Renderer.render directly. */
  renderDirect(canvasId: string, state: AppState, logicalTimeMs: number): void {
    render(state, logicalTimeMs, ctxOf(canvasId), dimsOf(canvasId), assets);
  },

  /** Renders via the exact preview code path (preview/PreviewLoop.previewTick). */
  renderViaPreview(canvasId: string, pgn: string, logicalTimeMs: number): void {
    const store = harness.buildFixtureStore(pgn);
    seekTo(store, logicalTimeMs);
    previewTick(store, ctxOf(canvasId), dimsOf(canvasId), assets);
  },

  /** Renders via the exact export code path (export/runExport.renderExportFrame), fps=1 so frameIndex*1000ms = logicalTimeMs. */
  renderViaExport(canvasId: string, pgn: string, logicalTimeMs: number): void {
    const state = harness.buildFixtureState(pgn);
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
    const octx = offscreen.getContext('2d')!;
    // fps chosen so frameIndex 1 lands exactly on logicalTimeMs.
    const fps = 1000;
    renderExportFrame(state, logicalTimeMs, fps, octx, dimsOf(canvasId), assets);
    const visibleCtx = ctxOf(canvasId);
    visibleCtx.clearRect(0, 0, canvas.width, canvas.height);
    visibleCtx.drawImage(offscreen, 0, 0);
  },

  hashCanvas(canvasId: string): string {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    const ctx = ctxOf(canvasId);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return hashImageData(data);
  },

  validateTimeline(timeline: Timeline) {
    return validateTimeline(timeline);
  },

  async hashExportOnce(pgn: string, dims: RenderDims, fps: number): Promise<string> {
    const state = harness.buildFixtureState(pgn);
    const encoder = new PngSequenceEncoder();
    const blob = await runExport(state, assets, encoder, { fps, dims });
    const bytes = new Uint8Array(await (blob as Blob).arrayBuffer());
    return hashImageData(bytes);
  },

  async exportPeakFramesInFlight(pgn: string, dims: RenderDims, fps: number): Promise<number> {
    const state = harness.buildFixtureState(pgn);
    let inFlight = 0;
    let peak = 0;
    const instrumented: Encoder = {
      start() {},
      async addFrame() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      },
      async finish() {
        return null;
      }
    };
    const opts: RunExportOptions = { fps, dims };
    await runExport(state, assets, instrumented, opts);
    return peak;
  }
};

(window as unknown as { __harness: typeof harness }).__harness = harness;
