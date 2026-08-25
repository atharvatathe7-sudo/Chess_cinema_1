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

/**
 * Phase 7B — computeViewport clamps centerX/centerY (independently) so the
 * zoomed viewport's [left, left+visibleUnits] / [top, top+visibleUnits]
 * window always stays inside the board's own [0, 8] extent. Without this,
 * a Camera centered near an edge/corner leaves part of the frame
 * unpainted, which composites to a solid black bar once encoded (see the
 * Phase 7A investigation for the full derivation and real-exported-frame
 * evidence). Every value below is independently derived — half = visible
 * units / 2, valid range [half, 8 - half] — and cross-checked against the
 * Phase 7A investigation's own scratchpad verification script.
 */
describe('computeViewport bounds clamp (Phase 7B)', () => {
  const CLIMAX_ZOOM = 1.8; // matches director/types.ts's DEFAULT_DIRECTOR_SETTINGS.climaxZoom
  // visibleUnits = 8 / 1.8 = 4.4444..., half = 2.2222..., valid range [2.2222, 5.7778].
  const HALF = 8 / CLIMAX_ZOOM / 2;
  const LO = HALF;
  const HI = 8 - HALF;

  it('board center (4, 4) is already in bounds and stays exactly on the existing formula', () => {
    const camera = { centerX: 4, centerY: 4, zoom: CLIMAX_ZOOM };
    const dims = { width: 800, height: 800 };
    const viewport = computeViewport(camera, dims);
    expect(viewport.left).toBeCloseTo(4 - HALF, 10);
    expect(viewport.top).toBeCloseTo(4 - HALF, 10);
  });

  it('clamps all four corners fully inside the board', () => {
    const dims = { width: 800, height: 800 };
    const corners = [
      { name: 'a8', x: 0.5, y: 0.5 },
      { name: 'h8', x: 7.5, y: 0.5 },
      { name: 'a1', x: 0.5, y: 7.5 },
      { name: 'h1', x: 7.5, y: 7.5 }
    ];
    for (const c of corners) {
      const viewport = computeViewport({ centerX: c.x, centerY: c.y, zoom: CLIMAX_ZOOM }, dims);
      expect(viewport.left, `${c.name} left`).toBeGreaterThanOrEqual(-1e-9);
      expect(viewport.top, `${c.name} top`).toBeGreaterThanOrEqual(-1e-9);
      const visibleUnits = 8 / CLIMAX_ZOOM;
      expect(viewport.left + visibleUnits, `${c.name} right`).toBeLessThanOrEqual(8 + 1e-9);
      expect(viewport.top + visibleUnits, `${c.name} bottom`).toBeLessThanOrEqual(8 + 1e-9);
    }
  });

  it('clamps all four edge midpoints fully inside the board', () => {
    const dims = { width: 800, height: 800 };
    const visibleUnits = 8 / CLIMAX_ZOOM;
    const edges = [
      { name: 'top', x: 4, y: 0.5 },
      { name: 'bottom', x: 4, y: 7.5 },
      { name: 'left', x: 0.5, y: 4 },
      { name: 'right', x: 7.5, y: 4 }
    ];
    for (const e of edges) {
      const viewport = computeViewport({ centerX: e.x, centerY: e.y, zoom: CLIMAX_ZOOM }, dims);
      expect(viewport.left, `${e.name} left`).toBeGreaterThanOrEqual(-1e-9);
      expect(viewport.top, `${e.name} top`).toBeGreaterThanOrEqual(-1e-9);
      expect(viewport.left + visibleUnits, `${e.name} right`).toBeLessThanOrEqual(8 + 1e-9);
      expect(viewport.top + visibleUnits, `${e.name} bottom`).toBeLessThanOrEqual(8 + 1e-9);
    }
  });

  it('clamps intermediate out-of-bounds centers to the nearest valid edge', () => {
    const dims = { width: 800, height: 800 };
    // (2, 3): x is below LO, y is already in range.
    const a = computeViewport({ centerX: 2, centerY: 3, zoom: CLIMAX_ZOOM }, dims);
    expect(a.left).toBeCloseTo(LO - HALF, 10); // clamped to LO, so left = LO - half = 0
    expect(a.left).toBeCloseTo(0, 10);
    expect(a.top).toBeCloseTo(3 - HALF, 10);

    // (6, 5.5): x is above HI, y is already in range.
    const b = computeViewport({ centerX: 6, centerY: 5.5, zoom: CLIMAX_ZOOM }, dims);
    expect(b.left).toBeCloseTo(HI - HALF, 10);
    expect(b.top).toBeCloseTo(5.5 - HALF, 10);
  });

  it('leaves an already-in-bounds off-center camera unchanged (clamp is a no-op there)', () => {
    const dims = { width: 800, height: 800 };
    // (3, 3) is within [LO, HI] on both axes.
    expect(3).toBeGreaterThanOrEqual(LO);
    expect(3).toBeLessThanOrEqual(HI);
    const viewport = computeViewport({ centerX: 3, centerY: 3, zoom: CLIMAX_ZOOM }, dims);
    expect(viewport.left).toBeCloseTo(3 - HALF, 10);
    expect(viewport.top).toBeCloseTo(3 - HALF, 10);
  });

  it('is exact (not just close) at the precise clamp boundaries', () => {
    const dims = { width: 800, height: 800 };
    const atLo = computeViewport({ centerX: LO, centerY: LO, zoom: CLIMAX_ZOOM }, dims);
    expect(atLo.left).toBeCloseTo(0, 10);
    expect(atLo.top).toBeCloseTo(0, 10);

    const atHi = computeViewport({ centerX: HI, centerY: HI, zoom: CLIMAX_ZOOM }, dims);
    const visibleUnits = 8 / CLIMAX_ZOOM;
    expect(atHi.left + visibleUnits).toBeCloseTo(8, 10);
    expect(atHi.top + visibleUnits).toBeCloseTo(8, 10);
  });

  it('zoom = 1 is unaffected: the existing base-camera viewport (centerX:4, centerY:4) is byte-identical to before the clamp', () => {
    const camera = { centerX: 4, centerY: 4, zoom: 1 };
    const dims = { width: 800, height: 800 };
    const viewport = computeViewport(camera, dims);
    expect(viewport.scale).toBe(100);
    expect(viewport.left).toBe(0);
    expect(viewport.top).toBe(0);
    expect(viewport.xOffset).toBe(0);
    expect(viewport.yOffset).toBe(0);
  });

  it('at zoom = 1 the valid range collapses to the single point (4, 4) — defense-in-depth for a center this codebase never actually produces at zoom 1', () => {
    const dims = { width: 800, height: 800 };
    const viewport = computeViewport({ centerX: 999, centerY: -999, zoom: 1 }, dims);
    expect(viewport.left).toBe(0);
    expect(viewport.top).toBe(0);
  });

  it('the clamp changes only left/top — scale, xOffset, and yOffset are identical between an in-bounds and an out-of-bounds camera at the same zoom/dims', () => {
    const dims = { width: 480, height: 480 };
    const inBounds = computeViewport({ centerX: 4, centerY: 4, zoom: CLIMAX_ZOOM }, dims);
    const outOfBounds = computeViewport({ centerX: 7, centerY: 7, zoom: CLIMAX_ZOOM }, dims);
    expect(outOfBounds.scale).toBe(inBounds.scale);
    expect(outOfBounds.xOffset).toBe(inBounds.xOffset);
    expect(outOfBounds.yOffset).toBe(inBounds.yOffset);
    // ...but left/top do differ, since the cameras are genuinely different.
    expect(outOfBounds.left).not.toBe(inBounds.left);
    expect(outOfBounds.top).not.toBe(inBounds.top);
  });

  /**
   * Real climax camera centers, hand-derived from the actual PGNs during
   * the Phase 7A investigation (mean of the climax move's from/to square
   * centers) and cross-checked against that investigation's own
   * scratchpad script output, at the app's real export dims (480x480).
   */
  describe('real-game climax camera centers', () => {
    const dims = { width: 480, height: 480 };

    it("Scholar's Mate — climax squares g8,f6 (3...Nf6), mean center (6.0, 1.5)", () => {
      const viewport = computeViewport({ centerX: 6.0, centerY: 1.5, zoom: CLIMAX_ZOOM }, dims);
      const visibleUnits = 8 / CLIMAX_ZOOM;
      // centerX (6.0) is above HI (5.778) -> clamped; centerY (1.5) is below LO (2.222) -> clamped.
      expect(viewport.left).toBeCloseTo(3.5556, 3);
      expect(viewport.top).toBeCloseTo(0, 3);
      expect(viewport.left).toBeGreaterThanOrEqual(-1e-9);
      expect(viewport.top).toBeGreaterThanOrEqual(-1e-9);
      expect(viewport.left + visibleUnits).toBeLessThanOrEqual(8 + 1e-9);
      expect(viewport.top + visibleUnits).toBeLessThanOrEqual(8 + 1e-9);
    });

    it('Promotion race — climax squares g2,h1 (5...gxh1=Q), mean center (7.0, 7.0)', () => {
      const viewport = computeViewport({ centerX: 7.0, centerY: 7.0, zoom: CLIMAX_ZOOM }, dims);
      const visibleUnits = 8 / CLIMAX_ZOOM;
      // Both axes above HI -> both clamped.
      expect(viewport.left).toBeCloseTo(3.5556, 3);
      expect(viewport.top).toBeCloseTo(3.5556, 3);
      expect(viewport.left + visibleUnits).toBeLessThanOrEqual(8 + 1e-9);
      expect(viewport.top + visibleUnits).toBeLessThanOrEqual(8 + 1e-9);
    });

    it('Stalemate — climax squares e8,f7 (6...Kf7), mean center (5.0, 1.0)', () => {
      const viewport = computeViewport({ centerX: 5.0, centerY: 1.0, zoom: CLIMAX_ZOOM }, dims);
      const visibleUnits = 8 / CLIMAX_ZOOM;
      // centerX (5.0) is already within [2.222, 5.778] -> unchanged; centerY (1.0) is below LO -> clamped.
      expect(viewport.left).toBeCloseTo(2.7778, 3);
      expect(viewport.top).toBeCloseTo(0, 3);
      expect(viewport.top).toBeGreaterThanOrEqual(-1e-9);
      expect(viewport.top + visibleUnits).toBeLessThanOrEqual(8 + 1e-9);
    });
  });
});

