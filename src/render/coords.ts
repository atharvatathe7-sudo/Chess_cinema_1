const FILES = 'abcdefgh';

/**
 * Board-space units: an 8x8 grid from (0,0) at a8 (top-left, White's
 * perspective, unflipped) to (8,8) at h1's bottom-right corner. This is
 * the one coordinate system every render/ module works in; pixel/canvas
 * scaling happens only where a draw call actually needs pixels.
 */
export interface BoardPoint {
  x: number;
  y: number;
}

export function squareToTopLeft(square: string, flipped: boolean): BoardPoint {
  const file = FILES.indexOf(square.charAt(0));
  const rank = 8 - Number(square.charAt(1));
  if (file < 0 || Number.isNaN(rank)) {
    throw new Error(`squareToTopLeft: invalid square "${square}"`);
  }
  const visFile = flipped ? 7 - file : file;
  const visRank = flipped ? 7 - rank : rank;
  return { x: visFile, y: visRank };
}

export function squareCenter(square: string, flipped: boolean): BoardPoint {
  const { x, y } = squareToTopLeft(square, flipped);
  return { x: x + 0.5, y: y + 0.5 };
}

/** Chess convention: a1, h8, and every square where file-index + rank is odd, is dark. */
export function isDarkSquare(fileIndex: number, rank: number): boolean {
  return (fileIndex + rank) % 2 === 1;
}

export function lerpPoint(a: BoardPoint, b: BoardPoint, t: number): BoardPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

export interface Camera {
  centerX: number;
  centerY: number;
  /** 1 = whole 8x8 board fits the frame. */
  zoom: number;
}

export interface RenderDims {
  width: number;
  height: number;
}

interface Viewport {
  scale: number;
  left: number;
  top: number;
  xOffset: number;
  yOffset: number;
}

const BOARD_SIZE = 8;

/**
 * Phase 7B — keeps a zoomed viewport's center from placing any part of the
 * visible window outside the board's own [0, boardSize] extent. Without
 * this, a Camera centered near an edge/corner (e.g. a climax square-pair
 * mean close to a1/h8) produces a left/top that pushes part of the frame
 * off-board; nothing ever paints there (drawBoard/drawPieces/
 * drawAnnotations only ever draw the real 0..7 squares), so that region
 * stays whatever render()'s own clearRect left it — which composites to a
 * solid black bar once encoded to VP9 (no alpha channel). See the Phase 7A
 * investigation for the full derivation and real-game verification.
 *
 * At zoom >= 1 (the only range this codebase ever produces — climaxZoom is
 * required > 1 and easeOutCubic-eased interpolation between two zoom
 * values >= 1 stays >= 1), this reduces to clamping into
 * [visibleUnits/2, boardSize - visibleUnits/2]. The min/max form also
 * degrades sensibly for a hypothetical zoom < 1 (viewport wider than the
 * board — no placement can avoid letterboxing there, so this clamps
 * toward centering instead of an inverted range). At zoom === 1 exactly,
 * the valid range collapses to the single point {boardSize / 2} — this is
 * why it's a true no-op for the existing base keyframe (always centered at
 * (4, 4)) and for the zoom=1 fixed-camera case already covered by
 * coords.test.ts.
 */
function clampCenter(center: number, visibleUnits: number, boardSize: number = BOARD_SIZE): number {
  const half = visibleUnits / 2;
  const lo = Math.min(half, boardSize - half);
  const hi = Math.max(half, boardSize - half);
  return Math.min(hi, Math.max(lo, center));
}

/**
 * How a Camera maps the 8-unit board space onto pixel dims, letterboxed if
 * dims isn't square. centerX/centerY are clamped here (not in
 * resolveCamera.ts or wherever a Camera is produced) because this is the
 * one place zoom and center are combined into a screen-space rectangle —
 * every board-space-to-pixel call (boardToPixel, and therefore
 * drawBoard/drawPieces/drawAnnotations) already routes through here, so a
 * single clamp fixes all of them. camera.zoom itself, and every other
 * field of the returned Viewport's derivation, is unchanged by this.
 */
export function computeViewport(camera: Camera, dims: RenderDims): Viewport {
  const visibleUnits = BOARD_SIZE / camera.zoom;
  const scale = Math.min(dims.width, dims.height) / visibleUnits;
  const clampedCenterX = clampCenter(camera.centerX, visibleUnits);
  const clampedCenterY = clampCenter(camera.centerY, visibleUnits);
  const left = clampedCenterX - visibleUnits / 2;
  const top = clampedCenterY - visibleUnits / 2;
  const xOffset = (dims.width - visibleUnits * scale) / 2;
  const yOffset = (dims.height - visibleUnits * scale) / 2;
  return { scale, left, top, xOffset, yOffset };
}

export function boardToPixel(camera: Camera, dims: RenderDims, point: BoardPoint): BoardPoint {
  const { scale, left, top, xOffset, yOffset } = computeViewport(camera, dims);
  return { x: (point.x - left) * scale + xOffset, y: (point.y - top) * scale + yOffset };
}
