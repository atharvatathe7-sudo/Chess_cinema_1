import { describe, expect, it } from 'vitest';
import {
  evaluationSwingCp,
  formatEvaluation,
  formatSwingCp,
  fromUciScore,
  mateTransition,
  swingForMoverCp,
  toComparableCp,
  SWING_CLAMP_CP
} from './evaluation';
import type { Evaluation } from './types';

const cp = (value: number): Evaluation => ({ kind: 'cp', cp: value });
const mate = (mateIn: number): Evaluation => ({ kind: 'mate', mateIn });

describe('fromUciScore — the one and only sign flip', () => {
  it('keeps engine sign when WHITE is to move (engine is already white-relative there)', () => {
    expect(fromUciScore({ kind: 'cp', value: 250 }, 'w')).toEqual(cp(250));
    expect(fromUciScore({ kind: 'cp', value: -180 }, 'w')).toEqual(cp(-180));
  });

  it('flips engine sign when BLACK is to move', () => {
    // Engine says "+3.00 for the side to move"; the side to move is Black,
    // so white-relative that is -3.00.
    expect(fromUciScore({ kind: 'cp', value: 300 }, 'b')).toEqual(cp(-300));
    // Engine says Black (to move) is losing by 1.5 -> White is +1.5.
    expect(fromUciScore({ kind: 'cp', value: -150 }, 'b')).toEqual(cp(150));
  });

  it('flips mate scores the same way', () => {
    // White to move, mate in 3 for the mover => White mates in 3.
    expect(fromUciScore({ kind: 'mate', value: 3 }, 'w')).toEqual(mate(3));
    // Black to move, mate in 3 for the mover => Black mates in 3 => negative.
    expect(fromUciScore({ kind: 'mate', value: 3 }, 'b')).toEqual(mate(-3));
    // Black to move, being mated in 2 => White mates in 2 => positive.
    expect(fromUciScore({ kind: 'mate', value: -2 }, 'b')).toEqual(mate(2));
  });

  it('treats "score mate 0" as checkmate ON THE BOARD, crediting the win to the side NOT to move', () => {
    // Regression: Stockfish reports `score mate 0` for an already-checkmated
    // position. Zero carries no sign, so applying the ordinary mate sign rule
    // credited the mate to the wrong player and inverted the result of every
    // game ending in checkmate. White to move + mate 0 means White has BEEN
    // mated, so Black won.
    expect(fromUciScore({ kind: 'mate', value: 0 }, 'w')).toEqual({
      kind: 'terminal',
      result: 'black-wins'
    });
    expect(fromUciScore({ kind: 'mate', value: 0 }, 'b')).toEqual({
      kind: 'terminal',
      result: 'white-wins'
    });
  });

  it('scores a delivered checkmate in the mating side\'s favour, not against them', () => {
    // Black plays mate: before, Black had mate in 1 (#-1); after, Black has won.
    const before = fromUciScore({ kind: 'mate', value: 1 }, 'b'); // Black to move, mate in 1
    const after = fromUciScore({ kind: 'mate', value: 0 }, 'w'); // White to move, White is mated
    expect(before).toEqual(mate(-1));
    expect(after).toEqual({ kind: 'terminal', result: 'black-wins' });
    // Delivering the mate you already had must NOT read as a catastrophic
    // swing against the player who delivered it.
    expect(swingForMoverCp(before, after, 'b')).toBe(0);
    expect(mateTransition(before, after)).toBe('mate-sustained');
  });

  it('preserves a zero evaluation for either side to move, without producing negative zero', () => {
    expect(fromUciScore({ kind: 'cp', value: 0 }, 'w')).toEqual(cp(0));
    // Flipping a level score must yield +0, not JavaScript's -0, which would
    // fail Object.is comparisons and format as "-0.00".
    expect(Object.is(toComparableCp(fromUciScore({ kind: 'cp', value: 0 }, 'b')), 0)).toBe(true);
    expect(formatEvaluation(fromUciScore({ kind: 'cp', value: 0 }, 'b'))).toBe('+0.00');
  });
});

describe('toComparableCp', () => {
  it('passes ordinary centipawn values through unchanged', () => {
    expect(toComparableCp(cp(0))).toBe(0);
    expect(toComparableCp(cp(430))).toBe(430);
    expect(toComparableCp(cp(-275))).toBe(-275);
  });

  it('clamps extreme centipawn values to the comparison ceiling', () => {
    expect(toComparableCp(cp(50_000))).toBe(SWING_CLAMP_CP);
    expect(toComparableCp(cp(-50_000))).toBe(-SWING_CLAMP_CP);
  });

  it('saturates mate to the ceiling in the mating side\'s direction', () => {
    expect(toComparableCp(mate(1))).toBe(SWING_CLAMP_CP);
    expect(toComparableCp(mate(12))).toBe(SWING_CLAMP_CP);
    expect(toComparableCp(mate(-1))).toBe(-SWING_CLAMP_CP);
    expect(toComparableCp(mate(-9))).toBe(-SWING_CLAMP_CP);
  });
});