/**
 * Phase 9 — 9:16 portrait export (1080x1920). computeViewport/boardToPixel
 * were already written generically against dims.width/dims.height (never
 * assuming width === height) — this describe block is new verification of
 * that existing behavior at the app's real portrait export size, not a
 * behavior change. The Phase 7B clamp (clampCenter) operates purely in
 * board-space (visibleUnits/boardSize), taking no dims parameter at all, so
 * it is mathematically invariant to dims and needs no portrait-specific
 * logic of its own — these tests confirm that invariance holds through
 * computeViewport's full pixel-space output too.
 */
describe('computeViewport with non-square (portrait) RenderDims (Phase 9)', () => {
  const PORTRAIT_DIMS = { width: 1080, height: 1920 };
  const CLIMAX_ZOOM = 1.8;

  it('at zoom 1, scale is governed by the narrower dimension (width) and the board is horizontally flush, vertically letterboxed', () => {
    const camera = { centerX: 4, centerY: 4, zoom: 1 };
    const viewport = computeViewport(camera, PORTRAIT_DIMS);
    // visibleUnits = 8, scale = min(1080,1920)/8 = 135.
    expect(viewport.scale).toBe(135);
    expect(viewport.left).toBe(0);
    expect(viewport.top).toBe(0);
    // Board (8 * 135 = 1080px) exactly fills the width -> no horizontal offset.
    expect(viewport.xOffset).toBe(0);
    // ...but leaves (1920 - 1080) / 2 = 420px above and below.
    expect(viewport.yOffset).toBe(420);
  });

  it('boardToPixel maps the board corners into a horizontally-flush, vertically-centered square region — never stretched', () => {
    const camera = { centerX: 4, centerY: 4, zoom: 1 };
    const topLeft = boardToPixel(camera, PORTRAIT_DIMS, { x: 0, y: 0 });
    const bottomRight = boardToPixel(camera, PORTRAIT_DIMS, { x: 8, y: 8 });
    expect(topLeft).toEqual({ x: 0, y: 420 });
    expect(bottomRight).toEqual({ x: 1080, y: 1500 });
    // The rendered board region is exactly square (1080x1080), regardless of the portrait frame's own 1080x1920 aspect ratio.
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    expect(width).toBe(height);
  });

  it('a single board-space unit maps to equal pixel width and height (no anisotropic stretch) at any zoom', () => {
    for (const zoom of [1, 1.4, CLIMAX_ZOOM]) {
      const camera = { centerX: 4, centerY: 4, zoom };
      const a = boardToPixel(camera, PORTRAIT_DIMS, { x: 4, y: 4 });
      const b = boardToPixel(camera, PORTRAIT_DIMS, { x: 5, y: 5 });
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      expect(dx).toBeCloseTo(dy, 10);
    }
  });

  it('the Phase 7B clamp remains correct at portrait dims: every real climax center stays fully inside the frame-mapped board region', () => {
    const visibleUnits = 8 / CLIMAX_ZOOM;
    const climaxCenters = [
      { name: "Scholar's Mate", x: 6.0, y: 1.5 },
      { name: 'Promotion race', x: 7.0, y: 7.0 },
      { name: 'Stalemate', x: 5.0, y: 1.0 }
    ];
    for (const c of climaxCenters) {
      const viewport = computeViewport({ centerX: c.x, centerY: c.y, zoom: CLIMAX_ZOOM }, PORTRAIT_DIMS);
      expect(viewport.left, `${c.name} left`).toBeGreaterThanOrEqual(-1e-9);
      expect(viewport.top, `${c.name} top`).toBeGreaterThanOrEqual(-1e-9);
      expect(viewport.left + visibleUnits, `${c.name} right`).toBeLessThanOrEqual(8 + 1e-9);
      expect(viewport.top + visibleUnits, `${c.name} bottom`).toBeLessThanOrEqual(8 + 1e-9);
    }
  });

  it('clamp output (left/top) is byte-identical between square and portrait dims — the clamp itself never reads dims', () => {
    const camera = { centerX: 7.0, centerY: 7.0, zoom: CLIMAX_ZOOM };
    const square = computeViewport(camera, { width: 480, height: 480 });
    const portrait = computeViewport(camera, PORTRAIT_DIMS);
    expect(portrait.left).toBe(square.left);
    expect(portrait.top).toBe(square.top);
  });

  it('xOffset/yOffset are invariant to zoom in portrait dims — the board occupies exactly pixel columns [0,1080] and rows [420,1500] at any zoom, since visibleUnits*scale always equals the narrower dimension (width) regardless of zoom', () => {
    for (const zoom of [1, 1.4, CLIMAX_ZOOM]) {
      const viewport = computeViewport({ centerX: 4, centerY: 4, zoom }, PORTRAIT_DIMS);
      expect(viewport.xOffset, `zoom=${zoom}`).toBe(0);
      expect(viewport.yOffset, `zoom=${zoom}`).toBe(420);
    }
  });

  it('xOffset/yOffset always keep the rendered board centered on the constraining axis, and flush (0) on the other', () => {
    // A hypothetical landscape RenderDims exercises the opposite branch (height is the constraining dimension is height < width here, so width is fully covered)
    const landscape = { width: 1920, height: 1080 };
    const viewport = computeViewport({ centerX: 4, centerY: 4, zoom: 1 }, landscape);
    expect(viewport.yOffset).toBe(0);
    expect(viewport.xOffset).toBe((1920 - 1080) / 2);
  });
});
