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

  // Phase 2.3.1 — real alternating-check king hunts (a check, a forced king
  // escape that is itself never "forcing", another check, ...) are always
  // split by detectForcedSequences into several short adjacent 2-ply check
  // sequences rather than one long one (confirmed against the real
  // Evergreen Game — see the Phase 2.4 preparatory investigation). These
  // cases exercise the grouping that recovers a genuine king-hunt signal
  // from that fragmented-but-adjacent evidence, without inferring anything
  // from ply proximity alone.

  function checkSeq(id: string, startPly: number, endPly: number): ForcedSequence {
    return {
      id,
      startPly,
      endPly,
      plies: [startPly, endPly],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [startPly, endPly], note: 'x' }
    };
  }

  it('flags king-hunt for several adjacent 2-ply check sequences whose merged run reaches a mate-appeared turning point mid-run (mirrors the real Evergreen Game shape)', () => {
    // Mirrors sequence-4..7 from the real Evergreen Game: four adjacent
    // 2-ply check sequences (39-40, 41-42, 43-44, 45-46), with the
    // mate-appeared turning point at ply 40 — inside the merged run, not at
    // its own final ply, since the actual mating move (ply 47) is never
    // itself part of any ForcedSequence.
    const sequences = [checkSeq('seq-a', 39, 40), checkSeq('seq-b', 41, 42), checkSeq('seq-c', 43, 44), checkSeq('seq-d', 45, 46)];
    const turningPoint: TurningPoint = {
      id: 'tp-40',
      ply: 40,
      kind: 'mate-appeared',
      significance: { score: 900, reasons: [] },
      causeConsequence: {} as never
    };

    const signals = computeNarrativeSignals(sequences, [turningPoint]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.archetype).toBe('king-hunt');
    expect(signals[0]!.confidence).toBeLessThan(1);
    // All four sequences' own evidence is carried through, plus one combined inference.
    expect(signals[0]!.supportingEvidence).toHaveLength(5);
  });

  it('does NOT merge two check sequences separated by an unrelated, non-checking ply', () => {
    // seq-a ends at ply 10; seq-b starts at ply 13 (not 11) — a real gap,
    // e.g. an unrelated quiet move at plies 11-12 sits between them. Even
    // though a turning point exists that would satisfy the merged-run
    // condition if they WERE adjacent, they must not be treated as one run.
    const sequences = [checkSeq('seq-a', 9, 10), checkSeq('seq-b', 13, 14)];
    const turningPoint: TurningPoint = {
      id: 'tp-14',
      ply: 14,
      kind: 'forced-mate-delivery',
      significance: { score: 900, reasons: [] },
      causeConsequence: {} as never
    };

    expect(computeNarrativeSignals(sequences, [turningPoint])).toEqual([]);
  });

  it('does NOT flag king-hunt for an adjacent, long-enough check run that never reaches a mate-related turning point', () => {
    const sequences = [checkSeq('seq-a', 5, 6), checkSeq('seq-b', 7, 8), checkSeq('seq-c', 9, 10)];
    // A turning point exists within the merged run's own plies, but of the
    // wrong kind (a mere decisive swing, not a mate-related turning point)
    // — the run itself never establishes forced mate, so it must not match.
    const turningPoint: TurningPoint = {
      id: 'tp-9',
      ply: 9,
      kind: 'decisive-swing',
      significance: { score: 400, reasons: [] },
      causeConsequence: {} as never
    };

    expect(computeNarrativeSignals(sequences, [turningPoint])).toEqual([]);
  });

  it('does NOT merge an odd-length check sequence with an immediately-adjacent check sequence delivered by the OPPONENT', () => {
    // A real, non-hypothetical shape: an odd-length ForcedSequence (check,
    // forced reply, one more forcing move — mirrors the Evergreen Game's
    // own sequence-3 = [33,34,35]) ends on the CHECKING side's own ply, not
    // the opponent's. The very next ply therefore belongs to the opponent —
    // an adjacent check-type sequence starting there is the OPPONENT's own
    // counter-attack, not a continuation of the same hunt, even though the
    // ply numbers are perfectly adjacent with no gap.
    const whiteCheckChain: ForcedSequence = {
      id: 'seq-white',
      startPly: 1,
      endPly: 3,
      plies: [1, 2, 3],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [1, 2, 3], note: 'white check chain' }
    };
    const blackCheckChain: ForcedSequence = {
      id: 'seq-black',
      startPly: 4,
      endPly: 5,
      plies: [4, 5],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [4, 5], note: 'black check chain — the opponent, not a continuation' }
    };
    const turningPoint: TurningPoint = {
      id: 'tp-4',
      ply: 4,
      kind: 'mate-appeared',
      significance: { score: 900, reasons: [] },
      causeConsequence: {} as never
    };

    // Without the same-side check this would incorrectly merge to 5 plies
    // and match on ply 4 — confirmed as a real false positive against the
    // implementation before this test was added.
    expect(computeNarrativeSignals([whiteCheckChain, blackCheckChain], [turningPoint])).toEqual([]);
  });
});