describe('terminal evaluations (game already over)', () => {
  const terminal = (result: 'white-wins' | 'black-wins' | 'draw'): Evaluation => ({
    kind: 'terminal',
    result
  });

  it('maps a finished game onto the comparison scale by its result', () => {
    expect(toComparableCp(terminal('white-wins'))).toBe(SWING_CLAMP_CP);
    expect(toComparableCp(terminal('black-wins'))).toBe(-SWING_CLAMP_CP);
    expect(toComparableCp(terminal('draw'))).toBe(0);
  });

  it('treats delivering checkmate as a mate appearing', () => {
    expect(mateTransition(cp(-300), terminal('black-wins'))).toBe('mate-appeared');
    expect(mateTransition(mate(-1), terminal('black-wins'))).toBe('mate-sustained');
  });

  it('treats a draw as no mate', () => {
    expect(mateTransition(cp(0), terminal('draw'))).toBe('none');
    expect(mateTransition(mate(2), terminal('draw'))).toBe('mate-disappeared');
  });

  it('formats terminal evaluations as game results', () => {
    expect(formatEvaluation(terminal('white-wins'))).toBe('1-0');
    expect(formatEvaluation(terminal('black-wins'))).toBe('0-1');
    expect(formatEvaluation(terminal('draw'))).toBe('½-½');
  });

  it('gives the mating side a positive mover-relative swing', () => {
    // Black was already winning and now delivers mate: good for Black, the mover.
    expect(swingForMoverCp(cp(-300), terminal('black-wins'), 'b')).toBeGreaterThan(0);
  });
});

describe('evaluationSwingCp — always white-relative', () => {
  it('reports a positive swing when the position moves toward White', () => {
    // +2.0 -> +5.0 : three pawns in White's favour.
    expect(evaluationSwingCp(cp(200), cp(500))).toBe(300);
  });

  it('reports a negative swing when the position moves toward Black', () => {
    // The spec's worked example: +2.0 -> -3.0 is a 5-pawn swing to Black.
    expect(evaluationSwingCp(cp(200), cp(-300))).toBe(-500);
  });

  it('reports zero for an unchanged evaluation', () => {
    expect(evaluationSwingCp(cp(75), cp(75))).toBe(0);
  });

  it('handles a swing into mate', () => {
    expect(evaluationSwingCp(cp(0), mate(3))).toBe(SWING_CLAMP_CP);
    expect(evaluationSwingCp(cp(0), mate(-3))).toBe(-SWING_CLAMP_CP);
  });
});

describe('swingForMoverCp — the chess correction', () => {
  it('a White move that improves White is positive for the mover', () => {
    expect(swingForMoverCp(cp(200), cp(500), 'w')).toBe(300);
  });

  it('a White move that hands the game to Black is negative for the mover', () => {
    // +2.0 -> -3.0 played by White: White lost five pawns of ground.
    expect(swingForMoverCp(cp(200), cp(-300), 'w')).toBe(-500);
  });

  it('the SAME white-relative swing is POSITIVE for Black when Black moved', () => {
    // Identical evaluations, different mover: +2.0 -> -3.0 is Black improving
    // their own position by five pawns. This is the case a naive
    // white-relative-only implementation gets backwards.
    expect(swingForMoverCp(cp(200), cp(-300), 'b')).toBe(500);
  });

  it('a Black move that worsens Black is negative for the mover', () => {
    // -3.0 -> +2.0 white-relative, played by Black: Black threw away five pawns.
    expect(swingForMoverCp(cp(-300), cp(200), 'b')).toBe(-500);
  });

  it('mover-relative swing is symmetric: negating the mover negates the result', () => {
    const before = cp(120);
    const after = cp(-340);
    expect(swingForMoverCp(before, after, 'w')).toBe(-swingForMoverCp(before, after, 'b'));
  });
});

describe('mateTransition', () => {
  it('reports none when no mate is involved', () => {
    expect(mateTransition(cp(30), cp(-45))).toBe('none');
  });

  it('reports mate-appeared when a forced mate shows up', () => {
    expect(mateTransition(cp(120), mate(4))).toBe('mate-appeared');
    expect(mateTransition(cp(120), mate(-4))).toBe('mate-appeared');
  });

  it('reports mate-disappeared when a forced mate is thrown away', () => {
    expect(mateTransition(mate(3), cp(50))).toBe('mate-disappeared');
  });

  it('reports mate-sustained when the same side keeps the mate', () => {
    expect(mateTransition(mate(5), mate(4))).toBe('mate-sustained');
    expect(mateTransition(mate(-5), mate(-4))).toBe('mate-sustained');
  });

  it('reports mate-flipped when the mate changes hands — the most dramatic case', () => {
    expect(mateTransition(mate(2), mate(-1))).toBe('mate-flipped');
    expect(mateTransition(mate(-2), mate(1))).toBe('mate-flipped');
  });
});

describe('formatting', () => {
  it('formats centipawn evaluations from White\'s point of view', () => {
    expect(formatEvaluation(cp(40))).toBe('+0.40');
    expect(formatEvaluation(cp(-380))).toBe('-3.80');
    expect(formatEvaluation(cp(0))).toBe('+0.00');
  });

  it('formats mate evaluations with the mating side implied by the sign', () => {
    expect(formatEvaluation(mate(4))).toBe('#4');
    expect(formatEvaluation(mate(-2))).toBe('#-2');
  });

  it('formats swings in pawns with an explicit sign', () => {
    // The spec's example: +0.4 -> -3.8 is a swing of -4.2.
    expect(formatSwingCp(evaluationSwingCp(cp(40), cp(-380)))).toBe('-4.20');
    expect(formatSwingCp(300)).toBe('+3.00');
  });
});
