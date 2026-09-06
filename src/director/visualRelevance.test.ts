import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import type { KingMobilityRecord, TacticalMotifInstance } from '../understanding/types';
import { analysisFrom, causeConsequence, centralConflict, consequenceChain, plyAnalysis, turningPoint, understandingFrom } from '../story/storyFixtures';
import { gameFromMoves, moveRecord, storyBeat, storyPlanFrom } from './directorFixtures';
import { cameraRoleFor, deriveBeatVisualRegion, regionsEqual, unionRegions, type VisualRelevanceContext } from './visualRelevance';

/**
 * Phase 18B — pure unit coverage for deriveBeatVisualRegion, one geometry
 * source at a time. Every fixture hand-supplies only the evidence the test
 * cares about (same discipline story/storyFixtures.ts's own helpers already
 * establish) — never a run through the real detectors, since these tests
 * are about REGION CONSTRUCTION from already-verified evidence, not about
 * producing that evidence.
 */

function climaxBeatFixture(): ReturnType<typeof storyBeat> {
  return storyBeat('beat-climax-1', 'climax', [1], { evidenceRefs: { turningPointId: 'tp-1' } });
}

function ctxWith(overrides: Partial<VisualRelevanceContext>): VisualRelevanceContext {
  const game = gameFromMoves([moveRecord(1, 'w', 'q', 'e5', 'e5', 'Qe5')]);
  const analysis = analysisFrom([plyAnalysis(1)]);
  const understanding = understandingFrom({ plies: [] });
  const story = storyPlanFrom({});
  return { game, analysis, understanding, story, ...overrides };
}

describe('deriveBeatVisualRegion — verified motif geometry', () => {
  it('1. fork: contains the attacker and every verified target', () => {
    const motif: TacticalMotifInstance = {
      id: 'motif-fork-1',
      ply: 1,
      motif: 'fork',
      squares: { attacker: 'e5', targets: ['c6', 'g6'] },
      motifInstanceKey: 'fork:e5:c6,g6',
      firstSeenPly: 1,
      geometryEvidence: { basis: 'chess-rule', sourcePlies: [1], note: 'fixture fork' }
    };
    const cc = causeConsequence(1, { mechanism: 'fork', mechanismVerified: true, mechanismMotifId: motif.id });
    const tp = turningPoint(1, 'decisive-swing', cc, 500);
    const understanding = understandingFrom({ plies: [], motifs: [motif], turningPoints: [tp] });
    const story = storyPlanFrom({ centralConflict: centralConflict(tp.id, 1), noConflictReason: undefined });

    const region = deriveBeatVisualRegion(climaxBeatFixture(), ctxWith({ understanding, story }));
    expect(region.primarySquares).toContain('e5');
    expect(region.primarySquares).toContain('c6');
    expect(region.primarySquares).toContain('g6');
    expect(region.source).toEqual({ kind: 'motif', motif: 'fork', motifId: motif.id });
  });

  it('2. pin/skewer: contains the attacker, the throughSquare, and the target', () => {
    const motif: TacticalMotifInstance = {
      id: 'motif-pin-1',
      ply: 1,
      motif: 'pin',
      squares: { attacker: 'd1', targets: ['d5'], throughSquare: 'd3' },
      motifInstanceKey: 'pin:d1:d5:d3',
      firstSeenPly: 1,
      geometryEvidence: { basis: 'chess-rule', sourcePlies: [1], note: 'fixture pin' }
    };
    const cc = causeConsequence(1, { mechanism: 'pin', mechanismVerified: true, mechanismMotifId: motif.id });
    const tp = turningPoint(1, 'decisive-swing', cc, 500);
    const understanding = understandingFrom({ plies: [], motifs: [motif], turningPoints: [tp] });
    const story = storyPlanFrom({ centralConflict: centralConflict(tp.id, 1), noConflictReason: undefined });

    const region = deriveBeatVisualRegion(climaxBeatFixture(), ctxWith({ understanding, story }));
    expect(region.primarySquares).toContain('d1');
    expect(region.primarySquares).toContain('d5');
    expect(region.secondarySquares).toContain('d3');
  });

  it('3. discovery/battery: uses the actual stored geometry verbatim, not a re-derived shape', () => {
    const motif: TacticalMotifInstance = {
      id: 'motif-battery-1',
      ply: 1,
      motif: 'battery',
      squares: { attacker: 'a1', targets: ['a8'] },
      motifInstanceKey: 'battery:a1:a8',
      firstSeenPly: 1,
      geometryEvidence: { basis: 'chess-rule', sourcePlies: [1], note: 'fixture battery' }
    };
    const cc = causeConsequence(1, { mechanism: 'battery', mechanismVerified: true, mechanismMotifId: motif.id });
    const tp = turningPoint(1, 'decisive-swing', cc, 500);
    const understanding = understandingFrom({ plies: [], motifs: [motif], turningPoints: [tp] });
    const story = storyPlanFrom({ centralConflict: centralConflict(tp.id, 1), noConflictReason: undefined });

    const region = deriveBeatVisualRegion(climaxBeatFixture(), ctxWith({ understanding, story }));
    expect(region.primarySquares).toEqual(expect.arrayContaining(['a1', 'a8']));
    expect(region.secondarySquares).toEqual([]);
  });

  it('does not use an unverified motif — falls back to plain move geometry instead', () => {
    const motif: TacticalMotifInstance = {
      id: 'motif-fork-unverified',
      ply: 1,
      motif: 'fork',
      squares: { attacker: 'e5', targets: ['c6', 'g6'] },
      motifInstanceKey: 'fork:e5:c6,g6',
      firstSeenPly: 1,
      geometryEvidence: { basis: 'chess-rule', sourcePlies: [1], note: 'fixture fork' }
    };
    // mechanism is null / mechanismVerified stays false (the default) —
    // a motif merely standing on the ply must never win here.
    const cc = causeConsequence(1, {});
    const tp = turningPoint(1, 'decisive-swing', cc, 500);
    const understanding = understandingFrom({ plies: [], motifs: [motif], turningPoints: [tp] });
    const story = storyPlanFrom({ centralConflict: centralConflict(tp.id, 1), noConflictReason: undefined });

    const game = gameFromMoves([moveRecord(1, 'w', 'q', 'h5', 'e5', 'Qe5')]);
    const region = deriveBeatVisualRegion(climaxBeatFixture(), ctxWith({ game, understanding, story }));
    expect(region.source.kind).toBe('move');
    expect(region.primarySquares).toEqual(expect.arrayContaining(['h5', 'e5']));
    expect(region.primarySquares).not.toContain('c6');
    expect(region.primarySquares).not.toContain('g6');
  });
});

