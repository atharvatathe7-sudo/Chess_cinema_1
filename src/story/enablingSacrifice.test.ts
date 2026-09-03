import { describe, expect, it } from 'vitest';
import type { NarrativeArchetypeSignal } from '../understanding/types';
import { enablingSacrificePly } from './archetypes';
import { causeConsequence, forcedSequence, plySemantics, plySignals, turningPoint, understandingFrom } from './storyFixtures';

/**
 * Phase 16 (MUST HAVE 7) — separating "a sacrifice happened during a king
 * hunt" from "the sacrifice enabled the mating sequence".
 *
 * Every fixture here is synthetic and shape-driven. No game id, SAN, FEN, or
 * move number from the benchmark corpus appears; the shapes below are the
 * general structures the rule is written against, and a real game improves
 * only if it happens to match one.
 */

/** A hunt whose plies are `plies`, qualified by a mate turning point at `matePly`. */
function huntUnderstanding(options: {
  huntPlies: readonly number[];
  matePly: number;
  sacrificePly?: number;
  sacrificeSequenceId?: string;
  sequences?: readonly ReturnType<typeof forcedSequence>[];
}) {
  const { huntPlies, matePly, sacrificePly, sacrificeSequenceId, sequences } = options;
  const plies = sacrificePly === undefined
    ? []
    : [
        plySemantics(
          sacrificePly,
          plySignals('w-q-d1', {
            isSacrifice: true,
            ...(sacrificeSequenceId !== undefined ? { forcedSequenceId: sacrificeSequenceId } : {})
          })
        )
      ];
  return understandingFrom({
    plies,
    sequences: sequences ?? [],
    turningPoints: [turningPoint(matePly, 'forced-mate-delivery', causeConsequence(matePly), 900)],
    narrativeSignals: [
      {
        archetype: 'king-hunt',
        supportingEvidence: [{ basis: 'inference', confidence: 0.55, sourcePlies: [...huntPlies], note: 'fixture hunt' }],
        confidence: 0.55
      } satisfies NarrativeArchetypeSignal
    ]
  });
}

describe('a valid enabling sacrifice', () => {
  it('is reported when the sacrifice forces a sequence that reaches the mate', () => {
    // The canonical shape: the sacrifice is checked into a forced sequence,
    // the opponent's forced reply follows, and mate lands on the next ply —
    // one past the sequence's own end, exactly as gameArc.ts documents.
    const understanding = huntUnderstanding({
      huntPlies: [51, 52, 53, 54, 55, 56, 57, 58],
      matePly: 59,
      sacrificePly: 57,
      sacrificeSequenceId: 'seq-sac',
      sequences: [forcedSequence('seq-sac', [57, 58], 'check')]
    });
    expect(enablingSacrificePly([51, 52, 53, 54, 55, 56, 57, 58, 59], understanding)).toBe(57);
  });

  it('is reported when the mate turning point lies INSIDE the sacrifice’s own sequence', () => {
    const understanding = huntUnderstanding({
      huntPlies: [20, 21, 22, 23],
      matePly: 23,
      sacrificePly: 20,
      sacrificeSequenceId: 'seq-sac',
      sequences: [forcedSequence('seq-sac', [20, 21, 22, 23], 'check')]
    });
    expect(enablingSacrificePly([20, 21, 22, 23], understanding)).toBe(20);
  });

  it('follows an adjacent-continuous run of check sequences to the mate', () => {
    // detectForcedSequences splits a continuous alternating-check hunt into
    // short sequences; the run is reassembled by exact adjacency only.
    const understanding = huntUnderstanding({
      huntPlies: [30, 31, 32, 33, 34, 35],
      matePly: 36,
      sacrificePly: 30,
      sacrificeSequenceId: 'seq-a',
      sequences: [
        forcedSequence('seq-a', [30, 31], 'check'),
        forcedSequence('seq-b', [32, 33], 'check'),
        forcedSequence('seq-c', [34, 35], 'check')
      ]
    });
    expect(enablingSacrificePly([30, 31, 32, 33, 34, 35, 36], understanding)).toBe(30);
  });

  it('picks the earliest qualifying sacrifice when several qualify, deterministically', () => {
    const base = huntUnderstanding({
      huntPlies: [40, 41, 42, 43],
      matePly: 44,
      sequences: [forcedSequence('seq-sac', [40, 41, 42, 43], 'check')]
    });
    const understanding = understandingFrom({
      ...base,
      plies: [
        plySemantics(42, plySignals('w-r-a1', { isSacrifice: true, forcedSequenceId: 'seq-sac' })),
        plySemantics(40, plySignals('w-q-d1', { isSacrifice: true, forcedSequenceId: 'seq-sac' }))
      ]
    });
    expect(enablingSacrificePly([40, 41, 42, 43, 44], understanding)).toBe(40);
  });
});

