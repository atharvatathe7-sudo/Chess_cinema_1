import type { AppState } from '../state/AppState';
import type { AssetManager } from '../assets/AssetManager';
import { computeViewport, type RenderDims } from './coords';
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

  // Phase 9 — drawBoard/drawPieces/drawAnnotations each draw every square/
  // piece/annotation via boardToPixel with no clipping of their own, relying
  // on the canvas's own hard edge-clipping at [0,dims.width]x[0,dims.height]
  // to hide anything outside the intended crop. That was invisible at
  // square dims (the crop rectangle computeViewport computes always equals
  // the full canvas there — xOffset/yOffset are 0 for every zoom when
  // dims.width === dims.height), but at non-square dims the crop rectangle
  // is smaller than the canvas: at zoom > 1 with a panned/clamped camera
  // (e.g. any Phase 7B-clamped climax shot), squares straddling the crop's
  // edge painted their full, unclipped fill straight into the letterbox
  // band instead of leaving it black. Clipping to computeViewport's own
  // [xOffset, yOffset, visibleUnits*scale, visibleUnits*scale] rectangle —
  // the exact crop every boardToPixel call already targets — is a one-line
  // fix at the single call site all three draw functions share, with no
  // change to coords.ts's math or to any draw function itself. A no-op at
  // square dims, where that rectangle already equals the full canvas.
  const viewport = computeViewport(camera, dims);
  // visibleUnits*scale — the crop rectangle's own pixel size, same 8 (board
  // size in board-space units) coords.ts's own BOARD_SIZE constant uses;
  // this file doesn't import that constant (it's not exported), so this
  // matches the same "8" literal render/coords.test.ts's own Phase 7B/9
  // tests already use for the identical computation.
  const visibleUnits = 8 / camera.zoom;
  const cropSize = visibleUnits * viewport.scale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.xOffset, viewport.yOffset, cropSize, cropSize);
  ctx.clip();

  drawBoard(ctx, camera, dims);
  drawPieces(ctx, baseFen, excluded, animated, assets, camera, dims);
  drawAnnotations(ctx, scene, logicalTimeMs, camera, dims);

  ctx.restore();
}
