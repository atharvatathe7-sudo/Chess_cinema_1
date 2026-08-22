import { describe, expect, it } from 'vitest';
import { resolveAnimations } from './resolveAnimations';
import type { MoveBeat } from '../timeline/types';

const STANDARD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

describe('resolveAnimations', () => {
  it('returns no frames when there are no active beats', () => {
    expect(resolveAnimations(STANDARD_START_FEN, [], 0)).toEqual([]);
  });

  it('resolves the moving piece type/color by reading the pre-move FEN at the from-square', () => {
    const beat = moveBeat({});
    const frames = resolveAnimations(STANDARD_START_FEN, [beat], 0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ pieceId: 'w-p-e2', type: 'p', color: 'w', from: 'e2', to: 'e4' });
  });

  it('progress is 0 at the start of the window and 1 at the end', () => {
    const beat = moveBeat({ atMs: 1000, durationMs: 600 });
    expect(resolveAnimations(STANDARD_START_FEN, [beat], 1000)[0]!.progress).toBe(0);
    expect(resolveAnimations(STANDARD_START_FEN, [beat], 1600)[0]!.progress).toBe(1);
  });

  it('is a pure function: identical inputs always give identical output', () => {
    const beat = moveBeat({ atMs: 0, durationMs: 600 });
    const a = resolveAnimations(STANDARD_START_FEN, [beat], 300);
    resolveAnimations(STANDARD_START_FEN, [moveBeat({ pieceId: 'b-p-e7', from: 'e7', to: 'e5' })], 9999);
    const b = resolveAnimations(STANDARD_START_FEN, [beat], 300);
    expect(a).toEqual(b);
  });

  it('emits a second frame for the rook on a castling beat, keyed by its own pieceId', () => {
    const kingFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const beat = moveBeat({
      pieceId: 'w-k-e1',
      from: 'e1',
      to: 'g1',
      rookMove: { pieceId: 'w-r-h1', from: 'h1', to: 'f1' }
    });
    const frames = resolveAnimations(kingFen, [beat], 0);
    expect(frames).toHaveLength(2);
    const rookFrame = frames.find((f) => f.pieceId === 'w-r-h1');
    expect(rookFrame).toMatchObject({ type: 'r', color: 'w', from: 'h1', to: 'f1' });
  });
});
