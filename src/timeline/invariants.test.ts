import { describe, expect, it } from 'vitest';
import { validateTimeline } from './invariants';
import type { MoveBeat, Scene, Timeline } from './types';

function sceneWith(beats: MoveBeat[]): Timeline {
  const scene: Scene = {
    id: 'scene-0',
    startPositionFen: 'startpos',
    startPly: 0,
    beats,
    cameraPlan: { keyframes: [{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }] },
    durationMs: beats.reduce((max, b) => Math.max(max, b.atMs + b.durationMs), 0)
  };
  return { scenes: [scene] };
}

function moveBeat(overrides: Partial<MoveBeat>): MoveBeat {
  return {
    kind: 'move',
    san: 'e4',
    pieceId: 'w-p-e2',
    from: 'e2',
    to: 'e4',
    atMs: 0,
    durationMs: 600,
    isEnPassant: false,
    resultingPly: 1,
    ...overrides
  };
}

describe('validateTimeline', () => {
  it('accepts a well-formed sequence of beats', () => {
    const timeline = sceneWith([
      moveBeat({ pieceId: 'w-p-e2', from: 'e2', to: 'e4', atMs: 0 }),
      moveBeat({ pieceId: 'b-p-e7', from: 'e7', to: 'e5', atMs: 600 })
    ]);
    expect(validateTimeline(timeline)).toEqual([]);
  });

  it('flags an unknown PieceId', () => {
    const timeline = sceneWith([moveBeat({ pieceId: 'w-p-nonexistent' })]);
    const violations = validateTimeline(timeline);
    expect(violations.some((v) => v.code === 'unknown-piece-id')).toBe(true);
  });

  it('flags two overlapping move windows for the same piece', () => {
    const timeline = sceneWith([
      moveBeat({ pieceId: 'w-p-e2', from: 'e2', to: 'e4', atMs: 0, durationMs: 600 }),
      // starts at 300ms, while the first beat's window [0,600) is still open
      moveBeat({ pieceId: 'w-p-e2', from: 'e4', to: 'e5', atMs: 300, durationMs: 600 })
    ]);
    const violations = validateTimeline(timeline);
    expect(violations.some((v) => v.code === 'overlapping-lane')).toBe(true);
  });

  it('flags a piece moving again after it was captured', () => {
    const timeline = sceneWith([
      moveBeat({
        pieceId: 'w-p-d2',
        from: 'd2',
        to: 'e3',
        atMs: 0,
        durationMs: 600,
        capturedPieceId: 'b-p-e7'
      }),
      // b-p-e7 was just captured, but here it moves again
      moveBeat({ pieceId: 'b-p-e7', from: 'e7', to: 'e5', atMs: 600, durationMs: 600 })
    ]);
    const violations = validateTimeline(timeline);
    expect(violations.some((v) => v.code === 'move-after-capture')).toBe(true);
  });

  it('flags a castling beat with the wrong rook id', () => {
    const timeline = sceneWith([
      moveBeat({
        pieceId: 'w-k-e1',
        from: 'e1',
        to: 'g1',
        atMs: 0,
        durationMs: 600,
        rookMove: { pieceId: 'w-r-a1', from: 'a1', to: 'f1' } // wrong rook for kingside castle
      })
    ]);
    const violations = validateTimeline(timeline);
    expect(violations.some((v) => v.code === 'bad-castling-rook')).toBe(true);
  });

  it('accepts a correct kingside castling beat', () => {
    const timeline = sceneWith([
      moveBeat({
        pieceId: 'w-k-e1',
        from: 'e1',
        to: 'g1',
        atMs: 0,
        durationMs: 600,
        rookMove: { pieceId: 'w-r-h1', from: 'h1', to: 'f1' }
      })
    ]);
    expect(validateTimeline(timeline)).toEqual([]);
  });
});
