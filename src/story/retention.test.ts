import { describe, expect, it } from 'vitest';
import { classifyMoveTreatment } from './retention';
import { buildBeats } from './beats';
import { causeConsequence, gameArc, plySemantics, plySignals, tacticalMotif, turningPoint, understandingFrom } from './storyFixtures';
import type { CentralConflict } from './types';

describe('classifyMoveTreatment', () => {
  it('classifies every ply into exactly one of the five treatments, none omitted', () => {
    const plies = [
      plySemantics(1, plySignals('w-p-a2'), { qualityClass: 'optimal' }), // theory
      plySemantics(2, plySignals('b-p-a7'), { qualityClass: 'optimal' }), // motif-bearing -> compressible, not theory
      plySemantics(3, plySignals('w-p-b2'), { qualityClass: 'optimal' }), // theory
      plySemantics(4, plySignals('b-p-b7'), { qualityClass: 'optimal' }), // pruned (past the opening window, no evidence)
      plySemantics(5, plySignals('w-p-c2'), { qualityClass: 'optimal' }), // setup (causal chain)
      plySemantics(6, plySignals('b-p-c7'), { qualityClass: 'optimal' }), // spine (climax)
      plySemantics(7, plySignals('w-p-d2'), { qualityClass: 'mistake' }), // compressible (non-optimal)
      plySemantics(8, plySignals('b-p-d7'), { qualityClass: 'optimal' }), // pruned
      plySemantics(9, plySignals('w-p-e2'), { qualityClass: 'optimal' }) // pruned
    ];

    const motif = tacticalMotif('motif-2-0', 2, 'fork', 'b6', ['a8', 'c8']);
    const cc = causeConsequence(6);
    const tp = turningPoint(6, 'decisive-swing', cc, 300);
    const understanding = understandingFrom({
      plies,
      motifs: [motif],
      turningPoints: [tp],
      gameArc: gameArc(3, 3, [])
    });

    const centralConflict: CentralConflict = {
      primaryTurningPointId: 'tp-6',
      causalChain: [{ ply: 5, linkType: 'threat-refutation', evidenceId: 'threat-5-0' }],
      secondaryConflicts: []
    };
    const beats = buildBeats(centralConflict, understanding);

    const result = classifyMoveTreatment(understanding, beats, []);

    expect(result.map((r) => r.ply)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.find((r) => r.ply === 1)!.treatment).toBe('theory');
    expect(result.find((r) => r.ply === 2)!.treatment).toBe('compressible');
    expect(result.find((r) => r.ply === 3)!.treatment).toBe('theory');
    expect(result.find((r) => r.ply === 4)!.treatment).toBe('pruned');
    expect(result.find((r) => r.ply === 5)!.treatment).toBe('setup');
    expect(result.find((r) => r.ply === 6)!.treatment).toBe('spine');
    expect(result.find((r) => r.ply === 7)!.treatment).toBe('compressible');
    expect(result.find((r) => r.ply === 8)!.treatment).toBe('pruned');
    expect(result.find((r) => r.ply === 9)!.treatment).toBe('pruned');
  });

  it('returns an empty list for an empty game, never omitting entries for plies that exist', () => {
    const understanding = understandingFrom({ plies: [] });
    expect(classifyMoveTreatment(understanding, [], [])).toEqual([]);
  });

  it('never deletes the underlying PlySemantics for a pruned ply — it remains in GameUnderstanding.plies', () => {
    const plies = [plySemantics(1, plySignals('w-p-a2'), { qualityClass: 'optimal' })];
    const understanding = understandingFrom({ plies, gameArc: gameArc(0, 0, []) });
    const result = classifyMoveTreatment(understanding, [], []);
    expect(result[0]!.treatment).toBe('pruned');
    // The fact itself is untouched — this is the record 'pruned' only ever labels, never removes.
    expect(understanding.plies).toHaveLength(1);
    expect(understanding.plies[0]!.ply).toBe(1);
  });
});
