import type { AppState } from '../state/AppState';
import type { AssetManager } from '../assets/AssetManager';
import type { RenderDims } from './coords';
import type { Ctx2D } from './Ctx2D';
import { resolveCamera } from './resolveCamera';
import { resolvePosition, excludedSquares } from './resolvePosition';
import { resolveAnimations } from './resolveAnimations';
import { drawBoard } from './drawBoard';
import { drawPieces } from './drawPieces';
import { drawAnnotations } from './drawAnnotations';

/**
 * The single function allowed to issue board-drawing canvas calls.
 * preview/PreviewLoop and export/runExport both call this function —
 * not a copy of it — with different time sources and different canvas
 * targets. See docs/architecture.md Correction 6 (the renderer-parity
 * acceptance test) and §16.
 *
 * Pure with respect to its arguments: reads only state, logicalTimeMs,
 * dims, and already-loaded images out of `assets`. Never reads
 * Date.now(), performance.now(), or any module-level mutable variable.
 * Given the same arguments, it always draws the same pixels.
 */
export function render(
  state: AppState,
  logicalTimeMs: number,
  ctx: Ctx2D,
  dims: RenderDims,
  assets: AssetManager<HTMLImageElement>
): void {
  ctx.clearRect(0, 0, dims.width, dims.height);

  if (!state.game || assets.getState() !== 'ready') return;

  const scene = state.game.timeline.scenes.find((s) => s.id === state.playback.activeSceneId);
  if (!scene) return;

  const camera = resolveCamera(scene.cameraPlan, logicalTimeMs);
  const { baseFen, activeBeats } = resolvePosition(state.game.gameRecord, scene, logicalTimeMs);
  const excluded = excludedSquares(activeBeats);
  const animated = resolveAnimations(baseFen, activeBeats, logicalTimeMs);

  drawBoard(ctx, camera, dims);
  drawPieces(ctx, baseFen, excluded, animated, assets, camera, dims);
  drawAnnotations(ctx, scene, logicalTimeMs, camera, dims);
}
