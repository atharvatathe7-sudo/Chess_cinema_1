import { describe, expect, it } from 'vitest';
import type { GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { CauseConsequenceRecord, TurningPoint } from '../understanding/types';
import { DEFAULT_STORY_SETTINGS } from './types';
import { buildCausalChain, selectCentralConflict } from './centralConflict';
import {
  analysisFrom,
  causeConsequence,
  forcedSequence,
  plyAnalysis,
  plySemantics,
  plySignals,
  threatRecord,
  turningPoint,
  understandingFrom,
  unknownOutcome
} from './storyFixtures';

/**
 * Phase 15 — selectCentralConflict no longer ranks turning points by
 * significance.score; it runs the five-gate cascade in storyCandidates.ts
 * (which has its own dedicated suite). What remains this file's concern is
 * what selectCentralConflict itself owns: abstention reasons, the SECONDARY
 * conflict list (which rankTurningPoints still orders), causal-chain
 * absorption, and buildCausalChain — which is unchanged.
 *
 * Fixtures here are built to be Gate-1 admissible on purpose: each turning
 * point carries a real mate transition, which both supplies a meaningful
 * consequence and exempts it from the persistence window (a mate cannot be
 * asked to persist for six plies — the game ends). Anything testing
 * admissibility itself belongs in storyCandidates.test.ts.
 */

function admissiblePly(ply: number): PlyAnalysis {
  return plyAnalysis(ply, { mateTransition: 'mate-appeared' });
}

function analysisFor(plies: readonly number[]): GameAnalysis {
  return analysisFrom(plies.map(admissiblePly));
}

function admissibleTurningPoint(ply: number, score: number, overrides: Partial<CauseConsequenceRecord> = {}): TurningPoint {
  const cc = causeConsequence(ply, {
    materialConsequence: { atPly: ply, netMaterialChange: 300 },
    ...overrides
  });
  return turningPoint(ply, 'mate-appeared', cc, score);
}

describe('selectCentralConflict', () => {
  it('returns null with no-turning-points when there are zero turning points', () => {
    const understanding = understandingFrom({ plies: [] });
    const result = selectCentralConflict(understanding, analysisFrom([]), unknownOutcome(), DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict).toBeNull();
    expect(result.noConflictReason).toBe('no-turning-points');
  });

  it('selects the single admissible turning point, with no secondaries', () => {
    const tp = admissibleTurningPoint(5, 300);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const result = selectCentralConflict(understanding, analysisFor([5]), unknownOutcome(), DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict).not.toBeNull();
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-5');
    expect(result.centralConflict!.secondaryConflicts).toEqual([]);
    // Phase 15 — the conflict now carries its own directional chain and tier.
    expect(result.centralConflict!.consequenceChain.triggerPly).toBe(5);
    expect(result.centralConflict!.tier).toBeDefined();
  });

  it('orders secondaryConflicts by significance.score descending', () => {
    const tpHigh = admissibleTurningPoint(9, 500);
    const tpMid = admissibleTurningPoint(3, 400);
    const tpLow = admissibleTurningPoint(7, 200);
    const understanding = understandingFrom({ plies: [], turningPoints: [tpLow, tpHigh, tpMid] });

    const result = selectCentralConflict(understanding, analysisFor([3, 7, 9]), unknownOutcome(), DEFAULT_STORY_SETTINGS);
    const secondaries = result.centralConflict!.secondaryConflicts;
    // Whichever the cascade selected as primary is excluded; the rest keep
    // significance order, which is still how the secondary list is ranked.
    expect(secondaries).not.toContain(result.centralConflict!.primaryTurningPointId);
    expect(secondaries).toEqual([...secondaries].sort((a, b) => {
      const scoreOf = (id: string) => [tpHigh, tpMid, tpLow].find((t) => t.id === id)!.significance.score;
      return scoreOf(b) - scoreOf(a);
    }));
  });

  it('returns below-significance-floor when the selected turning point does not clear a raised floor', () => {
    const tp = admissibleTurningPoint(5, 50);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const result = selectCentralConflict(understanding, analysisFor([5]), unknownOutcome(), {
      ...DEFAULT_STORY_SETTINGS,
      significanceFloorForConflict: 100
    });
    expect(result.centralConflict).toBeNull();
    expect(result.noConflictReason).toBe('below-significance-floor');
  });

  it('caps secondaryConflicts at maxSecondaryConflicts', () => {
    const plies = [10, 20, 30, 40, 50];
    const turningPoints = plies.map((ply, i) => admissibleTurningPoint(ply, 1000 - i * 10));
    const understanding = understandingFrom({ plies: [], turningPoints });

    const result = selectCentralConflict(understanding, analysisFor(plies), unknownOutcome(), {
      ...DEFAULT_STORY_SETTINGS,
      maxSecondaryConflicts: 2
    });
    expect(result.centralConflict!.secondaryConflicts).toHaveLength(2);
  });

  it('does not manufacture a conflict from GameAnalysis.candidates-shaped data when turningPoints is empty', () => {
    // Selection reads turningPoints and the resolved GameOutcome. It has no
    // access to GameAnalysis.candidates at all, so a candidate list can never
    // become a story by itself.
    const understanding = understandingFrom({ plies: [] });
    const result = selectCentralConflict(understanding, analysisFrom([]), unknownOutcome(), DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict).toBeNull();
  });

  it('does NOT link two turning points that are merely near each other in ply number', () => {
    const tpA = admissibleTurningPoint(10, 500);
    const tpB = admissibleTurningPoint(12, 200);
    const understanding = understandingFrom({ plies: [], turningPoints: [tpA, tpB] });

    const result = selectCentralConflict(understanding, analysisFor([10, 12]), unknownOutcome(), DEFAULT_STORY_SETTINGS);
    const conflict = result.centralConflict!;
    // Ply adjacency is never a causal link, so the other turning point stays
    // a genuine secondary rather than being absorbed into the chain.
    expect(conflict.causalChain).toEqual([]);
    expect(conflict.secondaryConflicts).toHaveLength(1);
  });

  it('absorbs a causally-linked turning point out of secondaryConflicts entirely', () => {
    const seq = forcedSequence('seq-3', [20, 21]);
    const ccWinner = causeConsequence(21, {
      materialConsequence: { atPly: 21, netMaterialChange: 900 },
      multiMoveConsequence: { sequenceId: 'seq-3', endPly: 21 }
    });
    const tpWinner = turningPoint(21, 'forced-mate-delivery', ccWinner, 900);
    const tpLinked = admissibleTurningPoint(20, 150);
    const understanding = understandingFrom({ plies: [], sequences: [seq], turningPoints: [tpWinner, tpLinked] });

    const result = selectCentralConflict(understanding, analysisFor([20, 21]), unknownOutcome(), DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-21');
    expect(result.centralConflict!.causalChain.map((l) => l.ply)).toContain(20);
    expect(result.centralConflict!.secondaryConflicts).toEqual([]);
  });
});

describe('buildCausalChain', () => {
  it('links plies sharing the same ForcedSequence', () => {
    const seq = forcedSequence('seq-1', [3, 4, 5, 6]);
    const cc = causeConsequence(6);
    const understanding = understandingFrom({ plies: [], sequences: [seq], turningPoints: [turningPoint(6, 'decisive-swing', cc, 300)] });

    const chain = buildCausalChain(6, understanding);
    expect(chain.map((l) => l.ply)).toEqual([3, 4, 5]);
    expect(chain.every((l) => l.linkType === 'same-sequence' && l.evidenceId === 'seq-1')).toBe(true);
  });

  it('links a ply forward via multiMoveConsequence to its sequence members', () => {
    // The sequence deliberately does NOT include ply 8 itself, isolating the
    // multi-move-consequence path from the same-sequence path — in
    // understandGame.ts's real construction the two nearly always coincide
    // (the triggering ply is typically also a member of its own consequence
    // sequence), but nothing in the type system requires that, and same-
    // sequence checks first when they do coincide. This fixture exercises
    // multi-move-consequence on its own terms.
    const seq = forcedSequence('seq-2', [9, 10]);
    const cc = causeConsequence(8, { multiMoveConsequence: { sequenceId: 'seq-2', endPly: 10 } });
    const understanding = understandingFrom({ plies: [], sequences: [seq], turningPoints: [turningPoint(8, 'decisive-swing', cc, 300)] });

    const chain = buildCausalChain(8, understanding);
    expect(chain.map((l) => l.ply).sort((a, b) => a - b)).toEqual([9, 10]);
    expect(chain.every((l) => l.linkType === 'multi-move-consequence')).toBe(true);
  });

  it('links a threat to the ply that refuted it, in both directions', () => {
    const threat = threatRecord('threat-2-0', 2, 'w', 'material-winning-threat', 'e5', { refutedBy: { ply: 6, moveUci: 'e5f6' } });
    const ccAtRefutation = causeConsequence(6);
    const understanding = understandingFrom({
      plies: [],
      threats: [threat],
      turningPoints: [turningPoint(6, 'decisive-swing', ccAtRefutation, 300)]
    });

    const chainFromRefutation = buildCausalChain(6, understanding);
    expect(chainFromRefutation).toEqual([{ ply: 2, linkType: 'threat-refutation', evidenceId: 'threat-2-0' }]);

    const chainFromThreat = buildCausalChain(2, understanding);
    expect(chainFromThreat).toEqual([{ ply: 6, linkType: 'threat-refutation', evidenceId: 'threat-2-0' }]);
  });
});

// Keeps the fixture helpers exercised for plySemantics/plySignals too, so an
// unused-import regression in storyFixtures.ts would be caught here.
describe('fixture sanity', () => {
  it('plySemantics/plySignals fixtures produce a well-formed PlySemantics', () => {
    const ps = plySemantics(1, plySignals('w-p-e2'));
    expect(ps.ply).toBe(1);
    expect(ps.signals.pieceId).toBe('w-p-e2');
  });
});
