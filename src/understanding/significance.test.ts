import { motifInstanceKeyFor } from './motifs';
import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import type { PlySignals, TacticalMotifInstance } from './types';
import { computeSignificance, withAdditionalReason } from './significance';

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

const noSignals: PlySignals = {
  matchesEngineBest: true,
  isSacrifice: false,
  deliversCheck: false,
  deliversMate: false,
  motifIds: [],
  isTurningPoint: false,
  pieceId: 'w-p-e2',
  isPromotion: false,
  isUnderpromotion: false
};

describe('computeSignificance', () => {
  it('is low for a quiet, unremarkable move', () => {
    const record = computeSignificance(ply({ swingCp: 5 }), {
      signals: noSignals,
      motifs: [],
      isSequenceTerminal: false,
      materialDelta: 0
    });
    expect(record.reasons).toEqual([]);
    expect(record.score).toBe(5);
  });

  it('flags a large swing in either direction, not just losses', () => {
    const positive = computeSignificance(ply({ swingCp: 500 }), {
      signals: noSignals,
      motifs: [],
      isSequenceTerminal: false,
      materialDelta: 0
    });
    const negative = computeSignificance(ply({ swingCp: -500 }), {
      signals: noSignals,
      motifs: [],
      isSequenceTerminal: false,
      materialDelta: 0
    });
    expect(positive.reasons).toContain('large-swing-either-direction');
    expect(negative.reasons).toContain('large-swing-either-direction');
  });

  it('flags decisive mate transitions', () => {
    const record = computeSignificance(ply({ swingCp: 0, mateTransition: 'mate-appeared' }), {
      signals: noSignals,
      motifs: [],
      isSequenceTerminal: false,
      materialDelta: 0
    });
    expect(record.reasons).toContain('decisive-mate-transition');
  });

  it('flags a confirmed (not merely geometric) tactical motif', () => {
    const confirmed: TacticalMotifInstance = {
      id: 'm1',
      ply: 1,
      motif: 'fork',
      squares: { attacker: 'b6', targets: ['a8', 'c8'] },
      motifInstanceKey: motifInstanceKeyFor('fork', 'b6', ['a8', 'c8'], undefined),
      firstSeenPly: 1,
      geometryEvidence: { basis: 'chess-rule', sourcePlies: [1], note: 'x' },
      significanceEvidence: { basis: 'engine-eval', sourcePlies: [1], note: 'confirmed' }
    };
    const signals: PlySignals = { ...noSignals, motifIds: ['m1'] };
    const record = computeSignificance(ply({}), { signals, motifs: [confirmed], isSequenceTerminal: false, materialDelta: 0 });
    expect(record.reasons).toContain('confirmed-tactical-motif');
  });

  it('does not flag an unconfirmed geometric-only motif', () => {
    const unconfirmed: TacticalMotifInstance = {
      id: 'm1',
      ply: 1,
      motif: 'fork',
      squares: { attacker: 'b6', targets: ['a8', 'c8'] },
      motifInstanceKey: motifInstanceKeyFor('fork', 'b6', ['a8', 'c8'], undefined),
      firstSeenPly: 1,
      geometryEvidence: { basis: 'chess-rule', sourcePlies: [1], note: 'x' }
    };
    const signals: PlySignals = { ...noSignals, motifIds: ['m1'] };
    const record = computeSignificance(ply({}), { signals, motifs: [unconfirmed], isSequenceTerminal: false, materialDelta: 0 });
    expect(record.reasons).not.toContain('confirmed-tactical-motif');
  });

  it('flags material-decisive swings and forced-sequence terminals', () => {
    const record = computeSignificance(ply({}), {
      signals: noSignals,
      motifs: [],
      isSequenceTerminal: true,
      materialDelta: -500
    });
    expect(record.reasons).toContain('material-decisive');
    expect(record.reasons).toContain('forced-sequence-terminal');
  });
});

describe('withAdditionalReason', () => {
  it('adds only-move-under-pressure and increases the score', () => {
    const base = computeSignificance(ply({ swingCp: 10 }), {
      signals: noSignals,
      motifs: [],
      isSequenceTerminal: false,
      materialDelta: 0
    });
    const extended = withAdditionalReason(base, 'only-move-under-pressure', 10);
    expect(extended.reasons).toContain('only-move-under-pressure');
    expect(extended.score).toBeGreaterThan(base.score);
  });

  it('is idempotent — adding the same reason twice does not double-count', () => {
    const base = computeSignificance(ply({ swingCp: 10 }), {
      signals: noSignals,
      motifs: [],
      isSequenceTerminal: false,
      materialDelta: 0
    });
    const once = withAdditionalReason(base, 'only-move-under-pressure', 10);
    const twice = withAdditionalReason(once, 'only-move-under-pressure', 10);
    expect(twice).toEqual(once);
  });
});
