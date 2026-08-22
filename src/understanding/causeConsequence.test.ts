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
  isTurningPoint: false
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

  it('picks the first confirmed motif as the mechanism when one is present', () => {
    const p = ply({});
    const fork: TacticalMotifInstance = {
      id: 'm1',
      ply: 1,
      motif: 'fork',
      squares: { attacker: 'b6', targets: ['a8', 'c8'] },
      geometryEvidence: { basis: 'chess-rule', sourcePlies: [1], note: 'x' }
    };
    const record = buildCauseConsequenceRecord({
      ply: p,
      signals: noSignals,
      motifsForPly: [fork],
      threatsCreatedHere: [],
      threatsResolvedHere: [],
      bestAlternative: buildBestAlternativeRecord(p, true, undefined, 30),
      reply: undefined,
      forcingReason: null,
      sequence: undefined,
      allPliesByNumber: new Map([[1, p]])
    });
    expect(record.mechanism).toBe('fork');
    expect(record.immediateChange.motifsTriggered).toEqual(['m1']);
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