describe('deriveBeatVisualRegion — verified causal facts', () => {
  it('4. defender-loss: uses the real detectDefenderLoss geometry (target + departed defender), not a guess', () => {
    // Real, legal position (same fixture understanding/defenders.test.ts
    // already validates): White rook on d1 attacks the black knight on d5,
    // defended once by the bishop on e6. Bxe6 removes that defender.
    const fenBefore = '4k3/8/4b3/3n4/8/7B/8/3RK3 w - - 0 1';
    const fenAfter = '4k3/8/4B3/3n4/8/8/8/3RK3 b - - 0 1';
    const ply1: PlyAnalysis = {
      ...plyAnalysis(1),
      sideToMove: 'w',
      movePlayedUci: 'h3e6',
      movePlayedSan: 'Bxe6',
      fenBefore,
      fenAfter
    };
    const cc = causeConsequence(1, {});
    const tp = turningPoint(1, 'decisive-swing', cc, 500);
    const chain = consequenceChain(1, { triggerFacts: ['defender-lost'] });
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });
    const story = storyPlanFrom({ centralConflict: centralConflict(tp.id, 1, { consequenceChain: chain }), noConflictReason: undefined });
    const analysis = analysisFrom([ply1]);
    const game = gameFromMoves([moveRecord(1, 'w', 'b', 'h3', 'e6', 'Bxe6')]);

    const region = deriveBeatVisualRegion(climaxBeatFixture(), ctxWith({ game, analysis, understanding, story }));
    expect(region.source).toEqual({ kind: 'defender-loss', ply: 1 });
    expect(region.primarySquares).toContain('d5'); // the target that became winnable
    expect(region.secondarySquares).toContain('e6'); // the departed defender's own square
  });

  it('5. escape-square-removed: uses the real KingMobilityRecord data (the king + exactly the squares that disappeared)', () => {
    const before: KingMobilityRecord = { ply: 0, color: 'b', legalEscapeSquares: ['b7', 'b8'], legalEscapeSquareCount: 2 };
    const after: KingMobilityRecord = { ply: 2, color: 'b', legalEscapeSquares: ['b8'], legalEscapeSquareCount: 1 };
    const ply1: PlyAnalysis = { ...plyAnalysis(1), fenAfter: 'k7/8/8/8/8/8/8/K7 w - - 0 1' };
    const cc = causeConsequence(1, {});
    const tp = turningPoint(1, 'decisive-swing', cc, 500);
    const chain = consequenceChain(1, { triggerFacts: ['escape-square-removed'] });
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], kingMobility: [before, after] });
    const story = storyPlanFrom({ centralConflict: centralConflict(tp.id, 1, { consequenceChain: chain }), noConflictReason: undefined });
    const analysis = analysisFrom([ply1]);

    const region = deriveBeatVisualRegion(climaxBeatFixture(), ctxWith({ analysis, understanding, story }));
    expect(region.source).toEqual({ kind: 'escape-square-removed', ply: 1 });
    expect(region.primarySquares).toEqual(['a8']); // the king's own square
    expect(region.secondarySquares).toEqual(['b7']); // exactly the escape square that disappeared
  });
});

