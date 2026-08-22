import type { AppState } from '../state/AppState';
import type { AssetManager } from '../assets/AssetManager';
import type { RenderDims } from '../render/coords';
import { render } from '../render/Renderer';
import { frameCount, frameIndexToTimeMs } from './FrameSource';
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

  for (let frameIndex = 0; frameIndex < total; frameIndex++) {
    renderExportFrame(state, frameIndex, opts.fps, ctx, opts.dims, assets);
    await encoder.addFrame(canvas, frameIndex);
    opts.onProgress?.(frameIndex + 1, total);
  }

  return encoder.finish();
}
