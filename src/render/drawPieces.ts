import type { Color, PieceType } from '../chess/ChessEngine';
import type { AssetManager } from '../assets/AssetManager';
import { boardToPixel, computeViewport, lerpPoint, squareCenter, type BoardPoint, type Camera, type RenderDims } from './coords';
import { parseFenPlacement } from './fen';
import type { AnimatedPieceFrame } from './resolveAnimations';
import type { Ctx2D } from './Ctx2D';

const PIECE_SCALE = 0.86;

function drawPieceAt(
  ctx: Ctx2D,
  assets: AssetManager<HTMLImageElement>,
  color: Color,
  type: PieceType,
  boardPoint: BoardPoint,
  camera: Camera,
  dims: RenderDims
): void {
  const img = assets.getPieceImage(color, type);
  if (!img) return; // Renderer already gates on assets being ready; this is defense in depth.
  const pixel = boardToPixel(camera, dims, boardPoint);
  const { scale } = computeViewport(camera, dims);
  const size = scale * PIECE_SCALE;
  ctx.drawImage(img, pixel.x - size / 2, pixel.y - size / 2, size, size);
}

/**
 * Draws every settled piece from baseFen (skipping squares an in-flight
 * animation owns) plus every animated piece at its current interpolated
 * position. Both draw through the same drawPieceAt helper, so a piece
 * looks identical whether it's static or mid-flight.
 */
export function drawPieces(
  ctx: Ctx2D,
  baseFen: string,
  excluded: ReadonlySet<string>,
  animated: readonly AnimatedPieceFrame[],
  assets: AssetManager<HTMLImageElement>,
  camera: Camera,
  dims: RenderDims
): void {
  const board = parseFenPlacement(baseFen);
  for (const [square, piece] of board) {
    if (excluded.has(square)) continue;
    drawPieceAt(ctx, assets, piece.color, piece.type, squareCenter(square, false), camera, dims);
  }

  for (const frame of animated) {
    const from = squareCenter(frame.from, false);
    const to = squareCenter(frame.to, false);
    const point = lerpPoint(from, to, frame.progress);
    drawPieceAt(ctx, assets, frame.color, frame.type, point, camera, dims);
  }
}
