import type { AppState } from '../state/AppState';
import type { AssetManager } from '../assets/AssetManager';
import type { RenderDims } from '../render/coords';
import { render } from '../render/Renderer';
import { deriveCinematicMoments, type CinematicMoment } from '../state/moments';
import { frameCount, frameIndexToTimeMs } from './FrameSource';
import { drawCaptions } from './drawCaptions';
import type { Encoder } from './Encoder';

/**
 * Renders exactly one export frame at the deterministic time for
 * frameIndex. Calls the same render/Renderer.render used by
 * preview/PreviewLoop.previewTick — see docs/architecture.md
 * Correction 6.
 */
export function renderExportFrame(
  state: AppState,
  frameIndex: number,
  fps: number,
  ctx: OffscreenCanvasRenderingContext2D,
  dims: RenderDims,
  assets: AssetManager<HTMLImageElement>
): void {
  const logicalTimeMs = frameIndexToTimeMs(frameIndex, fps);
  render(state, logicalTimeMs, ctx, dims, assets);
}

export interface RunExportOptions {
  fps: number;
  dims: RenderDims;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  /**
   * Phase 6 — burns the Moments panel's own narrative text into export
   * frames. Explicit opt-in, defaulting to off/undefined: runExport is
   * shared by both "Export PNG sequence" and "Export Video"
   * (ui/panel.ts's handleExport/handleExportVideo both call this same
   * function with different Encoders), and the Phase 6 investigation
   * scoped captions to the video export only — the PNG sequence must stay
   * byte-for-byte unchanged. Only ui/panel.ts's video-export call site
   * sets this true.
   */
  captions?: boolean;
}

/**
 * Phase 6 — the same CinematicMoment[] the Moments UI panel already
 * computes (state/moments.ts's deriveCinematicMoments), consumed here
 * read-only to burn captions into exported frames. Requires a completed
 * analysis AND a completed cinematic direction run (both may legitimately
 * be absent — e.g. a game exported straight off Phase 1's trivial
 * timeline, before "Generate Cinematic" is ever clicked); in that case
 * there is no narrative to show, so this safely returns no Moments rather
 * than failing the export.
 */
function momentsFor(state: AppState): readonly CinematicMoment[] {
  if (!state.game || !state.analysis.result || !state.direction.result) return [];
  const { cinematicPlan, understanding, story } = state.direction.result;
  return deriveCinematicMoments(cinematicPlan, state.game.timeline, state.analysis.result, understanding, story);
}

/**
 * Drives frame production and encoding with backpressure. Exactly one
 * frame is rendered into a single reused OffscreenCanvas, handed to the
 * encoder, and awaited before the next frame is rendered — no array of
 * frames or blobs is ever accumulated (docs/architecture.md
 * Correction 4). Frame timing is computed by FrameSource, never sampled
 * from a clock, so a given AppState always produces identical output.
 */
export async function runExport(
  state: AppState,
  assets: AssetManager<HTMLImageElement>,
  encoder: Encoder,
  opts: RunExportOptions
): Promise<Blob | null> {
  const scene = state.game?.timeline.scenes.find((s) => s.id === state.playback.activeSceneId);
  if (!state.game || !scene) {
    throw new Error('runExport: no loaded game or active scene to export');
  }

  const total = frameCount(scene.durationMs, opts.fps);
  await encoder.start({ width: opts.dims.width, height: opts.dims.height, fps: opts.fps });

  const canvas = new OffscreenCanvas(opts.dims.width, opts.dims.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('runExport: could not acquire a 2D context on OffscreenCanvas');

  // Computed once, outside the frame loop — deriveCinematicMoments is pure
  // and its inputs don't change frame to frame. Phase 6: burns the same
  // narrative already shown in the Moments UI panel into export frames
  // only (never into preview/PreviewLoop's own draw path — see
  // drawCaptions.ts's own module comment). Empty when opts.captions isn't
  // set, so the PNG-sequence export path never pays even the cost of
  // deriving Moments, let alone drawing them.
  const moments = opts.captions ? momentsFor(state) : [];

  for (let frameIndex = 0; frameIndex < total; frameIndex++) {
    const logicalTimeMs = frameIndexToTimeMs(frameIndex, opts.fps);
    renderExportFrame(state, frameIndex, opts.fps, ctx, opts.dims, assets);
    if (opts.captions) drawCaptions(ctx, moments, logicalTimeMs, opts.dims);
    await encoder.addFrame(canvas, frameIndex);
    opts.onProgress?.(frameIndex + 1, total);
  }

  return encoder.finish();
}
