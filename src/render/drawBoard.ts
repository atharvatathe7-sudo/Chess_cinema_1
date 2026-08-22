import { boardToPixel, isDarkSquare, type Camera, type RenderDims } from './coords';
import type { Ctx2D } from './Ctx2D';

const LIGHT_SQUARE = '#eeeed2';
const DARK_SQUARE = '#4a7a3c';

/** Draws the 8x8 checkerboard only — no pieces, no annotations. */
export function drawBoard(ctx: Ctx2D, camera: Camera, dims: RenderDims): void {
  // Phase 1 never flips the board (see docs/architecture.md §13), so
  // visual row 0 is always rank 8 — this is the one place that
  // assumption is baked in; a future flip feature must route through
  // squareToTopLeft's `flipped` param instead of this direct mapping.
  for (let file = 0; file < 8; file++) {
    for (let row = 0; row < 8; row++) {
      const rank = 8 - row;
      const isDark = isDarkSquare(file, rank);
      const topLeft = boardToPixel(camera, dims, { x: file, y: row });
      const bottomRight = boardToPixel(camera, dims, { x: file + 1, y: row + 1 });
      ctx.fillStyle = isDark ? DARK_SQUARE : LIGHT_SQUARE;
      ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    }
  }
}
