import { describe, expect, it } from 'vitest';
import { DEFAULT_CANDIDATE_SETTINGS, detectCandidates, rankScoreFor } from './candidates';
import { evaluationSwingCp, swingForMoverCp, mateTransition } from './evaluation';
import type { Color } from '../chess/ChessEngine';
import type { Evaluation, PlyAnalysis } from './types';

const cp = (value: number): Evaluation => ({ kind: 'cp', cp: value });
const mate = (mateIn: number): Evaluation => ({ kind: 'mate', mateIn });

/**
 * Builds a PlyAnalysis with derived fields computed by the real evaluation
 * helpers, so these tests exercise the same swing/mate maths the analyzer
 * uses rather than hand-written numbers that could drift out of agreement.
 */
function ply(
  plyNumber: number,
  mover: Color,
  before: Evaluation,
  after: Evaluation,
  san = 'Nf3'
): PlyAnalysis {
  return {
    ply: plyNumber,
    moveNumber: Math.ceil(plyNumber / 2),
    sideToMove: mover,
    movePlayedSan: san,
    movePlayedUci: 'g1f3',
    fenBefore: 'fen-before',
    fenAfter: 'fen-after',
    evaluationBefore: before,
    evaluationAfter: after,
    bestMove: 'e2e4',
    principalVariation: ['e2e4'],
    swingCp: evaluationSwingCp(before, after),
    swingForMoverCp: swingForMoverCp(before, after, mover),
    mateTransition: mateTransition(before, after),
    depth: 12
  };
}

describe('rankScoreFor', () => {
  it('scores a quiet move at zero', () => {
    expect(rankScoreFor(ply(1, 'w', cp(20), cp(25)))).toBe(0);
  });

  it('scores a move that GAINS ground for the mover at zero (only losses are significant here)', () => {
    expect(rankScoreFor(ply(1, 'w', cp(20), cp(400)))).toBe(0);
  });

  it('scores a loss by the size of the loss for the mover', () => {
    // White plays a move taking the position from +0.4 to -3.8: a 4.2 pawn loss.
    expect(rankScoreFor(ply(19, 'w', cp(40), cp(-380)))).toBe(420);
  });

  it('scores a Black loss by the same rule, using Black\'s perspective', () => {
    // White-relative -3.0 -> +2.0 played by Black is a 5-pawn loss for Black.
    expect(rankScoreFor(ply(20, 'b', cp(-300), cp(200)))).toBe(500);
  });

  it('adds a bonus when a mate changes hands', () => {
    const flipped = ply(30, 'w', mate(2), mate(-1));
    // loss for mover = 2000 (clamped +1000 -> -1000), plus the mate-flip bonus.
    expect(rankScoreFor(flipped)).toBe(2000 + 1200);
  });

  it('ranks a mate flip above an equally sized non-mate swing', () => {
    const mateFlip = ply(10, 'w', mate(3), mate(-2));
    const bigCpLoss = ply(12, 'w', cp(1000), cp(-1000));
    expect(rankScoreFor(mateFlip)).toBeGreaterThan(rankScoreFor(bigCpLoss));
  });
});

