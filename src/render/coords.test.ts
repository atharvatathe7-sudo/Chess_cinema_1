import { describe, expect, it } from 'vitest';
import { boardToPixel, computeViewport, isDarkSquare, squareCenter, squareToTopLeft } from './coords';

describe('squareToTopLeft / squareCenter', () => {
  it('places a8 at the top-left corner when unflipped', () => {
    expect(squareToTopLeft('a8', false)).toEqual({ x: 0, y: 0 });
  });

  it('places h1 at the bottom-right corner when unflipped', () => {
    expect(squareToTopLeft('h1', false)).toEqual({ x: 7, y: 7 });
  });

  it('flipping reflects the board', () => {
    expect(squareToTopLeft('a8', true)).toEqual({ x: 7, y: 7 });
    expect(squareToTopLeft('h1', true)).toEqual({ x: 0, y: 0 });
  });

  it('squareCenter is offset by half a unit from the top-left', () => {
    expect(squareCenter('a8', false)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('isDarkSquare', () => {
  it('matches standard chess board coloring', () => {
    // a1 dark, h1 light, a8 light, h8 dark, e4 light, d4 dark
    expect(isDarkSquare(0, 1)).toBe(true); // a1
    expect(isDarkSquare(7, 1)).toBe(false); // h1
    expect(isDarkSquare(0, 8)).toBe(false); // a8
    expect(isDarkSquare(7, 8)).toBe(true); // h8
    expect(isDarkSquare(4, 4)).toBe(false); // e4
    expect(isDarkSquare(3, 4)).toBe(true); // d4
  });
});

describe('computeViewport / boardToPixel', () => {
  it('at zoom 1 on a square canvas, the whole 8-unit board fills the frame with no offset', () => {
    const camera = { centerX: 4, centerY: 4, zoom: 1 };
    const dims = { width: 800, height: 800 };
    const viewport = computeViewport(camera, dims);
    expect(viewport.scale).toBe(100);
    expect(viewport.left).toBe(0);
    expect(viewport.top).toBe(0);
    expect(viewport.xOffset).toBe(0);
    expect(viewport.yOffset).toBe(0);
  });

  it('maps board-space corners to pixel corners at zoom 1', () => {
    const camera = { centerX: 4, centerY: 4, zoom: 1 };
    const dims = { width: 800, height: 800 };
    expect(boardToPixel(camera, dims, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(boardToPixel(camera, dims, { x: 8, y: 8 })).toEqual({ x: 800, y: 800 });
    expect(boardToPixel(camera, dims, { x: 4, y: 4 })).toEqual({ x: 400, y: 400 });
  });

  it('zooming in halves the visible units and doubles the scale', () => {
    const camera = { centerX: 4, centerY: 4, zoom: 2 };
    const dims = { width: 800, height: 800 };
    const viewport = computeViewport(camera, dims);
    expect(viewport.scale).toBe(200);
    expect(viewport.left).toBe(2);
    expect(viewport.top).toBe(2);
  });
});
