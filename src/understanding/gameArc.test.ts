import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import type { ForcedSequence, TurningPoint } from './types';
import { computeGameArc, computeNarrativeSignals } from './gameArc';

function ply(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 1,
    moveNumber: 1,
    sideToMove: 'w',
    movePlayedSan: 'e4',
    movePlayedUci: 'e2e4',
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 0 },
    bestMove: 'e2e4',
    principalVariation: ['e2e4'],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

describe('computeGameArc', () => {
  it('is deterministic and produces one material-trajectory entry per ply', () => {
    const plies = [ply({ ply: 1 }), ply({ ply: 2 })];
    const a = computeGameArc(plies);
    const b = computeGameArc(plies);
    expect(a).toEqual(b);
    expect(a.materialTrajectory).toHaveLength(2);
  });

  it('detects a bare-kings endgame position as ending the middlegame at that ply', () => {
    const plies = [
      ply({ ply: 1 }),
      ply({ ply: 2, fenAfter: '4k3/8/8/8/8/8/8/4K3 b - - 0 1' })
    ];
    const arc = computeGameArc(plies);
    expect(arc.middlegameEndPly).toBe(2);
  });

  it('never reports a middlegame boundary before the opening boundary', () => {
    const plies = [ply({ ply: 1, fenAfter: '4k3/8/8/8/8/8/8/4K3 b - - 0 1' })];
    const arc = computeGameArc(plies);
    expect(arc.middlegameEndPly).toBeGreaterThanOrEqual(arc.openingEndPly);
  });
});

describe('computeNarrativeSignals', () => {
  it('returns no signals when there is no qualifying forced-check sequence', () => {
    expect(computeNarrativeSignals([], [])).toEqual([]);
  });

  it('flags king-hunt for a long forced-check sequence ending in mate, always below full confidence', () => {
    const sequence: ForcedSequence = {
      id: 'seq-0',
      startPly: 1,
      endPly: 5,
      plies: [1, 2, 3, 4, 5],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [1, 2, 3, 4, 5], note: 'x' }
    };
    const turningPoint: TurningPoint = {
      id: 'tp-5',
      ply: 5,
      kind: 'forced-mate-delivery',
      significance: { score: 500, reasons: [] },
      causeConsequence: {} as never
    };
    const signals = computeNarrativeSignals([sequence], [turningPoint]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.archetype).toBe('king-hunt');
    expect(signals[0]!.confidence).toBeLessThan(1);
  });

  it('does not flag king-hunt for a short forced sequence', () => {
    const sequence: ForcedSequence = {
      id: 'seq-0',
      startPly: 1,
      endPly: 2,
      plies: [1, 2],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [1, 2], note: 'x' }
    };
    expect(computeNarrativeSignals([sequence], [])).toEqual([]);
  });
});