describe('an INCIDENTAL sacrifice in the hunt is not enabling', () => {
  it('is rejected when it forced no sequence at all', () => {
    // Inside the hunt, genuinely a sacrifice, but it forced nothing — so it
    // cannot have produced a forced mate. This is the weaker fact that must
    // never be promoted to the stronger claim.
    const understanding = huntUnderstanding({
      huntPlies: [51, 52, 53, 54],
      matePly: 55,
      sacrificePly: 52,
      sequences: [forcedSequence('seq-other', [53, 54], 'check')]
    });
    expect(enablingSacrificePly([51, 52, 53, 54, 55], understanding)).toBeUndefined();
  });

  it('is rejected when its sequence ends well before the mate, with no adjacent continuation', () => {
    const understanding = huntUnderstanding({
      huntPlies: [51, 52, 53, 54, 55, 56, 57, 58],
      matePly: 59,
      sacrificePly: 51,
      sacrificeSequenceId: 'seq-early',
      // Ends at 52; the next sequence starts at 56, so the run is broken.
      sequences: [forcedSequence('seq-early', [51, 52], 'check'), forcedSequence('seq-late', [56, 57], 'check')]
    });
    expect(enablingSacrificePly([51, 52, 53, 54, 55, 56, 57, 58, 59], understanding)).toBeUndefined();
  });

  it('is rejected when it happens AFTER the mate-qualifying event', () => {
    const understanding = huntUnderstanding({
      huntPlies: [10, 11, 12, 13, 14],
      matePly: 11,
      sacrificePly: 13,
      sacrificeSequenceId: 'seq-sac',
      sequences: [forcedSequence('seq-sac', [13, 14], 'check')]
    });
    expect(enablingSacrificePly([10, 11, 12, 13, 14], understanding)).toBeUndefined();
  });
});

describe('a sacrifice OUTSIDE the hunt is not enabling', () => {
  it('is rejected even when it forced a sequence reaching the same mate ply', () => {
    const understanding = huntUnderstanding({
      huntPlies: [51, 52, 53, 54],
      matePly: 55,
      sacrificePly: 12, // far outside the hunt
      sacrificeSequenceId: 'seq-sac',
      sequences: [forcedSequence('seq-sac', [12, 13], 'check')]
    });
    expect(enablingSacrificePly([51, 52, 53, 54, 55], understanding)).toBeUndefined();
  });
});

describe('a sacrifice with no connection to a mate is not enabling', () => {
  it('is rejected when the hunt has no mate-qualifying turning point at all', () => {
    const understanding = understandingFrom({
      plies: [plySemantics(52, plySignals('w-q-d1', { isSacrifice: true, forcedSequenceId: 'seq-sac' }))],
      sequences: [forcedSequence('seq-sac', [52, 53], 'check')],
      // A decisive swing is not a mate-qualifying event.
      turningPoints: [turningPoint(53, 'decisive-swing', causeConsequence(53), 400)]
    });
    expect(enablingSacrificePly([51, 52, 53, 54], understanding)).toBeUndefined();
  });

  it('is rejected when there is no sacrifice in the game at all', () => {
    const understanding = huntUnderstanding({ huntPlies: [51, 52, 53], matePly: 54 });
    expect(enablingSacrificePly([51, 52, 53, 54], understanding)).toBeUndefined();
  });

  it('does not treat a non-sacrifice ply inside a forcing sequence as enabling', () => {
    const understanding = understandingFrom({
      plies: [plySemantics(57, plySignals('w-q-d1', { isSacrifice: false, forcedSequenceId: 'seq-sac' }))],
      sequences: [forcedSequence('seq-sac', [57, 58], 'check')],
      turningPoints: [turningPoint(59, 'forced-mate-delivery', causeConsequence(59), 900)]
    });
    expect(enablingSacrificePly([56, 57, 58, 59], understanding)).toBeUndefined();
  });
});

describe('determinism', () => {
  it('returns the same answer across repeated calls', () => {
    const understanding = huntUnderstanding({
      huntPlies: [51, 52, 53, 54, 55, 56, 57, 58],
      matePly: 59,
      sacrificePly: 57,
      sacrificeSequenceId: 'seq-sac',
      sequences: [forcedSequence('seq-sac', [57, 58], 'check')]
    });
    const plies = [51, 52, 53, 54, 55, 56, 57, 58, 59];
    expect(enablingSacrificePly(plies, understanding)).toBe(enablingSacrificePly(plies, understanding));
  });
});
