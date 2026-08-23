import { describe, expect, it } from 'vitest';
import { DEFAULT_STORY_SETTINGS } from './types';
import { buildCausalChain, selectCentralConflict } from './centralConflict';
import { causeConsequence, forcedSequence, threatRecord, turningPoint, understandingFrom, plySemantics, plySignals } from './storyFixtures';

describe('selectCentralConflict', () => {
  it('returns null with no-turning-points when there are zero turning points', () => {
    const understanding = understandingFrom({ plies: [] });
    const result = selectCentralConflict(understanding, DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict).toBeNull();
    expect(result.noConflictReason).toBe('no-turning-points');
  });

  it('selects the single turning point trivially, with an empty causal chain and no secondaries', () => {
    const cc = causeConsequence(5);
    const tp = turningPoint(5, 'decisive-swing', cc, 300);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const result = selectCentralConflict(understanding, DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict).not.toBeNull();
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-5');
    expect(result.centralConflict!.causalChain).toEqual([]);
    expect(result.centralConflict!.secondaryConflicts).toEqual([]);
  });

  it('ranks by significance.score descending, then |netMaterialChange| descending, then ply ascending', () => {
    const ccLow = causeConsequence(3, { materialConsequence: { atPly: 3, netMaterialChange: 100 } });
    const ccHigh = causeConsequence(9, { materialConsequence: { atPly: 9, netMaterialChange: 900 } });
    const tpLow = turningPoint(3, 'decisive-swing', ccLow, 200);
    const tpHigh = turningPoint(9, 'decisive-swing', ccHigh, 500);
    const understanding = understandingFrom({ plies: [], turningPoints: [tpLow, tpHigh] });

    const result = selectCentralConflict(understanding, DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-9');
    expect(result.centralConflict!.secondaryConflicts).toEqual(['tp-3']);
  });

  it('breaks a significance.score tie by |netMaterialChange| descending', () => {
    const ccSmallMaterial = causeConsequence(2, { materialConsequence: { atPly: 2, netMaterialChange: 50 } });
    const ccBigMaterial = causeConsequence(7, { materialConsequence: { atPly: 7, netMaterialChange: 800 } });
    const tpA = turningPoint(2, 'decisive-swing', ccSmallMaterial, 300);
    const tpB = turningPoint(7, 'decisive-swing', ccBigMaterial, 300);
    const understanding = understandingFrom({ plies: [], turningPoints: [tpA, tpB] });

    const result = selectCentralConflict(understanding, DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-7');
  });

  it('breaks a fully-tied score and material by ply ascending', () => {
    const ccA = causeConsequence(4, { materialConsequence: { atPly: 4, netMaterialChange: 300 } });
    const ccB = causeConsequence(11, { materialConsequence: { atPly: 11, netMaterialChange: 300 } });
    const tpA = turningPoint(4, 'decisive-swing', ccA, 300);
    const tpB = turningPoint(11, 'decisive-swing', ccB, 300);
    const understanding = understandingFrom({ plies: [], turningPoints: [tpB, tpA] });

    const result = selectCentralConflict(understanding, DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-4');
  });

  it('returns below-significance-floor when the top-ranked turning point does not clear a raised floor', () => {
    const cc = causeConsequence(5);
    const tp = turningPoint(5, 'decisive-swing', cc, 50);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const result = selectCentralConflict(understanding, { ...DEFAULT_STORY_SETTINGS, significanceFloorForConflict: 100 });
    expect(result.centralConflict).toBeNull();
    expect(result.noConflictReason).toBe('below-significance-floor');
  });

  it('caps secondaryConflicts at maxSecondaryConflicts', () => {
    const turningPoints = [10, 20, 30, 40, 50].map((ply, i) =>
      turningPoint(ply, 'decisive-swing', causeConsequence(ply), 1000 - i * 10)
    );
    const understanding = understandingFrom({ plies: [], turningPoints });

    const result = selectCentralConflict(understanding, { ...DEFAULT_STORY_SETTINGS, maxSecondaryConflicts: 2 });
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-10');
    expect(result.centralConflict!.secondaryConflicts).toEqual(['tp-20', 'tp-30']);
  });

  it('does not manufacture a conflict from GameAnalysis.candidates-shaped data when turningPoints is empty (structural check: selectCentralConflict takes no analysis/candidates argument at all)', () => {
    // selectCentralConflict's signature only accepts (understanding, settings) —
    // there is no way to pass GameAnalysis.candidates into it, so this is
    // enforced at the type level rather than by a runtime assertion.
    const understanding = understandingFrom({ plies: [] });
    const result = selectCentralConflict(understanding, DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict).toBeNull();
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

  it('does NOT link two turning points that are merely near each other in ply number with no real connection', () => {
    const ccA = causeConsequence(10);
    const ccB = causeConsequence(12);
    const tpA = turningPoint(10, 'decisive-swing', ccA, 500);
    const tpB = turningPoint(12, 'decisive-swing', ccB, 200);
    const understanding = understandingFrom({ plies: [], turningPoints: [tpA, tpB] });

    const result = selectCentralConflict(understanding, DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-10');
    expect(result.centralConflict!.causalChain).toEqual([]);
    // tp-12 was NOT absorbed into the chain — it remains a genuine secondary conflict.
    expect(result.centralConflict!.secondaryConflicts).toEqual(['tp-12']);
  });

  it('absorbs a causally-linked turning point out of secondaryConflicts entirely', () => {
    const seq = forcedSequence('seq-3', [20, 21]);
    const ccWinner = causeConsequence(21);
    const ccLinked = causeConsequence(20);
    const tpWinner = turningPoint(21, 'forced-mate-delivery', ccWinner, 900);
    const tpLinked = turningPoint(20, 'decisive-swing', ccLinked, 150);
    const understanding = understandingFrom({ plies: [], sequences: [seq], turningPoints: [tpWinner, tpLinked] });

    const result = selectCentralConflict(understanding, DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict!.primaryTurningPointId).toBe('tp-21');
    expect(result.centralConflict!.causalChain).toEqual([{ ply: 20, linkType: 'same-sequence', evidenceId: 'seq-3' }]);
    expect(result.centralConflict!.secondaryConflicts).toEqual([]);
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
