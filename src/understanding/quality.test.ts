import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import { computeBaseSignals, qualityClassFor } from './quality';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function ply(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 1,
    moveNumber: 1,
    sideToMove: 'w',
    movePlayedSan: 'e4',
    movePlayedUci: 'e2e4',
    fenBefore: START_FEN,
    fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    evaluationBefore: { kind: 'cp', cp: 20 },
    evaluationAfter: { kind: 'cp', cp: 20 },
    bestMove: 'e2e4',
    principalVariation: ['e2e4'],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

describe('qualityClassFor', () => {
  it('classifies a move within epsilon of best as optimal', () => {
    expect(qualityClassFor(ply({ swingForMoverCp: 0 }))).toBe('optimal');
    expect(qualityClassFor(ply({ swingForMoverCp: -5 }))).toBe('optimal');
  });

  it('classifies a small loss as inaccuracy, below the mistake floor', () => {
    expect(qualityClassFor(ply({ swingForMoverCp: -50 }))).toBe('inaccuracy');
  });

  it('classifies a loss at or above the mistake floor as mistake', () => {
    expect(qualityClassFor(ply({ swingForMoverCp: -150 }))).toBe('mistake');
  });

  it('classifies a large loss as blunder', () => {
    expect(qualityClassFor(ply({ swingForMoverCp: -500 }))).toBe('blunder');
  });

  it('classifies a flipped mate as blunder regardless of swing magnitude', () => {
    expect(qualityClassFor(ply({ swingForMoverCp: 0, mateTransition: 'mate-flipped' }))).toBe('blunder');
  });

  it('classifies a disappeared mate as blunder', () => {
    expect(qualityClassFor(ply({ swingForMoverCp: 0, mateTransition: 'mate-disappeared' }))).toBe('blunder');
  });

  it('classifies a slower-but-still-winning mate as missed-win', () => {
    expect(
      qualityClassFor(
        ply({
          sideToMove: 'w',
          swingForMoverCp: 0,
          mateTransition: 'mate-sustained',
          evaluationBefore: { kind: 'mate', mateIn: 3 },
          evaluationAfter: { kind: 'mate', mateIn: 5 }
        })
      )
    ).toBe('missed-win');
  });

  it('does not classify a faster mate as missed-win', () => {
    expect(
      qualityClassFor(
        ply({
          sideToMove: 'w',
          swingForMoverCp: 0,
          mateTransition: 'mate-sustained',
          evaluationBefore: { kind: 'mate', mateIn: 3 },
          evaluationAfter: { kind: 'mate', mateIn: 2 }
        })
      )
    ).toBe('optimal');
  });

  it('is a strict total function: exactly one class, never ambiguous, for a spread of swings', () => {
    for (const swing of [500, 0, -1, -10, -99, -100, -101, -299, -300, -301, -1000]) {
      const result = qualityClassFor(ply({ swingForMoverCp: swing }));
      expect(['optimal', 'inaccuracy', 'mistake', 'blunder', 'missed-win']).toContain(result);
    }
  });
});

describe('computeBaseSignals', () => {
  it('reports matchesEngineBest true when the played move equals bestMove', () => {
    const signals = computeBaseSignals(ply({ movePlayedUci: 'e2e4', bestMove: 'e2e4' }));
    expect(signals.matchesEngineBest).toBe(true);
  });

  it('reports matchesEngineBest false when they differ', () => {
    const signals = computeBaseSignals(ply({ movePlayedUci: 'e2e4', bestMove: 'd2d4' }));
    expect(signals.matchesEngineBest).toBe(false);
  });

  it('reports matchesEngineBest false when the engine reported no best move', () => {
    const signals = computeBaseSignals(ply({ movePlayedUci: 'e2e4', bestMove: null }));
    expect(signals.matchesEngineBest).toBe(false);
  });

  it('detects a sound sacrifice: material offered, but not judged a mistake', () => {
    // White rook lands on e5 where a black pawn on d6 can take it for free —
    // material is offered — but the engine still calls it fine (swing ~0).
    const fenAfter = '4k3/8/3p4/4R3/8/8/8/7K b - - 0 1';
    const signals = computeBaseSignals(
      ply({
        sideToMove: 'w',
        movePlayedUci: 'e1e5',
        fenAfter,
        swingForMoverCp: 0
      })
    );
    expect(signals.isSacrifice).toBe(true);
  });

  it('does not call a genuine blunder a sacrifice even if material is hanging', () => {
    const fenAfter = '4k3/8/3p4/4R3/8/8/8/7K b - - 0 1';
    const signals = computeBaseSignals(
      ply({
        sideToMove: 'w',
        movePlayedUci: 'e1e5',
        fenAfter,
        swingForMoverCp: -600
      })
    );
    expect(signals.isSacrifice).toBe(false);
  });

  it('detects check and checkmate deliveries from the resulting FEN', () => {
    const checkPly = ply({ fenAfter: '4k3/8/8/8/8/8/8/4R2K b - - 0 1' });
    expect(computeBaseSignals(checkPly).deliversCheck).toBe(true);
    expect(computeBaseSignals(checkPly).deliversMate).toBe(false);

    // Back-rank mate: king on h8 boxed in by its own pawns, Re8 mating.
    const matePly = ply({ fenAfter: '4R1k1/5ppp/8/8/8/8/8/7K b - - 0 1' });
    expect(computeBaseSignals(matePly).deliversMate).toBe(true);
  });
});