describe('detectCandidates', () => {
  it('returns nothing for an empty game', () => {
    expect(detectCandidates([])).toEqual([]);
  });

  it('returns nothing for a single quiet move', () => {
    expect(detectCandidates([ply(1, 'w', cp(20), cp(30))])).toEqual([]);
  });

  it('returns nothing when no swing reaches the threshold', () => {
    const plies = [
      ply(1, 'w', cp(20), cp(-10)),
      ply(2, 'b', cp(-10), cp(40)),
      ply(3, 'w', cp(40), cp(15))
    ];
    expect(detectCandidates(plies)).toEqual([]);
  });

  it('detects a single large swing and preserves the raw engine numbers', () => {
    // The spec's worked example: move 19, +0.4 -> -3.8, swing -4.2.
    const plies = [
      ply(1, 'w', cp(20), cp(25)),
      ply(19, 'w', cp(40), cp(-380), 'Qxh7')
    ];
    const candidates = detectCandidates(plies);

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.ply).toBe(19);
    expect(candidate.movePlayedSan).toBe('Qxh7');
    expect(candidate.evaluationBefore).toEqual(cp(40));
    expect(candidate.evaluationAfter).toEqual(cp(-380));
    expect(candidate.swingCp).toBe(-420); // white-relative
    expect(candidate.swingForMoverCp).toBe(-420); // White moved, so same sign
    expect(candidate.mateTransition).toBe('none');
  });

  it('detects a Black error with the correct perspective', () => {
    // White-relative the evaluation IMPROVES (+2.0 -> +5.0), but Black moved,
    // so this is Black losing three pawns of ground — a candidate.
    const candidates = detectCandidates([ply(20, 'b', cp(200), cp(500), 'Nc6')]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.swingCp).toBe(300); // white-relative: positive
    expect(candidates[0]!.swingForMoverCp).toBe(-300); // mover-relative: negative
  });

  it('does NOT flag a move that improves the mover\'s position, however large', () => {
    // White-relative +2.0 -> +5.0 played by WHITE is a great move, not a candidate.
    expect(detectCandidates([ply(19, 'w', cp(200), cp(500))])).toEqual([]);
  });

  it('flags a mate transition even when the clamped centipawn swing is small', () => {
    // Already completely winning (+1000 clamped) and now mating: the centipawn
    // scale cannot express the change, but a mate appearing is still notable.
    const candidates = detectCandidates([ply(41, 'w', cp(1200), mate(3), 'a8=Q')]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.mateTransition).toBe('mate-appeared');
    expect(candidates[0]!.swingCp).toBe(0); // both saturate at the clamp
  });

  it('ranks the most significant swing first', () => {
    const plies = [
      ply(5, 'w', cp(0), cp(-150)), // 1.5 pawn loss
      ply(9, 'w', cp(50), cp(-600)), // 6.5 pawn loss  <- biggest
      ply(13, 'b', cp(-100), cp(200)) // 3.0 pawn loss for Black
    ];
    const candidates = detectCandidates(plies);
    expect(candidates.map((c) => c.ply)).toEqual([9, 13, 5]);
    expect(candidates[0]!.rankScore).toBeGreaterThan(candidates[1]!.rankScore);
  });

  it('places a mate flip above a large centipawn loss', () => {
    const plies = [
      ply(7, 'w', cp(300), cp(-700)), // 10 pawn loss = 1000
      ply(11, 'w', mate(2), mate(-3)) // mate flip = 2000 + 1200
    ];
    expect(detectCandidates(plies).map((c) => c.ply)).toEqual([11, 7]);
  });

  it('breaks ties deterministically by ply number ascending', () => {
    const plies = [
      ply(30, 'w', cp(0), cp(-300)),
      ply(10, 'w', cp(0), cp(-300)),
      ply(20, 'w', cp(0), cp(-300))
    ];
    // identical rank scores -> ordering must fall back to ply order
    expect(detectCandidates(plies).map((c) => c.ply)).toEqual([10, 20, 30]);
  });

  it('is deterministic: repeated runs over the same input give identical output', () => {
    const plies = [
      ply(3, 'w', cp(10), cp(-420)),
      ply(8, 'b', cp(-50), cp(380)),
      ply(15, 'w', mate(4), cp(-100)),
      ply(22, 'b', cp(0), cp(0))
    ];
    const first = detectCandidates(plies);
    const second = detectCandidates(plies);
    const third = detectCandidates([...plies]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('respects maxCandidates after ranking, keeping the most significant', () => {
    const plies = [
      ply(1, 'w', cp(0), cp(-200)),
      ply(3, 'w', cp(0), cp(-800)),
      ply(5, 'w', cp(0), cp(-500))
    ];
    const candidates = detectCandidates(plies, { minSwingCp: 100, maxCandidates: 2 });
    expect(candidates.map((c) => c.ply)).toEqual([3, 5]);
  });

  it('respects a custom minSwingCp threshold', () => {
    const plies = [ply(1, 'w', cp(0), cp(-150))];
    expect(detectCandidates(plies, { ...DEFAULT_CANDIDATE_SETTINGS, minSwingCp: 100 })).toHaveLength(1);
    expect(detectCandidates(plies, { ...DEFAULT_CANDIDATE_SETTINGS, minSwingCp: 200 })).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const plies = [ply(9, 'w', cp(0), cp(-500)), ply(1, 'w', cp(0), cp(-900))];
    const snapshot = plies.map((p) => p.ply);
    detectCandidates(plies);
    expect(plies.map((p) => p.ply)).toEqual(snapshot);
  });
});