describe('deriveBeatVisualRegion — abstention / low confidence', () => {
  it('11. an unsupported/unverified mechanism never produces a false tactical framing: falls back to the beat\'s own plain move squares', () => {
    // No motif, no causal facts, mechanism unverified — the honest fallback
    // is exactly the beat's own move geometry, never an invented region.
    const cc = causeConsequence(1, {});
    const tp = turningPoint(1, 'decisive-swing', cc, 500);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });
    const story = storyPlanFrom({ centralConflict: centralConflict(tp.id, 1), noConflictReason: undefined });
    const game = gameFromMoves([moveRecord(1, 'w', 'q', 'h5', 'f7', 'Qxf7')]);

    const region = deriveBeatVisualRegion(climaxBeatFixture(), ctxWith({ game, understanding, story }));
    expect(region.source.kind).toBe('move');
    expect(region.primarySquares).toEqual(expect.arrayContaining(['h5', 'f7']));
  });
});

describe('regionsEqual / unionRegions', () => {
  it('regions with the same square set (regardless of primary/secondary split or order) are equal', () => {
    const a = { primarySquares: ['e4', 'e5'], secondarySquares: ['d3'], source: { kind: 'move' as const, plies: [1] } };
    const b = { primarySquares: ['d3', 'e5'], secondarySquares: ['e4'], source: { kind: 'full-board' as const } };
    expect(regionsEqual(a, b)).toBe(true);
  });

  it('regions with different square sets are not equal', () => {
    const a = { primarySquares: ['e4'], secondarySquares: [], source: { kind: 'full-board' as const } };
    const b = { primarySquares: ['e5'], secondarySquares: [], source: { kind: 'full-board' as const } };
    expect(regionsEqual(a, b)).toBe(false);
  });

  it('unionRegions combines every square from every region, deduped', () => {
    const merged = unionRegions([
      { primarySquares: ['e4'], secondarySquares: [], source: { kind: 'full-board' as const } },
      { primarySquares: ['e4', 'd5'], secondarySquares: ['c6'], source: { kind: 'full-board' as const } }
    ]);
    expect(new Set(merged.primarySquares)).toEqual(new Set(['e4', 'd5']));
    expect(merged.secondarySquares).toEqual(['c6']);
  });
});

describe('cameraRoleFor', () => {
  it('maps setup and building-sequence to establish, climax to critical, consequence to consequence, resolution to payoff', () => {
    expect(cameraRoleFor('setup')).toBe('establish');
    expect(cameraRoleFor('building-sequence')).toBe('establish');
    expect(cameraRoleFor('climax')).toBe('critical');
    expect(cameraRoleFor('consequence')).toBe('consequence');
    expect(cameraRoleFor('resolution')).toBe('payoff');
  });
});
