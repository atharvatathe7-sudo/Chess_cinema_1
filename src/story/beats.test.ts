import { describe, expect, it } from 'vitest';
import { buildBeats } from './beats';
import { causeConsequence, plySemantics, plySignals, turningPoint, understandingFrom,
  consequenceChain
} from './storyFixtures';
import type { CentralConflict } from './types';

function pliesUpTo(n: number) {
  return Array.from({ length: n }, (_, i) => plySemantics(i + 1, plySignals('w-p-e2')));
}

describe('buildBeats', () => {
  it('returns no beats when there is no central conflict', () => {
    expect(buildBeats(null, understandingFrom({ plies: [] }))).toEqual([]);
  });

  it('produces only climax + resolution when the climax move itself ends the game', () => {
    const cc = causeConsequence(5); // default atPly === 5 for both consequence fields
    const tp = turningPoint(5, 'forced-mate-delivery', cc, 900);
    const understanding = understandingFrom({ plies: pliesUpTo(5), turningPoints: [tp] });
    const centralConflict: CentralConflict = { primaryTurningPointId: 'tp-5', causalChain: [], secondaryConflicts: [],
      consequenceChain: consequenceChain(0),
      tier: 'C' as const };

    const beats = buildBeats(centralConflict, understanding);
    expect(beats.map((b) => b.role)).toEqual(['climax', 'resolution']);
    expect(beats.find((b) => b.role === 'climax')!.plies).toEqual([5]);
    expect(beats.find((b) => b.role === 'resolution')!.plies).toEqual([5]);
    expect(beats.every((b) => b.salience === 900)).toBe(true);
  });

  it('produces a consequence beat (no resolution) when the consequence range stays short of the game end', () => {
    const cc = causeConsequence(4, {
      evaluationConsequence: { atPly: 6, swingCp: 400 },
      materialConsequence: { atPly: 6, netMaterialChange: 400 }
    });
    const tp = turningPoint(4, 'decisive-swing', cc, 500);
    const understanding = understandingFrom({ plies: pliesUpTo(10), turningPoints: [tp] });
    const centralConflict: CentralConflict = { primaryTurningPointId: 'tp-4', causalChain: [], secondaryConflicts: [],
      consequenceChain: consequenceChain(0),
      tier: 'C' as const };

    const beats = buildBeats(centralConflict, understanding);
    expect(beats.map((b) => b.role)).toEqual(['climax', 'consequence']);
    expect(beats.find((b) => b.role === 'consequence')!.plies).toEqual([5, 6]);
  });

  it('splits a consequence range that reaches the game end into consequence + resolution', () => {
    const cc = causeConsequence(5, {
      evaluationConsequence: { atPly: 8, swingCp: 600 },
      materialConsequence: { atPly: 8, netMaterialChange: 600 },
      multiMoveConsequence: { sequenceId: 'seq-x', endPly: 8 }
    });
    const tp = turningPoint(5, 'decisive-swing', cc, 600);
    const understanding = understandingFrom({ plies: pliesUpTo(8), turningPoints: [tp] });
    const centralConflict: CentralConflict = { primaryTurningPointId: 'tp-5', causalChain: [], secondaryConflicts: [],
      consequenceChain: consequenceChain(0),
      tier: 'C' as const };

    const beats = buildBeats(centralConflict, understanding);
    expect(beats.map((b) => b.role)).toEqual(['climax', 'consequence', 'resolution']);
    expect(beats.find((b) => b.role === 'consequence')!.plies).toEqual([6, 7]);
    expect(beats.find((b) => b.role === 'consequence')!.evidenceRefs.sequenceId).toBe('seq-x');
    expect(beats.find((b) => b.role === 'resolution')!.plies).toEqual([8]);
  });

  it('produces a setup beat from threat-refutation causal links before the climax', () => {
    const cc = causeConsequence(10);
    const tp = turningPoint(10, 'decisive-swing', cc, 400);
    const understanding = understandingFrom({ plies: pliesUpTo(10), turningPoints: [tp] });
    const centralConflict: CentralConflict = {
      primaryTurningPointId: 'tp-10',
      causalChain: [{ ply: 3, linkType: 'threat-refutation', evidenceId: 'threat-3-0' }],
      secondaryConflicts: [],
      consequenceChain: consequenceChain(0),
      tier: 'C' as const
    };

    const beats = buildBeats(centralConflict, understanding);
    const setup = beats.find((b) => b.role === 'setup');
    expect(setup).toBeDefined();
    expect(setup!.plies).toEqual([3]);
    expect(setup!.evidenceRefs.threatIds).toEqual(['threat-3-0']);
  });

  it('produces a building-sequence beat from same-sequence/multi-move-consequence causal links before the climax', () => {
    const cc = causeConsequence(10);
    const tp = turningPoint(10, 'decisive-swing', cc, 400);
    const understanding = understandingFrom({ plies: pliesUpTo(10), turningPoints: [tp] });
    const centralConflict: CentralConflict = {
      primaryTurningPointId: 'tp-10',
      causalChain: [{ ply: 8, linkType: 'same-sequence', evidenceId: 'seq-y' }],
      secondaryConflicts: [],
      consequenceChain: consequenceChain(0),
      tier: 'C' as const
    };

    const beats = buildBeats(centralConflict, understanding);
    const building = beats.find((b) => b.role === 'building-sequence');
    expect(building).toBeDefined();
    expect(building!.plies).toEqual([8]);
    expect(building!.evidenceRefs.sequenceId).toBe('seq-y');
  });

  it('every beat id follows the beat-{role}-{firstPly} format', () => {
    const cc = causeConsequence(6);
    const tp = turningPoint(6, 'decisive-swing', cc, 300);
    const understanding = understandingFrom({ plies: pliesUpTo(6), turningPoints: [tp] });
    const centralConflict: CentralConflict = {
      primaryTurningPointId: 'tp-6',
      causalChain: [{ ply: 2, linkType: 'threat-refutation', evidenceId: 'threat-2-0' }],
      secondaryConflicts: [],
      consequenceChain: consequenceChain(0),
      tier: 'C' as const
    };

    const beats = buildBeats(centralConflict, understanding);
    for (const beat of beats) {
      expect(beat.id).toBe(`beat-${beat.role}-${beat.plies[0]}`);
    }
  });
});
