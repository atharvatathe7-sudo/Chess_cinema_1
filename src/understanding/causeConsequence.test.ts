import { motifInstanceKeyFor } from './motifs';
import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import type { ForcedSequence, PlySignals, TacticalMotifInstance, ThreatRecord } from './types';
import { buildBestAlternativeRecord, buildCauseConsequenceRecord, buildTurningPoint } from './causeConsequence';

function ply(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 1,
    moveNumber: 1,
    sideToMove: 'w',
    movePlayedSan: 'e4',
    movePlayedUci: 'e2e4',
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
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

/** The knight-fork position used by the BestAlternativeRecord tests, where board material is not under test. */
function forkPly(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return ply({
    movePlayedSan: 'Nb6',
    movePlayedUci: 'd5b6',
    fenBefore: '8/8/8/3N4/8/8/8/K6k w - - 0 1',
    fenAfter: 'k1q5/8/1N6/8/8/8/8/K7 b - - 0 1',
    evaluationBefore: { kind: 'cp', cp: 20 },
    evaluationAfter: { kind: 'cp', cp: 320 },
    bestMove: 'd5b6',
    principalVariation: ['d5b6'],
    swingCp: 300,
    swingForMoverCp: 300,
    ...overrides
  });
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

describe('buildBestAlternativeRecord', () => {
  it('reflects matches-best and effective-equivalence from existing data, with no multipv', () => {
    const record = buildBestAlternativeRecord(forkPly({}), true, undefined, 30);
    expect(record.playedMoveWasTopMove).toBe(true);
    expect(record.playedMoveEffectivelyEquivalent).toBe(true);
    expect(record.bestMoveUniqueness).toBe('unknown');
    expect(record.alternativesConsidered).toEqual([]);
    expect(record.topMove).toEqual({ uci: 'd5b6', principalVariation: ['d5b6'] });
  });

  it('reports unique when the second MultiPV line is far behind', () => {
    const multiPv = {
      lines: [
        { rank: 1, move: 'd5b6', principalVariation: ['d5b6'], evaluation: { kind: 'cp' as const, cp: 320 }, depth: 12 },
        { rank: 2, move: 'd5e7', principalVariation: ['d5e7'], evaluation: { kind: 'cp' as const, cp: 20 }, depth: 12 }
      ]
    };
    const record = buildBestAlternativeRecord(forkPly({}), true, multiPv, 30);
    expect(record.bestMoveUniqueness).toBe('unique');
    expect(record.alternativesConsidered).toHaveLength(2);
    expect(record.alternativesConsidered[1]!.deltaFromTopCp).toBe(300);
  });

  it('reports shared when the second MultiPV line is within the equivalence epsilon', () => {
    const multiPv = {
      lines: [
        { rank: 1, move: 'd5b6', principalVariation: ['d5b6'], evaluation: { kind: 'cp' as const, cp: 320 }, depth: 12 },
        { rank: 2, move: 'd5e7', principalVariation: ['d5e7'], evaluation: { kind: 'cp' as const, cp: 300 }, depth: 12 }
      ]
    };
    const record = buildBestAlternativeRecord(forkPly({}), true, multiPv, 30);
    expect(record.bestMoveUniqueness).toBe('shared');
  });

  it('computes deltas correctly when Black is to move (mover-relative, not raw white-relative subtraction)', () => {
    const multiPv = {
      lines: [
        { rank: 1, move: 'a', principalVariation: ['a'], evaluation: { kind: 'cp' as const, cp: -400 }, depth: 12 },
        { rank: 2, move: 'b', principalVariation: ['b'], evaluation: { kind: 'cp' as const, cp: -100 }, depth: 12 }
      ]
    };
    const record = buildBestAlternativeRecord(forkPly({ sideToMove: 'b' }), false, multiPv, 30);
    // Black's best line is -400 (good for Black); the second line at -100 is worse for Black by 300cp.
    expect(record.alternativesConsidered[1]!.deltaFromTopCp).toBe(300);
    expect(record.bestMoveUniqueness).toBe('unique');
  });
});

describe('buildCauseConsequenceRecord', () => {
  const emptyMap = new Map<number, PlyAnalysis>();

  it('maps every stage of the explanation pattern to a structured field', () => {
    const p = forkPly({});
    const bestAlternative = buildBestAlternativeRecord(p, true, undefined, 30);
    const record = buildCauseConsequenceRecord({
      ply: p,
      signals: noSignals,
      motifsForPly: [],
      threatsCreatedHere: [],
      threatsResolvedHere: [],
      bestAlternative,
      reply: undefined,
      forcingReason: null,
      sequence: undefined,
      allPliesByNumber: new Map([[1, p]])
    });

    expect(record.positionBefore).toBe(p.fenBefore);
    expect(record.movePlayed).toEqual({ san: 'Nb6', uci: 'd5b6' });
    expect(record.immediateChange.evaluationDelta).toEqual({ swingCp: 300, swingForMoverCp: 300 });
    expect(record.bestAlternative).toBe(bestAlternative);
    expect(record.opponentResponse).toBeUndefined();
    expect(record.evaluationConsequence.atPly).toBe(1);
    expect(record.multiMoveConsequence).toBeUndefined();
  });

  /**
   * Phase 15 replaces the old "picks the first confirmed motif" rule. That
   * rule named whichever motif came first in board-scan order with no test
   * that it participated, which is what produced fabricated mechanisms on
   * real games. The mechanism must now be verified — see
   * mechanismVerification.ts — so these cases assert both directions of the
   * new rule rather than the single acceptance the old test covered.
   */
  function forkMotif(overrides: Partial<TacticalMotifInstance> = {}): TacticalMotifInstance {
    return {
      id: 'm1',
      ply: 1,
      motif: 'fork',
      squares: { attacker: 'b6', targets: ['a8', 'c8'] },
      motifInstanceKey: motifInstanceKeyFor('fork', 'b6', ['a8', 'c8'], undefined),
      firstSeenPly: 1,
      geometryEvidence: { basis: 'chess-rule', sourcePlies: [1], note: 'x' },
      ...overrides
    };
  }

  function recordWith(p: PlyAnalysis, motifs: readonly TacticalMotifInstance[], threats: readonly ThreatRecord[] = []) {
    return buildCauseConsequenceRecord({
      ply: p,
      signals: noSignals,
      motifsForPly: motifs,
      threatsCreatedHere: threats,
      threatsResolvedHere: [],
      bestAlternative: buildBestAlternativeRecord(p, true, undefined, 30),
      reply: undefined,
      forcingReason: null,
      sequence: undefined,
      allPliesByNumber: new Map([[p.ply, p]])
    });
  }

  const threatOn = (square: string): ThreatRecord => ({
    id: `t-${square}`,
    ply: 1,
    side: 'w',
    kind: 'material-winning-threat',
    targetSquare: square,
    evidence: { basis: 'chess-rule', sourcePlies: [1], note: 'x' }
  });

  it('names a verified motif as the mechanism, recording which instance passed', () => {
    // d5b6 lands the knight on b6, which is the fork's own attacker square
    // (V1), the pattern is new on this ply (V2), and the only threat created
    // lands inside the fork's target set while a real consequence exists (V4).
    const p = forkPly({});
    const record = recordWith(p, [forkMotif()], [threatOn('c8')]);
    expect(record.mechanism).toBe('fork');
    expect(record.mechanismVerified).toBe(true);
    expect(record.mechanismMotifId).toBe('m1');
    expect(record.immediateChange.motifsTriggered).toEqual(['m1']);
  });

  it('withholds a motif whose geometry the move never touched (V1)', () => {
    // e2e4 has nothing to do with a knight fork on b6 — the exact shape of
    // the old fabrications.
    const p = ply({});
    const record = recordWith(p, [forkMotif()], [threatOn('c8')]);
    expect(record.mechanism).toBeNull();
    expect(record.mechanismVerified).toBe(false);
    // The motif is still reported as present. Verification decides what may
    // be NAMED as causal, it never deletes observed geometry.
    expect(record.immediateChange.motifsTriggered).toEqual(['m1']);
  });

  it('withholds a motif that was already standing before this ply (V2)', () => {
    const p = forkPly({});
    const record = recordWith(p, [forkMotif({ firstSeenPly: -1 })], [threatOn('c8')]);
    expect(record.mechanism).toBeNull();
    expect(record.mechanismVerified).toBe(false);
  });

  it('withholds a motif when another threat could equally explain the consequence (V4)', () => {
    // A threat outside the fork's target set means the fork is not the only
    // available explanation, and V3 cannot rescue it with no forced window.
    const p = forkPly({});
    const record = recordWith(p, [forkMotif()], [threatOn('c8'), threatOn('h1')]);
    expect(record.mechanism).toBeNull();
    expect(record.mechanismVerified).toBe(false);
  });

  it('records a forced opponent response and threat cross-references', () => {
    const p = ply({ ply: 1 });
    const reply = ply({ ply: 2, sideToMove: 'b', movePlayedSan: 'Kd8' });
    const threat: ThreatRecord = {
      id: 't1',
      ply: 1,
      side: 'w',
      kind: 'material-winning-threat',
      targetSquare: 'c8',
      evidence: { basis: 'chess-rule', sourcePlies: [1], note: 'x' }
    };
    const record = buildCauseConsequenceRecord({
      ply: p,
      signals: noSignals,
      motifsForPly: [],
      threatsCreatedHere: [threat],
      threatsResolvedHere: [],
      bestAlternative: buildBestAlternativeRecord(p, true, undefined, 30),
      reply,
      forcingReason: 'check',
      sequence: undefined,
      allPliesByNumber: new Map([[1, p], [2, reply]])
    });
    expect(record.opponentResponse).toEqual({ ply: 2, san: 'Kd8', wasForced: true, forcingReason: 'check' });
    expect(record.threatsCreated).toEqual(['t1']);
  });

  it('extends evaluationConsequence/materialConsequence to the end of a forced sequence', () => {
    const p1 = ply({ ply: 1, sideToMove: 'w', evaluationBefore: { kind: 'cp', cp: 0 } });
    const p2 = ply({
      ply: 2,
      sideToMove: 'b',
      evaluationAfter: { kind: 'cp', cp: 900 },
      fenAfter: '8/8/8/8/8/8/8/K6k b - - 0 1'
    });
    const sequence: ForcedSequence = {
      id: 'seq-0',
      startPly: 1,
      endPly: 2,
      plies: [1, 2],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [1, 2], note: 'x' }
    };
    const record = buildCauseConsequenceRecord({
      ply: p1,
      signals: noSignals,
      motifsForPly: [],
      threatsCreatedHere: [],
      threatsResolvedHere: [],
      bestAlternative: buildBestAlternativeRecord(p1, true, undefined, 30),
      reply: p2,
      forcingReason: 'check',
      sequence,
      allPliesByNumber: new Map([[1, p1], [2, p2]])
    });
    expect(record.evaluationConsequence.atPly).toBe(2);
    expect(record.multiMoveConsequence).toEqual({ sequenceId: 'seq-0', endPly: 2 });
  });

  it('resolves to drawn rather than decisive-advantage when the consequence is a stalemate save (Phase 2.2.1)', () => {
    // White was losing badly (-500 white-relative) and this move reaches a
    // stalemate. The mover-relative swing is a large POSITIVE number (losing
    // -> drawn reads as an improvement) — exactly the case that, without the
    // dedicated drawn check, would satisfy the >= 300 "decisive-advantage"
    // band and mislabel a draw as a win.
    const p = ply({
      ply: 1,
      sideToMove: 'w',
      evaluationBefore: { kind: 'cp', cp: -500 },
      evaluationAfter: { kind: 'terminal', result: 'draw', drawReason: 'stalemate' },
      swingCp: 500,
      swingForMoverCp: 500
    });
    const record = buildCauseConsequenceRecord({
      ply: p,
      signals: noSignals,
      motifsForPly: [],
      threatsCreatedHere: [],
      threatsResolvedHere: [],
      bestAlternative: buildBestAlternativeRecord(p, true, undefined, 30),
      reply: undefined,
      forcingReason: null,
      sequence: undefined,
      allPliesByNumber: new Map([[1, p]])
    });
    expect(record.resolution).toBe('drawn');
  });

  /**
   * Phase 15 (M3) — 'repelled' used to be assigned from a large negative
   * mover-relative swing alone. A move that loses half a queen produces
   * exactly that number, so outright blunders were narrated as "the threat
   * being repelled". The label now requires the record's own threatsRemoved
   * to be non-empty.
   */
  describe('resolution corroboration', () => {
    function resolutionOf(overrides: Partial<PlyAnalysis>, threatsResolvedHere: readonly ThreatRecord[] = []) {
      const p = ply({ ply: 1, ...overrides });
      return buildCauseConsequenceRecord({
        ply: p,
        signals: noSignals,
        motifsForPly: [],
        threatsCreatedHere: [],
        threatsResolvedHere,
        bestAlternative: buildBestAlternativeRecord(p, true, undefined, 30),
        reply: undefined,
        forcingReason: null,
        sequence: undefined,
        allPliesByNumber: new Map([[1, p]])
      }).resolution;
    }

    const removedThreat: ThreatRecord = {
      id: 't-removed',
      ply: 1,
      side: 'b',
      kind: 'material-winning-threat',
      targetSquare: 'f7',
      evidence: { basis: 'chess-rule', sourcePlies: [1], note: 'x' }
    };

    it('does NOT resolve to repelled on a -502 swing with no threats removed', () => {
      const resolution = resolutionOf({
        evaluationBefore: { kind: 'cp', cp: 294 },
        evaluationAfter: { kind: 'cp', cp: -208 },
        swingCp: -502,
        swingForMoverCp: -502
      });
      expect(resolution).not.toBe('repelled');
      expect(resolution).toBe('unresolved');
    });

    it('still resolves to repelled when a threat was removed and the position held', () => {
      const resolution = resolutionOf(
        {
          evaluationBefore: { kind: 'cp', cp: 120 },
          evaluationAfter: { kind: 'cp', cp: -30 },
          swingCp: -150,
          swingForMoverCp: -150
        },
        [removedThreat]
      );
      expect(resolution).toBe('repelled');
    });

    it('does NOT claim a threat was repelled when the same move collapsed the position', () => {
      // A threat genuinely was removed, so the old (threatsRemoved > 0) rule
      // alone would allow the defensive phrasing — but the move also lost
      // the game, which is the fact a viewer would actually notice. Two
      // facts, neither assertable alone, so the record asserts neither.
      const resolution = resolutionOf(
        {
          evaluationBefore: { kind: 'cp', cp: 294 },
          evaluationAfter: { kind: 'cp', cp: -283 },
          swingCp: -577,
          swingForMoverCp: -577
        },
        [removedThreat]
      );
      expect(resolution).not.toBe('repelled');
      expect(resolution).toBe('unresolved');
    });

    it('resolves to forced-mate on mate evidence favouring the mover, without a terminal position', () => {
      const resolution = resolutionOf({
        evaluationBefore: { kind: 'cp', cp: 100 },
        evaluationAfter: { kind: 'mate', mateIn: 3 },
        mateTransition: 'mate-appeared',
        swingCp: 900,
        swingForMoverCp: 900
      });
      expect(resolution).toBe('forced-mate');
    });

    it('does not claim forced-mate when the mate on the board belongs to the opponent', () => {
      // Black plays a move after which WHITE has mate in 3. The mover did not
      // force a mate; the mover walked into one.
      const resolution = resolutionOf({
        sideToMove: 'b',
        evaluationBefore: { kind: 'cp', cp: 498 },
        evaluationAfter: { kind: 'mate', mateIn: 3 },
        mateTransition: 'mate-appeared',
        swingCp: 502,
        swingForMoverCp: -502
      });
      expect(resolution).not.toBe('forced-mate');
      expect(resolution).toBe('unresolved');
    });
  });
});

describe('buildTurningPoint', () => {
  const emptyMap = new Map<number, PlyAnalysis>();

  it('returns null for an unremarkable quiet move', () => {
    const p = ply({ swingCp: 5, swingForMoverCp: 5 });
    const cc = buildCauseConsequenceRecord({
      ply: p,
      signals: noSignals,
      motifsForPly: [],
      threatsCreatedHere: [],
      threatsResolvedHere: [],
      bestAlternative: buildBestAlternativeRecord(p, true, undefined, 30),
      reply: undefined,
      forcingReason: null,
      sequence: undefined,
      allPliesByNumber: new Map([[1, p]])
    });
    expect(buildTurningPoint(p, cc, { score: 5, reasons: [] })).toBeNull();
  });

  it('flags mate-appeared as a turning point regardless of qualityClass-relevant fields', () => {
    const p = ply({ mateTransition: 'mate-appeared' });
    const cc = buildCauseConsequenceRecord({
      ply: p,
      signals: noSignals,
      motifsForPly: [],
      threatsCreatedHere: [],
      threatsResolvedHere: [],
      bestAlternative: buildBestAlternativeRecord(p, true, undefined, 30),
      reply: undefined,
      forcingReason: null,
      sequence: undefined,
      allPliesByNumber: new Map([[1, p]])
    });
    const tp = buildTurningPoint(p, cc, { score: 500, reasons: ['decisive-mate-transition'] });
    expect(tp?.kind).toBe('mate-appeared');
    expect(tp?.causeConsequence).toBe(cc);
  });

  it('flags a decisive swing', () => {
    const p = ply({ swingCp: 400 });
    const cc = buildCauseConsequenceRecord({
      ply: p,
      signals: noSignals,
      motifsForPly: [],
      threatsCreatedHere: [],
      threatsResolvedHere: [],
      bestAlternative: buildBestAlternativeRecord(p, true, undefined, 30),
      reply: undefined,
      forcingReason: null,
      sequence: undefined,
      allPliesByNumber: new Map([[1, p]])
    });
    expect(buildTurningPoint(p, cc, { score: 400, reasons: [] })?.kind).toBe('decisive-swing');
  });
});
