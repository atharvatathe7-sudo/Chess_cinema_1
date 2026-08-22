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

/** How a Camera maps the 8-unit board space onto pixel dims, letterboxed if dims isn't square. */
export function computeViewport(camera: Camera, dims: RenderDims): Viewport {
  const visibleUnits = 8 / camera.zoom;
  const scale = Math.min(dims.width, dims.height) / visibleUnits;
  const left = camera.centerX - visibleUnits / 2;
  const top = camera.centerY - visibleUnits / 2;
  const xOffset = (dims.width - visibleUnits * scale) / 2;
  const yOffset = (dims.height - visibleUnits * scale) / 2;
  return { scale, left, top, xOffset, yOffset };
}

export function boardToPixel(camera: Camera, dims: RenderDims, point: BoardPoint): BoardPoint {
  const { scale, left, top, xOffset, yOffset } = computeViewport(camera, dims);
  return { x: (point.x - left) * scale + xOffset, y: (point.y - top) * scale + yOffset };
}
